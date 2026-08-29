package com.bundledrop

import android.os.Handler
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class BundleDropStartupRecoveryTest {
  @get:Rule val tempFolder = TemporaryFolder()

  private val binaryIdentity = "runtime:runtime-1|binary:1.0-1"

  @Test
  fun `activation imports only legacy failed hashes and writes only proven previous pointers`() {
    val root = tempFolder.newFolder("bundle-drop")
    val filesDir = root.parentFile!!
    val unprovenHash = writeBundle(root, "unproven")
    val failedHash = "f".repeat(64)
    val candidateHash = writeBundle(root, "candidate")
    File(root, "current.json").writeText("""{"hash":"$unprovenHash"}""")
    File(root, "state.json").writeText(
      """{"lastGoodHash":"$unprovenHash","failedBundles":{"$failedHash":{"reason":"crash_loop"}}}""",
    )

    controller(root, filesDir, "activation", now = 1_000)
      .activateCandidate(candidateHash, 3, "manual", 10.0)

    assertEquals(candidateHash, pointerHash(root, "current.json"))
    assertFalse(File(root, "previous.json").exists())
    val pointerTimestamp = JSONObject(File(root, "current.json").readText()).getString("updatedAt")
    assertTrue(pointerTimestamp.matches(Regex("\\d{4}-\\d{2}-\\d{2}T.*Z")))
    val snapshot = controller(root, filesDir, "snapshot").snapshot()
    assertFalse(snapshot.has("stableHash"))
    assertEquals(listOf(failedHash), jsonStrings(snapshot, "quarantinedHashes"))
  }

  @Test
  fun `legacy failed hash import keeps only the twenty newest valid records`() {
    val root = tempFolder.newFolder("legacy-cap-root")
    val filesDir = root.parentFile!!
    val failedBundles = JSONObject()
    val timestampedHashes = (0 until 22).map { index ->
      index.toString(16).padStart(64, '0').also { hash ->
        failedBundles.put(hash, JSONObject().put("failedAt", 1_000 + index))
      }
    }
    failedBundles.put("e".repeat(64), JSONObject())
    failedBundles.put("f".repeat(64), JSONObject().put("failedAt", "invalid"))
    failedBundles.put("not-a-hash", JSONObject().put("failedAt", Long.MAX_VALUE))
    File(root, "state.json").writeText(
      JSONObject()
        .put("failedBundles", failedBundles)
        .put("lastGoodHash", "d".repeat(64))
        .put("candidateHash", "c".repeat(64))
        .put("crashCount", 99)
        .toString(),
    )

    val imported = controller(root, filesDir, "importer").snapshot()
    val quarantined = jsonStrings(imported, "quarantinedHashes").toSet()

    assertEquals(20, quarantined.size)
    assertEquals(timestampedHashes.drop(2).toSet(), quarantined)
    assertFalse("d".repeat(64) in quarantined)
    assertFalse("c".repeat(64) in quarantined)
    assertFalse("e".repeat(64) in quarantined)
    assertFalse("f".repeat(64) in quarantined)
  }

  @Test
  fun `attempt ids are process scoped and health requires both hash and id`() {
    val root = tempFolder.newFolder("attempt-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    val firstProcess = controller(root, filesDir, "process-1")
    firstProcess.activateCandidate(hash, 2, "manual", 0.0)

    val first = firstProcess.selectForStartup()
    val duplicate = firstProcess.selectForStartup()
    assertEquals(first.attemptId, duplicate.attemptId)
    assertFalse(firstProcess.markHealthy(hash, "wrong-attempt"))
    assertFalse(firstProcess.markHealthy("a".repeat(64), first.attemptId!!))
    assertTrue(firstProcess.markHealthy(hash, first.attemptId!!))
    assertTrue(firstProcess.markHealthy(hash, first.attemptId!!))
    assertEquals("stable", firstProcess.snapshot().getString("phase"))
  }

  @Test
  fun `healthy bundle remains stable across launches and duplicate health revalidates current`() {
    val root = tempFolder.newFolder("healthy-stable-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    val controller = controller(root, filesDir, "first-process", ids = ids("attempt-1"))
    controller.activateCandidate(hash, 2, "manual", 0.0)
    val attempt = controller.selectForStartup()
    assertTrue(controller.markHealthy(hash, attempt.attemptId!!))

    val stableSelection = controller(root, filesDir, "next-process").selectForStartup()
    assertEquals(bundlePath(root, hash), stableSelection.bundlePath)
    assertNull(stableSelection.attemptId)
    val stableState = controller(root, filesDir, "stable-state").snapshot()
    assertEquals("stable", stableState.getString("phase"))
    assertFalse(stableState.has("candidateHash"))
    assertTrue(controller.markHealthy(hash, attempt.attemptId!!))

    val otherHash = writeBundle(root, "other")
    File(root, "current.json").writeText("""{"hash":"$otherHash"}""")
    assertFalse(controller.markHealthy(hash, attempt.attemptId!!))
  }

  @Test
  fun `health commit rejects missing bundle revoked candidate and stale binary identity`() {
    val missingRoot = tempFolder.newFolder("health-missing-root")
    val missingFilesDir = missingRoot.parentFile!!
    val missingHash = writeBundle(missingRoot, "candidate")
    val missing = controller(missingRoot, missingFilesDir, "process", ids = ids("attempt-missing"))
    missing.activateCandidate(missingHash, 2, "manual", 0.0)
    val missingAttempt = missing.selectForStartup()
    File(missingRoot, "bundles/$missingHash/main.jsbundle").delete()
    assertFalse(missing.markHealthy(missingHash, missingAttempt.attemptId!!))

    val revokedRoot = tempFolder.newFolder("health-revoked-root")
    val revokedFilesDir = revokedRoot.parentFile!!
    val revokedHash = writeBundle(revokedRoot, "candidate")
    val revoked = controller(revokedRoot, revokedFilesDir, "process", ids = ids("attempt-revoked"))
    revoked.activateCandidate(revokedHash, 2, "manual", 0.0)
    val revokedAttempt = revoked.selectForStartup()
    revoked.setRevokedHashes(setOf(revokedHash))
    assertFalse(revoked.markHealthy(revokedHash, revokedAttempt.attemptId!!))

    val identityRoot = tempFolder.newFolder("health-identity-root")
    val identityFilesDir = identityRoot.parentFile!!
    val identityHash = writeBundle(identityRoot, "candidate")
    val original = controller(identityRoot, identityFilesDir, "process", ids = ids("attempt-identity"))
    original.activateCandidate(identityHash, 2, "manual", 0.0)
    val identityAttempt = original.selectForStartup()
    assertFalse(
      controller(identityRoot, identityFilesDir, "new-binary", identity = "different-binary")
        .markHealthy(identityHash, identityAttempt.attemptId!!),
    )
  }

  @Test
  fun `unknown current pointer is passive-ineligible and fails startup closed`() {
    val root = tempFolder.newFolder("unknown-current-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "unproven")
    File(root, "current.json").writeText("""{"hash":"$hash"}""")
    val controller = controller(root, filesDir, "process")
    controller.snapshot()

    assertNull(controller.resolvePassive())
    assertTrue(File(root, "current.json").exists())
    assertNull(controller.selectForStartup().bundlePath)
    assertFalse(File(root, "current.json").exists())
  }

  @Test
  fun `same hash activation preserves stable state and an active attempt count`() {
    val root = tempFolder.newFolder("same-hash-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    val first = controller(root, filesDir, "first", ids = ids("attempt-1"))
    first.activateCandidate(hash, 3, "manual", 0.0)
    val firstAttempt = first.selectForStartup()
    assertTrue(first.markHealthy(hash, firstAttempt.attemptId!!))
    val stableRevision = first.snapshot().getLong("revision")

    first.activateCandidate(hash, 5, "auto", 9.0)
    assertEquals(stableRevision, first.snapshot().getLong("revision"))
    assertNull(controller(root, filesDir, "stable-launch").selectForStartup().attemptId)

    val nextHash = writeBundle(root, "next-candidate")
    first.activateCandidate(nextHash, 3, "manual", 0.0)
    first.selectForStartup()
    val retryProcess = controller(root, filesDir, "retry", ids = ids("attempt-2"))
    val retryAttempt = retryProcess.selectForStartup()
    val countBefore = retryProcess.snapshot().getJSONObject("activeAttempt")
      .getInt("unacknowledgedLaunchCount")

    retryProcess.activateCandidate(nextHash, 5, "manual", 4.0)

    val after = retryProcess.snapshot().getJSONObject("activeAttempt")
    assertEquals(retryAttempt.attemptId, after.getString("attemptId"))
    assertEquals(countBefore, after.getInt("unacknowledgedLaunchCount"))
    assertTrue(retryProcess.markHealthy(nextHash, retryAttempt.attemptId!!))
  }

  @Test
  fun `failed candidate recovers before React and preserves metadata for JS reconciliation`() {
    val root = tempFolder.newFolder("previous-root")
    val filesDir = root.parentFile!!
    val stableHash = writeBundle(root, "stable")
    val failedHash = writeBundle(root, "failed")
    val installer = controller(root, filesDir, "installer", ids = ids("stable-attempt", "event-1"))

    installer.activateCandidate(stableHash, 1, "manual", 0.0)
    val stableAttempt = installer.selectForStartup()
    assertTrue(installer.markHealthy(stableHash, stableAttempt.attemptId!!))
    installer.activateCandidate(failedHash, 1, "manual", 0.0)
    assertEquals(stableHash, pointerHash(root, "previous.json"))
    File(filesDir, "bundle-info.json").writeText("stale failed metadata")

    controller(root, filesDir, "bad-process", ids = ids("bad-attempt")).selectForStartup()
    val recovered = controller(root, filesDir, "recovery-process", ids = ids("recovery-event"))
      .selectForStartup()

    assertEquals(bundlePath(root, stableHash), recovered.bundlePath)
    assertEquals(stableHash, pointerHash(root, "current.json"))
    assertEquals("stale failed metadata", File(filesDir, "bundle-info.json").readText())
    val event = controller(root, filesDir, "snapshot").snapshot()
      .getJSONArray("pendingRecoveryEvents").getJSONObject(0)
    assertEquals(failedHash, event.getString("failedHash"))
    assertEquals("previous", event.getString("recoveryTarget"))
    assertEquals(stableHash, event.getString("recoveredHash"))
    assertEquals(1, event.getInt("crashCount"))
    assertEquals("crash_loop", event.getString("reason"))
    val eventId = event.getString("id")
    val acknowledger = controller(root, filesDir, "acknowledger")
    assertFalse(acknowledger.acknowledgeRecovery("unknown"))
    assertTrue(acknowledger.acknowledgeRecovery(eventId))
    assertEquals(0, acknowledger.snapshot().getJSONArray("pendingRecoveryEvents").length())
  }

  @Test
  fun `failed candidate falls back to embedded when no proven bundle exists`() {
    val root = tempFolder.newFolder("embedded-root")
    val filesDir = root.parentFile!!
    val failedHash = writeBundle(root, "failed")
    controller(root, filesDir, "installer").activateCandidate(failedHash, 1, "manual", 0.0)
    controller(root, filesDir, "bad-process").selectForStartup()

    val recovered = controller(root, filesDir, "recovery-process").selectForStartup()

    assertNull(recovered.bundlePath)
    assertFalse(File(root, "current.json").exists())
    val snapshot = controller(root, filesDir, "snapshot").snapshot()
    assertEquals(listOf(failedHash), jsonStrings(snapshot, "quarantinedHashes"))
    assertEquals(
      "embedded",
      snapshot.getJSONArray("pendingRecoveryEvents").getJSONObject(0).getString("recoveryTarget"),
    )
  }

  @Test
  fun `corrupt recovery ledger fails closed to embedded`() {
    val root = tempFolder.newFolder("corrupt-ledger-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    controller(root, filesDir, "installer").activateCandidate(hash, 2, "manual", 0.0)
    File(root, BundleDropStartupRecoveryController.RECOVERY_LEDGER).writeText("{\"revision\":")

    val selected = controller(root, filesDir, "startup").selectForStartup()

    assertNull(selected.bundlePath)
    assertNull(selected.attemptId)
    assertFalse(File(root, "current.json").exists())
    val snapshot = controller(root, filesDir, "snapshot").snapshot()
    assertEquals(listOf(hash), jsonStrings(snapshot, "quarantinedHashes"))
    assertEquals(0, snapshot.getJSONArray("pendingRecoveryEvents").length())
  }

  @Test
  fun `corrupt current pointer discards armed candidate without an attempt`() {
    val root = tempFolder.newFolder("corrupt-current-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    controller(root, filesDir, "installer").activateCandidate(hash, 2, "manual", 0.0)
    File(root, "current.json").writeText("{\"hash\":")

    val selected = controller(
      root,
      filesDir,
      process = "startup",
      ids = { throw AssertionError("Corrupt current pointer must not allocate an attempt") },
    ).selectForStartup()

    assertNull(selected.bundlePath)
    assertNull(selected.attemptId)
    assertFalse(File(root, "current.json").exists())
    assertEquals("idle", controller(root, filesDir, "snapshot").snapshot().getString("phase"))
  }

  @Test
  fun `corrupt previous pointer makes crash recovery fall back to embedded`() {
    val root = tempFolder.newFolder("corrupt-previous-root")
    val filesDir = root.parentFile!!
    val stableHash = writeBundle(root, "stable")
    val failedHash = writeBundle(root, "failed")
    val installer = controller(root, filesDir, "installer")
    installer.activateCandidate(stableHash, 1, "manual", 0.0)
    val stableAttempt = installer.selectForStartup()
    installer.markHealthy(stableHash, stableAttempt.attemptId!!)
    installer.activateCandidate(failedHash, 1, "manual", 0.0)
    controller(root, filesDir, "failed-launch").selectForStartup()
    File(root, "previous.json").writeText("{\"hash\":")

    val recovered = controller(root, filesDir, "recovery").selectForStartup()

    assertNull(recovered.bundlePath)
    assertFalse(File(root, "current.json").exists())
    val snapshot = controller(root, filesDir, "snapshot").snapshot()
    assertEquals(listOf(failedHash), jsonStrings(snapshot, "quarantinedHashes"))
    val event = snapshot.getJSONArray("pendingRecoveryEvents").getJSONObject(0)
    assertEquals(failedHash, event.getString("failedHash"))
    assertEquals("embedded", event.getString("recoveryTarget"))
    assertFalse(event.has("recoveredHash"))
  }

  @Test
  fun `candidate files removed after activation fail closed without an attempt`() {
    val root = tempFolder.newFolder("missing-candidate-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    controller(root, filesDir, "installer").activateCandidate(hash, 2, "manual", 0.0)
    File(root, "bundles/$hash/main.jsbundle").delete()

    val selected = controller(
      root,
      filesDir,
      process = "startup",
      ids = { throw AssertionError("Missing candidate files must not allocate an attempt") },
    ).selectForStartup()

    assertNull(selected.bundlePath)
    assertNull(selected.attemptId)
    assertFalse(File(root, "current.json").exists())
    assertEquals(JSONObject.NULL, controller(root, filesDir, "snapshot").snapshot().get("activeAttempt"))
  }

  @Test
  fun `passive resolution does not mutate a launching attempt`() {
    val root = tempFolder.newFolder("passive-launch-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    val controller = controller(root, filesDir, "launch-process", ids = ids("attempt-passive"))
    controller.activateCandidate(hash, 3, "manual", 0.0)
    val launching = controller.selectForStartup()
    val ledgerFile = File(root, BundleDropStartupRecoveryController.RECOVERY_LEDGER)
    val before = ledgerFile.readText()
    val beforeJson = JSONObject(before)

    assertEquals(bundlePath(root, hash), controller.resolvePassive())
    assertEquals(bundlePath(root, hash), controller.resolvePassive())

    val after = ledgerFile.readText()
    val afterJson = JSONObject(after)
    assertEquals(before, after)
    assertEquals(beforeJson.getLong("revision"), afterJson.getLong("revision"))
    assertEquals("launching", afterJson.getString("phase"))
    assertEquals(launching.attemptId, afterJson.getJSONObject("activeAttempt").getString("attemptId"))
    assertEquals("launch-process", afterJson.getJSONObject("activeAttempt").getString("processToken"))
    assertEquals(0, afterJson.getJSONObject("activeAttempt").getInt("unacknowledgedLaunchCount"))
  }

  @Test
  fun `zero crash limit never creates or retries health attempts`() {
    val root = tempFolder.newFolder("disabled-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    controller(root, filesDir, "installer").activateCandidate(hash, 0, "auto", 0.0)

    repeat(4) { index ->
      val selected = controller(root, filesDir, "process-$index").selectForStartup()
      assertEquals(bundlePath(root, hash), selected.bundlePath)
      assertNull(selected.attemptId)
    }
    assertEquals(JSONObject.NULL, controller(root, filesDir, "snapshot").snapshot().get("activeAttempt"))
  }

  @Test
  fun `binary identity mismatch clears OTA without trusting prior stable proof`() {
    val root = tempFolder.newFolder("binary-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    controller(root, filesDir, "old-process").activateCandidate(hash, 2, "manual", 0.0)

    val selected = controller(
      root,
      filesDir,
      process = "new-process",
      identity = "runtime:runtime-2|binary:2.0-2",
    ).selectForStartup()

    assertNull(selected.bundlePath)
    assertFalse(File(root, "current.json").exists())
  }

  @Test
  fun `activation rejects missing or mismatched embedded runtime identity`() {
    val root = tempFolder.newFolder("runtime-mismatch-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")

    assertThrows(IllegalArgumentException::class.java) {
      controller(root, filesDir, "missing-runtime", expectedRuntime = null)
        .activateCandidate(hash, 2, "manual", 0.0)
    }
    assertThrows(IllegalArgumentException::class.java) {
      controller(root, filesDir, "wrong-runtime", expectedRuntime = "runtime-2")
        .activateCandidate(hash, 2, "manual", 0.0)
    }
    assertFalse(File(root, "current.json").exists())
  }

  @Test
  fun `verification failpoint leaves no armed candidate and activation can retry`() {
    val root = tempFolder.newFolder("verification-failpoint-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    val interrupted = controller(root, filesDir, "installer", failpoint = { stage ->
      if (stage == BundleDropStartupRecoveryController.FAIL_AFTER_VERIFICATION) {
        throw SimulatedProcessDeath()
      }
    })

    try {
      interrupted.activateCandidate(hash, 2, "manual", 0.0)
      throw AssertionError("Expected simulated process death")
    } catch (_: SimulatedProcessDeath) {}

    val beforeRetry = controller(root, filesDir, "snapshot").snapshot()
    assertEquals("idle", beforeRetry.getString("phase"))
    assertFalse(beforeRetry.has("candidateHash"))
    assertFalse(File(root, "current.json").exists())

    controller(root, filesDir, "retry").activateCandidate(hash, 2, "manual", 0.0)
    assertEquals(hash, pointerHash(root, "current.json"))
  }

  @Test
  fun `launch persistence failpoint reuses the committed attempt in the same process`() {
    val root = tempFolder.newFolder("launch-failpoint-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    controller(root, filesDir, "installer", ids = ids("reserved-attempt"))
      .activateCandidate(hash, 2, "manual", 0.0)
    val interrupted = controller(root, filesDir, "launch-process", failpoint = { stage ->
      if (stage == BundleDropStartupRecoveryController.FAIL_AFTER_LAUNCH_PERSISTED) {
        throw SimulatedProcessDeath()
      }
    })

    try {
      interrupted.selectForStartup()
      throw AssertionError("Expected simulated process death")
    } catch (_: SimulatedProcessDeath) {}

    val retry = interrupted.selectForStartup()
    assertEquals("reserved-attempt", retry.attemptId)
    assertEquals(
      "reserved-attempt",
      interrupted.snapshot().getJSONObject("activeAttempt").getString("attemptId"),
    )
  }

  @Test
  fun `health commit failpoint leaves an idempotently healthy attempt`() {
    val root = tempFolder.newFolder("health-failpoint-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    val interrupted = controller(root, filesDir, "process", failpoint = { stage ->
      if (stage == BundleDropStartupRecoveryController.FAIL_AFTER_HEALTH_COMMITTED) {
        throw SimulatedProcessDeath()
      }
    })
    interrupted.activateCandidate(hash, 2, "manual", 0.0)
    val attempt = interrupted.selectForStartup()

    try {
      interrupted.markHealthy(hash, attempt.attemptId!!)
      throw AssertionError("Expected simulated process death")
    } catch (_: SimulatedProcessDeath) {}

    val retry = controller(root, filesDir, "retry")
    val committedRevision = retry.snapshot().getLong("revision")
    assertEquals("stable", retry.snapshot().getString("phase"))
    assertTrue(retry.markHealthy(hash, attempt.attemptId!!))
    assertEquals(committedRevision, retry.snapshot().getLong("revision"))
  }

  @Test
  fun `recovery transition resumes after a crash at rollback required failpoint`() {
    val root = tempFolder.newFolder("failpoint-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    controller(root, filesDir, "installer").activateCandidate(hash, 1, "manual", 0.0)
    controller(root, filesDir, "bad-process").selectForStartup()
    val crashing = controller(root, filesDir, "crashing-recovery", failpoint = { stage ->
      if (stage == BundleDropStartupRecoveryController.FAIL_AFTER_ROLLBACK_REQUIRED) {
        throw SimulatedProcessDeath()
      }
    })

    try {
      crashing.selectForStartup()
      throw AssertionError("Expected simulated process death")
    } catch (_: SimulatedProcessDeath) {}

    assertEquals(hash, pointerHash(root, "current.json"))
    assertEquals(
      listOf(hash),
      jsonStrings(controller(root, filesDir, "durability-snapshot").snapshot(), "quarantinedHashes"),
    )
    assertNull(controller(root, filesDir, "next-process").selectForStartup().bundlePath)
    val events = controller(root, filesDir, "snapshot").snapshot()
      .getJSONArray("pendingRecoveryEvents")
    assertEquals(1, events.length())
  }

  @Test
  fun `recovery resumes idempotently after previous fallback pointer is promoted`() {
    val root = tempFolder.newFolder("fallback-pointer-failpoint-root")
    val filesDir = root.parentFile!!
    val stableHash = writeBundle(root, "stable")
    val failedHash = writeBundle(root, "failed")
    val installer = controller(root, filesDir, "installer")
    installer.activateCandidate(stableHash, 1, "manual", 0.0)
    val stableAttempt = installer.selectForStartup()
    installer.markHealthy(stableHash, stableAttempt.attemptId!!)
    installer.activateCandidate(failedHash, 1, "manual", 0.0)
    controller(root, filesDir, "failed-launch").selectForStartup()
    val interrupted = controller(root, filesDir, "recovery", failpoint = { stage ->
      if (stage == BundleDropStartupRecoveryController.FAIL_AFTER_RECOVERY_POINTER) {
        throw SimulatedProcessDeath()
      }
    })

    try {
      interrupted.selectForStartup()
      throw AssertionError("Expected simulated process death")
    } catch (_: SimulatedProcessDeath) {}

    assertEquals(stableHash, pointerHash(root, "current.json"))
    assertFalse(File(root, "previous.json").exists())
    val resumed = controller(root, filesDir, "resumed-recovery").selectForStartup()
    assertEquals(bundlePath(root, stableHash), resumed.bundlePath)
    val snapshot = controller(root, filesDir, "snapshot").snapshot()
    assertEquals(listOf(failedHash), jsonStrings(snapshot, "quarantinedHashes"))
    assertEquals(1, snapshot.getJSONArray("pendingRecoveryEvents").length())
    assertEquals(
      "previous",
      snapshot.getJSONArray("pendingRecoveryEvents").getJSONObject(0).getString("recoveryTarget"),
    )
  }

  @Test
  fun `activation crash before pointer promotion leaves the current bundle unchanged`() {
    val root = tempFolder.newFolder("activation-failpoint-root")
    val filesDir = root.parentFile!!
    val stableHash = writeBundle(root, "stable")
    val candidateHash = writeBundle(root, "candidate")
    val stable = controller(root, filesDir, "stable-process")
    stable.activateCandidate(stableHash, 2, "manual", 0.0)
    val attempt = stable.selectForStartup()
    stable.markHealthy(stableHash, attempt.attemptId!!)
    val crashing = controller(root, filesDir, "installer", failpoint = { stage ->
      if (stage == BundleDropStartupRecoveryController.FAIL_AFTER_ARMED) {
        throw SimulatedProcessDeath()
      }
    })

    try {
      crashing.activateCandidate(candidateHash, 2, "manual", 0.0)
      throw AssertionError("Expected simulated process death")
    } catch (_: SimulatedProcessDeath) {}

    assertEquals(stableHash, pointerHash(root, "current.json"))
    val selected = controller(root, filesDir, "next-process").selectForStartup()
    assertEquals(bundlePath(root, stableHash), selected.bundlePath)
    assertNull(selected.attemptId)
    val snapshot = controller(root, filesDir, "snapshot").snapshot()
    assertEquals("stable", snapshot.getString("phase"))
    assertEquals(stableHash, snapshot.getString("candidateHash"))
    assertEquals(JSONObject.NULL, snapshot.get("activeAttempt"))
    assertTrue(snapshot.getLong("revision") > 0)
  }

  @Test
  fun `unpublished arm without a proven current pointer is discarded without an attempt`() {
    val root = tempFolder.newFolder("discarded-arm-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    val installer = controller(
      root,
      filesDir,
      process = "installer",
      ids = ids("reserved-but-unpublished"),
      failpoint = { stage ->
        if (stage == BundleDropStartupRecoveryController.FAIL_AFTER_ARMED) {
          throw SimulatedProcessDeath()
        }
      },
    )

    try {
      installer.activateCandidate(hash, 2, "manual", 0.0)
      throw AssertionError("Expected simulated process death")
    } catch (_: SimulatedProcessDeath) {}

    val selected = controller(
      root,
      filesDir,
      process = "first-startup",
      ids = { throw AssertionError("Discarding an unpublished arm must not allocate an attempt") },
    ).selectForStartup()
    assertNull(selected.bundlePath)
    assertNull(selected.attemptId)
    val snapshot = controller(root, filesDir, "snapshot").snapshot()
    assertEquals("idle", snapshot.getString("phase"))
    assertFalse(snapshot.has("candidateHash"))
    assertEquals(JSONObject.NULL, snapshot.get("activeAttempt"))
    val ledger = JSONObject(File(root, BundleDropStartupRecoveryController.RECOVERY_LEDGER).readText())
    assertFalse(ledger.has("reservedAttemptId"))
  }

  @Test
  fun `unpublished arm ignores an unproven mismatched current pointer`() {
    val root = tempFolder.newFolder("mismatched-arm-root")
    val filesDir = root.parentFile!!
    val candidateHash = writeBundle(root, "candidate")
    val unprovenHash = writeBundle(root, "unproven-current")
    val installer = controller(
      root,
      filesDir,
      process = "installer",
      failpoint = { stage ->
        if (stage == BundleDropStartupRecoveryController.FAIL_AFTER_ARMED) {
          throw SimulatedProcessDeath()
        }
      },
    )

    try {
      installer.activateCandidate(candidateHash, 2, "manual", 0.0)
      throw AssertionError("Expected simulated process death")
    } catch (_: SimulatedProcessDeath) {}
    File(root, "current.json").writeText("""{"hash":"$unprovenHash"}""")

    val selected = controller(
      root,
      filesDir,
      process = "first-startup",
      ids = { throw AssertionError("Discarding an unpublished arm must not allocate an attempt") },
    ).selectForStartup()
    assertNull(selected.bundlePath)
    assertNull(selected.attemptId)
    assertFalse(File(root, "current.json").exists())
    assertEquals("idle", controller(root, filesDir, "snapshot").snapshot().getString("phase"))
  }

  @Test
  fun `stale revision cannot overwrite a newer committed ledger`() {
    val root = tempFolder.newFolder("stale-revision-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    controller(root, filesDir, "seed").snapshot()
    val ledgerFile = File(root, BundleDropStartupRecoveryController.RECOVERY_LEDGER)
    var injectedRevision = -1L
    var injected = false
    val staleWriter = controller(
      root,
      filesDir,
      process = "stale-writer",
      failpoint = { stage ->
        if (stage == BundleDropStartupRecoveryController.FAIL_BEFORE_LEDGER_COMMIT && !injected) {
          injected = true
          val newer = JSONObject(ledgerFile.readText())
          injectedRevision = newer.getLong("revision") + 1
          newer.put("revision", injectedRevision)
          ledgerFile.writeText(newer.toString())
        }
      },
    )

    assertThrows(IllegalStateException::class.java) {
      staleWriter.activateCandidate(hash, 2, "manual", 0.0)
    }

    val committed = JSONObject(ledgerFile.readText())
    assertEquals(injectedRevision, committed.getLong("revision"))
    assertEquals("idle", committed.getString("phase"))
    assertFalse(File(root, "current.json").exists())
  }

  @Test
  fun `shared startup recovery contract fixture matches production Android snapshot`() {
    val workingDirectory = File(System.getProperty("user.dir"))
    val fixture = listOf(
      File(workingDirectory, "test-fixtures/startup-recovery-contract-v1.json"),
      File(workingDirectory.parentFile, "test-fixtures/startup-recovery-contract-v1.json"),
    ).firstOrNull(File::isFile) ?: throw AssertionError("Shared startup recovery fixture not found")
    val contract = JSONObject(fixture.readText())
    val root = tempFolder.newFolder("contract-root")
    val filesDir = root.parentFile!!
    val attempt = JSONObject(contract.getJSONObject("activeAttempt").toString())
      .put("processToken", "process-contract-v1")
    val ledger = JSONObject()
      .put("schemaVersion", BundleDropStartupRecoveryController.PROTOCOL_VERSION)
      .put("revision", contract.getLong("revision"))
      .put("binaryIdentity", binaryIdentity)
      .put("phase", contract.getString("phase"))
      .put("candidateHash", contract.getString("candidateHash"))
      .put("candidateRuntimeVersion", "runtime-1")
      .put("stableHash", contract.getString("stableHash"))
      .put("stableRuntimeVersion", "runtime-1")
      .put("policy", contract.getJSONObject("policy"))
      .put("activeAttempt", attempt)
      .put("quarantinedHashes", contract.getJSONArray("quarantinedHashes"))
      .put("revokedHashes", org.json.JSONArray())
      .put("pendingRecoveryEvents", contract.getJSONArray("pendingRecoveryEvents"))
      .put("legacyStateImported", true)
      .put("rollbackCrashCount", 0)
    File(root, BundleDropStartupRecoveryController.RECOVERY_LEDGER).writeText(ledger.toString())

    val snapshot = controller(
      root,
      filesDir,
      "process-contract-v1",
    ).snapshot()
    assertEquals(canonicalJson(contract), canonicalJson(snapshot))
  }

  @Test
  fun `automatic health waits for the configured content appeared grace period`() {
    val root = tempFolder.newFolder("content-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    val controller = controller(root, filesDir, "process")
    controller.activateCandidate(hash, 2, "auto", 2.0)
    controller.selectForStartup()

    controller.scheduleContentAppearedHealth(Handler(Looper.getMainLooper()))
    assertEquals("launching", controller.snapshot().getString("phase"))
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(2, TimeUnit.SECONDS)
    assertEquals("stable", controller.snapshot().getString("phase"))
  }

  @Test
  fun `content appeared schedules health only once per attempt id`() {
    val hash = "a".repeat(64)
    var schedules = 0

    assertTrue(BundleDropStartupRecovery.scheduleContentAppearedHealthOnce(hash, "attempt-dedupe") {
      schedules += 1
    })
    assertFalse(BundleDropStartupRecovery.scheduleContentAppearedHealthOnce(hash, "attempt-dedupe") {
      schedules += 1
    })
    assertTrue(BundleDropStartupRecovery.scheduleContentAppearedHealthOnce(hash, "attempt-newer") {
      schedules += 1
    })
    assertEquals(2, schedules)
  }

  @Test
  fun `production facade captures selected hash and fails ordinary exceptions closed`() {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    val hash = "a".repeat(64)
    val bundlePath = File(context.filesDir, "bundle-drop/bundles/$hash/main.jsbundle").absolutePath

    val selected = BundleDropStartupRecovery.selectForStartup(context) {
      BundleDropStartupRecoveryController.StartupSelection(bundlePath)
    }
    assertEquals(bundlePath, selected.bundlePath)
    assertEquals(hash, BundleDropStartupRecovery.startupSelectedHash())
    assertNull(BundleDropStartupRecovery.startupAttempt())

    val failedClosed = BundleDropStartupRecovery.selectForStartup(context) {
      throw IllegalStateException("storage unavailable")
    }
    assertNull(failedClosed.bundlePath)
    assertNull(BundleDropStartupRecovery.startupSelectedHash())
    assertNull(BundleDropStartupRecovery.startupAttempt())
  }

  @Test
  fun `revoked candidates recover offline without crash quarantine or telemetry`() {
    val root = tempFolder.newFolder("event-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    controller(root, filesDir, "installer").activateCandidate(hash, 2, "manual", 0.0)
    val controller = controller(root, filesDir, "revoker")
    assertTrue(controller.setRevokedHashes(setOf(hash)))
    val revisionAfterRevoke = controller.snapshot().getLong("revision")
    assertFalse(controller.setRevokedHashes(setOf(hash)))
    assertEquals(revisionAfterRevoke, controller.snapshot().getLong("revision"))
    assertNull(controller.selectForStartup().bundlePath)
    assertNull(controller.resolvePassive())

    val snapshot = controller.snapshot()
    assertEquals(0, snapshot.getJSONArray("pendingRecoveryEvents").length())
    assertEquals(0, snapshot.getJSONArray("quarantinedHashes").length())
    assertFalse(controller.acknowledgeRecovery("unknown"))
  }

  @Test
  fun `attempt id reserved by activation survives interruption before first startup selection`() {
    val root = tempFolder.newFolder("reserved-attempt-root")
    val filesDir = root.parentFile!!
    val hash = writeBundle(root, "candidate")
    val installer = controller(
      root,
      filesDir,
      process = "installer",
      ids = ids("reserved-first-attempt"),
      failpoint = { stage ->
        if (stage == BundleDropStartupRecoveryController.FAIL_AFTER_CURRENT_POINTER) {
          throw SimulatedProcessDeath()
        }
      },
    )

    try {
      installer.activateCandidate(hash, 2, "manual", 0.0)
      throw AssertionError("Expected simulated process death")
    } catch (_: SimulatedProcessDeath) {}

    val ledger = JSONObject(File(root, BundleDropStartupRecoveryController.RECOVERY_LEDGER).readText())
    assertEquals("reserved-first-attempt", ledger.getString("reservedAttemptId"))
    val selected = controller(root, filesDir, "first-startup", ids = ids("unexpected-id"))
      .selectForStartup()
    assertEquals("reserved-first-attempt", selected.attemptId)
    assertEquals(
      "reserved-first-attempt",
      controller(root, filesDir, "snapshot").snapshot()
        .getJSONObject("activeAttempt").getString("attemptId"),
    )
  }

  @Test
  fun `authoritative rollback selects only the prior proven healthy bundle without quarantine`() {
    val root = tempFolder.newFolder("authoritative-root")
    val filesDir = root.parentFile!!
    val firstHash = writeBundle(root, "first-stable")
    val secondHash = writeBundle(root, "second-stable")
    val controller = controller(root, filesDir, "process")

    controller.activateCandidate(firstHash, 2, "manual", 0.0)
    val firstAttempt = controller.selectForStartup()
    controller.markHealthy(firstHash, firstAttempt.attemptId!!)
    controller.activateCandidate(secondHash, 2, "manual", 0.0)
    val secondAttempt = controller.selectForStartup()
    controller.markHealthy(secondHash, secondAttempt.attemptId!!)

    val rollback = controller.rollbackStartupBundle(forceEmbedded = false)

    assertTrue(rollback.rolledBack)
    assertFalse(rollback.toEmbedded)
    assertEquals(firstHash, rollback.hash)
    assertEquals(firstHash, pointerHash(root, "current.json"))
    val snapshot = controller.snapshot()
    assertEquals(0, snapshot.getJSONArray("pendingRecoveryEvents").length())
    assertEquals(0, snapshot.getJSONArray("quarantinedHashes").length())

    val embedded = controller.rollbackStartupBundle(forceEmbedded = true)
    assertTrue(embedded.rolledBack)
    assertTrue(embedded.toEmbedded)
    assertNull(embedded.hash)
    assertFalse(File(root, "current.json").exists())

    val alreadyEmbedded = controller.rollbackStartupBundle(forceEmbedded = true)
    assertFalse(alreadyEmbedded.rolledBack)
    assertTrue(alreadyEmbedded.toEmbedded)
    assertNull(alreadyEmbedded.hash)
  }

  @Suppress("UNUSED_PARAMETER")
  private fun controller(
    root: File,
    filesDir: File,
    process: String,
    identity: String = binaryIdentity,
    expectedRuntime: String? = "runtime-1",
    now: Long = 1_700_000_000_000,
    ids: () -> String = { "id-${System.nanoTime()}" },
    failpoint: (String) -> Unit = {},
  ): BundleDropStartupRecoveryController = BundleDropStartupRecoveryController(
    bundleDropRoot = root,
    processToken = process,
    binaryIdentity = identity,
    expectedRuntimeVersion = expectedRuntime,
    nowMillis = { now },
    newId = ids,
    failpoint = failpoint,
  )

  private fun ids(vararg values: String): () -> String {
    val remaining = ArrayDeque(values.toList())
    return { remaining.removeFirstOrNull() ?: "id-${System.nanoTime()}" }
  }

  private fun pointerHash(root: File, name: String): String =
    JSONObject(File(root, name).readText()).getString("hash")

  private fun jsonStrings(json: JSONObject, key: String): List<String> {
    val array = json.getJSONArray(key)
    return (0 until array.length()).map(array::getString)
  }

  private fun canonicalJson(value: Any?): String = when (value) {
    is JSONObject -> value.keys().asSequence().toList().sorted()
      .joinToString(prefix = "{", postfix = "}") { key ->
        "${JSONObject.quote(key)}:${canonicalJson(value.get(key))}"
      }
    is org.json.JSONArray -> (0 until value.length())
      .joinToString(prefix = "[", postfix = "]") { index -> canonicalJson(value.get(index)) }
    JSONObject.NULL, null -> "null"
    is String -> JSONObject.quote(value)
    is Number, is Boolean -> value.toString()
    else -> JSONObject.quote(value.toString())
  }

  private fun bundlePath(root: File, hash: String): String =
    File(root, "bundles/$hash/main.jsbundle").absolutePath

  private fun writeBundle(root: File, bundleContent: String): String {
    val files = listOf(
      TestFile("main.jsbundle", "jsbundle", bundleContent),
      TestFile("metadata-android.json", "metadata", "{}"),
      TestFile("image-manifest.json", "androidImageManifest", "{}"),
    )
    val canonicalFiles = files.sortedBy { it.path }.joinToString(",", transform = ::fileJson)
    val hash = sha256("{\"files\":[$canonicalFiles],\"manifestVersion\":1}")
    val jsHash = files.first().sha256
    val manifestHash = sha256(
      "{\"bundleHash\":\"$hash\",\"files\":[$canonicalFiles],\"jsBundleHash\":\"$jsHash\",\"manifestVersion\":1,\"platform\":\"android\",\"runtimeVersion\":\"runtime-1\",\"version\":\"1.0.0\"}",
    )
    val bundleDir = File(root, "bundles/$hash").apply { mkdirs() }
    files.forEach { File(bundleDir, it.path).writeText(it.content) }
    File(bundleDir, "bundle-manifest.json").writeText(
      "{\"manifestVersion\":1,\"bundleHash\":\"$hash\",\"jsBundleHash\":\"$jsHash\",\"platform\":\"android\",\"runtimeVersion\":\"runtime-1\",\"version\":\"1.0.0\",\"manifestHash\":\"$manifestHash\",\"files\":[${files.joinToString(",", transform = ::fileJson)}]}",
    )
    return hash
  }

  private data class TestFile(val path: String, val role: String, val content: String) {
    val size = content.toByteArray(Charsets.UTF_8).size
    val sha256 = sha256(content)
  }

  private fun fileJson(file: TestFile): String =
    "{\"path\":\"${file.path}\",\"role\":\"${file.role}\",\"sha256\":\"${file.sha256}\",\"size\":${file.size}}"

  private class SimulatedProcessDeath : RuntimeException()

  companion object {
    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
      .digest(value.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
  }
}
