import CryptoKit
import XCTest
@testable import BundleDropIOSCore

final class BundleDropBundleVerifierTests: XCTestCase {
  private var tempRoot: URL!

  override func setUpWithError() throws {
    tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("BundleDropBundleVerifierTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    if let tempRoot {
      try? FileManager.default.removeItem(at: tempRoot)
    }
    tempRoot = nil
  }

  func testVerifyBundleFilesAcceptsCompleteFileTree() throws {
    let bundleDir = try makeBundleDir("valid")
    try writeFile("bundle", to: bundleDir.appendingPathComponent("main.jsbundle"))
    try writeFile("logo", to: bundleDir.appendingPathComponent("assets/logo.png"))
    let manifest = try writeManifest(
      in: bundleDir,
      entries: [
        entry(path: "main.jsbundle", content: "bundle"),
        entry(path: "assets/logo.png", content: "logo")
      ]
    )

    XCTAssertNoThrow(
      try BundleDropBundleVerifier.verifyBundleFiles(bundleDir: bundleDir, manifestURL: manifest)
    )
  }

  func testVerifyBundleFilesRejectsMissingFiles() throws {
    let bundleDir = try makeBundleDir("missing")
    let manifest = try writeManifest(in: bundleDir, entries: [entry(path: "main.jsbundle", content: "bundle")])

    XCTAssertThrowsError(
      try BundleDropBundleVerifier.verifyBundleFiles(bundleDir: bundleDir, manifestURL: manifest)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("Manifest file missing"))
    }
  }

  func testVerifyBundleFilesRejectsSizeMismatches() throws {
    let bundleDir = try makeBundleDir("size")
    try writeFile("bundle", to: bundleDir.appendingPathComponent("main.jsbundle"))
    let manifest = try writeManifestRaw(
      in: bundleDir,
      content: #"{"files":[{"path":"main.jsbundle","size":7,"sha256":"\#(sha256("bundle"))"}]}"#
    )

    XCTAssertThrowsError(
      try BundleDropBundleVerifier.verifyBundleFiles(bundleDir: bundleDir, manifestURL: manifest)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("Manifest file size mismatch"))
    }
  }

  func testVerifyBundleFilesRejectsHashMismatches() throws {
    let bundleDir = try makeBundleDir("hash")
    try writeFile("tampered", to: bundleDir.appendingPathComponent("main.jsbundle"))
    let manifest = try writeManifest(in: bundleDir, entries: [entry(path: "main.jsbundle", content: "expected")])

    XCTAssertThrowsError(
      try BundleDropBundleVerifier.verifyBundleFiles(bundleDir: bundleDir, manifestURL: manifest)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("Manifest file hash mismatch"))
    }
  }

  func testVerifyBundleFilesRejectsExtraFiles() throws {
    let bundleDir = try makeBundleDir("extra")
    try writeFile("bundle", to: bundleDir.appendingPathComponent("main.jsbundle"))
    try writeFile("extra", to: bundleDir.appendingPathComponent("assets/unlisted.png"))
    let manifest = try writeManifest(in: bundleDir, entries: [entry(path: "main.jsbundle", content: "bundle")])

    XCTAssertThrowsError(
      try BundleDropBundleVerifier.verifyBundleFiles(bundleDir: bundleDir, manifestURL: manifest)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("Unmanifested file"))
    }
  }

  func testVerifyBundleFilesRejectsUnsafeAndDuplicatePaths() throws {
    let unsafeDir = try makeBundleDir("unsafe")
    let unsafeManifest = try writeManifestRaw(
      in: unsafeDir,
      content: #"{"files":[{"path":"../escape","size":1,"sha256":"\#(sha256("x"))"}]}"#
    )
    XCTAssertThrowsError(
      try BundleDropBundleVerifier.verifyBundleFiles(bundleDir: unsafeDir, manifestURL: unsafeManifest)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("Invalid manifest path"))
    }

    let duplicateDir = try makeBundleDir("duplicate")
    try writeFile("bundle", to: duplicateDir.appendingPathComponent("main.jsbundle"))
    let duplicateEntry = entry(path: "main.jsbundle", content: "bundle")
    let duplicateManifest = try writeManifestRaw(
      in: duplicateDir,
      content: #"{"files":[\#(duplicateEntry),\#(duplicateEntry)]}"#
    )
    XCTAssertThrowsError(
      try BundleDropBundleVerifier.verifyBundleFiles(bundleDir: duplicateDir, manifestURL: duplicateManifest)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("Duplicate manifest file path"))
    }
  }

  func testVerifyBundleFilesRejectsMalformedManifestAndMissingFilesArray() throws {
    let malformedDir = try makeBundleDir("malformed")
    let malformedManifest = try writeManifestRaw(in: malformedDir, content: "{")
    XCTAssertThrowsError(
      try BundleDropBundleVerifier.verifyBundleFiles(bundleDir: malformedDir, manifestURL: malformedManifest)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("Malformed bundle manifest"))
    }

    let missingFilesDir = try makeBundleDir("missing-files")
    let missingFilesManifest = try writeManifestRaw(in: missingFilesDir, content: #"{"manifestVersion":1}"#)
    XCTAssertThrowsError(
      try BundleDropBundleVerifier.verifyBundleFiles(bundleDir: missingFilesDir, manifestURL: missingFilesManifest)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("Bundle manifest must include files"))
    }
  }

  private func makeBundleDir(_ name: String) throws -> URL {
    let url = tempRoot.appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private func writeFile(_ content: String, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try content.write(to: url, atomically: true, encoding: .utf8)
  }

  private func entry(path: String, content: String) -> String {
    #"{"path":"\#(path)","size":\#(Data(content.utf8).count),"sha256":"\#(sha256(content))"}"#
  }

  private func writeManifest(in bundleDir: URL, entries: [String]) throws -> URL {
    try writeManifestRaw(in: bundleDir, content: #"{"files":[\#(entries.joined(separator: ","))]}"#)
  }

  private func writeManifestRaw(in bundleDir: URL, content: String) throws -> URL {
    let manifest = bundleDir.appendingPathComponent("bundle-manifest.json")
    try content.write(to: manifest, atomically: true, encoding: .utf8)
    return manifest
  }

  private func sha256(_ content: String) -> String {
    SHA256.hash(data: Data(content.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
