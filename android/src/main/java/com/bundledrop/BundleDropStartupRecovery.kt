package com.bundledrop

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.AtomicFile
import android.util.Log
import com.facebook.react.bridge.ReactMarker
import com.facebook.react.bridge.ReactMarkerConstants
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native source of truth for OTA launch probation.
 *
 * The ledger is persisted before an OTA path is returned to React Native. A later process can
 * therefore recover from Java, JNI, Hermes, or JS failures that happen before the bridge starts.
 */
internal class BundleDropStartupRecoveryController(
  private val bundleDropRoot: File,
  private val processToken: String,
  private val binaryIdentity: String,
  private val expectedRuntimeVersion: String?,
  private val nowMillis: () -> Long = { System.currentTimeMillis() },
  private val newId: () -> String = { UUID.randomUUID().toString() },
  private val failpoint: (String) -> Unit = {},
) {
  data class ActivationResult(val hash: String, val bundlePath: String)
  data class RollbackResult(
    val rolledBack: Boolean,
    val toEmbedded: Boolean,
    val hash: String?,
  )

  data class StartupSelection(
    val bundlePath: String?,
    val attemptHash: String? = null,
    val attemptId: String? = null,
  )

  private data class RecoveryPolicy(
    val maxCrashCount: Int,
    val healthCheckMode: String,
    val healthyAfterSec: Double,
  )

  private data class ActiveAttempt(
    val hash: String,
    val attemptId: String,
    val processToken: String,
    val unacknowledgedLaunchCount: Int,
  )

  private data class RecoveryEvent(
    val id: String,
    val failedHash: String,
    val recoveryTarget: String,
    val recoveredHash: String?,
    val crashCount: Int,
    val failedAt: Long,
  )

  private data class Ledger(
    val revision: Long = 0,
    val binaryIdentity: String? = null,
    val phase: String = PHASE_IDLE,
    val candidateHash: String? = null,
    val candidateRuntimeVersion: String? = null,
    val stableHash: String? = null,
    val stableRuntimeVersion: String? = null,
    val previousStableHash: String? = null,
    val previousStableRuntimeVersion: String? = null,
    val policy: RecoveryPolicy? = null,
    val reservedAttemptId: String? = null,
    val activeAttempt: ActiveAttempt? = null,
    val lastHealthyAttemptId: String? = null,
    val quarantinedHashes: Set<String> = emptySet(),
    val revokedHashes: Set<String> = emptySet(),
    val pendingRecoveryEvents: List<RecoveryEvent> = emptyList(),
    val legacyStateImported: Boolean = false,
    val rollbackFailedHash: String? = null,
    val rollbackCrashCount: Int = 0,
    val rollbackReason: String? = null,
  )

  fun activateCandidate(
    hash: String,
    maxCrashCount: Int,
    healthCheckMode: String,
    healthyAfterSec: Double,
  ): ActivationResult = synchronized(STORAGE_LOCK) {
    requireHash(hash)
    require(maxCrashCount >= 0) { "maxCrashCount must not be negative" }
    require(healthCheckMode == HEALTH_AUTO || healthCheckMode == HEALTH_MANUAL) {
      "healthCheckMode must be auto or manual"
    }
    require(healthyAfterSec.isFinite() && healthyAfterSec >= 0) {
      "healthyAfterSec must be a finite non-negative number"
    }

    val bundlePath = BundleDropOtaResolver.readBundleForHash(bundleDropRoot, hash)
      ?: throw IllegalArgumentException("Candidate bundle is missing or failed native verification")
    val candidateRuntimeVersion = BundleDropOtaResolver.readBundleRuntimeVersion(bundleDropRoot, hash)
      ?: throw IllegalArgumentException("Candidate runtime identity is missing")
    require(!expectedRuntimeVersion.isNullOrBlank()) {
      "Embedded runtime identity is missing; OTA startup activation is disabled"
    }
    require(candidateRuntimeVersion == expectedRuntimeVersion) {
      "Candidate runtime identity does not match the embedded binary"
    }
    var ledger = readLedgerWithLegacyImport()
    require(hash !in ledger.quarantinedHashes && hash !in ledger.revokedHashes) {
      "Candidate bundle is quarantined or revoked"
    }
    failpoint(FAIL_AFTER_VERIFICATION)

    val currentHash = currentHash()
    val requestedPolicy = RecoveryPolicy(maxCrashCount, healthCheckMode, healthyAfterSec)
    if (
      currentHash == hash &&
      ledger.stableHash == hash &&
      (ledger.phase == PHASE_STABLE || ledger.phase == PHASE_RECOVERED)
    ) {
      return@synchronized ActivationResult(hash, bundlePath)
    }
    if (
      currentHash == hash &&
      ledger.candidateHash == hash &&
      (ledger.phase == PHASE_ARMED || ledger.phase == PHASE_LAUNCHING)
    ) {
      var updated = ledger.copy(policy = requestedPolicy)
      if (maxCrashCount == 0) {
        updated = updated.copy(
          phase = PHASE_ARMED,
          reservedAttemptId = null,
          activeAttempt = null,
          lastHealthyAttemptId = null,
        )
      } else if (updated.phase == PHASE_ARMED && updated.reservedAttemptId == null) {
        updated = updated.copy(reservedAttemptId = newId())
      }
      if (updated != ledger) persist(updated)
      return@synchronized ActivationResult(hash, bundlePath)
    }

    val previousStableHash = selectKnownGoodHash(ledger, excludedHash = hash)
    val previousStableRuntimeVersion = when (previousStableHash) {
      ledger.stableHash -> ledger.stableRuntimeVersion
      ledger.previousStableHash -> ledger.previousStableRuntimeVersion
      else -> null
    }
    ledger = ledger.copy(
      binaryIdentity = binaryIdentity,
      phase = PHASE_ARMED,
      candidateHash = hash,
      candidateRuntimeVersion = candidateRuntimeVersion,
      previousStableHash = previousStableHash,
      previousStableRuntimeVersion = previousStableRuntimeVersion,
      policy = requestedPolicy,
      reservedAttemptId = if (maxCrashCount == 0) null else newId(),
      activeAttempt = null,
      lastHealthyAttemptId = null,
      rollbackFailedHash = null,
      rollbackCrashCount = 0,
      rollbackReason = null,
    )
    ledger = persist(ledger)
    failpoint(FAIL_AFTER_ARMED)

    if (previousStableHash != null) {
      writePointer(PREVIOUS_POINTER, previousStableHash)
      failpoint(FAIL_AFTER_PREVIOUS_POINTER)
    } else {
      deletePointer(PREVIOUS_POINTER)
    }
    writePointer(CURRENT_POINTER, hash)
    failpoint(FAIL_AFTER_CURRENT_POINTER)

    ActivationResult(hash, bundlePath)
  }

  fun selectForStartup(): StartupSelection = synchronized(STORAGE_LOCK) {
    var ledger = try {
      readLedgerWithLegacyImport()
    } catch (_: IncompatibleLedgerException) {
      return@synchronized resetForBinaryChange()
    } catch (_: CorruptLedgerException) {
      return@synchronized recoverFromCorruptLedger()
    }

    if (ledger.phase == PHASE_ROLLBACK_REQUIRED) {
      return@synchronized completeRecovery(
        ledger,
        recordCrashLoop = ledger.rollbackReason != ROLLBACK_REVOKED,
      )
    }

    val path = BundleDropOtaResolver.readCurrentPointer(bundleDropRoot)
    val hash = path?.let(::hashFromBundlePath)
    if (ledger.phase == PHASE_ARMED && hash != ledger.candidateHash) {
      return@synchronized discardUnpublishedArm(ledger, path, hash)
    }
    if (path == null || hash == null) return@synchronized StartupSelection(null)

    if (
      ledger.binaryIdentity != binaryIdentity ||
      expectedRuntimeVersion.isNullOrBlank() ||
      BundleDropOtaResolver.readBundleRuntimeVersion(bundleDropRoot, hash) != expectedRuntimeVersion
    ) {
      return@synchronized resetForBinaryChange()
    }

    if (hash in ledger.revokedHashes) {
      ledger = persist(ledger.copy(
        phase = PHASE_ROLLBACK_REQUIRED,
        rollbackFailedHash = hash,
        rollbackCrashCount = 0,
        rollbackReason = ROLLBACK_REVOKED,
      ))
      return@synchronized completeRecovery(ledger, recordCrashLoop = false)
    }

    if (hash in ledger.quarantinedHashes) {
      val crashCount = ledger.activeAttempt?.unacknowledgedLaunchCount ?: 0
      ledger = persist(ledger.copy(
        phase = PHASE_ROLLBACK_REQUIRED,
        rollbackFailedHash = hash,
        rollbackCrashCount = crashCount,
        rollbackReason = ROLLBACK_CRASH_LOOP,
      ))
      return@synchronized completeRecovery(ledger, recordCrashLoop = true)
    }

    if (
      ledger.stableHash == hash &&
      (ledger.phase == PHASE_STABLE || ledger.phase == PHASE_RECOVERED)
    ) {
      return@synchronized StartupSelection(path)
    }

    val policy = ledger.policy
    if (
      ledger.candidateHash != hash ||
      ledger.candidateRuntimeVersion != expectedRuntimeVersion ||
      policy == null ||
      (ledger.phase != PHASE_ARMED && ledger.phase != PHASE_LAUNCHING)
    ) {
      deletePointer(CURRENT_POINTER)
      return@synchronized StartupSelection(null)
    }

    // Zero explicitly disables crash classification while retaining revocation and integrity gates.
    if (policy.maxCrashCount == 0) {
      return@synchronized StartupSelection(path)
    }

    val activeAttempt = ledger.activeAttempt
    if (activeAttempt?.hash == hash && activeAttempt.processToken == processToken) {
      return@synchronized StartupSelection(path, hash, activeAttempt.attemptId)
    }

    val failedLaunchCount = if (activeAttempt?.hash == hash) {
      activeAttempt.unacknowledgedLaunchCount + 1
    } else {
      0
    }
    val threshold = policy.maxCrashCount
    if (threshold > 0 && failedLaunchCount >= threshold) {
      ledger = persist(ledger.copy(
        phase = PHASE_ROLLBACK_REQUIRED,
        rollbackFailedHash = hash,
        rollbackCrashCount = failedLaunchCount,
        rollbackReason = ROLLBACK_CRASH_LOOP,
        quarantinedHashes = ledger.quarantinedHashes + hash,
      ))
      failpoint(FAIL_AFTER_ROLLBACK_REQUIRED)
      return@synchronized completeRecovery(ledger, recordCrashLoop = true)
    }

    val attempt = ActiveAttempt(
      hash = hash,
      attemptId = ledger.reservedAttemptId ?: newId(),
      processToken = processToken,
      unacknowledgedLaunchCount = failedLaunchCount,
    )
    persist(ledger.copy(
      phase = PHASE_LAUNCHING,
      reservedAttemptId = null,
      activeAttempt = attempt,
    ))
    failpoint(FAIL_AFTER_LAUNCH_PERSISTED)
    StartupSelection(path, hash, attempt.attemptId)
  }

  fun resolvePassive(): String? = synchronized(STORAGE_LOCK) {
    val path = BundleDropOtaResolver.readCurrentPointer(bundleDropRoot) ?: return@synchronized null
    val hash = hashFromBundlePath(path) ?: return@synchronized null
    val ledger = try {
      readLedgerWithLegacyImport()
    } catch (_: IncompatibleLedgerException) {
      return@synchronized null
    } catch (_: CorruptLedgerException) {
      return@synchronized null
    }
    if (ledger.phase == PHASE_ROLLBACK_REQUIRED) return@synchronized null
    if (hash in ledger.quarantinedHashes || hash in ledger.revokedHashes) return@synchronized null

    val recordedRuntimeVersion = when {
      ledger.stableHash == hash &&
        (ledger.phase == PHASE_STABLE || ledger.phase == PHASE_RECOVERED) -> ledger.stableRuntimeVersion
      ledger.candidateHash == hash &&
        (ledger.phase == PHASE_ARMED || ledger.phase == PHASE_LAUNCHING) &&
        ledger.policy != null -> ledger.candidateRuntimeVersion
      else -> null
    }
    if (!isCurrentBundleEligible(ledger, hash, recordedRuntimeVersion)) null else path
  }

  fun markHealthy(hash: String, attemptId: String): Boolean = synchronized(STORAGE_LOCK) {
    requireHash(hash)
    val ledger = try {
      readLedgerWithLegacyImport()
    } catch (_: IncompatibleLedgerException) {
      return@synchronized false
    } catch (_: CorruptLedgerException) {
      return@synchronized false
    }
    val attempt = ledger.activeAttempt
    val recordedRuntimeVersion = when {
      ledger.phase == PHASE_STABLE &&
        ledger.stableHash == hash &&
        ledger.lastHealthyAttemptId == attemptId -> ledger.stableRuntimeVersion
      ledger.phase == PHASE_LAUNCHING &&
        ledger.candidateHash == hash &&
        attempt?.hash == hash &&
        attempt.attemptId == attemptId -> ledger.candidateRuntimeVersion
      else -> null
    }
    if (!isCurrentBundleEligible(ledger, hash, recordedRuntimeVersion)) {
      return@synchronized false
    }
    if (
      ledger.phase == PHASE_STABLE &&
      ledger.stableHash == hash &&
      ledger.lastHealthyAttemptId == attemptId
    ) {
      return@synchronized true
    }
    if (
      ledger.phase != PHASE_LAUNCHING ||
      attempt?.hash != hash ||
      attempt.attemptId != attemptId
    ) {
      return@synchronized false
    }

    persist(ledger.copy(
      phase = PHASE_STABLE,
      candidateHash = null,
      candidateRuntimeVersion = null,
      stableHash = hash,
      stableRuntimeVersion = recordedRuntimeVersion,
      policy = null,
      reservedAttemptId = null,
      activeAttempt = null,
      lastHealthyAttemptId = attemptId,
      rollbackFailedHash = null,
      rollbackCrashCount = 0,
      rollbackReason = null,
    ))
    failpoint(FAIL_AFTER_HEALTH_COMMITTED)
    true
  }

  fun setRevokedHashes(hashes: Set<String>): Unit = synchronized(STORAGE_LOCK) {
    hashes.forEach(::requireHash)
    val ledger = readLedgerWithLegacyImport()
    if (ledger.revokedHashes == hashes) return@synchronized
    persist(ledger.copy(revokedHashes = hashes))
  }

  fun rollbackStartupBundle(forceEmbedded: Boolean): RollbackResult = synchronized(STORAGE_LOCK) {
    val ledger = readLedgerWithLegacyImport()
    val currentHash = currentHash()
    val targetHash = if (forceEmbedded) {
      null
    } else {
      selectKnownGoodHash(ledger, excludedHash = currentHash)
    }
    if (targetHash != null) {
      val targetRuntimeVersion = BundleDropOtaResolver.readBundleRuntimeVersion(bundleDropRoot, targetHash)
      writePointer(CURRENT_POINTER, targetHash)
      deletePointer(PREVIOUS_POINTER)
      persist(ledger.copy(
        phase = PHASE_STABLE,
        candidateHash = targetHash,
        candidateRuntimeVersion = targetRuntimeVersion,
        stableHash = targetHash,
        stableRuntimeVersion = targetRuntimeVersion,
        previousStableHash = null,
        previousStableRuntimeVersion = null,
        reservedAttemptId = null,
        activeAttempt = null,
        lastHealthyAttemptId = null,
        policy = null,
        rollbackFailedHash = null,
        rollbackCrashCount = 0,
        rollbackReason = null,
      ))
    } else {
      deletePointer(CURRENT_POINTER)
      deletePointer(PREVIOUS_POINTER)
      persist(ledger.copy(
        phase = PHASE_IDLE,
        candidateHash = null,
        candidateRuntimeVersion = null,
        stableHash = null,
        stableRuntimeVersion = null,
        previousStableHash = null,
        previousStableRuntimeVersion = null,
        reservedAttemptId = null,
        activeAttempt = null,
        lastHealthyAttemptId = null,
        policy = null,
        rollbackFailedHash = null,
        rollbackCrashCount = 0,
        rollbackReason = null,
      ))
    }
    RollbackResult(
      rolledBack = currentHash != null,
      toEmbedded = targetHash == null,
      hash = targetHash,
    )
  }

  fun acknowledgeRecovery(eventId: String): Boolean = synchronized(STORAGE_LOCK) {
    val ledger = readLedgerWithLegacyImport()
    if (ledger.pendingRecoveryEvents.none { it.id == eventId }) return@synchronized false
    persist(ledger.copy(
      pendingRecoveryEvents = ledger.pendingRecoveryEvents.filterNot { it.id == eventId },
    ))
    true
  }

  fun snapshot(): JSONObject = synchronized(STORAGE_LOCK) {
    val ledger = readLedgerWithLegacyImport()
    val output = JSONObject()
      .put("protocolVersion", PROTOCOL_VERSION)
      .put("revision", ledger.revision)
      .put("phase", externalPhase(ledger.phase))
      .put("activeAttempt", ledger.activeAttempt?.let(::attemptJson) ?: JSONObject.NULL)
      .put("quarantinedHashes", JSONArray(ledger.quarantinedHashes.sorted()))
      .put("pendingRecoveryEvents", JSONArray(ledger.pendingRecoveryEvents.map(::eventJson)))
    ledger.candidateHash?.let { output.put("candidateHash", it) }
    ledger.stableHash?.let { output.put("stableHash", it) }
    ledger.policy?.let {
      output.put("policy", JSONObject()
        .put("maxCrashCount", it.maxCrashCount)
        .put("healthCheckMode", it.healthCheckMode)
        .put("healthyAfterSec", it.healthyAfterSec))
    }
    output
  }

  fun activeAttempt(): Pair<String, String>? = synchronized(STORAGE_LOCK) {
    val attempt = try {
      readLedgerWithLegacyImport().activeAttempt
    } catch (_: CorruptLedgerException) {
      null
    } ?: return@synchronized null
    attempt.hash to attempt.attemptId
  }

  fun scheduleContentAppearedHealth(handler: Handler = Handler(Looper.getMainLooper())) {
    val ledger = synchronized(STORAGE_LOCK) {
      try {
        readLedgerWithLegacyImport()
      } catch (_: CorruptLedgerException) {
        null
      }
    } ?: return
    val attempt = ledger.activeAttempt ?: return
    val policy = ledger.policy ?: return
    if (ledger.phase != PHASE_LAUNCHING || policy.healthCheckMode != HEALTH_AUTO) return
    val delayMillis = (policy.healthyAfterSec * 1000.0).toLong().coerceAtLeast(0)
    handler.postDelayed({ markHealthy(attempt.hash, attempt.attemptId) }, delayMillis)
  }

  private fun completeRecovery(ledger: Ledger, recordCrashLoop: Boolean): StartupSelection {
    val failedHash = ledger.rollbackFailedHash ?: ledger.candidateHash
      ?: return StartupSelection(null)
    val crashCount = ledger.rollbackCrashCount
    val alreadyPromotedTarget = currentHash()
      ?.takeIf { it != failedHash && isKnownGoodHash(ledger, it) }
    val targetHash = alreadyPromotedTarget ?: selectKnownGoodHash(ledger, failedHash)
      ?.takeIf { readPointerHash(PREVIOUS_POINTER) == it }
    val recoveryTarget: String

    if (targetHash != null) {
      writePointer(CURRENT_POINTER, targetHash)
      deletePointer(PREVIOUS_POINTER)
      recoveryTarget = RECOVERY_PREVIOUS
    } else {
      deletePointer(CURRENT_POINTER)
      deletePointer(PREVIOUS_POINTER)
      recoveryTarget = RECOVERY_EMBEDDED
    }
    failpoint(FAIL_AFTER_RECOVERY_POINTER)

    val events = if (recordCrashLoop) {
      val event = RecoveryEvent(
        id = newId(),
        failedHash = failedHash,
        recoveryTarget = recoveryTarget,
        recoveredHash = targetHash,
        crashCount = crashCount,
        failedAt = nowMillis() / 1000,
      )
      (ledger.pendingRecoveryEvents + event).takeLast(MAX_PENDING_EVENTS)
    } else {
      ledger.pendingRecoveryEvents
    }
    persist(ledger.copy(
      phase = PHASE_RECOVERED,
      candidateHash = targetHash,
      candidateRuntimeVersion = targetHash?.let {
        BundleDropOtaResolver.readBundleRuntimeVersion(bundleDropRoot, it)
      },
      stableHash = targetHash,
      stableRuntimeVersion = targetHash?.let {
        BundleDropOtaResolver.readBundleRuntimeVersion(bundleDropRoot, it)
      },
      previousStableHash = null,
      previousStableRuntimeVersion = null,
      policy = null,
      reservedAttemptId = null,
      activeAttempt = null,
      lastHealthyAttemptId = null,
      quarantinedHashes = if (recordCrashLoop) {
        ledger.quarantinedHashes + failedHash
      } else {
        ledger.quarantinedHashes
      },
      pendingRecoveryEvents = events,
      rollbackFailedHash = null,
      rollbackCrashCount = 0,
      rollbackReason = null,
    ))
    failpoint(FAIL_AFTER_RECOVERED)
    return StartupSelection(
      bundlePath = targetHash?.let { BundleDropOtaResolver.readBundleForHash(bundleDropRoot, it) },
    )
  }

  private fun discardUnpublishedArm(
    ledger: Ledger,
    currentPath: String?,
    currentHash: String?,
  ): StartupSelection {
    val stableCurrentHash = currentHash?.takeIf { isKnownGoodHash(ledger, it) }
    deletePointer(PREVIOUS_POINTER)

    if (stableCurrentHash == null) {
      deletePointer(CURRENT_POINTER)
      persist(ledger.copy(
        phase = PHASE_IDLE,
        candidateHash = null,
        candidateRuntimeVersion = null,
        policy = null,
        reservedAttemptId = null,
        activeAttempt = null,
        lastHealthyAttemptId = null,
        rollbackFailedHash = null,
        rollbackCrashCount = 0,
        rollbackReason = null,
      ))
      return StartupSelection(null)
    }

    val stableRuntimeVersion = BundleDropOtaResolver.readBundleRuntimeVersion(
      bundleDropRoot,
      stableCurrentHash,
    )
    val previousStableHash = selectKnownGoodHash(ledger, excludedHash = stableCurrentHash)
    val previousStableRuntimeVersion = previousStableHash?.let {
      BundleDropOtaResolver.readBundleRuntimeVersion(bundleDropRoot, it)
    }
    persist(ledger.copy(
      phase = PHASE_STABLE,
      candidateHash = stableCurrentHash,
      candidateRuntimeVersion = stableRuntimeVersion,
      stableHash = stableCurrentHash,
      stableRuntimeVersion = stableRuntimeVersion,
      previousStableHash = previousStableHash,
      previousStableRuntimeVersion = previousStableRuntimeVersion,
      policy = null,
      reservedAttemptId = null,
      activeAttempt = null,
      lastHealthyAttemptId = null,
      rollbackFailedHash = null,
      rollbackCrashCount = 0,
      rollbackReason = null,
    ))
    return StartupSelection(currentPath)
  }

  private fun recoverFromCorruptLedger(): StartupSelection {
    val failedHash = currentHash()
    deletePointer(CURRENT_POINTER)
    deletePointer(PREVIOUS_POINTER)
    val quarantined = failedHash?.let(::setOf) ?: emptySet()
    persist(Ledger(
      binaryIdentity = binaryIdentity,
      phase = PHASE_RECOVERED,
      quarantinedHashes = quarantined,
      legacyStateImported = true,
    ), replaceExisting = true)
    return StartupSelection(null)
  }

  private fun resetForBinaryChange(): StartupSelection {
    deletePointer(CURRENT_POINTER)
    deletePointer(PREVIOUS_POINTER)
    persist(
      Ledger(binaryIdentity = binaryIdentity, legacyStateImported = true),
      replaceExisting = true,
    )
    return StartupSelection(null)
  }

  private fun selectKnownGoodHash(ledger: Ledger, excludedHash: String?): String? {
    val candidates = listOfNotNull(ledger.stableHash, ledger.previousStableHash).distinct()
    return candidates.firstOrNull { hash -> hash != excludedHash && isKnownGoodHash(ledger, hash) }
  }

  private fun isKnownGoodHash(ledger: Ledger, hash: String): Boolean {
    val recordedRuntimeVersion = when (hash) {
      ledger.stableHash -> ledger.stableRuntimeVersion
      ledger.previousStableHash -> ledger.previousStableRuntimeVersion
      else -> null
    }
    return ledger.binaryIdentity == binaryIdentity &&
      !recordedRuntimeVersion.isNullOrBlank() &&
      hash !in ledger.quarantinedHashes &&
      hash !in ledger.revokedHashes &&
      recordedRuntimeVersion == expectedRuntimeVersion &&
      BundleDropOtaResolver.readBundleForHash(bundleDropRoot, hash) != null &&
      BundleDropOtaResolver.readBundleRuntimeVersion(bundleDropRoot, hash) == expectedRuntimeVersion
  }

  private fun isCurrentBundleEligible(
    ledger: Ledger,
    hash: String,
    recordedRuntimeVersion: String?,
  ): Boolean {
    return ledger.binaryIdentity == binaryIdentity &&
      !expectedRuntimeVersion.isNullOrBlank() &&
      recordedRuntimeVersion == expectedRuntimeVersion &&
      hash !in ledger.quarantinedHashes &&
      hash !in ledger.revokedHashes &&
      currentHash() == hash &&
      BundleDropOtaResolver.readBundleRuntimeVersion(bundleDropRoot, hash) == expectedRuntimeVersion
  }

  private fun readLedgerWithLegacyImport(): Ledger {
    val file = ledgerFile()
    val ledger = if (!file.baseFile.exists() && !File(file.baseFile.path + ".new").exists()) {
      Ledger(binaryIdentity = binaryIdentity)
    } else {
      try {
        ledgerFromJson(JSONObject(String(file.readFully(), Charsets.UTF_8)))
      } catch (error: Exception) {
        throw CorruptLedgerException(error)
      }
    }
    if (ledger.binaryIdentity != binaryIdentity) throw IncompatibleLedgerException()
    if (ledger.legacyStateImported) return ledger

    val legacy = readLegacyState()
    val imported = ledger.copy(
      quarantinedHashes = ledger.quarantinedHashes + legacy,
      legacyStateImported = true,
    )
    return persist(imported)
  }

  private fun readLegacyState(): Set<String> {
    return try {
      val stateFile = File(bundleDropRoot, LEGACY_STATE)
      if (!stateFile.exists()) return emptySet()
      val json = JSONObject(stateFile.readText())
      val failedBundles = json.optJSONObject("failedBundles")
      val failed = mutableListOf<LegacyFailedHash>()
      failedBundles?.keys()?.forEach { hash ->
        if (isValidHash(hash)) {
          val timestamp = failedBundles.optJSONObject(hash)
            ?.optDouble("failedAt", Double.NaN)
            ?.takeIf { it.isFinite() && it >= 0 }
          failed.add(LegacyFailedHash(hash, timestamp))
        }
      }
      failed.sortedWith(
        compareByDescending<LegacyFailedHash> { it.failedAt != null }
          .thenByDescending { it.failedAt ?: Double.NEGATIVE_INFINITY }
          .thenBy { it.hash },
      ).take(MAX_LEGACY_FAILED_HASHES).mapTo(linkedSetOf()) { it.hash }
    } catch (_: Exception) {
      emptySet()
    }
  }

  private data class LegacyFailedHash(val hash: String, val failedAt: Double?)

  private fun persist(ledger: Ledger, replaceExisting: Boolean = false): Ledger {
    failpoint(FAIL_BEFORE_LEDGER_COMMIT)
    if (!replaceExisting) {
      val diskRevision = readPersistedRevision()
      check(diskRevision == ledger.revision) {
        "Startup recovery ledger changed before commit " +
          "(expected revision ${ledger.revision}, found $diskRevision)"
      }
    }
    val next = ledger.copy(revision = ledger.revision + 1)
    writeAtomic(ledgerFile(), ledgerJson(next).toString())
    return next
  }

  private fun readPersistedRevision(): Long {
    val file = ledgerFile()
    if (!file.baseFile.exists() && !File(file.baseFile.path + ".new").exists()) return 0
    return JSONObject(String(file.readFully(), Charsets.UTF_8)).getLong("revision")
  }

  private fun ledgerJson(ledger: Ledger): JSONObject {
    val json = JSONObject()
      .put("schemaVersion", PROTOCOL_VERSION)
      .put("revision", ledger.revision)
      .put("binaryIdentity", ledger.binaryIdentity)
      .put("phase", ledger.phase)
      .put("quarantinedHashes", JSONArray(ledger.quarantinedHashes.sorted()))
      .put("revokedHashes", JSONArray(ledger.revokedHashes.sorted()))
      .put("pendingRecoveryEvents", JSONArray(ledger.pendingRecoveryEvents.map(::eventJson)))
      .put("legacyStateImported", ledger.legacyStateImported)
      .put("rollbackCrashCount", ledger.rollbackCrashCount)
    ledger.reservedAttemptId?.let { json.put("reservedAttemptId", it) }
    ledger.candidateHash?.let { json.put("candidateHash", it) }
    ledger.candidateRuntimeVersion?.let { json.put("candidateRuntimeVersion", it) }
    ledger.stableHash?.let { json.put("stableHash", it) }
    ledger.stableRuntimeVersion?.let { json.put("stableRuntimeVersion", it) }
    ledger.previousStableHash?.let { json.put("previousStableHash", it) }
    ledger.previousStableRuntimeVersion?.let { json.put("previousStableRuntimeVersion", it) }
    ledger.rollbackFailedHash?.let { json.put("rollbackFailedHash", it) }
    ledger.rollbackReason?.let { json.put("rollbackReason", it) }
    ledger.lastHealthyAttemptId?.let { json.put("lastHealthyAttemptId", it) }
    ledger.policy?.let {
      json.put("policy", JSONObject()
        .put("maxCrashCount", it.maxCrashCount)
        .put("healthCheckMode", it.healthCheckMode)
        .put("healthyAfterSec", it.healthyAfterSec))
    }
    ledger.activeAttempt?.let {
      json.put("activeAttempt", attemptJson(it).put("processToken", it.processToken))
    }
    return json
  }

  private fun ledgerFromJson(json: JSONObject): Ledger {
    if (json.optInt("schemaVersion", -1) != PROTOCOL_VERSION) {
      throw IllegalArgumentException("Unsupported startup recovery schema")
    }
    val policyJson = json.optJSONObject("policy")
    val policy = policyJson?.let {
      RecoveryPolicy(
        maxCrashCount = it.getInt("maxCrashCount"),
        healthCheckMode = it.getString("healthCheckMode"),
        healthyAfterSec = it.getDouble("healthyAfterSec"),
      )
    }
    val attemptJson = json.optJSONObject("activeAttempt")
    val attempt = attemptJson?.let {
      ActiveAttempt(
        hash = it.getString("hash"),
        attemptId = it.getString("attemptId"),
        processToken = it.getString("processToken"),
        unacknowledgedLaunchCount = it.optInt("unacknowledgedLaunchCount", 0),
      )
    }
    val events = json.optJSONArray("pendingRecoveryEvents").toJsonObjects().map {
      RecoveryEvent(
        id = it.getString("id"),
        failedHash = it.getString("failedHash"),
        recoveryTarget = it.getString("recoveryTarget"),
        recoveredHash = it.optString("recoveredHash", "").takeIf(String::isNotEmpty),
        crashCount = it.getInt("crashCount"),
        failedAt = it.getLong("failedAt"),
      )
    }
    return Ledger(
      revision = json.optLong("revision", 0),
      binaryIdentity = json.optString("binaryIdentity", "").takeIf(String::isNotEmpty),
      phase = json.optString("phase", PHASE_IDLE),
      candidateHash = json.optString("candidateHash", "").takeIf(String::isNotEmpty),
      candidateRuntimeVersion = json.optString("candidateRuntimeVersion", "").takeIf(String::isNotEmpty),
      stableHash = json.optString("stableHash", "").takeIf(String::isNotEmpty),
      stableRuntimeVersion = json.optString("stableRuntimeVersion", "").takeIf(String::isNotEmpty),
      previousStableHash = json.optString("previousStableHash", "").takeIf(String::isNotEmpty),
      previousStableRuntimeVersion = json.optString("previousStableRuntimeVersion", "").takeIf(String::isNotEmpty),
      policy = policy,
      reservedAttemptId = json.optString("reservedAttemptId", "").takeIf(String::isNotEmpty),
      activeAttempt = attempt,
      lastHealthyAttemptId = json.optString("lastHealthyAttemptId", "").takeIf(String::isNotEmpty),
      quarantinedHashes = json.optJSONArray("quarantinedHashes").toStringSet(),
      revokedHashes = json.optJSONArray("revokedHashes").toStringSet(),
      pendingRecoveryEvents = events,
      legacyStateImported = json.optBoolean("legacyStateImported", false),
      rollbackFailedHash = json.optString("rollbackFailedHash", "").takeIf(String::isNotEmpty),
      rollbackCrashCount = json.optInt("rollbackCrashCount", 0),
      rollbackReason = json.optString("rollbackReason", "").takeIf(String::isNotEmpty),
    ).also(::validateLedger)
  }

  private fun validateLedger(ledger: Ledger) {
    ledger.candidateHash?.let(::requireHash)
    ledger.stableHash?.let(::requireHash)
    ledger.previousStableHash?.let(::requireHash)
    ledger.rollbackFailedHash?.let(::requireHash)
    ledger.activeAttempt?.let {
      requireHash(it.hash)
      require(it.attemptId.isNotBlank()) { "Active startup attempt is missing its ID" }
      require(it.processToken.isNotBlank()) { "Active startup attempt is missing its process token" }
      require(it.unacknowledgedLaunchCount >= 0) { "Invalid startup launch count" }
    }
    ledger.policy?.let {
      require(it.maxCrashCount >= 0) { "Invalid startup crash limit" }
      require(it.healthCheckMode == HEALTH_AUTO || it.healthCheckMode == HEALTH_MANUAL) {
        "Invalid startup health mode"
      }
      require(it.healthyAfterSec.isFinite() && it.healthyAfterSec >= 0) {
        "Invalid startup health delay"
      }
    }
    if (ledger.phase == PHASE_ARMED && (ledger.policy?.maxCrashCount ?: 0) > 0) {
      require(ledger.candidateHash != null && !ledger.reservedAttemptId.isNullOrBlank()) {
        "Armed startup candidate is missing its reserved attempt ID"
      }
    }
    if (ledger.phase == PHASE_LAUNCHING) {
      require(ledger.activeAttempt != null && ledger.reservedAttemptId == null) {
        "Launching startup candidate has invalid attempt state"
      }
    }
    require(ledger.rollbackReason == null || ledger.rollbackReason in setOf(
      ROLLBACK_CRASH_LOOP,
      ROLLBACK_REVOKED,
    )) { "Invalid startup rollback reason" }
  }

  private fun attemptJson(attempt: ActiveAttempt): JSONObject = JSONObject()
    .put("hash", attempt.hash)
    .put("attemptId", attempt.attemptId)
    .put("status", PHASE_LAUNCHING)
    .put("unacknowledgedLaunchCount", attempt.unacknowledgedLaunchCount)

  private fun eventJson(event: RecoveryEvent): JSONObject {
    val json = JSONObject()
      .put("id", event.id)
      .put("failedHash", event.failedHash)
      .put("recoveryTarget", event.recoveryTarget)
      .put("crashCount", event.crashCount)
      .put("reason", "crash_loop")
      .put("failedAt", event.failedAt)
    event.recoveredHash?.let { json.put("recoveredHash", it) }
    return json
  }

  private fun externalPhase(phase: String): String = when (phase) {
    PHASE_ROLLBACK_REQUIRED -> PHASE_LAUNCHING
    else -> phase
  }

  private fun currentHash(): String? = BundleDropOtaResolver.readCurrentPointer(bundleDropRoot)
    ?.let(::hashFromBundlePath)

  private fun readPointerHash(name: String): String? {
    return try {
      val pointer = File(bundleDropRoot, name)
      if (!pointer.isFile) return null
      JSONObject(pointer.readText()).optString("hash", "").takeIf(::isValidHash)
    } catch (_: Exception) {
      null
    }
  }

  private fun hashFromBundlePath(path: String): String? = File(path).parentFile?.name?.takeIf(::isValidHash)

  private fun writePointer(name: String, hash: String) {
    requireHash(hash)
    bundleDropRoot.mkdirs()
    val json = JSONObject()
      .put("hash", hash)
      .put("updatedAt", isoTimestamp(nowMillis()))
    writeAtomic(AtomicFile(File(bundleDropRoot, name)), json.toString())
  }

  private fun deletePointer(name: String) {
    AtomicFile(File(bundleDropRoot, name)).delete()
  }

  private fun ledgerFile(): AtomicFile = AtomicFile(File(bundleDropRoot, RECOVERY_LEDGER))

  private fun isoTimestamp(timestampMillis: Long): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
    }.format(Date(timestampMillis))

  private fun writeAtomic(file: AtomicFile, content: String) {
    file.baseFile.parentFile?.mkdirs()
    var stream: FileOutputStream? = null
    try {
      stream = file.startWrite()
      stream.write(content.toByteArray(Charsets.UTF_8))
      file.finishWrite(stream)
    } catch (error: Exception) {
      if (stream != null) file.failWrite(stream)
      throw error
    }
  }

  private fun JSONArray?.toStringSet(): Set<String> {
    if (this == null) return emptySet()
    val values = mutableSetOf<String>()
    for (index in 0 until length()) {
      val value = optString(index, "")
      if (isValidHash(value)) values.add(value)
    }
    return values
  }

  private fun JSONArray?.toJsonObjects(): List<JSONObject> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull(::optJSONObject)
  }

  private fun requireHash(hash: String) {
    require(isValidHash(hash)) { "Bundle hash must be a canonical lowercase SHA-256" }
  }

  private fun isValidHash(hash: String): Boolean = BUNDLE_HASH.matches(hash)

  private class CorruptLedgerException(cause: Throwable) : Exception(cause)
  private class IncompatibleLedgerException : Exception()

  companion object {
    const val PROTOCOL_VERSION = 1
    const val RECOVERY_LEDGER = "startup-recovery.json"
    const val FAIL_AFTER_ARMED = "after_armed"
    const val FAIL_AFTER_VERIFICATION = "after_verification"
    const val FAIL_BEFORE_LEDGER_COMMIT = "before_ledger_commit"
    const val FAIL_AFTER_PREVIOUS_POINTER = "after_previous_pointer"
    const val FAIL_AFTER_CURRENT_POINTER = "after_current_pointer"
    const val FAIL_AFTER_LAUNCH_PERSISTED = "after_launch_persisted"
    const val FAIL_AFTER_HEALTH_COMMITTED = "after_health_committed"
    const val FAIL_AFTER_ROLLBACK_REQUIRED = "after_rollback_required"
    const val FAIL_AFTER_RECOVERY_POINTER = "after_recovery_pointer"
    const val FAIL_AFTER_RECOVERED = "after_recovered"

    private const val CURRENT_POINTER = "current.json"
    private const val PREVIOUS_POINTER = "previous.json"
    private const val LEGACY_STATE = "state.json"
    private const val MAX_PENDING_EVENTS = 20
    private const val MAX_LEGACY_FAILED_HASHES = 20
    private const val HEALTH_AUTO = "auto"
    private const val HEALTH_MANUAL = "manual"
    private const val PHASE_IDLE = "idle"
    private const val PHASE_ARMED = "armed"
    private const val PHASE_LAUNCHING = "launching"
    private const val PHASE_STABLE = "stable"
    private const val PHASE_ROLLBACK_REQUIRED = "rollback_required"
    private const val PHASE_RECOVERED = "recovered"
    private const val RECOVERY_PREVIOUS = "previous"
    private const val RECOVERY_EMBEDDED = "embedded"
    private const val ROLLBACK_CRASH_LOOP = "crash_loop"
    private const val ROLLBACK_REVOKED = "revoked"
    private val BUNDLE_HASH = Regex("^[a-f0-9]{64}$")
    private val STORAGE_LOCK = Any()
  }
}

/** Process-scoped facade used by cold-start resolution and the React Native bridge. */
internal object BundleDropStartupRecovery {
  private val processToken = UUID.randomUUID().toString()

  @Volatile private var startupAttemptHash: String? = null
  @Volatile private var startupAttemptId: String? = null
  @Volatile private var startupSelectedHash: String? = null
  @Volatile private var contentListenerInstalled = false
  @Volatile private var scheduledHealthAttemptKey: String? = null

  fun controller(context: Context): BundleDropStartupRecoveryController =
    BundleDropStartupRecoveryController(
      bundleDropRoot = File(context.filesDir, "bundle-drop"),
      processToken = processToken,
      binaryIdentity = BundleDropNativePaths.currentBinaryIdentity(context),
      expectedRuntimeVersion = BundleDropNativePaths.readEmbeddedRuntimeVersion(context),
    )

  fun selectForStartup(
    context: Context,
    select: () -> BundleDropStartupRecoveryController.StartupSelection = {
      controller(context).selectForStartup()
    },
  ): BundleDropStartupRecoveryController.StartupSelection {
    val selection = try {
      select()
    } catch (error: Exception) {
      Log.e("BundleDrop", "Startup recovery failed closed to the embedded bundle", error)
      BundleDropStartupRecoveryController.StartupSelection(null)
    }
    startupAttemptHash = selection.attemptHash
    startupAttemptId = selection.attemptId
    startupSelectedHash = selection.bundlePath
      ?.let(::File)
      ?.parentFile
      ?.name
      ?.takeIf { it.matches(Regex("^[a-f0-9]{64}$")) }
    if (selection.attemptId != null) installContentAppearedListener(context)
    return selection
  }

  fun startupAttempt(): Pair<String, String>? {
    val hash = startupAttemptHash ?: return null
    val id = startupAttemptId ?: return null
    return hash to id
  }

  fun startupSelectedHash(): String? = startupSelectedHash

  fun clearStartupSelection() {
    startupAttemptHash = null
    startupAttemptId = null
    startupSelectedHash = null
  }

  internal fun scheduleContentAppearedHealthOnce(
    hash: String,
    attemptId: String,
    schedule: () -> Unit,
  ): Boolean = synchronized(this) {
    val attemptKey = "$hash:$attemptId"
    if (scheduledHealthAttemptKey == attemptKey) return@synchronized false
    scheduledHealthAttemptKey = attemptKey
    schedule()
    true
  }

  private fun installContentAppearedListener(context: Context) {
    if (contentListenerInstalled) return
    synchronized(this) {
      if (contentListenerInstalled) return
      ReactMarker.addListener(object : ReactMarker.MarkerListener {
        override fun logMarker(name: ReactMarkerConstants, tag: String?, instanceKey: Int) {
          if (name == ReactMarkerConstants.CONTENT_APPEARED) {
            val (hash, attemptId) = startupAttempt() ?: return
            scheduleContentAppearedHealthOnce(hash, attemptId) {
              controller(context).scheduleContentAppearedHealth()
            }
          }
        }
      })
      contentListenerInstalled = true
    }
  }
}
