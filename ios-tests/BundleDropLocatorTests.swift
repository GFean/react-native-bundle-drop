import XCTest
import CryptoKit
@testable import BundleDropIOSCore

final class BundleDropLocatorTests: XCTestCase {
  private var tempRoot: URL!
  private var userDefaults: UserDefaults!
  private var suiteName: String!
  private let validHash = "6f16049a7161b58f594f26bacc917de6d94f9115f0a91a458bf180255da6466f"

  override func setUpWithError() throws {
    tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("BundleDropLocatorTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: tempRoot,
      withIntermediateDirectories: true
    )

    suiteName = "BundleDropLocatorTests.\(UUID().uuidString)"
    userDefaults = UserDefaults(suiteName: suiteName)
    userDefaults.removePersistentDomain(forName: suiteName)
  }

  override func tearDownWithError() throws {
    if let suiteName {
      userDefaults?.removePersistentDomain(forName: suiteName)
    }
    if let tempRoot {
      try? FileManager.default.removeItem(at: tempRoot)
    }
    userDefaults = nil
    suiteName = nil
    tempRoot = nil
  }

  func testBundleURLStoresCurrentBinaryVersionWhenNoOtaBundleExists() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("library/bundle-drop")

    let bundleURL = BundleDropLocatorCore.bundleURL(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "1.0.0-1",
      userDefaults: userDefaults,
      shouldLogBinaryUpdate: false
    )

    XCTAssertNil(bundleURL)
    XCTAssertEqual(
      userDefaults.string(forKey: BundleDropLocatorCore.binaryVersionKey),
      "1.0.0-1"
    )
  }

  func testBundleURLReturnsPointerWhenStoredBinaryVersionMatches() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("library/bundle-drop")
    let bundle = try makeBundle(root: root)
    try write(
      "{\"hash\":\"\(validHash)\",\"bundlePath\":\"\(bundle.path)\"}",
      to: root.appendingPathComponent("current.json")
    )
    userDefaults.set("1.0.0-1", forKey: BundleDropLocatorCore.binaryVersionKey)

    let bundleURL = BundleDropLocatorCore.bundleURL(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "1.0.0-1",
      userDefaults: userDefaults,
      shouldLogBinaryUpdate: false
    )

    XCTAssertEqual(bundleURL, bundle)
    XCTAssertEqual(
      userDefaults.string(forKey: BundleDropLocatorCore.binaryVersionKey),
      "1.0.0-1"
    )
  }

  func testBundleURLClearsStateAndStoresCurrentBinaryVersionWhenStoredVersionChanges() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("library/bundle-drop")
    let bundle = try makeBundle(root: root)
    let current = root.appendingPathComponent("current.json")
    let previous = root.appendingPathComponent("previous.json")
    let state = root.appendingPathComponent("state.json")
    let bundleInfo = docs.appendingPathComponent("bundle-info.json")

    try write("{\"hash\":\"\(validHash)\",\"bundlePath\":\"\(bundle.path)\"}", to: current)
    try write("{}", to: previous)
    try write("{}", to: state)
    try write("{}", to: bundleInfo)
    userDefaults.set("1.0.0-1", forKey: BundleDropLocatorCore.binaryVersionKey)
    var logs: [String] = []

    let bundleURL = BundleDropLocatorCore.bundleURL(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "2.0.0-7",
      userDefaults: userDefaults,
      shouldLogBinaryUpdate: true,
      log: { logs.append($0) }
    )

    XCTAssertNil(bundleURL)
    XCTAssertEqual(
      userDefaults.string(forKey: BundleDropLocatorCore.binaryVersionKey),
      "2.0.0-7"
    )
    XCTAssertFalse(FileManager.default.fileExists(atPath: current.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: previous.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: state.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: bundleInfo.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: bundle.path))
    XCTAssertEqual(
      logs,
      ["BundleDrop: Binary updated (1.0.0-1 → 2.0.0-7), clearing OTA bundle"]
    )
  }

  func testBinaryVersionKeyReadsVersionAndBuildFromBundleInfo() throws {
    let bundle = try makeBundleFixture(
      version: "3.4.5",
      build: "67"
    )

    XCTAssertEqual(BundleDropLocatorCore.getBinaryVersionKey(bundle: bundle), "3.4.5-67")
  }

  func testBinaryVersionKeyIncludesEmbeddedRuntimeVersion() throws {
    let bundle = try makeBundleFixture(
      version: "3.4.5",
      build: "67",
      runtimeVersion: "runtime-2"
    )

    XCTAssertEqual(
      BundleDropLocatorCore.getBinaryVersionKey(bundle: bundle),
      "runtime:runtime-2|binary:3.4.5-67"
    )
  }

  func testBinaryVersionKeyReadsRuntimeVersionFromSignedExpoBuildIdentity() throws {
    let bundle = try makeBundleFixture(
      version: "3.4.5",
      build: "67",
      embeddedRuntimeVersion: "runtime-from-build"
    )

    XCTAssertEqual(
      BundleDropLocatorCore.getBinaryVersionKey(bundle: bundle),
      "runtime:runtime-from-build|binary:3.4.5-67"
    )
  }

  func testEmbeddedBuildIdentityTakesPrecedenceOverLegacyInfoPlistRuntime() throws {
    let bundle = try makeBundleFixture(
      version: "3.4.5",
      build: "67",
      runtimeVersion: "legacy-runtime",
      embeddedRuntimeVersion: "signed-runtime"
    )

    XCTAssertEqual(BundleDropLocatorCore.getRuntimeVersion(bundle: bundle), "signed-runtime")
  }

  func testEmbeddedRuntimeChangeChangesTheBinaryVersionKey() throws {
    let runtimeTwo = try makeBundleFixture(
      version: "3.4.5",
      build: "67",
      embeddedRuntimeVersion: "runtime-2"
    )
    let runtimeThree = try makeBundleFixture(
      version: "3.4.5",
      build: "67",
      embeddedRuntimeVersion: "runtime-3"
    )

    XCTAssertNotEqual(
      BundleDropLocatorCore.getBinaryVersionKey(bundle: runtimeTwo),
      BundleDropLocatorCore.getBinaryVersionKey(bundle: runtimeThree)
    )
  }

  func testExpoBuildFailsClosedWhenRuntimeIdentityIsMissingOrInvalid() throws {
    let missingIdentity = try makeBundleFixture(
      version: "3.4.5",
      build: "67",
      expoEnabled: true
    )
    let wrongPlatformIdentity = try makeBundleFixture(
      version: "3.4.5",
      build: "67",
      expoEnabled: true,
      embeddedRuntimeVersion: "runtime-2",
      embeddedPlatform: "android"
    )
    let wrongSchemaIdentity = try makeBundleFixture(
      version: "3.4.5",
      build: "67",
      expoEnabled: true,
      embeddedRuntimeVersion: "runtime-2",
      embeddedSchemaVersion: 2
    )
    let malformedIdentity = try makeBundleFixture(
      version: "3.4.5",
      build: "67",
      expoEnabled: true,
      embeddedRuntimeVersion: "runtime-2"
    )
    try "{".write(
      to: malformedIdentity.bundleURL.appendingPathComponent(
        BundleDropLocatorCore.embeddedBuildIdentityFilename
      ),
      atomically: true,
      encoding: .utf8
    )
    let bareBuild = try makeBundleFixture(version: "3.4.5", build: "67")

    XCTAssertFalse(BundleDropLocatorCore.hasRuntimeIdentityForOta(bundle: missingIdentity))
    XCTAssertFalse(BundleDropLocatorCore.hasRuntimeIdentityForOta(bundle: wrongPlatformIdentity))
    XCTAssertFalse(BundleDropLocatorCore.hasRuntimeIdentityForOta(bundle: wrongSchemaIdentity))
    XCTAssertFalse(BundleDropLocatorCore.hasRuntimeIdentityForOta(bundle: malformedIdentity))
    XCTAssertTrue(BundleDropLocatorCore.hasRuntimeIdentityForOta(bundle: bareBuild))
  }

  func testFileSizeReturnsFileSizeAndZeroForMissingFile() throws {
    let file = tempRoot.appendingPathComponent("asset.bin")
    try Data([1, 2, 3, 4]).write(to: file)

    XCTAssertEqual(BundleDropLocatorCore.fileSize(at: file), 4)
    XCTAssertEqual(
      BundleDropLocatorCore.fileSize(at: tempRoot.appendingPathComponent("missing.bin")),
      0
    )
  }

  // MARK: - isOtaEnabled / killswitch gate

  func testIsOtaEnabledDefaultsToTrueWhenKeyIsAbsent() {
    XCTAssertTrue(BundleDropLocatorCore.isOtaEnabled(userDefaults: userDefaults))
  }

  func testIsOtaEnabledReturnsFalseWhenSetToFalse() {
    userDefaults.set(false, forKey: BundleDropLocatorCore.otaEnabledKey)
    XCTAssertFalse(BundleDropLocatorCore.isOtaEnabled(userDefaults: userDefaults))
  }

  func testIsOtaEnabledReturnsTrueWhenExplicitlySetToTrue() {
    userDefaults.set(true, forKey: BundleDropLocatorCore.otaEnabledKey)
    XCTAssertTrue(BundleDropLocatorCore.isOtaEnabled(userDefaults: userDefaults))
  }

  func testBundleURLReturnsNilWhenOtaIsDisabled() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("library/bundle-drop")
    let bundle = try makeBundle(root: root)
    try write(
      "{\"hash\":\"\(validHash)\",\"bundlePath\":\"\(bundle.path)\"}",
      to: root.appendingPathComponent("current.json")
    )
    userDefaults.set("1.0.0-1", forKey: BundleDropLocatorCore.binaryVersionKey)
    userDefaults.set(false, forKey: BundleDropLocatorCore.otaEnabledKey)

    let bundleURL = BundleDropLocatorCore.bundleURL(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "1.0.0-1",
      userDefaults: userDefaults,
      shouldLogBinaryUpdate: false
    )

    XCTAssertNil(bundleURL)
  }

  func testBundleURLReturnsBundleWhenOtaIsReEnabled() throws {
    let docs = try makeDirectory("docs")
    let root = try makeDirectory("library/bundle-drop")
    let bundle = try makeBundle(root: root)
    try write(
      "{\"hash\":\"\(validHash)\",\"bundlePath\":\"\(bundle.path)\"}",
      to: root.appendingPathComponent("current.json")
    )
    userDefaults.set("1.0.0-1", forKey: BundleDropLocatorCore.binaryVersionKey)
    userDefaults.set(true, forKey: BundleDropLocatorCore.otaEnabledKey)

    let bundleURL = BundleDropLocatorCore.bundleURL(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: "1.0.0-1",
      userDefaults: userDefaults,
      shouldLogBinaryUpdate: false
    )

    XCTAssertEqual(bundleURL, bundle)
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
    try write("{}", to: bundleDir.appendingPathComponent("metadata-ios.json"))
    let jsBundleHash = "1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc"
    let metadataHash = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    let canonicalFiles = [
      "{\"path\":\"main.jsbundle\",\"role\":\"jsbundle\",\"sha256\":\"\(jsBundleHash)\",\"size\":6}",
      "{\"path\":\"metadata-ios.json\",\"role\":\"metadata\",\"sha256\":\"\(metadataHash)\",\"size\":2}"
    ].joined(separator: ",")
    let canonicalManifest = "{\"bundleHash\":\"\(bundleHash)\",\"files\":[\(canonicalFiles)],\"jsBundleHash\":\"\(jsBundleHash)\",\"manifestVersion\":1,\"platform\":\"ios\",\"runtimeVersion\":\"1.0.0\",\"version\":\"1.0.0\"}"
    let manifestHash = sha256String(canonicalManifest)
    try write(
      "{\"manifestVersion\":1,\"bundleHash\":\"\(bundleHash)\",\"jsBundleHash\":\"\(jsBundleHash)\",\"platform\":\"ios\",\"runtimeVersion\":\"1.0.0\",\"version\":\"1.0.0\",\"manifestHash\":\"\(manifestHash)\",\"files\":[\(canonicalFiles)]}",
      to: bundleDir.appendingPathComponent("bundle-manifest.json")
    )
    return bundle
  }

  private func sha256String(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
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

  private func makeBundleFixture(
    version: String,
    build: String,
    runtimeVersion: String? = nil,
    expoEnabled: Bool = false,
    embeddedRuntimeVersion: String? = nil,
    embeddedPlatform: String = "ios",
    embeddedSchemaVersion: Int = 1
  ) throws -> Bundle {
    let bundleURL = tempRoot.appendingPathComponent(
      "Fixture-\(UUID().uuidString).bundle",
      isDirectory: true
    )
    try FileManager.default.createDirectory(
      at: bundleURL,
      withIntermediateDirectories: true
    )
    var plist: [String: Any] = [
      "CFBundleIdentifier": "app.bundledrop.fixture",
      "CFBundleInfoDictionaryVersion": "6.0",
      "CFBundleName": "Fixture",
      "CFBundlePackageType": "BNDL",
      "CFBundleShortVersionString": version,
      "CFBundleVersion": build,
    ]
    if let runtimeVersion {
      plist[BundleDropLocatorCore.runtimeVersionInfoKey] = runtimeVersion
    }
    if expoEnabled {
      plist[BundleDropLocatorCore.expoEnabledInfoKey] = true
    }
    let data = try PropertyListSerialization.data(
      fromPropertyList: plist,
      format: .xml,
      options: 0
    )
    try data.write(to: bundleURL.appendingPathComponent("Info.plist"))

    if let embeddedRuntimeVersion {
      let candidate: [String: Any] = [
        "schemaVersion": embeddedSchemaVersion,
        "platform": embeddedPlatform,
        "runtimeVersion": embeddedRuntimeVersion,
      ]
      let candidateData = try JSONSerialization.data(withJSONObject: candidate)
      try candidateData.write(
        to: bundleURL.appendingPathComponent(BundleDropLocatorCore.embeddedBuildIdentityFilename)
      )
    }

    return try XCTUnwrap(Bundle(url: bundleURL))
  }
}
