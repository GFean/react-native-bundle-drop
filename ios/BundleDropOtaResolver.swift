import Foundation
import CryptoKit

struct BundleDropOtaResolveResult {
  let bundleURL: URL?
  let clearedOta: Bool
  let storedVersion: String
}

struct BundleDropOtaPointer {
  let hash: String
  let bundleURL: URL
  let runtimeVersion: String
}

enum BundleDropOtaResolver {
  static func readCurrentPointer(
    bundleDropRoot: URL,
    expectedRuntimeVersion: String? = nil,
    fileManager: FileManager = .default
  ) -> URL? {
    readPointer(
      named: "current.json",
      bundleDropRoot: bundleDropRoot,
      expectedRuntimeVersion: expectedRuntimeVersion,
      fileManager: fileManager
    )?.bundleURL
  }

  static func readPointer(
    named filename: String,
    bundleDropRoot: URL,
    expectedRuntimeVersion: String? = nil,
    fileManager: FileManager = .default
  ) -> BundleDropOtaPointer? {
    let pointerURL = bundleDropRoot.appendingPathComponent(filename)
    guard fileManager.fileExists(atPath: pointerURL.path) else { return nil }

    do {
      let data = try Data(contentsOf: pointerURL)
      let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      guard let hash = obj?["hash"] as? String,
            hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        return nil
      }
      return verifiedBundle(
        hash: hash,
        bundleDropRoot: bundleDropRoot,
        expectedRuntimeVersion: expectedRuntimeVersion,
        fileManager: fileManager
      )
    } catch {
      return nil
    }
  }

  static func readBundle(
    hash: String,
    bundleDropRoot: URL,
    expectedRuntimeVersion: String? = nil,
    fileManager: FileManager = .default
  ) -> BundleDropOtaPointer? {
    guard hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
      return nil
    }
    return verifiedBundle(
      hash: hash,
      bundleDropRoot: bundleDropRoot,
      expectedRuntimeVersion: expectedRuntimeVersion,
      fileManager: fileManager
    )
  }

  private static func verifiedBundle(
    hash: String,
    bundleDropRoot: URL,
    expectedRuntimeVersion: String?,
    fileManager: FileManager
  ) -> BundleDropOtaPointer? {
    let bundleURL = bundleDropRoot
      .appendingPathComponent("bundles")
      .appendingPathComponent(hash)
      .appendingPathComponent("main.jsbundle")
    let manifestURL = bundleURL
      .deletingLastPathComponent()
      .appendingPathComponent("bundle-manifest.json")
    guard fileManager.fileExists(atPath: manifestURL.path),
          let manifestData = try? Data(contentsOf: manifestURL),
          let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
          (manifest["manifestVersion"] as? NSNumber)?.intValue == 1,
          manifest["bundleHash"] as? String == hash,
          let runtimeVersion = manifest["runtimeVersion"] as? String,
          expectedRuntimeVersion == nil || runtimeVersion == expectedRuntimeVersion,
          verifyBundleDir(
            bundleDir: bundleURL.deletingLastPathComponent(),
            manifest: manifest,
            expectedHash: hash,
            fileManager: fileManager
          ),
          fileManager.fileExists(atPath: bundleURL.path) else {
      return nil
    }
    return BundleDropOtaPointer(hash: hash, bundleURL: bundleURL, runtimeVersion: runtimeVersion)
  }

  static func writePointer(
    named filename: String,
    hash: String,
    bundleDropRoot: URL,
    fileManager: FileManager = .default
  ) throws {
    guard hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
      throw NSError(
        domain: "BundleDropStartupRecovery",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Bundle pointer hash is invalid"]
      )
    }
    try fileManager.createDirectory(at: bundleDropRoot, withIntermediateDirectories: true)
    let pointerURL = bundleDropRoot.appendingPathComponent(filename)
    let pointer: [String: Any] = [
      "hash": hash,
      "updatedAt": ISO8601DateFormatter().string(from: Date()),
    ]
    let temporaryURL = bundleDropRoot.appendingPathComponent(
      ".\(filename)-\(UUID().uuidString).tmp"
    )
    do {
      try JSONSerialization.data(withJSONObject: pointer, options: [.sortedKeys])
        .write(to: temporaryURL)
      let handle = try FileHandle(forWritingTo: temporaryURL)
      try handle.synchronize()
      try handle.close()
      if fileManager.fileExists(atPath: pointerURL.path) {
        _ = try fileManager.replaceItemAt(pointerURL, withItemAt: temporaryURL)
      } else {
        try fileManager.moveItem(at: temporaryURL, to: pointerURL)
      }
    } catch {
      try? fileManager.removeItem(at: temporaryURL)
      throw error
    }
  }

  static func deletePointer(
    named filename: String,
    bundleDropRoot: URL,
    fileManager: FileManager = .default
  ) throws {
    let pointerURL = bundleDropRoot.appendingPathComponent(filename)
    if fileManager.fileExists(atPath: pointerURL.path) {
      try fileManager.removeItem(at: pointerURL)
    }
  }

  private static func verifyBundleDir(
    bundleDir: URL,
    manifest: [String: Any],
    expectedHash: String,
    fileManager: FileManager
  ) -> Bool {
    guard let files = manifest["files"] as? [[String: Any]] else { return false }
    guard manifest["platform"] as? String == "ios" else { return false }
    var mainBundleHash: String?
    var jsBundleRoleCount = 0
    var metadataRoleCount = 0
    var metadataPathMatches = false
    var androidImageManifestRoleCount = 0

    for file in files {
      guard let path = file["path"] as? String,
            let expectedSha = file["sha256"] as? String,
            let role = file["role"] as? String else {
        return false
      }
      guard BundleDropBundleVerifier.isSafeManifestPath(path) else { return false }
      switch role {
      case "jsbundle":
        jsBundleRoleCount += 1
        if path == "main.jsbundle" {
          mainBundleHash = expectedSha
        }
      case "metadata":
        metadataRoleCount += 1
        if path == "metadata-ios.json" {
          metadataPathMatches = true
        }
      case "androidImageManifest":
        androidImageManifestRoleCount += 1
      default:
        break
      }
    }

    guard let jsBundleHash = manifest["jsBundleHash"] as? String,
          jsBundleRoleCount == 1,
          mainBundleHash == jsBundleHash,
          metadataRoleCount == 1,
          metadataPathMatches,
          androidImageManifestRoleCount == 0,
          calculateBundleHash(files: files) == expectedHash else {
      return false
    }
    guard verifyManifestHash(manifest: manifest, files: files) else {
      return false
    }
    do {
      try BundleDropBundleVerifier.verifyManifestFiles(
        bundleDir: bundleDir,
        files: files,
        fileManager: fileManager
      )
      return true
    } catch {
      return false
    }
  }

  private static func calculateBundleHash(files: [[String: Any]]) -> String {
    let entries = canonicalFileEntries(files: files)
    let canonical = "{\"files\":[\(entries.joined(separator: ","))],\"manifestVersion\":1}"
    return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private static func verifyManifestHash(manifest: [String: Any], files: [[String: Any]]) -> Bool {
    guard let manifestHash = manifest["manifestHash"] as? String,
          manifestHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
      return false
    }
    for field in ["bundleHash", "jsBundleHash", "platform", "runtimeVersion", "version"] {
      guard let value = manifest[field] as? String, !value.isEmpty else { return false }
    }
    let canonical = [
      "\"bundleHash\":\(jsonString(manifest["bundleHash"] as? String ?? ""))",
      "\"files\":[\(canonicalFileEntries(files: files).joined(separator: ","))]",
      "\"jsBundleHash\":\(jsonString(manifest["jsBundleHash"] as? String ?? ""))",
      "\"manifestVersion\":1",
      "\"platform\":\(jsonString(manifest["platform"] as? String ?? ""))",
      "\"runtimeVersion\":\(jsonString(manifest["runtimeVersion"] as? String ?? ""))",
      "\"version\":\(jsonString(manifest["version"] as? String ?? ""))"
    ].joined(separator: ",")
    let expectedHash = SHA256.hash(data: Data("{\(canonical)}".utf8)).map { String(format: "%02x", $0) }.joined()
    return expectedHash == manifestHash
  }

  private static func canonicalFileEntries(files: [[String: Any]]) -> [String] {
    return files.map { file -> (path: String, serialized: String) in
      let path = file["path"] as? String ?? ""
      let executable = (file["executable"] as? Bool) == true ? "\"executable\":true," : ""
      return (
        path,
        "{\(executable)\"path\":\(jsonString(path)),\"role\":\(jsonString(file["role"] as? String ?? "")),\"sha256\":\(jsonString(file["sha256"] as? String ?? "")),\"size\":\((file["size"] as? NSNumber)?.int64Value ?? -1)}"
      )
    }
    .sorted { compareUtf8($0.path, $1.path) < 0 }
    .map(\.serialized)
  }

  private static func compareUtf8(_ left: String, _ right: String) -> Int {
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

  private static func jsonString(_ value: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [value]),
          let encoded = String(data: data, encoding: .utf8) else {
      return "\"\""
    }
    return String(encoded.dropFirst().dropLast()).replacingOccurrences(of: "\\/", with: "/")
  }

  @discardableResult
  static func clearOtaState(
    bundleDropRoot: URL,
    documentsDirectory: URL,
    fileManager: FileManager = .default
  ) -> Bool {
    let filesToClear = [
      bundleDropRoot.appendingPathComponent("current.json"),
      bundleDropRoot.appendingPathComponent("previous.json"),
      bundleDropRoot.appendingPathComponent("state.json"),
      bundleDropRoot.appendingPathComponent("recovery-ledger.json"),
      documentsDirectory.appendingPathComponent("bundle-info.json"),
    ]

    var clearedAllFiles = true
    filesToClear.forEach { url in
      do {
        if fileManager.fileExists(atPath: url.path) {
          try fileManager.removeItem(at: url)
        }
      } catch {
        clearedAllFiles = false
        // Best effort cleanup; a single bad file should not block native fallback.
      }
    }
    return clearedAllFiles
  }

  static func hasOtaState(
    bundleDropRoot: URL,
    documentsDirectory: URL,
    fileManager: FileManager = .default
  ) -> Bool {
    [
      bundleDropRoot.appendingPathComponent("current.json"),
      bundleDropRoot.appendingPathComponent("previous.json"),
      bundleDropRoot.appendingPathComponent("state.json"),
      bundleDropRoot.appendingPathComponent("recovery-ledger.json"),
      documentsDirectory.appendingPathComponent("bundle-info.json"),
    ].contains { url in
      fileManager.fileExists(atPath: url.path)
    }
  }

  static func resolve(
    bundleDropRoot: URL,
    documentsDirectory: URL,
    currentBinaryVersion: String,
    storedBinaryVersion: String?,
    fileManager: FileManager = .default
  ) -> BundleDropOtaResolveResult {
    if let storedBinaryVersion = storedBinaryVersion,
       storedBinaryVersion != currentBinaryVersion {
      let hadOtaState = hasOtaState(
        bundleDropRoot: bundleDropRoot,
        documentsDirectory: documentsDirectory,
        fileManager: fileManager
      )
      let clearedAllFiles = clearOtaState(
        bundleDropRoot: bundleDropRoot,
        documentsDirectory: documentsDirectory,
        fileManager: fileManager
      )
      return BundleDropOtaResolveResult(
        bundleURL: nil,
        clearedOta: hadOtaState,
        storedVersion: clearedAllFiles ? currentBinaryVersion : storedBinaryVersion
      )
    }

    guard let bundleURL = readCurrentPointer(
      bundleDropRoot: bundleDropRoot,
      fileManager: fileManager
    ) else {
      return BundleDropOtaResolveResult(
        bundleURL: nil,
        clearedOta: false,
        storedVersion: currentBinaryVersion
      )
    }

    return BundleDropOtaResolveResult(
      bundleURL: bundleURL,
      clearedOta: false,
      storedVersion: currentBinaryVersion
    )
  }
}
