import Foundation
import React

@objc(BundleDropModule)
final class BundleDropModule: NSObject {

  private static var isReloading = false
  private static let fm = FileManager.default
  private static let fileOpsQueue = DispatchQueue(label: "com.bundledrop.file-ops", qos: .userInitiated)

  private func runFileOperation(
    errorCode: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock,
    operation: @escaping () throws -> Any?
  ) {
    Self.fileOpsQueue.async {
      do {
        resolve(try operation())
      } catch {
        reject(errorCode, error.localizedDescription, error)
      }
    }
  }

  // MARK: - OTA bundle path

  @objc
  func getDownloadedBundlePath(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    if let url = BundleDropLocatorCore.bundleURL() {
      print("📦 Found downloaded bundle at: \(url.path)")
      resolve(url.path)
      return
    }
    print("📦 No downloaded bundle found.")
    resolve(nil)
  }

  @objc
  func setOtaEnabled(
    _ enabled: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    UserDefaults.standard.set(enabled, forKey: BundleDropLocatorCore.otaEnabledKey)
    resolve(nil)
  }

  @objc
  func restartReactNative() {
    DispatchQueue.main.async {
      if Self.isReloading {
        print("🔁 Restart already in progress - ignoring.")
        return
      }

      guard let url = BundleDropLocatorCore.bundleURL() else {
        print("⚠️ No downloaded bundle found; skipping restart.")
        return
      }

      let size = BundleDropLocatorCore.fileSize(at: url)
      if size < 1024 {
        print("⚠️ Bundle exists but looks invalid (size=\(size)). Skipping restart.")
        return
      }

      Self.isReloading = true
      print("🔄 Restarting RN from \(url.path) size=\(size)")

      RCTReloadCommandSetBundleURL(url)
      RCTTriggerReloadCommandListeners("bundle-drop-restart")

      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
        Self.isReloading = false
      }
    }
  }

  // MARK: - Constants

  @objc
  func constantsToExport() -> [String: Any] {
    let fm = FileManager.default
    let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first?.path ?? ""
    let lib = fm.urls(for: .libraryDirectory, in: .userDomainMask).first?.path ?? ""
    return [
      "DocumentDirectoryPath": docs,
      "LibraryDirectoryPath": lib,
    ]
  }

  // MARK: - FS primitives (replaces react-native-fs dependency)

  @objc
  func fsExists(
    _ path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(Self.fm.fileExists(atPath: path))
  }

  @objc
  func fsReadFile(
    _ path: String,
    encoding: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard Self.fm.fileExists(atPath: path) else {
      reject("ENOENT", "File not found: \(path)", nil)
      return
    }
    do {
      let fileURL = URL(fileURLWithPath: path)
      if encoding == "base64" {
        let data = try Data(contentsOf: fileURL)
        resolve(data.base64EncodedString())
      } else {
        let text = try String(contentsOf: fileURL, encoding: .utf8)
        resolve(text)
      }
    } catch {
      reject("ERR_READ", error.localizedDescription, error)
    }
  }

  @objc
  func fsWriteFile(
    _ path: String,
    content: String,
    encoding: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let dir = (path as NSString).deletingLastPathComponent
      if !Self.fm.fileExists(atPath: dir) {
        try Self.fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
      }
      let fileURL = URL(fileURLWithPath: path)
      if encoding == "base64" {
        guard let data = Data(base64Encoded: content) else {
          reject("ERR_WRITE", "Invalid base64 data", nil)
          return
        }
        try data.write(to: fileURL)
      } else {
        try content.write(to: fileURL, atomically: true, encoding: .utf8)
      }
      resolve(nil)
    } catch {
      reject("ERR_WRITE", error.localizedDescription, error)
    }
  }

  @objc
  func fsMkdir(
    _ path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      if !Self.fm.fileExists(atPath: path) {
        try Self.fm.createDirectory(atPath: path, withIntermediateDirectories: true)
      }
      resolve(nil)
    } catch {
      reject("ERR_MKDIR", error.localizedDescription, error)
    }
  }

  @objc
  func fsUnlink(
    _ path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try BundleDropFileOps.unlinkPath(path)
      resolve(nil)
    } catch {
      reject("ERR_UNLINK", error.localizedDescription, error)
    }
  }

  @objc
  func fsReadDir(
    _ path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let items = try Self.fm.contentsOfDirectory(atPath: path)
      resolve(items)
    } catch {
      reject("ERR_READDIR", error.localizedDescription, error)
    }
  }

  @objc
  func fsMoveFile(
    _ src: String,
    dest: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runFileOperation(errorCode: "ERR_MOVE", resolve: resolve, reject: reject) {
      try BundleDropFileOps.moveFile(srcPath: src, destPath: dest)
      return nil
    }
  }

  @objc
  func fsCopyFile(
    _ src: String,
    dest: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runFileOperation(errorCode: "ERR_COPY", resolve: resolve, reject: reject) {
      try BundleDropFileOps.copyFile(srcPath: src, destPath: dest)
      return nil
    }
  }

  @objc
  func fsSha256File(
    _ path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runFileOperation(errorCode: "ERR_SHA256", resolve: resolve, reject: reject) {
      try BundleDropFileOps.sha256File(path)
    }
  }

  @objc
  func fsFileSize(
    _ path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      resolve(try BundleDropFileOps.fileSize(path))
    } catch {
      reject("ERR_FILE_SIZE", error.localizedDescription, error)
    }
  }

  @objc
  func fsApplyXdelta(
    _ basePath: String,
    patchPath: String,
    outputPath: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runFileOperation(errorCode: "ERR_XDELTA", resolve: resolve, reject: reject) {
      try BundleDropFileOps.applyXdelta(
        basePath: basePath,
        patchPath: patchPath,
        outputPath: outputPath
      )
      return nil
    }
  }

  @objc
  func fsVerifyBundleFiles(
    _ bundleDir: String,
    manifestPath: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runFileOperation(errorCode: "ERR_VERIFY_BUNDLE", resolve: resolve, reject: reject) {
      try BundleDropBundleVerifier.verifyBundleFiles(
        bundleDir: URL(fileURLWithPath: bundleDir),
        manifestURL: URL(fileURLWithPath: manifestPath)
      )
      return ["verified": true]
    }
  }

  @objc
  func fsSupportsXdelta(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(BundleDropFileOps.supportsXdelta())
  }

  @objc
  func fsUnzip(
    _ zipPath: String,
    destPath: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    runFileOperation(errorCode: "ERR_UNZIP", resolve: resolve, reject: reject) {
      let filenames = try BundleDropZipExtractor.extractZip(atPath: zipPath,
                                                            toDirectory: destPath)
      return filenames ?? []
    }
  }

  @objc
  func fsDownloadFile(
    _ url: String,
    destPath: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 300

    BundleDropFileOps.downloadToFile(
      urlString: url,
      destPath: destPath,
      configuration: config
    ) { result in
      switch result {
      case .success:
        resolve(nil)
      case .failure(let error):
        reject("ERR_DOWNLOAD", error.localizedDescription, error)
      }
    }
  }
}
