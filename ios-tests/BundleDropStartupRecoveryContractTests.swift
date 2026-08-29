import Foundation
import XCTest
@testable import BundleDropIOSCore

final class BundleDropStartupRecoveryContractTests: XCTestCase {
  func testSharedProtocolV1FixtureMatchesProductionIOSSnapshot() throws {
    let fixtureURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
      .appendingPathComponent("test-fixtures/startup-recovery-contract-v1.json")
    let fixture = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any]
    )
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("bundle-drop-contract-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

    let candidateHash = String(repeating: "a", count: 64)
    let quarantinedHash = String(repeating: "b", count: 64)
    let stableHash = String(repeating: "c", count: 64)
    let ledger = BundleDropStartupRecoveryLedger(
      revision: 7,
      binaryIdentity: "binary-contract-v1",
      runtimeIdentity: "runtime-contract-v1",
      legacyFailuresImported: true,
      phase: .launching,
      candidateHash: candidateHash,
      stableHash: stableHash,
      activeAttempt: BundleDropStartupRecoveryAttempt(
        hash: candidateHash,
        attemptId: "attempt-contract-v1",
        processToken: "process-contract-v1",
        startedAt: 1_700_000_000,
        unacknowledgedLaunchCount: 2,
        contentAppeared: false
      ),
      policy: BundleDropStartupRecoveryPolicy(
        maxCrashCount: 3,
        healthCheckMode: "manual",
        healthyAfterSec: 4.5
      ),
      quarantinedHashes: [quarantinedHash],
      pendingRecoveryEvents: [
        BundleDropStartupRecoveryEvent(
          id: "event-contract-v1",
          failedHash: candidateHash,
          recoveryTarget: "previous",
          recoveredHash: stableHash,
          crashCount: 3,
          reason: "crash_loop",
          failedAt: 1_700_000_000
        ),
      ]
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try encoder.encode(ledger).write(to: root.appendingPathComponent("recovery-ledger.json"))

    let snapshot = try BundleDropStartupRecoveryController(
      bundleDropRoot: root,
      expectedRuntimeVersion: "runtime-contract-v1",
      expectedBinaryIdentity: "binary-contract-v1",
      processToken: "process-contract-v1"
    ).snapshot()

    XCTAssertEqual(NSDictionary(dictionary: snapshot), NSDictionary(dictionary: fixture))
  }
}
