import Foundation

enum BundleDropStartupRecoveryError: LocalizedError {
  case invalidHash
  case invalidHealthCheckMode
  case invalidPolicy
  case candidateUnavailable
  case candidateIneligible
  case ledgerCorrupt
  case storageUnavailable
  case staleLedger

  var errorDescription: String? {
    switch self {
    case .invalidHash:
      return "Bundle Drop startup recovery received an invalid bundle hash"
    case .invalidHealthCheckMode:
      return "Bundle Drop startup recovery healthCheckMode must be auto or manual"
    case .invalidPolicy:
      return "Bundle Drop startup recovery policy must use a non-negative 32-bit integer maxCrashCount and a finite non-negative healthyAfterSec"
    case .candidateUnavailable:
      return "Bundle Drop startup recovery could not verify the candidate bundle"
    case .candidateIneligible:
      return "Bundle Drop startup recovery rejected a quarantined or revoked candidate"
    case .ledgerCorrupt:
      return "Bundle Drop startup recovery ledger is malformed or unsupported"
    case .storageUnavailable:
      return "Bundle Drop startup recovery storage is unavailable"
    case .staleLedger:
      return "Bundle Drop startup recovery rejected a stale ledger transition"
    }
  }
}

enum BundleDropStartupRecoveryPhase: String, Codable {
  case idle
  case armed
  case launching
  case stable
  case recovered
}

struct BundleDropStartupRecoveryPolicy: Codable, Equatable {
  let maxCrashCount: Int
  let healthCheckMode: String
  let healthyAfterSec: Double
}

struct BundleDropStartupRecoveryAttempt: Codable, Equatable {
  let hash: String
  let attemptId: String
  let processToken: String
  let startedAt: Int64
  var unacknowledgedLaunchCount: Int
  var contentAppeared: Bool
}

struct BundleDropStartupRecoveryTransition: Codable, Equatable {
  let kind: String
  let targetHash: String?
}

struct BundleDropStartupRecoveryEvent: Codable, Equatable {
  let id: String
  let failedHash: String
  let recoveryTarget: String
  let recoveredHash: String?
  let crashCount: Int
  let reason: String
  let failedAt: Int64
}

struct BundleDropStartupRecoveryLedger: Codable, Equatable {
  var schemaVersion = 1
  var revision = 0
  var binaryIdentity: String?
  var runtimeIdentity: String?
  var legacyFailuresImported: Bool?
  var phase = BundleDropStartupRecoveryPhase.idle
  var candidateHash: String?
  var stableHash: String?
  var previousStableHash: String?
  var lastHealthyAttemptId: String?
  var activeAttempt: BundleDropStartupRecoveryAttempt?
  var reservedAttemptId: String?
  var pendingTransition: BundleDropStartupRecoveryTransition?
  var policy: BundleDropStartupRecoveryPolicy?
  var quarantinedHashes: [String] = []
  var revokedHashes: [String] = []
  var pendingRecoveryEvents: [BundleDropStartupRecoveryEvent] = []
}

struct BundleDropStartupSelection: Equatable {
  let bundleURL: URL?
  let attemptHash: String?
  let attemptId: String?
}

struct BundleDropStartupActivationResult: Equatable {
  let hash: String
  let bundleURL: URL
}

struct BundleDropStartupRollbackResult: Equatable {
  let rolledBack: Bool
  let toEmbedded: Bool
  let hash: String?
}

/// Native-owned startup ledger. JavaScript may request transitions through the bridge,
/// but it never writes this file directly.
final class BundleDropStartupRecoveryController {
  static let protocolVersion = 1
  private static let ledgerCommitLock = NSLock()

  typealias Failpoint = (String) throws -> Void

  private let bundleDropRoot: URL
  private let expectedRuntimeVersion: String?
  private let expectedBinaryIdentity: String?
  private let processToken: String
  private let fileManager: FileManager
  private let now: () -> Int64
  private let makeId: () -> String
  private let failpoint: Failpoint?
  private let lock = NSRecursiveLock()

  private var ledgerURL: URL {
    bundleDropRoot.appendingPathComponent("recovery-ledger.json")
  }

  private var legacyStateURL: URL {
    bundleDropRoot.appendingPathComponent("state.json")
  }

  init(
    bundleDropRoot: URL,
    expectedRuntimeVersion: String?,
    expectedBinaryIdentity: String? = nil,
    processToken: String = UUID().uuidString.lowercased(),
    fileManager: FileManager = .default,
    now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970) },
    makeId: @escaping () -> String = { UUID().uuidString.lowercased() },
    failpoint: Failpoint? = nil
  ) {
    self.bundleDropRoot = bundleDropRoot
    self.expectedRuntimeVersion = expectedRuntimeVersion
    self.expectedBinaryIdentity = expectedBinaryIdentity
    self.processToken = processToken
    self.fileManager = fileManager
    self.now = now
    self.makeId = makeId
    self.failpoint = failpoint
  }

  func activateCandidate(
    hash: String,
    maxCrashCount: Int,
    healthCheckMode: String,
    healthyAfterSec: Double
  ) throws -> BundleDropStartupActivationResult {
    try withLock {
      guard hasExpectedIdentity else {
        throw BundleDropStartupRecoveryError.candidateUnavailable
      }
      guard Self.isCanonicalHash(hash) else {
        throw BundleDropStartupRecoveryError.invalidHash
      }
      guard healthCheckMode == "auto" || healthCheckMode == "manual" else {
        throw BundleDropStartupRecoveryError.invalidHealthCheckMode
      }
      guard maxCrashCount >= 0,
            maxCrashCount <= Int(Int32.max),
            healthyAfterSec.isFinite,
            healthyAfterSec >= 0 else {
        throw BundleDropStartupRecoveryError.invalidPolicy
      }
      guard let candidate = BundleDropOtaResolver.readBundle(
        hash: hash,
        bundleDropRoot: bundleDropRoot,
        expectedRuntimeVersion: expectedRuntimeVersion,
        fileManager: fileManager
      ) else {
        throw BundleDropStartupRecoveryError.candidateUnavailable
      }
      try failpoint?("afterCandidateVerified")

      var ledger = try readLedgerImportingLegacyState()
      if ledger.pendingTransition != nil {
        try completePendingTransition(ledger: &ledger)
      }
      guard !ledger.quarantinedHashes.contains(hash), !ledger.revokedHashes.contains(hash) else {
        throw BundleDropStartupRecoveryError.candidateIneligible
      }

      let current = BundleDropOtaResolver.readPointer(
        named: "current.json",
        bundleDropRoot: bundleDropRoot,
        expectedRuntimeVersion: expectedRuntimeVersion,
        fileManager: fileManager
      )
      let requestedPolicy = BundleDropStartupRecoveryPolicy(
        maxCrashCount: maxCrashCount,
        healthCheckMode: healthCheckMode,
        healthyAfterSec: healthyAfterSec
      )
      if current?.hash == hash,
         ledger.stableHash == hash,
         ledger.phase == .stable || ledger.phase == .recovered {
        return BundleDropStartupActivationResult(hash: hash, bundleURL: candidate.bundleURL)
      }
      if current?.hash == hash,
         ledger.candidateHash == hash,
         ledger.phase == .armed || ledger.phase == .launching {
        var changed = ledger.policy != requestedPolicy
        ledger.policy = requestedPolicy
        if requestedPolicy.maxCrashCount == 0 {
          changed = changed || ledger.phase != .armed || ledger.activeAttempt != nil || ledger.reservedAttemptId != nil
          ledger.phase = .armed
          ledger.activeAttempt = nil
          ledger.reservedAttemptId = nil
          ledger.lastHealthyAttemptId = nil
        } else if ledger.phase == .armed, ledger.reservedAttemptId == nil {
          ledger.reservedAttemptId = makeId()
          changed = true
        }
        if changed {
          try commit(&ledger)
        }
        return BundleDropStartupActivationResult(hash: hash, bundleURL: candidate.bundleURL)
      }

      let previousPointer = BundleDropOtaResolver.readPointer(
        named: "previous.json",
        bundleDropRoot: bundleDropRoot,
        expectedRuntimeVersion: expectedRuntimeVersion,
        fileManager: fileManager
      )
      let currentIsProvenStable = current?.hash == ledger.stableHash
      let previousIsProvenStable = previousPointer?.hash == ledger.stableHash
      let fallbackHash: String?
      if currentIsProvenStable, let currentHash = current?.hash {
        fallbackHash = currentHash
        try writePointer(named: "previous.json", hash: currentHash, failpointPrefix: "previous")
      } else if current?.hash == hash && previousIsProvenStable {
        // Transitional compatibility for a JS client that changed current.json first.
        fallbackHash = previousPointer?.hash
      } else {
        fallbackHash = nil
        try? BundleDropOtaResolver.deletePointer(
          named: "previous.json",
          bundleDropRoot: bundleDropRoot,
          fileManager: fileManager
        )
      }

      ledger.phase = .armed
      ledger.candidateHash = hash
      ledger.stableHash = fallbackHash
      ledger.previousStableHash = nil
      ledger.lastHealthyAttemptId = nil
      ledger.activeAttempt = nil
      ledger.policy = requestedPolicy
      ledger.reservedAttemptId = requestedPolicy.maxCrashCount > 0 ? makeId() : nil
      try commit(&ledger)
      try failpoint?("afterCandidateArmed")

      if current?.hash != hash {
        try writePointer(named: "current.json", hash: hash, failpointPrefix: "current")
      }
      return BundleDropStartupActivationResult(hash: hash, bundleURL: candidate.bundleURL)
    }
  }

  func selectStartupBundle(beginReload: Bool = false) -> BundleDropStartupSelection {
    withLock {
      guard hasExpectedIdentity else {
        return BundleDropStartupSelection(bundleURL: nil, attemptHash: nil, attemptId: nil)
      }
      do {
        var ledger = try readLedgerImportingLegacyState()
        if ledger.pendingTransition != nil {
          try completePendingTransition(ledger: &ledger)
        }
        guard let current = BundleDropOtaResolver.readPointer(
          named: "current.json",
          bundleDropRoot: bundleDropRoot,
          expectedRuntimeVersion: expectedRuntimeVersion,
          fileManager: fileManager
        ) else {
          if ledger.phase == .armed {
            let fallback = ledger.stableHash.flatMap { hash in
              verifiedPreviousPointer(hash: hash, ledger: ledger)
            }
            if let fallback {
              try writePointer(
                named: "current.json",
                hash: fallback.hash,
                failpointPrefix: "abortedActivationCurrent"
              )
            }
            ledger.phase = fallback == nil ? .idle : .stable
            ledger.candidateHash = nil
            ledger.stableHash = fallback?.hash
            ledger.previousStableHash = nil
            ledger.activeAttempt = nil
            ledger.reservedAttemptId = nil
            ledger.policy = nil
            try? BundleDropOtaResolver.deletePointer(
              named: "previous.json",
              bundleDropRoot: bundleDropRoot,
              fileManager: fileManager
            )
            try commit(&ledger)
            return BundleDropStartupSelection(
              bundleURL: fallback?.bundleURL,
              attemptHash: nil,
              attemptId: nil
            )
          }
          return BundleDropStartupSelection(bundleURL: nil, attemptHash: nil, attemptId: nil)
        }

        // Activation writes the ledger before publishing current.json. If the
        // process stops between those writes, abandon the unpublished candidate
        // and continue booting the previously proven bundle.
        if ledger.phase == .armed,
           ledger.candidateHash != current.hash,
           ledger.stableHash == current.hash {
          ledger.phase = .stable
          ledger.candidateHash = nil
          ledger.activeAttempt = nil
          ledger.reservedAttemptId = nil
          ledger.policy = nil
          try? BundleDropOtaResolver.deletePointer(
            named: "previous.json",
            bundleDropRoot: bundleDropRoot,
            fileManager: fileManager
          )
          try commit(&ledger)
          return BundleDropStartupSelection(bundleURL: current.bundleURL, attemptHash: nil, attemptId: nil)
        }

        if ledger.revokedHashes.contains(current.hash) || ledger.quarantinedHashes.contains(current.hash) {
          return try recover(
            failedHash: current.hash,
            crashCount: ledger.activeAttempt?.unacknowledgedLaunchCount ?? 0,
            quarantine: ledger.quarantinedHashes.contains(current.hash),
            emitEvent: false,
            ledger: &ledger
          )
        }

        if ledger.stableHash == current.hash,
           ledger.phase == .stable || ledger.phase == .recovered {
          return BundleDropStartupSelection(
            bundleURL: current.bundleURL,
            attemptHash: nil,
            attemptId: nil
          )
        }

        guard ledger.candidateHash == current.hash,
              ledger.phase == .armed || ledger.phase == .launching,
              let policy = ledger.policy else {
          // An OTA without native proof must never become startup-visible.
          try BundleDropOtaResolver.deletePointer(
            named: "current.json",
            bundleDropRoot: bundleDropRoot,
            fileManager: fileManager
          )
          return BundleDropStartupSelection(bundleURL: nil, attemptHash: nil, attemptId: nil)
        }

        // A zero limit explicitly disables launch-health classification. The
        // candidate remains ledger-tracked for integrity and revocation checks,
        // but it is never treated as health-proven or charged a failed attempt.
        if policy.maxCrashCount == 0 {
          return BundleDropStartupSelection(
            bundleURL: current.bundleURL,
            attemptHash: nil,
            attemptId: nil
          )
        }

        if !beginReload,
           ledger.activeAttempt?.processToken == processToken,
           ledger.activeAttempt?.hash == current.hash {
          return BundleDropStartupSelection(
            bundleURL: current.bundleURL,
            attemptHash: current.hash,
            attemptId: ledger.activeAttempt?.attemptId
          )
        }

        var unacknowledgedLaunchCount = ledger.activeAttempt?.unacknowledgedLaunchCount ?? 0
        if ledger.phase == .launching, !beginReload {
          unacknowledgedLaunchCount += 1
        }

        if policy.maxCrashCount > 0,
           unacknowledgedLaunchCount >= policy.maxCrashCount {
          return try recover(
            failedHash: current.hash,
            crashCount: unacknowledgedLaunchCount,
            quarantine: true,
            emitEvent: true,
            ledger: &ledger
          )
        }

        let attemptId = ledger.reservedAttemptId ?? makeId()
        ledger.phase = .launching
        ledger.reservedAttemptId = nil
        ledger.activeAttempt = BundleDropStartupRecoveryAttempt(
          hash: current.hash,
          attemptId: attemptId,
          processToken: processToken,
          startedAt: now(),
          unacknowledgedLaunchCount: unacknowledgedLaunchCount,
          contentAppeared: false
        )
        try commit(&ledger)
        try failpoint?("afterLaunchPersisted")
        return BundleDropStartupSelection(
          bundleURL: current.bundleURL,
          attemptHash: current.hash,
          attemptId: attemptId
        )
      } catch BundleDropStartupRecoveryError.ledgerCorrupt {
        return repairCorruptLedger()
      } catch {
        // Failing closed here prevents an untracked candidate from booting.
        return BundleDropStartupSelection(bundleURL: nil, attemptHash: nil, attemptId: nil)
      }
    }
  }

  func markContentAppeared(hash: String, attemptId: String) -> Double? {
    withLock {
      do {
        var ledger = try readLedgerImportingLegacyState()
        guard ledger.phase == .launching,
              ledger.candidateHash == hash,
              ledger.activeAttempt?.hash == hash,
              ledger.activeAttempt?.attemptId == attemptId,
              ledger.activeAttempt?.contentAppeared == false,
              ledger.policy?.healthCheckMode == "auto" else {
          return nil
        }
        ledger.activeAttempt?.contentAppeared = true
        try commit(&ledger)
        return ledger.policy?.healthyAfterSec ?? 0
      } catch {
        return nil
      }
    }
  }

  func markHealthy(hash: String, attemptId: String) -> Bool {
    withLock {
      do {
        var ledger = try readLedgerImportingLegacyState()
        guard isCurrentBundleEligible(hash: hash, ledger: ledger) else {
          return false
        }
        if ledger.phase == .stable,
           ledger.stableHash == hash,
           ledger.lastHealthyAttemptId == attemptId {
          return true
        }
        guard ledger.phase == .launching,
              ledger.candidateHash == hash,
              ledger.activeAttempt?.hash == hash,
              ledger.activeAttempt?.attemptId == attemptId else {
          return false
        }
        ledger.phase = .stable
        ledger.previousStableHash = ledger.stableHash
        ledger.stableHash = hash
        ledger.lastHealthyAttemptId = attemptId
        ledger.candidateHash = nil
        ledger.activeAttempt = nil
        ledger.reservedAttemptId = nil
        ledger.policy = nil
        try commit(&ledger)
        try failpoint?("afterHealthCommitted")
        return true
      } catch {
        return false
      }
    }
  }

  func passiveCurrentBundle() -> URL? {
    withLock {
      guard hasExpectedIdentity else { return nil }
      do {
        guard let current = BundleDropOtaResolver.readPointer(
          named: "current.json",
          bundleDropRoot: bundleDropRoot,
          expectedRuntimeVersion: expectedRuntimeVersion,
          fileManager: fileManager
        ), let ledger = try readLedgerFromDisk() else {
          return nil
        }
        guard ledger.binaryIdentity == expectedBinaryIdentity,
              ledger.runtimeIdentity == expectedRuntimeVersion,
              !ledger.revokedHashes.contains(current.hash),
              !ledger.quarantinedHashes.contains(current.hash) else {
          return nil
        }
        let isStable = ledger.stableHash == current.hash &&
          (ledger.phase == .stable || ledger.phase == .recovered)
        let isCandidate = ledger.candidateHash == current.hash &&
          (ledger.phase == .armed || ledger.phase == .launching) &&
          ledger.policy != nil
        return isStable || isCandidate ? current.bundleURL : nil
      } catch {
        return nil
      }
    }
  }

  func setRevokedHashes(_ hashes: [String]) throws {
    try withLock {
      guard hashes.allSatisfy(Self.isCanonicalHash) else {
        throw BundleDropStartupRecoveryError.invalidHash
      }
      var ledger = try readLedgerImportingLegacyState()
      let normalized = Array(Set(hashes)).sorted()
      guard normalized != ledger.revokedHashes else { return }
      ledger.revokedHashes = normalized
      try commit(&ledger)
    }
  }

  func acknowledgeRecovery(eventId: String) throws -> Bool {
    try withLock {
      var ledger = try readLedgerImportingLegacyState()
      let originalCount = ledger.pendingRecoveryEvents.count
      ledger.pendingRecoveryEvents.removeAll { $0.id == eventId }
      guard ledger.pendingRecoveryEvents.count != originalCount else { return false }
      try commit(&ledger)
      return true
    }
  }

  func rollback(forceEmbedded: Bool) throws -> BundleDropStartupRollbackResult {
    try withLock {
      var ledger = try readLedgerImportingLegacyState()
      let current = BundleDropOtaResolver.readPointer(
        named: "current.json",
        bundleDropRoot: bundleDropRoot,
        expectedRuntimeVersion: expectedRuntimeVersion,
        fileManager: fileManager
      )
      let fallbackHash = forceEmbedded ? nil : provenFallbackHash(
        failedHash: current?.hash,
        ledger: ledger
      )
      let fallback = fallbackHash.flatMap { hash in
        verifiedPreviousPointer(hash: hash, ledger: ledger)
      }

      ledger.phase = fallback == nil ? .idle : .stable
      ledger.candidateHash = nil
      ledger.previousStableHash = nil
      ledger.stableHash = fallback?.hash
      ledger.lastHealthyAttemptId = nil
      ledger.activeAttempt = nil
      ledger.reservedAttemptId = nil
      ledger.policy = nil
      ledger.pendingTransition = BundleDropStartupRecoveryTransition(
        kind: "rollback",
        targetHash: fallback?.hash
      )
      try commit(&ledger)
      try failpoint?("afterRollbackPrepared")
      try completePendingTransition(ledger: &ledger)
      return BundleDropStartupRollbackResult(
        rolledBack: current != nil,
        toEmbedded: fallback == nil,
        hash: fallback?.hash
      )
    }
  }

  func snapshot() throws -> [String: Any] {
    try withLock {
      let ledger = try readLedgerImportingLegacyState()
      var result: [String: Any] = [
        "protocolVersion": Self.protocolVersion,
        "revision": ledger.revision,
        "phase": ledger.phase.rawValue,
        "quarantinedHashes": ledger.quarantinedHashes.sorted(),
        "pendingRecoveryEvents": ledger.pendingRecoveryEvents.map(Self.eventDictionary),
      ]
      if let candidateHash = ledger.candidateHash {
        result["candidateHash"] = candidateHash
      }
      if let stableHash = ledger.stableHash {
        result["stableHash"] = stableHash
      }
      if let policy = ledger.policy {
        result["policy"] = [
          "maxCrashCount": policy.maxCrashCount,
          "healthCheckMode": policy.healthCheckMode,
          "healthyAfterSec": policy.healthyAfterSec,
        ]
      }
      if let attempt = ledger.activeAttempt, ledger.phase == .launching {
        result["activeAttempt"] = [
          "hash": attempt.hash,
          "attemptId": attempt.attemptId,
          "status": "launching",
          "unacknowledgedLaunchCount": attempt.unacknowledgedLaunchCount,
        ]
      } else {
        result["activeAttempt"] = NSNull()
      }
      return result
    }
  }

  private func recover(
    failedHash: String,
    crashCount: Int,
    quarantine: Bool,
    emitEvent: Bool,
    ledger: inout BundleDropStartupRecoveryLedger
  ) throws -> BundleDropStartupSelection {
    let fallbackHash = provenFallbackHash(failedHash: failedHash, ledger: ledger)
    let fallback = fallbackHash.flatMap { hash in
      verifiedPreviousPointer(hash: hash, ledger: ledger)
    }

    if quarantine {
      ledger.quarantinedHashes = Array(Set(ledger.quarantinedHashes + [failedHash])).sorted()
    }
    if emitEvent {
      ledger.pendingRecoveryEvents.append(BundleDropStartupRecoveryEvent(
        id: makeId(),
        failedHash: failedHash,
        recoveryTarget: fallback == nil ? "embedded" : "previous",
        recoveredHash: fallback?.hash,
        crashCount: crashCount,
        reason: "crash_loop",
        failedAt: now()
      ))
      if ledger.pendingRecoveryEvents.count > 20 {
        ledger.pendingRecoveryEvents.removeFirst(ledger.pendingRecoveryEvents.count - 20)
      }
    }

    ledger.phase = .recovered
    ledger.candidateHash = failedHash
    ledger.previousStableHash = nil
    ledger.stableHash = fallback?.hash
    ledger.lastHealthyAttemptId = nil
    ledger.activeAttempt = nil
    ledger.reservedAttemptId = nil
    ledger.policy = nil
    ledger.pendingTransition = BundleDropStartupRecoveryTransition(
      kind: "recovery",
      targetHash: fallback?.hash
    )
    try commit(&ledger)
    try failpoint?("afterRecoveryPrepared")
    try completePendingTransition(ledger: &ledger)
    return BundleDropStartupSelection(
      bundleURL: fallback?.bundleURL,
      attemptHash: nil,
      attemptId: nil
    )
  }

  private func completePendingTransition(
    ledger: inout BundleDropStartupRecoveryLedger
  ) throws {
    guard var transition = ledger.pendingTransition else { return }
    if let targetHash = transition.targetHash,
       !isPendingTransitionTargetEligible(targetHash, ledger: ledger) {
      transition = BundleDropStartupRecoveryTransition(
        kind: transition.kind,
        targetHash: nil
      )
      ledger.stableHash = nil
      ledger.previousStableHash = nil
      ledger.pendingTransition = transition
      if transition.kind == "recovery",
         let eventIndex = ledger.pendingRecoveryEvents.lastIndex(where: {
           $0.recoveryTarget == "previous" && $0.recoveredHash == targetHash
         }) {
        let event = ledger.pendingRecoveryEvents[eventIndex]
        ledger.pendingRecoveryEvents[eventIndex] = BundleDropStartupRecoveryEvent(
          id: event.id,
          failedHash: event.failedHash,
          recoveryTarget: "embedded",
          recoveredHash: nil,
          crashCount: event.crashCount,
          reason: event.reason,
          failedAt: event.failedAt
        )
      }
      // Persist the downgrade before touching pointers so another interruption
      // can only resume toward embedded, never toward the unavailable target.
      try commit(&ledger)
    }
    try applyPendingPointerTransition(transition)
    ledger.pendingTransition = nil
    try commit(&ledger)
  }

  private func applyPendingPointerTransition(
    _ transition: BundleDropStartupRecoveryTransition
  ) throws {
    guard transition.kind == "recovery" || transition.kind == "rollback" else {
      throw BundleDropStartupRecoveryError.ledgerCorrupt
    }
    let failpointPrefix = transition.kind == "recovery" ? "recoveryCurrent" : "rollbackCurrent"
    if let targetHash = transition.targetHash {
      guard BundleDropOtaResolver.readBundle(
        hash: targetHash,
        bundleDropRoot: bundleDropRoot,
        expectedRuntimeVersion: expectedRuntimeVersion,
        fileManager: fileManager
      ) != nil else {
        throw BundleDropStartupRecoveryError.candidateUnavailable
      }
      try writePointer(named: "current.json", hash: targetHash, failpointPrefix: failpointPrefix)
    } else {
      try deleteCurrentPointer(failpointPrefix: failpointPrefix)
    }
    try? BundleDropOtaResolver.deletePointer(
      named: "previous.json",
      bundleDropRoot: bundleDropRoot,
      fileManager: fileManager
    )
  }

  private func isPendingTransitionTargetEligible(
    _ hash: String,
    ledger: BundleDropStartupRecoveryLedger
  ) -> Bool {
    guard hasExpectedIdentity,
          ledger.binaryIdentity == expectedBinaryIdentity,
          ledger.runtimeIdentity == expectedRuntimeVersion,
          !ledger.quarantinedHashes.contains(hash),
          !ledger.revokedHashes.contains(hash) else {
      return false
    }
    return BundleDropOtaResolver.readBundle(
      hash: hash,
      bundleDropRoot: bundleDropRoot,
      expectedRuntimeVersion: expectedRuntimeVersion,
      fileManager: fileManager
    ) != nil
  }

  private func provenFallbackHash(
    failedHash: String?,
    ledger: BundleDropStartupRecoveryLedger
  ) -> String? {
    guard let failedHash else { return nil }
    if ledger.candidateHash == failedHash {
      return ledger.stableHash
    }
    if ledger.stableHash == failedHash {
      return ledger.previousStableHash
    }
    return nil
  }

  private func verifiedPreviousPointer(
    hash: String,
    ledger: BundleDropStartupRecoveryLedger
  ) -> BundleDropOtaPointer? {
    guard hasExpectedIdentity,
          !ledger.quarantinedHashes.contains(hash),
          !ledger.revokedHashes.contains(hash) else {
      return nil
    }
    let previous = BundleDropOtaResolver.readPointer(
      named: "previous.json",
      bundleDropRoot: bundleDropRoot,
      expectedRuntimeVersion: expectedRuntimeVersion,
      fileManager: fileManager
    )
    return previous?.hash == hash ? previous : nil
  }

  private func isCurrentBundleEligible(
    hash: String,
    ledger: BundleDropStartupRecoveryLedger
  ) -> Bool {
    guard hasExpectedIdentity,
          ledger.binaryIdentity == expectedBinaryIdentity,
          ledger.runtimeIdentity == expectedRuntimeVersion,
          !ledger.quarantinedHashes.contains(hash),
          !ledger.revokedHashes.contains(hash),
          let current = BundleDropOtaResolver.readPointer(
            named: "current.json",
            bundleDropRoot: bundleDropRoot,
            expectedRuntimeVersion: expectedRuntimeVersion,
            fileManager: fileManager
          ),
          current.hash == hash else {
      return false
    }
    return BundleDropOtaResolver.readBundle(
      hash: hash,
      bundleDropRoot: bundleDropRoot,
      expectedRuntimeVersion: expectedRuntimeVersion,
      fileManager: fileManager
    ) != nil
  }

  private func readLedgerImportingLegacyState() throws -> BundleDropStartupRecoveryLedger {
    var ledger = try readLedgerFromDisk() ?? BundleDropStartupRecoveryLedger()
    try bindLedgerToExpectedIdentity(&ledger)
    guard ledger.legacyFailuresImported != true else {
      return ledger
    }

    if fileManager.fileExists(atPath: legacyStateURL.path),
       let data = try? Data(contentsOf: legacyStateURL),
       let legacy = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let failedBundles = legacy["failedBundles"] as? [String: Any] {
      let imported = Self.newestLegacyFailureHashes(failedBundles)
      let merged = Array(Set(ledger.quarantinedHashes + imported)).sorted()
      ledger.quarantinedHashes = merged
    }
    ledger.legacyFailuresImported = true
    try commit(&ledger)
    return ledger
  }

  private var hasExpectedIdentity: Bool {
    expectedRuntimeVersion?.isEmpty == false && expectedBinaryIdentity?.isEmpty == false
  }

  private func bindLedgerToExpectedIdentity(
    _ ledger: inout BundleDropStartupRecoveryLedger
  ) throws {
    guard let runtimeIdentity = expectedRuntimeVersion,
          !runtimeIdentity.isEmpty,
          let binaryIdentity = expectedBinaryIdentity,
          !binaryIdentity.isEmpty else {
      throw BundleDropStartupRecoveryError.candidateUnavailable
    }
    guard ledger.runtimeIdentity != runtimeIdentity || ledger.binaryIdentity != binaryIdentity else {
      return
    }

    let previousRevision = ledger.revision
    ledger = BundleDropStartupRecoveryLedger()
    ledger.revision = previousRevision
    ledger.runtimeIdentity = runtimeIdentity
    ledger.binaryIdentity = binaryIdentity
    try BundleDropOtaResolver.deletePointer(
      named: "current.json",
      bundleDropRoot: bundleDropRoot,
      fileManager: fileManager
    )
    try BundleDropOtaResolver.deletePointer(
      named: "previous.json",
      bundleDropRoot: bundleDropRoot,
      fileManager: fileManager
    )
    try commit(&ledger)
  }

  private func readLedgerFromDisk() throws -> BundleDropStartupRecoveryLedger? {
    guard fileManager.fileExists(atPath: ledgerURL.path) else { return nil }
    do {
      let ledger = try JSONDecoder().decode(
        BundleDropStartupRecoveryLedger.self,
        from: Data(contentsOf: ledgerURL)
      )
      guard Self.isValid(ledger) else {
        throw BundleDropStartupRecoveryError.ledgerCorrupt
      }
      return ledger
    } catch let error as BundleDropStartupRecoveryError {
      throw error
    } catch {
      throw BundleDropStartupRecoveryError.ledgerCorrupt
    }
  }

  private func repairCorruptLedger() -> BundleDropStartupSelection {
    guard let runtimeIdentity = expectedRuntimeVersion,
          !runtimeIdentity.isEmpty,
          let binaryIdentity = expectedBinaryIdentity,
          !binaryIdentity.isEmpty else {
      return BundleDropStartupSelection(bundleURL: nil, attemptHash: nil, attemptId: nil)
    }

    let currentHash = BundleDropOtaResolver.readPointer(
      named: "current.json",
      bundleDropRoot: bundleDropRoot,
      expectedRuntimeVersion: expectedRuntimeVersion,
      fileManager: fileManager
    )?.hash
    var replacement = BundleDropStartupRecoveryLedger()
    replacement.revision = 1
    replacement.binaryIdentity = binaryIdentity
    replacement.runtimeIdentity = runtimeIdentity
    replacement.legacyFailuresImported = true
    replacement.phase = .recovered
    replacement.quarantinedHashes = currentHash.map { [$0] } ?? []

    do {
      Self.ledgerCommitLock.lock()
      defer { Self.ledgerCommitLock.unlock() }
      try writeLedgerAtomically(replacement)
      try BundleDropOtaResolver.deletePointer(
        named: "current.json",
        bundleDropRoot: bundleDropRoot,
        fileManager: fileManager
      )
      try BundleDropOtaResolver.deletePointer(
        named: "previous.json",
        bundleDropRoot: bundleDropRoot,
        fileManager: fileManager
      )
    } catch {
      // The caller still fails closed to embedded. A later launch can retry the
      // repair without trusting any health claim from the corrupt ledger.
    }
    return BundleDropStartupSelection(bundleURL: nil, attemptHash: nil, attemptId: nil)
  }

  private func commit(_ ledger: inout BundleDropStartupRecoveryLedger) throws {
    ledger.schemaVersion = Self.protocolVersion
    try fileManager.createDirectory(at: bundleDropRoot, withIntermediateDirectories: true)
    try failpoint?("beforeLedgerWrite")
    Self.ledgerCommitLock.lock()
    do {
      let persistedRevision = try readLedgerFromDisk()?.revision ?? 0
      guard persistedRevision == ledger.revision else {
        throw BundleDropStartupRecoveryError.staleLedger
      }
      ledger.revision += 1
    } catch {
      Self.ledgerCommitLock.unlock()
      throw error
    }
    do {
      try writeLedgerAtomically(ledger)
    } catch {
      Self.ledgerCommitLock.unlock()
      throw error
    }
    Self.ledgerCommitLock.unlock()
    try failpoint?("afterLedgerWrite")
  }

  private func writeLedgerAtomically(_ ledger: BundleDropStartupRecoveryLedger) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let temporaryURL = bundleDropRoot.appendingPathComponent(
      ".recovery-ledger-\(UUID().uuidString).tmp"
    )
    do {
      try encoder.encode(ledger).write(to: temporaryURL)
      let handle = try FileHandle(forWritingTo: temporaryURL)
      try handle.synchronize()
      try handle.close()
      if fileManager.fileExists(atPath: ledgerURL.path) {
        _ = try fileManager.replaceItemAt(ledgerURL, withItemAt: temporaryURL)
      } else {
        try fileManager.moveItem(at: temporaryURL, to: ledgerURL)
      }
    } catch {
      try? fileManager.removeItem(at: temporaryURL)
      throw error
    }
  }

  private func writePointer(named filename: String, hash: String, failpointPrefix: String) throws {
    try failpoint?("before\(failpointPrefix.prefix(1).uppercased())\(failpointPrefix.dropFirst())Write")
    try BundleDropOtaResolver.writePointer(
      named: filename,
      hash: hash,
      bundleDropRoot: bundleDropRoot,
      fileManager: fileManager
    )
    try failpoint?("after\(failpointPrefix.prefix(1).uppercased())\(failpointPrefix.dropFirst())Write")
  }

  private func deleteCurrentPointer(failpointPrefix: String) throws {
    try failpoint?("before\(failpointPrefix.prefix(1).uppercased())\(failpointPrefix.dropFirst())Delete")
    try BundleDropOtaResolver.deletePointer(
      named: "current.json",
      bundleDropRoot: bundleDropRoot,
      fileManager: fileManager
    )
    try failpoint?("after\(failpointPrefix.prefix(1).uppercased())\(failpointPrefix.dropFirst())Delete")
  }

  private func withLock<T>(_ operation: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try operation()
  }

  private static func isCanonicalHash(_ value: String) -> Bool {
    value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
  }

  private static func newestLegacyFailureHashes(
    _ failedBundles: [String: Any]
  ) -> [String] {
    failedBundles.compactMap { hash, value -> (hash: String, failedAt: Double?)? in
      guard isCanonicalHash(hash) else { return nil }
      let record = value as? [String: Any]
      let rawFailedAt = record?["failedAt"]
      let number = rawFailedAt is Bool ? nil : rawFailedAt as? NSNumber
      let failedAt = number?.doubleValue
      return (
        hash,
        failedAt.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
      )
    }
    .sorted { left, right in
      switch (left.failedAt, right.failedAt) {
      case let (leftDate?, rightDate?) where leftDate != rightDate:
        return leftDate > rightDate
      case (_?, nil):
        return true
      case (nil, _?):
        return false
      default:
        return left.hash < right.hash
      }
    }
    .prefix(20)
    .map(\.hash)
  }

  private static func isValid(_ ledger: BundleDropStartupRecoveryLedger) -> Bool {
    guard ledger.schemaVersion == protocolVersion,
          ledger.revision >= 0,
          ledger.binaryIdentity.map({ !$0.isEmpty }) ?? true,
          ledger.runtimeIdentity.map({ !$0.isEmpty }) ?? true,
          [ledger.candidateHash, ledger.stableHash, ledger.previousStableHash]
            .compactMap({ $0 })
            .allSatisfy(isCanonicalHash),
          ledger.quarantinedHashes.allSatisfy(isCanonicalHash),
          ledger.revokedHashes.allSatisfy(isCanonicalHash),
          Set(ledger.quarantinedHashes).count == ledger.quarantinedHashes.count,
          Set(ledger.revokedHashes).count == ledger.revokedHashes.count else {
      return false
    }
    if let policy = ledger.policy,
       policy.maxCrashCount < 0 ||
       !policy.healthyAfterSec.isFinite ||
       policy.healthyAfterSec < 0 ||
       (policy.healthCheckMode != "auto" && policy.healthCheckMode != "manual") {
      return false
    }
    if let attempt = ledger.activeAttempt,
       !isCanonicalHash(attempt.hash) ||
       attempt.attemptId.isEmpty ||
       attempt.processToken.isEmpty ||
       attempt.unacknowledgedLaunchCount < 0 {
      return false
    }
    if let reservedAttemptId = ledger.reservedAttemptId, reservedAttemptId.isEmpty {
      return false
    }
    if let lastHealthyAttemptId = ledger.lastHealthyAttemptId, lastHealthyAttemptId.isEmpty {
      return false
    }
    if let transition = ledger.pendingTransition,
       (transition.kind != "recovery" && transition.kind != "rollback") ||
       (transition.targetHash != nil && !isCanonicalHash(transition.targetHash!)) {
      return false
    }
    return ledger.pendingRecoveryEvents.allSatisfy { event in
      !event.id.isEmpty &&
        isCanonicalHash(event.failedHash) &&
        event.crashCount >= 0 &&
        event.failedAt >= 0 &&
        event.reason == "crash_loop" &&
        ((event.recoveryTarget == "embedded" && event.recoveredHash == nil) ||
          (event.recoveryTarget == "previous" &&
            event.recoveredHash.map(isCanonicalHash) == true))
    }
  }

  private static func eventDictionary(_ event: BundleDropStartupRecoveryEvent) -> [String: Any] {
    var result: [String: Any] = [
      "id": event.id,
      "failedHash": event.failedHash,
      "recoveryTarget": event.recoveryTarget,
      "crashCount": event.crashCount,
      "reason": event.reason,
      "failedAt": event.failedAt,
    ]
    if let recoveredHash = event.recoveredHash {
      result["recoveredHash"] = recoveredHash
    }
    return result
  }
}
