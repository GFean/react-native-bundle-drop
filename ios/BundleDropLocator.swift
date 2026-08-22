import Foundation

@objc(BundleDropLocatorCore) public final class BundleDropLocatorCore: NSObject {

  static let binaryVersionKey = "BundleDropBinaryVersion"
  static let runtimeVersionInfoKey = "BundleDropRuntimeVersion"
  static let expoEnabledInfoKey = "BundleDropExpoEnabled"
  static let embeddedBuildIdentityFilename = ".bundle-drop-build-identity.json"

  private struct EmbeddedBuildIdentity: Decodable {
    let schemaVersion: Int
    let platform: String
    let runtimeVersion: String
  }

  /// Matches Android `BundleDropOtaPrefs.KEY_OTA_ENABLED` for cross-platform debugging.
  static let otaEnabledKey = "bundledrop_ota_enabled"

  static func isOtaEnabled(userDefaults: UserDefaults = .standard) -> Bool {
    if userDefaults.object(forKey: otaEnabledKey) == nil { return true }
    return userDefaults.bool(forKey: otaEnabledKey)
  }

  static func getBinaryVersionKey(bundle: Bundle = .main) -> String {
    let version = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
    let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    let binaryVersion = "\(version)-\(build)"
    guard let runtimeVersion = getRuntimeVersion(bundle: bundle) else {
      return binaryVersion
    }
    return "runtime:\(runtimeVersion)|binary:\(binaryVersion)"
  }

  static func getRuntimeVersion(bundle: Bundle = .main) -> String? {
    if let embeddedRuntimeVersion = getEmbeddedRuntimeVersion(bundle: bundle) {
      return embeddedRuntimeVersion
    }
    return normalizeRuntimeVersion(bundle.infoDictionary?[runtimeVersionInfoKey] as? String)
  }

  static func hasRuntimeIdentityForOta(bundle: Bundle = .main) -> Bool {
    let isExpoBuild = bundle.infoDictionary?[expoEnabledInfoKey] as? Bool == true
    return !isExpoBuild || getEmbeddedRuntimeVersion(bundle: bundle) != nil
  }

  private static func getEmbeddedRuntimeVersion(bundle: Bundle) -> String? {
    let candidateURL = bundle.bundleURL.appendingPathComponent(embeddedBuildIdentityFilename)
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: candidateURL.path),
          let fileType = attributes[.type] as? FileAttributeType,
          fileType == .typeRegular,
          let fileSize = attributes[.size] as? NSNumber,
          fileSize.intValue > 0,
          fileSize.intValue <= 64 * 1024,
          let data = try? Data(contentsOf: candidateURL),
          let candidate = try? JSONDecoder().decode(EmbeddedBuildIdentity.self, from: data),
          candidate.schemaVersion == 1,
          candidate.platform == "ios" else {
      return nil
    }
    return normalizeRuntimeVersion(candidate.runtimeVersion)
  }

  private static func normalizeRuntimeVersion(_ runtimeVersion: String?) -> String? {
    guard let runtimeVersion else { return nil }
    let normalized = runtimeVersion.trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized.isEmpty ? nil : normalized
  }

  @objc public static func bundleURL() -> URL? {
    guard hasRuntimeIdentityForOta() else {
      print("BundleDrop: Expo runtime identity is missing; using the embedded bundle")
      return nil
    }
    let fm = FileManager.default
    guard let lib = fm.urls(for: .libraryDirectory, in: .userDomainMask).first else { return nil }
    guard let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
    let root = lib.appendingPathComponent("bundle-drop", isDirectory: true)

    let currentVersion = getBinaryVersionKey()
    return bundleURL(
      bundleDropRoot: root,
      documentsDirectory: docs,
      currentBinaryVersion: currentVersion
    )
  }

  static func bundleURL(
    bundleDropRoot: URL,
    documentsDirectory: URL,
    currentBinaryVersion: String,
    userDefaults: UserDefaults = .standard,
    fileManager: FileManager = .default,
    shouldLogBinaryUpdate: Bool = true,
    log: (String) -> Void = { print($0) }
  ) -> URL? {
    // Single gate for public and internal entrypoints (tests inject `userDefaults`).
    if !isOtaEnabled(userDefaults: userDefaults) { return nil }
    let lastVersion = userDefaults.string(forKey: binaryVersionKey)
    let result = BundleDropOtaResolver.resolve(
      bundleDropRoot: bundleDropRoot,
      documentsDirectory: documentsDirectory,
      currentBinaryVersion: currentBinaryVersion,
      storedBinaryVersion: lastVersion,
      fileManager: fileManager
    )

    if shouldLogBinaryUpdate, result.clearedOta, let lastVersion = lastVersion {
      log("BundleDrop: Binary updated (\(lastVersion) → \(currentBinaryVersion)), clearing OTA bundle")
    }

    userDefaults.set(result.storedVersion, forKey: binaryVersionKey)
    return result.bundleURL
  }

  @objc public static func fileSize(at url: URL) -> UInt64 {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? UInt64) ?? 0
  }
}
