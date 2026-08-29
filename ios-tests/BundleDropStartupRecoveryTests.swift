import CryptoKit
import XCTest
@testable import BundleDropIOSCore

final class BundleDropStartupRecoveryTests: XCTestCase {
  func testActivationRejectsInvalidPolicyInsteadOfClampingIt() throws {
    let candidate = try makeBundle(contents: "invalid-policy")
    let controller = makeController()

    for maxCrashCount in [-1, Int(Int32.max) + 1] {
      XCTAssertThrowsError(try controller.activateCandidate(
        hash: candidate.hash,
        maxCrashCount: maxCrashCount,
        healthCheckMode: "auto",
        healthyAfterSec: 0
      ))
    }
    for healthyAfterSec in [-1.0, Double.infinity, Double.nan] {
      XCTAssertThrowsError(try controller.activateCandidate(
        hash: candidate.hash,
        maxCrashCount: 1,
        healthCheckMode: "auto",
        healthyAfterSec: healthyAfterSec
      ))
    }
  }

  private var tempRoot: URL!
  private let runtimeVersion = "1.0.0"

  override func setUpWithError() throws {
    tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("BundleDropStartupRecoveryTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    if let tempRoot {
      try? FileManager.default.removeItem(at: tempRoot)
    }
    tempRoot = nil
  }

  func testActivationArmsLedgerBeforePublishingCurrentPointer() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    var observedFailpoints: [String] = []
    let controller = makeController(failpoint: { name in
      observedFailpoints.append(name)
      if name == "afterCandidateArmed" { throw TestError.interrupted }
    })

    XCTAssertThrowsError(try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    ))

    XCTAssertEqual(readPointer("current.json")?.hash, stable.hash)
    let ledger = try readLedger()
    XCTAssertEqual(ledger.phase, .armed)
    XCTAssertEqual(ledger.candidateHash, candidate.hash)
    XCTAssertEqual(ledger.stableHash, stable.hash)
    XCTAssertTrue(observedFailpoints.contains("afterLedgerWrite"))
    XCTAssertTrue(observedFailpoints.contains("afterCandidateArmed"))

    let nextLaunch = makeController().selectStartupBundle()
    XCTAssertEqual(nextLaunch.bundleURL, stable.bundleURL)
    XCTAssertEqual(try readLedger().phase, .stable)
    XCTAssertNil(try readLedger().candidateHash)
  }

  func testCandidateVerificationFailpointPrecedesAnyArmSideEffect() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(failpoint: { name in
      if name == "afterCandidateVerified" { throw TestError.interrupted }
    })

    XCTAssertThrowsError(try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    ))

    XCTAssertNil(readPointer("current.json"))
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: tempRoot.appendingPathComponent("recovery-ledger.json").path
    ))
  }

  func testCrashLoopReusesAttemptWithinProcessThenRecoversPreviousBundle() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    let controller = makeController(ids: ["attempt-1"], processToken: "process-1")
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )

    let first = controller.selectStartupBundle()
    XCTAssertEqual(first.attemptId, "attempt-1")
    let revisionAfterFirstLaunch = try readLedger().revision

    let sameProcess = controller.selectStartupBundle()
    XCTAssertEqual(sameProcess, first)
    XCTAssertEqual(try readLedger().revision, revisionAfterFirstLaunch)

    let secondLaunch = makeController(
      ids: ["attempt-2"],
      processToken: "process-2"
    ).selectStartupBundle()
    XCTAssertEqual(secondLaunch.attemptId, "attempt-2")
    XCTAssertEqual(try readLedger().activeAttempt?.unacknowledgedLaunchCount, 1)

    let recovered = makeController(
      ids: ["event-1"],
      processToken: "process-3"
    ).selectStartupBundle()
    XCTAssertEqual(recovered.bundleURL, stable.bundleURL)
    XCTAssertNil(recovered.attemptId)
    XCTAssertEqual(readPointer("current.json")?.hash, stable.hash)

    let ledger = try readLedger()
    XCTAssertEqual(ledger.phase, .recovered)
    XCTAssertEqual(ledger.quarantinedHashes, [candidate.hash])
    XCTAssertEqual(ledger.pendingRecoveryEvents, [
      BundleDropStartupRecoveryEvent(
        id: "event-1",
        failedHash: candidate.hash,
        recoveryTarget: "previous",
        recoveredHash: stable.hash,
        crashCount: 2,
        reason: "crash_loop",
        failedAt: 1_700_000_000
      ),
    ])

    let recoveredRevision = ledger.revision
    _ = try controller.activateCandidate(
      hash: stable.hash,
      maxCrashCount: 3,
      healthCheckMode: "manual",
      healthyAfterSec: 5
    )
    XCTAssertEqual(try readLedger().revision, recoveredRevision)
    XCTAssertEqual(try readLedger().phase, .recovered)
    XCTAssertNil(controller.selectStartupBundle().attemptId)
  }

  func testActivationReservesTheFirstAttemptIdBeforePublishingCandidate() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(ids: ["reserved-at-activation"])

    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )

    let armed = try readLedger()
    XCTAssertEqual(armed.phase, .armed)
    XCTAssertEqual(armed.runtimeIdentity, runtimeVersion)
    XCTAssertEqual(armed.binaryIdentity, "binary-1")
    XCTAssertEqual(armed.reservedAttemptId, "reserved-at-activation")
    XCTAssertNil(armed.activeAttempt)

    let firstLaunch = makeController(ids: ["must-not-be-used"]).selectStartupBundle()
    XCTAssertEqual(firstLaunch.attemptId, "reserved-at-activation")
    XCTAssertNil(try readLedger().reservedAttemptId)
    XCTAssertEqual(try readLedger().activeAttempt?.attemptId, "reserved-at-activation")
  }

  func testMissingCurrentPointerDiscardsUnpublishedArmWithoutAttempt() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(ids: ["reserved-at-activation"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    try BundleDropOtaResolver.deletePointer(
      named: "current.json",
      bundleDropRoot: tempRoot
    )

    let selection = controller.selectStartupBundle()

    XCTAssertNil(selection.bundleURL)
    XCTAssertNil(selection.attemptId)
    let ledger = try readLedger()
    XCTAssertEqual(ledger.phase, .idle)
    XCTAssertNil(ledger.candidateHash)
    XCTAssertNil(ledger.reservedAttemptId)
    XCTAssertNil(ledger.activeAttempt)
  }

  func testStartupFinalizesPendingEmbeddedRecoveryAfterPointerDeletion() throws {
    let candidate = try makeBundle(contents: "candidate")
    let firstLaunch = makeController(
      ids: ["attempt-1"],
      processToken: "process-1"
    )
    _ = try firstLaunch.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 1,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    _ = firstLaunch.selectStartupBundle()
    let interrupted = makeController(
      ids: ["event-1"],
      processToken: "process-2",
      failpoint: { name in
        if name == "afterRecoveryCurrentDelete" { throw TestError.interrupted }
      }
    )
    XCTAssertNil(interrupted.selectStartupBundle().bundleURL)
    XCTAssertNil(readPointer("current.json"))
    XCTAssertEqual(try readLedger().pendingTransition?.kind, "recovery")

    let nextLaunch = makeController().selectStartupBundle()

    XCTAssertNil(nextLaunch.bundleURL)
    XCTAssertNil(try readLedger().pendingTransition)
    XCTAssertEqual(try readLedger().pendingRecoveryEvents.map(\.id), ["event-1"])
  }

  func testManualHealthRequiresExactAttemptAndPreservesPreviousProof() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    let controller = makeController(ids: ["attempt-1"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 30
    )
    let attempt = controller.selectStartupBundle()

    let revisionBeforeContent = try readLedger().revision
    XCTAssertNil(controller.markContentAppeared(hash: candidate.hash, attemptId: attempt.attemptId!))
    XCTAssertEqual(try readLedger().revision, revisionBeforeContent)
    XCTAssertFalse(try XCTUnwrap(readLedger().activeAttempt).contentAppeared)
    XCTAssertFalse(controller.markHealthy(hash: stable.hash, attemptId: attempt.attemptId!))
    XCTAssertFalse(controller.markHealthy(hash: candidate.hash, attemptId: "wrong-attempt"))
    XCTAssertTrue(controller.markHealthy(hash: candidate.hash, attemptId: attempt.attemptId!))

    let ledger = try readLedger()
    XCTAssertEqual(ledger.phase, .stable)
    XCTAssertEqual(ledger.stableHash, candidate.hash)
    XCTAssertEqual(ledger.previousStableHash, stable.hash)
    XCTAssertNil(ledger.activeAttempt)
  }

  func testAutoContentAppearanceReturnsConfiguredHealthDelay() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(ids: ["attempt-1"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 1,
      healthCheckMode: "auto",
      healthyAfterSec: 12.5
    )
    let attempt = controller.selectStartupBundle()

    XCTAssertEqual(
      controller.markContentAppeared(hash: candidate.hash, attemptId: attempt.attemptId!),
      12.5
    )
    let revisionAfterContent = try readLedger().revision
    XCTAssertTrue(try XCTUnwrap(readLedger().activeAttempt).contentAppeared)
    XCTAssertNil(controller.markContentAppeared(hash: candidate.hash, attemptId: attempt.attemptId!))
    XCTAssertEqual(try readLedger().revision, revisionAfterContent)
  }

  func testZeroCrashLimitDisablesAutomaticRecovery() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController()
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 0,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )

    for _ in 0..<6 {
      XCTAssertEqual(controller.selectStartupBundle().bundleURL, candidate.bundleURL)
    }

    let ledger = try readLedger()
    XCTAssertEqual(ledger.phase, .armed)
    XCTAssertNil(ledger.activeAttempt)
    XCTAssertTrue(ledger.quarantinedHashes.isEmpty)
    XCTAssertTrue(ledger.pendingRecoveryEvents.isEmpty)
  }

  func testHealthyMarkIsIdempotentOnlyForExactStableAttempt() throws {
    let first = try makeBundle(contents: "first")
    let second = try makeBundle(contents: "second")
    let controller = makeController(ids: ["first-attempt", "second-attempt"])
    _ = try controller.activateCandidate(
      hash: first.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )
    let firstLaunch = controller.selectStartupBundle()
    XCTAssertTrue(controller.markHealthy(hash: first.hash, attemptId: firstLaunch.attemptId!))
    let stableRevision = try readLedger().revision

    XCTAssertTrue(controller.markHealthy(hash: first.hash, attemptId: firstLaunch.attemptId!))
    XCTAssertEqual(try readLedger().revision, stableRevision)
    XCTAssertFalse(controller.markHealthy(hash: first.hash, attemptId: "different-attempt"))

    _ = try controller.activateCandidate(
      hash: second.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )
    XCTAssertFalse(controller.markHealthy(hash: first.hash, attemptId: firstLaunch.attemptId!))
    XCTAssertFalse(controller.markHealthy(hash: second.hash, attemptId: firstLaunch.attemptId!))
    XCTAssertNil(try readLedger().lastHealthyAttemptId)
  }

  func testHealthyMarkRevalidatesFilesRevocationAndBinaryIdentity() throws {
    let missing = try makeBundle(contents: "missing")
    let controller = makeController(ids: ["missing-attempt", "revoked-attempt", "identity-attempt"])
    _ = try controller.activateCandidate(
      hash: missing.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )
    let missingAttempt = controller.selectStartupBundle()
    try FileManager.default.removeItem(at: missing.bundleURL)
    XCTAssertFalse(controller.markHealthy(hash: missing.hash, attemptId: missingAttempt.attemptId!))

    let revoked = try makeBundle(contents: "revoked")
    _ = try controller.activateCandidate(
      hash: revoked.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )
    let revokedAttempt = controller.selectStartupBundle()
    XCTAssertTrue(try controller.setRevokedHashes([revoked.hash]))
    XCTAssertFalse(controller.markHealthy(hash: revoked.hash, attemptId: revokedAttempt.attemptId!))

    XCTAssertTrue(try controller.setRevokedHashes([]))
    let identity = try makeBundle(contents: "identity")
    _ = try controller.activateCandidate(
      hash: identity.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )
    let identityAttempt = controller.selectStartupBundle()
    XCTAssertFalse(
      makeController(binaryIdentity: "binary-2")
        .markHealthy(hash: identity.hash, attemptId: identityAttempt.attemptId!)
    )
  }

  func testAdapterCapturesSelectedHashIndependentlyOfAttemptIdentity() {
    let stableHash = String(repeating: "a", count: 64)
    let stableURL = tempRoot
      .appendingPathComponent("bundles/\(stableHash)")
      .appendingPathComponent("main.jsbundle")
    BundleDropStartupRecoveryAdapter.captureStartupSelection(BundleDropStartupSelection(
      bundleURL: stableURL,
      attemptHash: nil,
      attemptId: nil
    ))

    XCTAssertEqual(BundleDropStartupRecoveryAdapter.capturedSelectedHash(), stableHash)
    XCTAssertNil(BundleDropStartupRecoveryAdapter.capturedAttempt().attemptId)

    BundleDropStartupRecoveryAdapter.clearCapturedSelection()
    XCTAssertNil(BundleDropStartupRecoveryAdapter.capturedSelectedHash())
  }

  func testSameProcessReloadStartsNewAttemptWithoutChargingCrash() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(ids: ["attempt-1", "attempt-reload"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 1,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    _ = controller.selectStartupBundle()

    let reload = controller.selectStartupBundle(beginReload: true)

    XCTAssertEqual(reload.attemptId, "attempt-reload")
    XCTAssertEqual(try readLedger().activeAttempt?.unacknowledgedLaunchCount, 0)
    XCTAssertTrue(try readLedger().pendingRecoveryEvents.isEmpty)
  }

  func testSameProcessResolutionReusesAttemptWithoutVolatileAdapterState() throws {
    let candidate = try makeBundle(contents: "candidate")
    let firstController = makeController(ids: ["attempt-1"], processToken: "same-process")
    _ = try firstController.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 1,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )
    let first = firstController.selectStartupBundle()
    let revision = try readLedger().revision

    // A new controller mirrors losing the adapter's volatile capture while the
    // native process itself is still alive.
    let repeated = makeController(processToken: "same-process").selectStartupBundle()

    XCTAssertEqual(repeated, first)
    XCTAssertEqual(try readLedger().revision, revision)
    XCTAssertEqual(try readLedger().activeAttempt?.unacknowledgedLaunchCount, 0)
  }

  func testContentRootRemainsBoundToItsOriginalReloadAttempt() {
    final class TestRoot {}
    let bindings = BundleDropStartupContentBindings()
    let oldRoot = TestRoot()
    let newRoot = TestRoot()
    let oldHash = String(repeating: "a", count: 64)
    let newHash = String(repeating: "b", count: 64)
    let oldURL = URL(fileURLWithPath: "/tmp/bundle-old/main.jsbundle")
    let newURL = URL(fileURLWithPath: "/tmp/bundle-new/main.jsbundle")
    let unrelatedURL = URL(fileURLWithPath: "/tmp/unrelated/main.jsbundle")

    bindings.capture(hash: oldHash, attemptId: "attempt-old", bundleURL: oldURL)
    bindings.runtimeDidLoad(bundleURL: oldURL)
    let oldBinding = bindings.binding(for: oldRoot)
    bindings.capture(hash: newHash, attemptId: "attempt-new", bundleURL: newURL)

    XCTAssertEqual(bindings.binding(for: oldRoot), oldBinding)
    XCTAssertNil(bindings.binding(for: newRoot))
    bindings.runtimeDidLoad(bundleURL: unrelatedURL)
    XCTAssertNil(bindings.binding(for: newRoot))
    bindings.runtimeDidLoad(bundleURL: newURL)
    XCTAssertEqual(bindings.binding(for: newRoot), .init(
      generation: 2,
      hash: newHash,
      attemptId: "attempt-new",
      bundlePath: newURL.path
    ))
    XCTAssertEqual(bindings.binding(for: oldRoot), .init(
      generation: 2,
      hash: newHash,
      attemptId: "attempt-new",
      bundlePath: newURL.path
    ))
  }

  func testRuntimeLoadUsesTheBridgeBundleURLAndRejectsUnrelatedProviders() {
    final class TestBridge: NSObject {
      @objc let bundleURL: URL

      init(bundleURL: URL) {
        self.bundleURL = bundleURL
      }
    }
    let selectedURL = URL(fileURLWithPath: "/tmp/selected/main.jsbundle")
    let bridge = TestBridge(bundleURL: selectedURL)
    let notification = Notification(
      name: Notification.Name("RCTJavaScriptDidLoadNotification"),
      object: NSObject(),
      userInfo: ["bridge": bridge]
    )

    XCTAssertEqual(BundleDropStartupRecoveryAdapter.bundleURL(from: notification), selectedURL)
    XCTAssertNil(BundleDropStartupRecoveryAdapter.bundleURL(from: Notification(
      name: Notification.Name("RCTJavaScriptDidLoadNotification"),
      object: NSObject()
    )))
  }

  func testRuntimeLoadReadsBundleURLImplementedByAProxyThatDeniesRespondsCheck() {
    final class ProxyLikeBridge: NSObject {
      @objc let bundleURL: URL

      init(bundleURL: URL) {
        self.bundleURL = bundleURL
      }

      override func responds(to selector: Selector!) -> Bool {
        selector == NSSelectorFromString("bundleURL") ? false : super.responds(to: selector)
      }
    }
    let selectedURL = URL(fileURLWithPath: "/tmp/selected/main.jsbundle")
    let notification = Notification(
      name: Notification.Name("RCTJavaScriptDidLoadNotification"),
      userInfo: ["bridge": ProxyLikeBridge(bundleURL: selectedURL)]
    )

    XCTAssertEqual(BundleDropStartupRecoveryAdapter.bundleURL(from: notification), selectedURL)
  }

  func testLaunchPersistedFailpointLeavesDurableUnfinishedAttempt() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(
      ids: ["attempt-1"],
      failpoint: { name in
        if name == "afterLaunchPersisted" { throw TestError.interrupted }
      }
    )
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )

    XCTAssertNil(controller.selectStartupBundle().bundleURL)
    XCTAssertEqual(try readLedger().phase, .launching)
    XCTAssertEqual(try readLedger().activeAttempt?.attemptId, "attempt-1")
  }

  func testHealthCommitFailpointCanRetryAsIdempotentSuccess() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(
      ids: ["attempt-1"],
      failpoint: { name in
        if name == "afterHealthCommitted" { throw TestError.interrupted }
      }
    )
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )
    let attempt = controller.selectStartupBundle()

    XCTAssertFalse(controller.markHealthy(hash: candidate.hash, attemptId: attempt.attemptId!))
    XCTAssertEqual(try readLedger().phase, .stable)
    XCTAssertTrue(controller.markHealthy(hash: candidate.hash, attemptId: attempt.attemptId!))
  }

  func testRollbackUsesLedgerProvenPreviousWithoutCrashTelemetry() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    let controller = makeController(ids: ["attempt-1"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    _ = controller.selectStartupBundle()

    let result = try controller.rollback(forceEmbedded: false)

    XCTAssertEqual(result, BundleDropStartupRollbackResult(
      rolledBack: true,
      toEmbedded: false,
      hash: stable.hash
    ))
    XCTAssertEqual(readPointer("current.json")?.hash, stable.hash)
    let ledger = try readLedger()
    XCTAssertTrue(ledger.quarantinedHashes.isEmpty)
    XCTAssertTrue(ledger.pendingRecoveryEvents.isEmpty)
  }

  func testForcedRollbackSelectsEmbeddedWithoutCrashTelemetry() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(ids: ["attempt-1"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    _ = controller.selectStartupBundle()

    let result = try controller.rollback(forceEmbedded: true)

    XCTAssertEqual(result, BundleDropStartupRollbackResult(
      rolledBack: true,
      toEmbedded: true,
      hash: nil
    ))
    XCTAssertNil(readPointer("current.json"))
    XCTAssertTrue(try readLedger().pendingRecoveryEvents.isEmpty)
  }

  func testRevokedCandidateFallsBackButIsNotQuarantined() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    let controller = makeController(ids: ["event-1"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    XCTAssertTrue(try controller.setRevokedHashes([candidate.hash]))

    let selection = controller.selectStartupBundle()

    XCTAssertEqual(selection.bundleURL, stable.bundleURL)
    XCTAssertFalse(try readLedger().quarantinedHashes.contains(candidate.hash))
    XCTAssertTrue(try readLedger().pendingRecoveryEvents.isEmpty)
    XCTAssertThrowsError(try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )) { error in
      XCTAssertEqual(error as? BundleDropStartupRecoveryError, .candidateIneligible)
    }
  }

  func testLegacyFailedHashesAreImportedAsQuarantined() throws {
    let candidate = try makeBundle(contents: "candidate")
    try writeJson(
      [
        "failedBundles": [candidate.hash: ["attempts": 3]],
        "lastGoodHash": candidate.hash,
        "candidateHash": candidate.hash,
        "candidateCommitted": true,
      ],
      to: tempRoot.appendingPathComponent("state.json")
    )
    let controller = makeController()

    let snapshot = try controller.snapshot()

    XCTAssertEqual(snapshot["quarantinedHashes"] as? [String], [candidate.hash])
    XCTAssertNil(snapshot["stableHash"])
    XCTAssertThrowsError(try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    ))
  }

  func testLegacyFailureImportKeepsOnlyTwentyNewestHashesOnce() throws {
    var failedBundles: [String: Any] = [:]
    let hashes = (1...25).map { String(format: "%064x", $0) }
    for (index, hash) in hashes.enumerated() {
      if index >= 6 {
        failedBundles[hash] = ["failedAt": index + 1]
      } else if index.isMultiple(of: 2) {
        failedBundles[hash] = ["failedAt": "invalid"]
      } else {
        failedBundles[hash] = [:]
      }
    }
    try writeJson(
      ["failedBundles": failedBundles],
      to: tempRoot.appendingPathComponent("state.json")
    )
    let controller = makeController()

    _ = try controller.snapshot()

    let imported = try readLedger()
    XCTAssertEqual(imported.quarantinedHashes.count, 20)
    XCTAssertTrue(imported.quarantinedHashes.contains(hashes[0]))
    XCTAssertTrue(Set(hashes[6...24]).isSubset(of: Set(imported.quarantinedHashes)))
    XCTAssertFalse(imported.quarantinedHashes.contains(hashes[1]))
    XCTAssertEqual(imported.legacyFailuresImported, true)

    let revisionAfterImport = imported.revision
    let laterHash = String(repeating: "f", count: 64)
    failedBundles[laterHash] = ["failedAt": 9_999_999]
    try writeJson(
      ["failedBundles": failedBundles],
      to: tempRoot.appendingPathComponent("state.json")
    )
    _ = try controller.snapshot()

    XCTAssertEqual(try readLedger().revision, revisionAfterImport)
    XCTAssertFalse(try readLedger().quarantinedHashes.contains(laterHash))
  }

  func testPassiveLookupRequiresAnEligibleLedgerWithoutMutatingIt() throws {
    let candidate = try makeBundle(contents: "candidate")
    try BundleDropOtaResolver.writePointer(
      named: "current.json",
      hash: candidate.hash,
      bundleDropRoot: tempRoot
    )
    let controller = makeController()

    XCTAssertNil(controller.passiveCurrentBundle())
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: tempRoot.appendingPathComponent("recovery-ledger.json").path
    ))

    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    XCTAssertEqual(controller.passiveCurrentBundle(), candidate.bundleURL)
    XCTAssertNil(makeController(binaryIdentity: "binary-2").passiveCurrentBundle())

    let ledgerURL = tempRoot.appendingPathComponent("recovery-ledger.json")
    let corrupt = Data("not-json".utf8)
    try corrupt.write(to: ledgerURL)
    XCTAssertNil(controller.passiveCurrentBundle())
    XCTAssertEqual(try Data(contentsOf: ledgerURL), corrupt)
  }

  func testCorruptLedgerFailsStartupClosedToEmbedded() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(ids: ["attempt-1"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    try Data("{\"revision\":".utf8).write(
      to: tempRoot.appendingPathComponent("recovery-ledger.json")
    )

    let selection = makeController().selectStartupBundle()

    XCTAssertNil(selection.bundleURL)
    XCTAssertNil(selection.attemptId)
    XCTAssertNil(readPointer("current.json"))
    let repaired = try readLedger()
    XCTAssertEqual(repaired.phase, .recovered)
    XCTAssertEqual(repaired.quarantinedHashes, [candidate.hash])

    let healthy = try makeBundle(contents: "healthy-after-repair")
    let activation = try makeController(ids: ["healthy-attempt"]).activateCandidate(
      hash: healthy.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )
    XCTAssertEqual(activation.hash, healthy.hash)
    XCTAssertEqual(readPointer("current.json")?.hash, healthy.hash)
  }

  func testCorruptCurrentPointerFailsStartupClosedToEmbedded() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(ids: ["attempt-1"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    try Data("{\"hash\":".utf8).write(to: tempRoot.appendingPathComponent("current.json"))

    let selection = controller.selectStartupBundle()

    XCTAssertNil(selection.bundleURL)
    XCTAssertNil(selection.attemptId)
    XCTAssertEqual(try readLedger().phase, .idle)
    XCTAssertNil(try readLedger().activeAttempt)
  }

  func testCorruptPreviousPointerRecoversToEmbeddedAndRecordsCrash() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    let controller = makeController(ids: ["attempt-1"], processToken: "process-1")
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 1,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    _ = controller.selectStartupBundle()
    try Data("not-json".utf8).write(to: tempRoot.appendingPathComponent("previous.json"))

    let recovery = makeController(
      ids: ["event-1"],
      processToken: "process-2"
    ).selectStartupBundle()

    XCTAssertNil(recovery.bundleURL)
    XCTAssertNil(readPointer("current.json"))
    let ledger = try readLedger()
    XCTAssertEqual(ledger.quarantinedHashes, [candidate.hash])
    XCTAssertEqual(ledger.pendingRecoveryEvents.first?.id, "event-1")
    XCTAssertEqual(ledger.pendingRecoveryEvents.first?.recoveryTarget, "embedded")
    XCTAssertNil(ledger.pendingRecoveryEvents.first?.recoveredHash)
  }

  func testCandidateFilesRemovedAfterActivationFailStartupClosedWithoutAttempt() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(ids: ["reserved-but-not-launched"])
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    try FileManager.default.removeItem(at: candidate.bundleURL)

    let selection = controller.selectStartupBundle()

    XCTAssertNil(selection.bundleURL)
    XCTAssertNil(selection.attemptId)
    let ledger = try readLedger()
    XCTAssertEqual(ledger.phase, .idle)
    XCTAssertNil(ledger.activeAttempt)
    XCTAssertNil(ledger.reservedAttemptId)
    XCTAssertTrue(ledger.pendingRecoveryEvents.isEmpty)
    XCTAssertTrue(ledger.quarantinedHashes.isEmpty)
  }

  func testRuntimeMismatchIsRejectedDuringActivation() throws {
    let candidate = try makeBundle(contents: "candidate", runtimeVersion: "2.0.0")
    let controller = makeController()

    XCTAssertThrowsError(try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )) { error in
      XCTAssertEqual(error as? BundleDropStartupRecoveryError, .candidateUnavailable)
    }
  }

  func testMissingEmbeddedRuntimeIdentityRejectsActivation() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = BundleDropStartupRecoveryController(
      bundleDropRoot: tempRoot,
      expectedRuntimeVersion: nil,
      expectedBinaryIdentity: "binary-1"
    )

    XCTAssertThrowsError(try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )) { error in
      XCTAssertEqual(error as? BundleDropStartupRecoveryError, .candidateUnavailable)
    }
    XCTAssertNil(controller.selectStartupBundle().bundleURL)
    XCTAssertNil(controller.passiveCurrentBundle())
  }

  func testBinaryIdentityMismatchResetsLedgerAndPointers() throws {
    let candidate = try makeBundle(contents: "candidate")
    let firstBinary = makeController(ids: ["attempt-1"])
    _ = try firstBinary.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )

    let nextBinary = makeController(binaryIdentity: "binary-2")
    XCTAssertNil(nextBinary.selectStartupBundle().bundleURL)

    let ledger = try readLedger()
    XCTAssertEqual(ledger.binaryIdentity, "binary-2")
    XCTAssertEqual(ledger.runtimeIdentity, runtimeVersion)
    XCTAssertEqual(ledger.phase, .idle)
    XCTAssertNil(ledger.candidateHash)
    XCTAssertNil(readPointer("current.json"))
  }

  func testStaleLedgerWriterCannotOverwriteNewerRevision() throws {
    let candidate = try makeBundle(contents: "candidate")
    _ = try makeController().snapshot()
    let newerHash = String(repeating: "d", count: 64)
    let newerController = makeController()
    var injectedNewerWrite = false
    let staleController = makeController(
      ids: ["stale-attempt"],
      failpoint: { name in
        guard name == "beforeLedgerWrite", !injectedNewerWrite else { return }
        injectedNewerWrite = true
        _ = try newerController.setRevokedHashes([newerHash])
      }
    )

    XCTAssertThrowsError(try staleController.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )) { error in
      XCTAssertEqual(error as? BundleDropStartupRecoveryError, .staleLedger)
    }

    let ledger = try readLedger()
    XCTAssertEqual(ledger.revokedHashes, [newerHash])
    XCTAssertNil(ledger.candidateHash)
    XCTAssertNil(readPointer("current.json"))
  }

  func testLedgerWriteFailureFailsClosedWithoutExposingUntrackedCandidate() throws {
    let candidate = try makeBundle(contents: "candidate")
    let setup = makeController(ids: ["unused"])
    _ = try setup.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    let failing = makeController(failpoint: { name in
      if name == "beforeLedgerWrite" { throw TestError.interrupted }
    })

    let selection = failing.selectStartupBundle()

    XCTAssertNil(selection.bundleURL)
    XCTAssertEqual(readPointer("current.json")?.hash, candidate.hash)
    XCTAssertEqual(try readLedger().phase, .armed)
  }

  func testRecoveryEventCanBeAcknowledgedExactlyOnce() throws {
    let candidate = try makeBundle(contents: "candidate")
    let controller = makeController(ids: ["attempt-1"], processToken: "process-1")
    _ = try controller.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 1,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    _ = controller.selectStartupBundle()
    _ = makeController(ids: ["event-1"], processToken: "process-2").selectStartupBundle()

    XCTAssertTrue(try controller.acknowledgeRecovery(eventId: "event-1"))
    XCTAssertFalse(try controller.acknowledgeRecovery(eventId: "event-1"))
    XCTAssertTrue(try readLedger().pendingRecoveryEvents.isEmpty)
  }

  func testInterruptedRecoveryTransitionCompletesOnceOnNextLaunch() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    let firstLaunch = makeController(
      ids: ["attempt-1"],
      processToken: "process-1"
    )
    _ = try firstLaunch.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 1,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    _ = firstLaunch.selectStartupBundle()
    let interrupted = makeController(
      ids: ["event-1"],
      processToken: "process-2",
      failpoint: { name in
        if name == "afterRecoveryPrepared" { throw TestError.interrupted }
      }
    )

    XCTAssertNil(interrupted.selectStartupBundle().bundleURL)
    XCTAssertEqual(readPointer("current.json")?.hash, candidate.hash)
    XCTAssertEqual(try readLedger().pendingTransition?.kind, "recovery")

    let recovered = makeController().selectStartupBundle()
    XCTAssertEqual(recovered.bundleURL, stable.bundleURL)
    XCTAssertEqual(readPointer("current.json")?.hash, stable.hash)
    XCTAssertNil(try readLedger().pendingTransition)
    XCTAssertEqual(try readLedger().pendingRecoveryEvents.map(\.id), ["event-1"])
  }

  func testInterruptedRecoveryDowngradesUnavailablePreviousToEmbedded() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    let firstLaunch = makeController(
      ids: ["attempt-1"],
      processToken: "process-1"
    )
    _ = try firstLaunch.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 1,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    _ = firstLaunch.selectStartupBundle()
    let interrupted = makeController(
      ids: ["event-1"],
      processToken: "process-2",
      failpoint: { name in
        if name == "afterRecoveryPrepared" { throw TestError.interrupted }
      }
    )
    _ = interrupted.selectStartupBundle()
    try FileManager.default.removeItem(at: stable.bundleURL)

    let recovered = makeController(processToken: "process-3").selectStartupBundle()

    XCTAssertNil(recovered.bundleURL)
    XCTAssertNil(readPointer("current.json"))
    XCTAssertNil(readPointer("previous.json"))
    let ledger = try readLedger()
    XCTAssertNil(ledger.pendingTransition)
    XCTAssertNil(ledger.stableHash)
    XCTAssertEqual(ledger.quarantinedHashes, [candidate.hash])
    XCTAssertEqual(ledger.pendingRecoveryEvents.map(\.id), ["event-1"])
    XCTAssertEqual(ledger.pendingRecoveryEvents.first?.recoveryTarget, "embedded")
    XCTAssertNil(ledger.pendingRecoveryEvents.first?.recoveredHash)
  }

  func testInterruptedRollbackTransitionCompletesWithoutCrashEvent() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    let interrupted = makeController(
      ids: ["attempt-1"],
      failpoint: { name in
        if name == "afterRollbackPrepared" { throw TestError.interrupted }
      }
    )
    _ = try interrupted.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )

    XCTAssertThrowsError(try interrupted.rollback(forceEmbedded: false))
    XCTAssertEqual(readPointer("current.json")?.hash, candidate.hash)
    XCTAssertEqual(try readLedger().pendingTransition?.kind, "rollback")

    let recovered = makeController().selectStartupBundle()
    XCTAssertEqual(recovered.bundleURL, stable.bundleURL)
    XCTAssertNil(try readLedger().pendingTransition)
    XCTAssertTrue(try readLedger().pendingRecoveryEvents.isEmpty)
    XCTAssertTrue(try readLedger().quarantinedHashes.isEmpty)
  }

  func testInterruptedRollbackDowngradesUnavailablePreviousToEmbedded() throws {
    let stable = try makeBundle(contents: "stable")
    let candidate = try makeBundle(contents: "candidate")
    try establishNativeStable(stable.hash)
    let interrupted = makeController(failpoint: { name in
      if name == "afterRollbackPrepared" { throw TestError.interrupted }
    })
    _ = try interrupted.activateCandidate(
      hash: candidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "manual",
      healthyAfterSec: 0
    )

    XCTAssertThrowsError(try interrupted.rollback(forceEmbedded: false))
    try FileManager.default.removeItem(at: stable.bundleURL)

    let recovered = makeController().selectStartupBundle()

    XCTAssertNil(recovered.bundleURL)
    XCTAssertNil(readPointer("current.json"))
    XCTAssertNil(readPointer("previous.json"))
    let ledger = try readLedger()
    XCTAssertNil(ledger.pendingTransition)
    XCTAssertNil(ledger.stableHash)
    XCTAssertTrue(ledger.pendingRecoveryEvents.isEmpty)
    XCTAssertTrue(ledger.quarantinedHashes.isEmpty)
  }

  func testActivationCompletesInterruptedEmbeddedRollbackFirst() throws {
    let firstCandidate = try makeBundle(contents: "first")
    let nextCandidate = try makeBundle(contents: "next")
    let interrupted = makeController(
      ids: ["attempt-1"],
      failpoint: { name in
        if name == "afterRollbackCurrentDelete" { throw TestError.interrupted }
      }
    )
    _ = try interrupted.activateCandidate(
      hash: firstCandidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    XCTAssertThrowsError(try interrupted.rollback(forceEmbedded: true))
    XCTAssertNil(readPointer("current.json"))
    XCTAssertEqual(try readLedger().pendingTransition?.kind, "rollback")

    _ = try makeController(ids: ["next-attempt"]).activateCandidate(
      hash: nextCandidate.hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )

    XCTAssertEqual(readPointer("current.json")?.hash, nextCandidate.hash)
    XCTAssertNil(try readLedger().pendingTransition)
    XCTAssertEqual(try readLedger().reservedAttemptId, "next-attempt")
  }

  private enum TestError: Error {
    case interrupted
  }

  private struct TestBundle {
    let hash: String
    let bundleURL: URL
  }

  private struct ManifestFile {
    let path: String
    let role: String
    let sha256: String
    let size: Int
  }

  private func makeController(
    ids: [String] = [],
    binaryIdentity: String = "binary-1",
    processToken: String = UUID().uuidString,
    failpoint: BundleDropStartupRecoveryController.Failpoint? = nil
  ) -> BundleDropStartupRecoveryController {
    var remainingIds = ids
    return BundleDropStartupRecoveryController(
      bundleDropRoot: tempRoot,
      expectedRuntimeVersion: runtimeVersion,
      expectedBinaryIdentity: binaryIdentity,
      processToken: processToken,
      now: { 1_700_000_000 },
      makeId: { remainingIds.isEmpty ? UUID().uuidString : remainingIds.removeFirst() },
      failpoint: failpoint
    )
  }

  private func makeBundle(contents: String, runtimeVersion: String? = nil) throws -> TestBundle {
    let files = [
      ManifestFile(
        path: "main.jsbundle",
        role: "jsbundle",
        sha256: sha256(contents),
        size: contents.utf8.count
      ),
      ManifestFile(
        path: "metadata-ios.json",
        role: "metadata",
        sha256: sha256("{}"),
        size: 2
      ),
    ]
    let canonicalFiles = files.sorted { $0.path.utf8.lexicographicallyPrecedes($1.path.utf8) }
    let fileJson = canonicalFiles.map(fileJson).joined(separator: ",")
    let bundleHash = sha256("{\"files\":[\(fileJson)],\"manifestVersion\":1}")
    let bundleDirectory = tempRoot.appendingPathComponent("bundles/\(bundleHash)", isDirectory: true)
    try FileManager.default.createDirectory(at: bundleDirectory, withIntermediateDirectories: true)
    try contents.write(
      to: bundleDirectory.appendingPathComponent("main.jsbundle"),
      atomically: true,
      encoding: .utf8
    )
    try "{}".write(
      to: bundleDirectory.appendingPathComponent("metadata-ios.json"),
      atomically: true,
      encoding: .utf8
    )
    let actualRuntime = runtimeVersion ?? self.runtimeVersion
    let jsHash = files[0].sha256
    let manifestHashFields = [
      "\"bundleHash\":\(jsonString(bundleHash))",
      "\"files\":[\(fileJson)]",
      "\"jsBundleHash\":\(jsonString(jsHash))",
      "\"manifestVersion\":1",
      "\"platform\":\(jsonString("ios"))",
      "\"runtimeVersion\":\(jsonString(actualRuntime))",
      "\"version\":\(jsonString("1.0.0"))",
    ].joined(separator: ",")
    let manifestHash = sha256("{\(manifestHashFields)}")
    let manifest = "{\"manifestVersion\":1,\"bundleHash\":\(jsonString(bundleHash)),\"jsBundleHash\":\(jsonString(jsHash)),\"platform\":\(jsonString("ios")),\"runtimeVersion\":\(jsonString(actualRuntime)),\"version\":\(jsonString("1.0.0")),\"manifestHash\":\(jsonString(manifestHash)),\"files\":[\(fileJson)]}"
    try manifest.write(
      to: bundleDirectory.appendingPathComponent("bundle-manifest.json"),
      atomically: true,
      encoding: .utf8
    )
    return TestBundle(
      hash: bundleHash,
      bundleURL: bundleDirectory.appendingPathComponent("main.jsbundle")
    )
  }

  private func establishNativeStable(_ hash: String) throws {
    let controller = makeController(ids: ["stable-attempt"])
    _ = try controller.activateCandidate(
      hash: hash,
      maxCrashCount: 2,
      healthCheckMode: "auto",
      healthyAfterSec: 0
    )
    let attempt = controller.selectStartupBundle()
    XCTAssertTrue(controller.markHealthy(hash: hash, attemptId: try XCTUnwrap(attempt.attemptId)))
  }

  private func readPointer(_ name: String) -> BundleDropOtaPointer? {
    BundleDropOtaResolver.readPointer(
      named: name,
      bundleDropRoot: tempRoot,
      expectedRuntimeVersion: runtimeVersion
    )
  }

  private func readLedger() throws -> BundleDropStartupRecoveryLedger {
    try JSONDecoder().decode(
      BundleDropStartupRecoveryLedger.self,
      from: Data(contentsOf: tempRoot.appendingPathComponent("recovery-ledger.json"))
    )
  }

  private func fileJson(_ file: ManifestFile) -> String {
    "{\"path\":\(jsonString(file.path)),\"role\":\(jsonString(file.role)),\"sha256\":\(jsonString(file.sha256)),\"size\":\(file.size)}"
  }

  private func jsonString(_ value: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [value])
    return String(data: data, encoding: .utf8)!
      .dropFirst()
      .dropLast()
      .replacingOccurrences(of: "\\/", with: "/")
  }

  private func sha256(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private func writeJson(_ object: Any, to url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    try data.write(to: url, options: .atomic)
  }
}
