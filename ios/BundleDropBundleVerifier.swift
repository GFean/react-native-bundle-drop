import Foundation

enum BundleDropBundleVerifier {
  private static let manifestFileName = "bundle-manifest.json"

  static func verifyBundleFiles(
    bundleDir: URL,
    manifestURL: URL,
    fileManager: FileManager = .default
  ) throws {
    let manifest: [String: Any]
    do {
      let data = try Data(contentsOf: manifestURL)
      guard let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw BundleDropFileOps.error("Malformed bundle manifest")
      }
      manifest = parsed
    } catch {
      throw BundleDropFileOps.error("Malformed bundle manifest")
    }

    guard let files = manifest["files"] as? [[String: Any]] else {
      throw error("Bundle manifest must include files")
    }
    try verifyManifestFiles(bundleDir: bundleDir, files: files, fileManager: fileManager)
  }

  static func verifyManifestFiles(
    bundleDir: URL,
    files: [[String: Any]],
    fileManager: FileManager = .default
  ) throws {
    var allowed = Set([manifestFileName])

    for (index, file) in files.enumerated() {
      guard let path = file["path"] as? String else {
        throw error("Invalid manifest file entry at index \(index)")
      }
      guard isSafeManifestPath(path) else {
        throw error("Invalid manifest path: \(path)")
      }
      guard allowed.insert(path).inserted else {
        throw error("Duplicate manifest file path: \(path)")
      }
      guard let size = file["size"] as? NSNumber,
            let expectedSha = file["sha256"] as? String else {
        throw error("Invalid manifest file entry for \(path)")
      }

      let fileURL = bundleDir.appendingPathComponent(path)
      var isDirectory: ObjCBool = false
      guard fileManager.fileExists(atPath: fileURL.path, isDirectory: &isDirectory) else {
        throw error("Manifest file missing: \(path)")
      }
      guard !isDirectory.boolValue else {
        throw error("Manifest file is a directory: \(path)")
      }
      guard let attrs = try? fileManager.attributesOfItem(atPath: fileURL.path),
            let actualSize = attrs[.size] as? NSNumber,
            actualSize.int64Value == size.int64Value else {
        throw error("Manifest file size mismatch for \(path)")
      }
      guard try BundleDropFileOps.sha256File(fileURL.path) == expectedSha else {
        throw error("Manifest file hash mismatch for \(path)")
      }
    }

    let actualFiles = listRelativeFiles(root: bundleDir, fileManager: fileManager)
    if let extraFile = actualFiles.first(where: { !allowed.contains($0) }) {
      throw error("Unmanifested file in bundle archive: \(extraFile)")
    }
  }

  static func isSafeManifestPath(_ path: String) -> Bool {
    !path.isEmpty &&
      !path.hasPrefix("/") &&
      !path.contains("\\") &&
      !path.contains("\u{0000}") &&
      !path.split(separator: "/", omittingEmptySubsequences: false).contains { part in
        part.isEmpty || part == "." || part == ".."
      }
  }

  private static func listRelativeFiles(
    root: URL,
    current: URL? = nil,
    prefix: String = "",
    fileManager: FileManager
  ) -> [String] {
    let directory = current ?? root
    guard let entries = try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey]) else {
      return []
    }
    return entries.flatMap { entry -> [String] in
      let relativePath = prefix.isEmpty ? entry.lastPathComponent : "\(prefix)/\(entry.lastPathComponent)"
      let isDirectory = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
      return isDirectory
        ? listRelativeFiles(root: root, current: entry, prefix: relativePath, fileManager: fileManager)
        : [relativePath]
    }
  }

  private static func error(_ message: String) -> NSError {
    BundleDropFileOps.error(message)
  }
}
