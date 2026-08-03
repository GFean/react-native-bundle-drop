import XCTest
import CryptoKit
@testable import BundleDropIOSCore

final class BundleDropOtaResolverTests: XCTestCase {
  private var tempRoot: URL!
  private let validHash = "6f16049a7161b58f594f26bacc917de6d94f9115f0a91a458bf180255da6466f"

  override func setUpWithError() throws {
    tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("BundleDropOtaResolverTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: tempRoot,
      withIntermediateDirectories: true
    )
  }

  override func tearDownWithError() throws {
    if let tempRoot {
      try? FileManager.default.removeItem(at: tempRoot)
    }
    tempRoot = nil
  }

  func testReadCurrentPointerReturnsDerivedURLWhenCurrentJsonHashIsValidAndFileExists() throws {
    let root = try makeDirectory("bundle-drop")
    let bundle = try makeBundle(root: root)
    try write(
      "{\"hash\":\"\(validHash)\",\"updatedAt\":123}",
      to: root.appendingPathComponent("current.json")
    )

    XCTAssertEqual(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root), bundle)
  }

  func testReadCurrentPointerRejectsOldManifestVersionHashDomain() throws {
    let root = try makeDirectory("bundle-drop")
    let oldHash = "95b6ea4efb34687b23a00ca183d892b22a036eae822956e73665935a3c33ac79"
    let bundleDir = root.appendingPathComponent("bundles/\(oldHash)", isDirectory: true)
    try FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)
    let bundle = bundleDir.appendingPathComponent("main.jsbundle")
    try write("bundle", to: bundle)
    try write(
      "{\"manifestVersion\":2,\"bundleHash\":\"\(oldHash)\",\"files\":[{\"path\":\"main.jsbundle\",\"role\":\"jsbundle\",\"sha256\":\"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc\",\"size\":6}]}",
      to: bundleDir.appendingPathComponent("bundle-manifest.json")
    )
    try write(
      "{\"hash\":\"\(oldHash)\",\"bundlePath\":\"\(bundle.path)\"}",
      to: root.appendingPathComponent("current.json")
    )

    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))
  }

  func testReadCurrentPointerReturnsNilWhenCurrentJsonIsMissing() throws {
    let root = try makeDirectory("bundle-drop")
    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))
  }

  func testReadCurrentPointerReturnsNilWhenBundlePathFileIsMissing() throws {
    let root = try makeDirectory("bundle-drop")
    try write(
      "{\"bundlePath\":\"\(tempRoot.appendingPathComponent("missing/main.jsbundle").path)\"}",
      to: root.appendingPathComponent("current.json")
    )

    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))
  }

  func testReadCurrentPointerReturnsNilWhenHashIsMissing() throws {
    let root = try makeDirectory("bundle-drop")
    try write("{\"bundlePath\":\"\"}", to: root.appendingPathComponent("current.json"))
    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))

    try write("{\"otherKey\":\"value\"}", to: root.appendingPathComponent("current.json"))
    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))
  }

  func testReadCurrentPointerDerivesPathFromHashAndIgnoresStaleBundlePath() throws {
    let root = try makeDirectory("bundle-drop")
    let bundle = try makeBundle(root: root)
    try write(
      "{\"hash\":\"\(validHash)\",\"bundlePath\":\"/old/container/bundle-drop/bundles/\(validHash)/main.jsbundle\"}",
      to: root.appendingPathComponent("current.json")
    )

    XCTAssertEqual(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root), bundle)

    try write("{\"hash\":\"\(validHash)\"}", to: root.appendingPathComponent("current.json"))
    XCTAssertEqual(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root), bundle)
  }

  func testReadCurrentPointerReturnsNilOnMalformedJson() throws {
    let root = try makeDirectory("bundle-drop")
    try write("not valid json {{{", to: root.appendingPathComponent("current.json"))
    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))
  }

  func testReadCurrentPointerVerifiesExecutableEntriesInPathOrder() throws {
    let root = try makeDirectory("bundle-drop")
    let hash = "75f981bf86d60c89e46d22c97931040c16291012f54433e5b6610c63c50967fe"
    let bundleDir = root.appendingPathComponent("bundles/\(hash)", isDirectory: true)
    try FileManager.default.createDirectory(at: bundleDir, withIntermediateDirectories: true)
    let bundle = bundleDir.appendingPathComponent("main.jsbundle")
    try write("bundle", to: bundle)
    try writeRequiredIOSBundleFiles(bundleDir: bundleDir)
    try write("tool", to: bundleDir.appendingPathComponent("zz/tool"))
    try write(
      manifestJson(bundleHash: hash, files: [
        ManifestFile(
          path: "zz/tool",
          role: "asset",
          sha256: "7c9bbe5ec9b3fb774e8fa0f54247e93c34ddf8e5d16fe3073420de0ae81a262d",
          size: 4,
          executable: true
        ),
        mainBundleFile()
      ]),
      to: bundleDir.appendingPathComponent("bundle-manifest.json")
    )
    try write(
      "{\"hash\":\"\(hash)\",\"bundlePath\":\"\(bundle.path)\"}",
      to: root.appendingPathComponent("current.json")
    )

    XCTAssertEqual(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root), bundle)
  }

  func testReadCurrentPointerRejectsExtraRoleEntriesOutsideCanonicalPaths() throws {
    let root = try makeDirectory("bundle-drop")
    let bundle = try makeBundle(root: root)
    let bundleDir = bundle.deletingLastPathComponent()
    let manifest = bundleDir.appendingPathComponent("bundle-manifest.json")
    try write(
      "{\"hash\":\"\(validHash)\",\"bundlePath\":\"\(bundle.path)\"}",
      to: root.appendingPathComponent("current.json")
    )

    try write("other", to: bundleDir.appendingPathComponent("other.jsbundle"))
    try write(
      manifestJson(bundleHash: validHash, files: [
        mainBundleFile(),
        ManifestFile(path: "other.jsbundle", role: "jsbundle", sha256: sha256String("other"), size: 5)
      ]),
      to: manifest
    )
    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))

    try write("{}", to: bundleDir.appendingPathComponent("metadata-extra.json"))
    try write(
      manifestJson(bundleHash: validHash, files: [
        mainBundleFile(),
        metadataFile(),
        ManifestFile(
          path: "metadata-extra.json",
          role: "metadata",
          sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          size: 2
        )
      ]),
      to: manifest
    )
    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))

    try write("{}", to: bundleDir.appendingPathComponent("image-manifest.json"))
    try write(
      manifestJson(bundleHash: validHash, files: [
        mainBundleFile(),
        metadataFile(),
        ManifestFile(
          path: "image-manifest.json",
          role: "androidImageManifest",
          sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          size: 2
        )
      ]),
      to: manifest
    )
    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))
  }

  func testReadCurrentPointerReturnsNilWhenManifestHashIsMissingOrInvalid() throws {
    let root = try makeDirectory("bundle-drop")
    let bundle = try makeBundle(root: root)
    let manifestURL = bundle.deletingLastPathComponent().appendingPathComponent("bundle-manifest.json")
    try write(
      "{\"hash\":\"\(validHash)\",\"bundlePath\":\"\(bundle.path)\"}",
      to: root.appendingPathComponent("current.json")
    )

    try write(
      "{\"manifestVersion\":1,\"bundleHash\":\"\(validHash)\",\"jsBundleHash\":\"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc\",\"platform\":\"ios\",\"runtimeVersion\":\"1.0.0\",\"version\":\"1.0.0\",\"files\":[{\"path\":\"main.jsbundle\",\"role\":\"jsbundle\",\"sha256\":\"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc\",\"size\":6}]}",
      to: manifestURL
    )
    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))

    let invalidHashManifest = manifestJson(bundleHash: validHash, files: [mainBundleFile()])
      .replacingOccurrences(
        of: "\"manifestHash\":\"[a-f0-9]{64}\"",
        with: "\"manifestHash\":\"\(String(repeating: "f", count: 64))\"",
        options: .regularExpression
      )
    try write(invalidHashManifest, to: manifestURL)
    XCTAssertNil(BundleDropOtaResolver.readCurrentPointer(bundleDropRoot: root))
  }

  func testClearOtaStateDeletesOnlyExpectedFiles() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("docs/bundle-drop")
    let keptDir = try makeDirectory("docs/bundle-drop/bundles/abc123")

    let current = root.appendingPathComponent("current.json")
    let previous = root.appendingPathComponent("previous.json")
    let state = root.appendingPathComponent("state.json")
    let bundleInfo = docs.appendingPathComponent("bundle-info.json")
    let kept = keptDir.appendingPathComponent("main.jsbundle")

    try write("{}", to: current)
    try write("{}", to: previous)
    try write("{}", to: state)
    try write("{}", to: bundleInfo)
    try write("bundle", to: kept)

    BundleDropOtaResolver.clearOtaState(
      bundleDropRoot: root,
      documentsDirectory: docs
    )

    XCTAssertFalse(FileManager.default.fileExists(atPath: current.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: previous.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: state.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: bundleInfo.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path))
  }

  func testResolveReturnsNilAndStoresVersionWhenNoOtaBundleExists() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("docs/bundle-drop")

    let result = BundleDropOtaResolver.resolve(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "1.0.0-1",
      storedBinaryVersion: nil
    )

    XCTAssertNil(result.bundleURL)
    XCTAssertFalse(result.clearedOta)
    XCTAssertEqual(result.storedVersion, "1.0.0-1")
  }

  func testResolveReturnsBundleURLWhenOtaExistsAndBinaryVersionMatches() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("docs/bundle-drop")
    let bundle = try makeBundle(root: root)
    try write(
      "{\"hash\":\"\(validHash)\",\"bundlePath\":\"\(bundle.path)\"}",
      to: root.appendingPathComponent("current.json")
    )

    let result = BundleDropOtaResolver.resolve(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "1.0.0-1",
      storedBinaryVersion: "1.0.0-1"
    )

    XCTAssertEqual(result.bundleURL, bundle)
    XCTAssertFalse(result.clearedOta)
    XCTAssertEqual(result.storedVersion, "1.0.0-1")
  }

  func testResolveReturnsBundleURLOnFirstLaunchWithOtaBundle() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("docs/bundle-drop")
    let bundle = try makeBundle(root: root)
    try write(
      "{\"hash\":\"\(validHash)\",\"bundlePath\":\"\(bundle.path)\"}",
      to: root.appendingPathComponent("current.json")
    )

    let result = BundleDropOtaResolver.resolve(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "1.0.0-1",
      storedBinaryVersion: nil
    )

    XCTAssertEqual(result.bundleURL, bundle)
    XCTAssertFalse(result.clearedOta)
    XCTAssertEqual(result.storedVersion, "1.0.0-1")
  }

  func testResolveClearsOtaStateAndReturnsNilWhenBinaryVersionChanges() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("docs/bundle-drop")
    let bundle = try makeBundle(root: root)
    let current = root.appendingPathComponent("current.json")
    let state = root.appendingPathComponent("state.json")

    try write("{\"hash\":\"\(validHash)\",\"bundlePath\":\"\(bundle.path)\"}", to: current)
    try write("{}", to: state)

    let result = BundleDropOtaResolver.resolve(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "2.0.0-5",
      storedBinaryVersion: "1.0.0-1"
    )

    XCTAssertNil(result.bundleURL)
    XCTAssertTrue(result.clearedOta)
    XCTAssertEqual(result.storedVersion, "2.0.0-5")
    XCTAssertFalse(FileManager.default.fileExists(atPath: current.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: state.path))
  }

  func testResolveClearsStaleOtaStateWhenBinaryVersionChangesAndCurrentJsonIsMalformed() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("docs/bundle-drop")
    let current = root.appendingPathComponent("current.json")
    let previous = root.appendingPathComponent("previous.json")
    let state = root.appendingPathComponent("state.json")
    let bundleInfo = docs.appendingPathComponent("bundle-info.json")

    try write("not valid json {{{", to: current)
    try write("{}", to: previous)
    try write("{}", to: state)
    try write("{\"hash\":\"stale\"}", to: bundleInfo)

    let result = BundleDropOtaResolver.resolve(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "2.0.0-5",
      storedBinaryVersion: "1.0.0-1"
    )

    XCTAssertNil(result.bundleURL)
    XCTAssertTrue(result.clearedOta)
    XCTAssertEqual(result.storedVersion, "2.0.0-5")
    XCTAssertFalse(FileManager.default.fileExists(atPath: current.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: previous.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: state.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: bundleInfo.path))
  }

  func testResolveStoresVersionWithoutClearingWhenBinaryVersionChangesAndNoOtaStateExists() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("docs/bundle-drop")

    let result = BundleDropOtaResolver.resolve(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "2.0.0-5",
      storedBinaryVersion: "1.0.0-1"
    )

    XCTAssertNil(result.bundleURL)
    XCTAssertFalse(result.clearedOta)
    XCTAssertEqual(result.storedVersion, "2.0.0-5")
  }

  private func makeBundle(root: URL, hash: String? = nil) throws -> URL {
    let bundleHash = hash ?? validHash
    let bundleDir = root.appendingPathComponent("bundles/\(bundleHash)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: bundleDir,
      withIntermediateDirectories: true
    )
    let bundle = bundleDir.appendingPathComponent("main.jsbundle")
    try write("bundle", to: bundle)
    try writeRequiredIOSBundleFiles(bundleDir: bundleDir)
    try write(
      manifestJson(bundleHash: bundleHash, files: [mainBundleFile()]),
      to: bundleDir.appendingPathComponent("bundle-manifest.json")
    )
    return bundle
  }

  private func writeRequiredIOSBundleFiles(bundleDir: URL) throws {
    try write("{}", to: bundleDir.appendingPathComponent("metadata-ios.json"))
  }

  private struct ManifestFile {
    let path: String
    let role: String
    let sha256: String
    let size: Int
    let executable: Bool

    init(path: String, role: String, sha256: String, size: Int, executable: Bool = false) {
      self.path = path
      self.role = role
      self.sha256 = sha256
      self.size = size
      self.executable = executable
    }
  }

  private func mainBundleFile(
    sha256: String = "1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc",
    size: Int = 6
  ) -> ManifestFile {
    ManifestFile(path: "main.jsbundle", role: "jsbundle", sha256: sha256, size: size)
  }

  private func metadataFile() -> ManifestFile {
    ManifestFile(
      path: "metadata-ios.json",
      role: "metadata",
      sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      size: 2
    )
  }

  private func completeManifestFiles(_ files: [ManifestFile]) -> [ManifestFile] {
    var complete = files
    if !complete.contains(where: { $0.role == "metadata" }) {
      complete.append(metadataFile())
    }
    return complete
  }

  private func manifestJson(
    bundleHash: String,
    files: [ManifestFile],
    platform: String = "ios",
    runtimeVersion: String = "1.0.0",
    version: String = "1.0.0"
  ) -> String {
    let completeFiles = completeManifestFiles(files)
    let jsBundleHash = completeFiles.first { $0.role == "jsbundle" && $0.path == "main.jsbundle" }?.sha256 ?? ""
    let manifestHashBody = [
      "\"bundleHash\":\(jsonString(bundleHash))",
      "\"files\":[\(canonicalFileEntries(completeFiles).joined(separator: ","))]",
      "\"jsBundleHash\":\(jsonString(jsBundleHash))",
      "\"manifestVersion\":1",
      "\"platform\":\(jsonString(platform))",
      "\"runtimeVersion\":\(jsonString(runtimeVersion))",
      "\"version\":\(jsonString(version))"
    ].joined(separator: ",")
    let manifestHash = sha256String("{\(manifestHashBody)}")
    let body = [
      "\"manifestVersion\":1",
      "\"bundleHash\":\(jsonString(bundleHash))",
      "\"jsBundleHash\":\(jsonString(jsBundleHash))",
      "\"platform\":\(jsonString(platform))",
      "\"runtimeVersion\":\(jsonString(runtimeVersion))",
      "\"version\":\(jsonString(version))",
      "\"manifestHash\":\(jsonString(manifestHash))",
      "\"files\":[\(completeFiles.map(fileEntryJson).joined(separator: ","))]"
    ].joined(separator: ",")
    return "{\(body)}"
  }

  private func canonicalFileEntries(_ files: [ManifestFile]) -> [String] {
    files
      .sorted { compareUtf8($0.path, $1.path) < 0 }
      .map(fileEntryJson)
  }

  private func fileEntryJson(_ file: ManifestFile) -> String {
    let executable = file.executable ? "\"executable\":true," : ""
    return "{\(executable)\"path\":\(jsonString(file.path)),\"role\":\(jsonString(file.role)),\"sha256\":\(jsonString(file.sha256)),\"size\":\(file.size)}"
  }

  private func compareUtf8(_ left: String, _ right: String) -> Int {
    let leftBytes = Array(left.utf8)
    let rightBytes = Array(right.utf8)
    let count = min(leftBytes.count, rightBytes.count)
    for index in 0..<count {
      if leftBytes[index] != rightBytes[index] {
        return Int(leftBytes[index]) - Int(rightBytes[index])
      }
    }
    return leftBytes.count - rightBytes.count
  }

  private func sha256String(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private func jsonString(_ value: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [value]),
          let encoded = String(data: data, encoding: .utf8) else {
      return "\"\""
    }
    return String(encoded.dropFirst().dropLast()).replacingOccurrences(of: "\\/", with: "/")
  }

  private func makeDirectory(_ relativePath: String) throws -> URL {
    let url = tempRoot.appendingPathComponent(relativePath, isDirectory: true)
    try FileManager.default.createDirectory(
      at: url,
      withIntermediateDirectories: true
    )
    return url
  }

  private func write(_ content: String, to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try content.write(to: url, atomically: true, encoding: .utf8)
  }
}
