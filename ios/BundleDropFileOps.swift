import Foundation
import CryptoKit

@_silgen_name("bd_xdelta_apply")
private func bdXdeltaApply(
  _ basePath: UnsafePointer<CChar>,
  _ patchPath: UnsafePointer<CChar>,
  _ outputPath: UnsafePointer<CChar>,
  _ errorBuffer: UnsafeMutablePointer<CChar>,
  _ errorBufferLen: Int
) -> Int32

@_silgen_name("bd_xdelta_self_test")
private func bdXdeltaSelfTest() -> Int32

enum BundleDropFileOps {
  static let defaultMaxDownloadBytes: Int64 = 256 * 1024 * 1024
  private static let patchTargetDirPrefix = "_patch_target_"
  private static let bundleHashPattern = #"^[a-f0-9]{64}$"#

  static func validateHttpUrl(_ urlString: String) throws -> URL {
    guard let url = URL(string: urlString),
          let scheme = url.scheme?.lowercased(),
          scheme == "https" || scheme == "http",
          url.host != nil else {
      throw error("Invalid or non-HTTP URL: \(urlString)")
    }
    return url
  }

  static func unlinkPath(
    _ path: String,
    fileManager: FileManager = .default
  ) throws {
    if fileManager.fileExists(atPath: path) {
      try fileManager.removeItem(atPath: path)
    }
  }

  static func moveFile(
    srcPath: String,
    destPath: String,
    fileManager: FileManager = .default
  ) throws {
    let destURL = URL(fileURLWithPath: destPath)
    let destDir = destURL.deletingLastPathComponent()
    if !fileManager.fileExists(atPath: destDir.path) {
      try fileManager.createDirectory(
        at: destDir,
        withIntermediateDirectories: true
      )
    }

    if fileManager.fileExists(atPath: destPath) {
      try fileManager.removeItem(atPath: destPath)
    }

    try fileManager.moveItem(
      at: URL(fileURLWithPath: srcPath),
      to: destURL
    )
  }

  static func copyFile(
    srcPath: String,
    destPath: String,
    fileManager: FileManager = .default
  ) throws {
    let destURL = URL(fileURLWithPath: destPath)
    let destDir = destURL.deletingLastPathComponent()
    if !fileManager.fileExists(atPath: destDir.path) {
      try fileManager.createDirectory(
        at: destDir,
        withIntermediateDirectories: true
      )
    }
    if fileManager.fileExists(atPath: destPath) {
      try fileManager.removeItem(atPath: destPath)
    }
    try fileManager.copyItem(
      at: URL(fileURLWithPath: srcPath),
      to: destURL
    )
  }

  static func sha256File(_ path: String) throws -> String {
    let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
    defer {
      if #available(iOS 13.0, macOS 10.15, *) {
        try? handle.close()
      } else {
        handle.closeFile()
      }
    }

    var hasher = SHA256()
    while autoreleasepool(invoking: {
      let data = handle.readData(ofLength: 64 * 1024)
      if data.isEmpty { return false }
      hasher.update(data: data)
      return true
    }) {}

    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  static func fileSize(
    _ path: String,
    fileManager: FileManager = .default
  ) throws -> Int64 {
    let attrs = try fileManager.attributesOfItem(atPath: path)
    guard let size = attrs[.size] as? NSNumber else {
      throw error("File size is unavailable: \(path)")
    }
    return size.int64Value
  }

  static func supportsXdelta() -> Bool {
    bdXdeltaSelfTest() == 1
  }

  static func applyXdelta(
    basePath: String,
    patchPath: String,
    outputPath: String
  ) throws {
    try validateXdeltaOutputPath(outputPath)

    try FileManager.default.createDirectory(
      atPath: URL(fileURLWithPath: outputPath).deletingLastPathComponent().path,
      withIntermediateDirectories: true
    )

    var errorBuffer = [CChar](repeating: 0, count: 512)
    let result = basePath.withCString { baseCString in
      patchPath.withCString { patchCString in
        outputPath.withCString { outputCString in
          bdXdeltaApply(
            baseCString,
            patchCString,
            outputCString,
            &errorBuffer,
            errorBuffer.count
          )
        }
      }
    }

    if result != 0 {
      try? FileManager.default.removeItem(atPath: outputPath)
      let message = String(cString: errorBuffer)
      throw error(message.isEmpty ? "xdelta3-vcdiff native apply failed" : message)
    }
  }

  private static func validateXdeltaOutputPath(_ outputPath: String) throws {
    if outputPath.contains("\0") {
      throw error("xdelta output path contains a null byte")
    }
    if outputPath.contains("\\") {
      throw error("xdelta output path must not contain unsafe separators")
    }
    if outputPath.split(separator: "/").contains("..") {
      throw error("xdelta output path must not contain traversal segments")
    }

    let outputURL = URL(fileURLWithPath: outputPath).standardizedFileURL
    let components = outputURL.pathComponents.filter { $0 != "/" }
    guard components.count >= 4 else {
      throw error("xdelta output path must be inside bundle-drop/bundles/_patch_target_<bundleHash>")
    }

    for index in 0..<(components.count - 3) {
      guard components[index] == "bundle-drop",
            components[index + 1] == "bundles" else {
        continue
      }

      let patchTargetDir = components[index + 2]
      guard patchTargetDir.hasPrefix(patchTargetDirPrefix) else {
        throw error("xdelta output path must not target an active bundle folder")
      }

      let targetHash = String(patchTargetDir.dropFirst(patchTargetDirPrefix.count))
      guard targetHash.range(
        of: bundleHashPattern,
        options: .regularExpression
      ) != nil else {
        throw error("xdelta output path must use a valid patch target temp directory")
      }

      return
    }

    throw error("xdelta output path must be inside bundle-drop/bundles/_patch_target_<bundleHash>")
  }

  static func downloadToFile(
    urlString: String,
    destPath: String,
    maxBytes: Int64 = defaultMaxDownloadBytes,
    configuration: URLSessionConfiguration = .default,
    fileManager: FileManager = .default,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    do {
      let url = try validateHttpUrl(urlString)
      downloadToFile(
        url: url,
        destPath: destPath,
        maxBytes: maxBytes,
        configuration: configuration,
        fileManager: fileManager,
        completion: completion
      )
    } catch {
      completion(.failure(error))
    }
  }

  static func downloadToFile(
    url: URL,
    destPath: String,
    maxBytes: Int64 = defaultMaxDownloadBytes,
    configuration: URLSessionConfiguration = .default,
    fileManager: FileManager = .default,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    let delegate = BundleDropDownloadDelegate(
      destURL: URL(fileURLWithPath: destPath),
      maxBytes: maxBytes,
      fileManager: fileManager,
      completion: completion
    )
    let session = URLSession(
      configuration: configuration,
      delegate: delegate,
      delegateQueue: nil
    )
    delegate.session = session
    session.dataTask(with: url).resume()
  }

  static func error(_ message: String) -> NSError {
    NSError(
      domain: "BundleDrop",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }
}

private final class BundleDropDownloadDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let destURL: URL
  private let maxBytes: Int64
  private let fileManager: FileManager
  private let completion: (Result<Void, Error>) -> Void
  private var fileHandle: FileHandle?
  private var bytesWritten: Int64 = 0
  private var finished = false

  weak var session: URLSession?

  init(
    destURL: URL,
    maxBytes: Int64,
    fileManager: FileManager,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    self.destURL = destURL
    self.maxBytes = maxBytes
    self.fileManager = fileManager
    self.completion = completion
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let httpResponse = response as? HTTPURLResponse else {
      fail(BundleDropFileOps.error("Invalid HTTP response"))
      completionHandler(.cancel)
      return
    }

    guard (200...299).contains(httpResponse.statusCode) else {
      fail(BundleDropFileOps.error("HTTP \(httpResponse.statusCode)"))
      completionHandler(.cancel)
      return
    }

    do {
      let destDir = destURL.deletingLastPathComponent()
      if !fileManager.fileExists(atPath: destDir.path) {
        try fileManager.createDirectory(
          at: destDir,
          withIntermediateDirectories: true
        )
      }
      if fileManager.fileExists(atPath: destURL.path) {
        try fileManager.removeItem(at: destURL)
      }
      fileManager.createFile(atPath: destURL.path, contents: nil)
      fileHandle = try FileHandle(forWritingTo: destURL)
      completionHandler(.allow)
    } catch {
      fail(error)
      completionHandler(.cancel)
    }
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive data: Data
  ) {
    guard !finished else { return }

    let nextBytesWritten = bytesWritten + Int64(data.count)
    if nextBytesWritten > maxBytes {
      fail(BundleDropFileOps.error(
        "Download exceeds \(maxBytes / (1024 * 1024)) MB limit"
      ))
      dataTask.cancel()
      return
    }

    bytesWritten = nextBytesWritten
    fileHandle?.write(data)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    guard !finished else { return }

    if let error = error {
      fail(error)
      return
    }

    finished = true
    closeFile()
    completion(.success(()))
    session.finishTasksAndInvalidate()
  }

  private func fail(_ error: Error) {
    guard !finished else { return }
    finished = true
    closeFile()
    try? fileManager.removeItem(at: destURL)
    completion(.failure(error))
    session?.invalidateAndCancel()
  }

  private func closeFile() {
    if #available(iOS 13.0, macOS 10.15, *) {
      try? fileHandle?.close()
    } else {
      fileHandle?.closeFile()
    }
    fileHandle = nil
  }
}
