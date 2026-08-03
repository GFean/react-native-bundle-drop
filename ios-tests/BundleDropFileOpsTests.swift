import XCTest
@testable import BundleDropIOSCore

final class BundleDropFileOpsTests: XCTestCase {
  private var tempRoot: URL!

  override func setUpWithError() throws {
    tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("BundleDropFileOpsTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: tempRoot,
      withIntermediateDirectories: true
    )
  }

  override func tearDownWithError() throws {
    MockURLProtocol.handler = nil
    if let tempRoot {
      try? FileManager.default.removeItem(at: tempRoot)
    }
    tempRoot = nil
  }

  func testValidateHttpUrlAcceptsHttpAndHttps() throws {
    XCTAssertEqual(
      try BundleDropFileOps.validateHttpUrl("https://cdn.example.com/bundle.zip").scheme,
      "https"
    )
    XCTAssertEqual(
      try BundleDropFileOps.validateHttpUrl("http://localhost:4000/bundle.zip").scheme,
      "http"
    )
  }

  func testValidateHttpUrlRejectsUnsupportedOrMalformedUrls() {
    XCTAssertThrowsError(try BundleDropFileOps.validateHttpUrl("file:///etc/passwd"))
    XCTAssertThrowsError(try BundleDropFileOps.validateHttpUrl("ftp://ftp.example.com/file"))
    XCTAssertThrowsError(try BundleDropFileOps.validateHttpUrl(""))
    XCTAssertThrowsError(try BundleDropFileOps.validateHttpUrl("not-a-url"))
  }

  func testUnlinkPathDeletesFileDirectoryAndMissingPathIsNoop() throws {
    let file = tempRoot.appendingPathComponent("file.txt")
    try "data".write(to: file, atomically: true, encoding: .utf8)
    try BundleDropFileOps.unlinkPath(file.path)
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))

    let nested = tempRoot.appendingPathComponent("parent/child", isDirectory: true)
    try FileManager.default.createDirectory(
      at: nested,
      withIntermediateDirectories: true
    )
    let nestedFile = nested.appendingPathComponent("nested.txt")
    try "data".write(to: nestedFile, atomically: true, encoding: .utf8)
    try BundleDropFileOps.unlinkPath(tempRoot.appendingPathComponent("parent").path)
    XCTAssertFalse(FileManager.default.fileExists(atPath: nested.path))

    XCTAssertNoThrow(try BundleDropFileOps.unlinkPath(tempRoot.appendingPathComponent("missing").path))
  }

  func testMoveFileCreatesParentDirectoriesAndOverwritesDestination() throws {
    let src = tempRoot.appendingPathComponent("source.txt")
    let dest = tempRoot.appendingPathComponent("deep/nested/dest.txt")
    try "new".write(to: src, atomically: true, encoding: .utf8)

    try BundleDropFileOps.moveFile(srcPath: src.path, destPath: dest.path)

    XCTAssertFalse(FileManager.default.fileExists(atPath: src.path))
    XCTAssertEqual(try String(contentsOf: dest), "new")

    let replacement = tempRoot.appendingPathComponent("replacement.txt")
    try "replacement".write(to: replacement, atomically: true, encoding: .utf8)

    try BundleDropFileOps.moveFile(srcPath: replacement.path, destPath: dest.path)

    XCTAssertFalse(FileManager.default.fileExists(atPath: replacement.path))
    XCTAssertEqual(try String(contentsOf: dest), "replacement")
  }

  func testCopyFileCreatesParentDirectoriesAndLeavesSourceInPlace() throws {
    let src = tempRoot.appendingPathComponent("copy-source.txt")
    let dest = tempRoot.appendingPathComponent("copy/deep/dest.txt")
    try "copy-data".write(to: src, atomically: true, encoding: .utf8)

    try BundleDropFileOps.copyFile(srcPath: src.path, destPath: dest.path)

    XCTAssertTrue(FileManager.default.fileExists(atPath: src.path))
    XCTAssertEqual(try String(contentsOf: dest), "copy-data")
  }

  func testSha256FileStreamsFileContent() throws {
    let file = tempRoot.appendingPathComponent("hash.txt")
    try "hello".write(to: file, atomically: true, encoding: .utf8)

    XCTAssertEqual(
      try BundleDropFileOps.sha256File(file.path),
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    )
  }

  func testApplyXdeltaUsesLinkedNativeEngine() throws {
    XCTAssertTrue(BundleDropFileOps.supportsXdelta())

    let base = tempRoot.appendingPathComponent("base.txt")
    let patch = tempRoot.appendingPathComponent("patch.vcdiff")
    let output = patchTargetOutput("out.txt")

    try Data("Bundle Drop xdelta base fixture\nline one\n".utf8).write(to: base)
    try xdeltaFixturePatch.write(to: patch)

    try BundleDropFileOps.applyXdelta(
      basePath: base.path,
      patchPath: patch.path,
      outputPath: output.path
    )

    XCTAssertEqual(
      try Data(contentsOf: output),
      Data("Bundle Drop xdelta target fixture\nline two\n".utf8)
    )
  }

  func testApplyXdeltaRemovesPartialOutputOnFailure() throws {
    let base = tempRoot.appendingPathComponent("base.txt")
    let patch = tempRoot.appendingPathComponent("corrupt.vcdiff")
    let output = patchTargetOutput("out.txt")

    try Data("Bundle Drop xdelta base fixture\nline one\n".utf8).write(to: base)
    try Data("not-a-vcdiff".utf8).write(to: patch)
    try FileManager.default.createDirectory(
      at: output.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try Data("stale".utf8).write(to: output)

    XCTAssertThrowsError(
      try BundleDropFileOps.applyXdelta(
        basePath: base.path,
        patchPath: patch.path,
        outputPath: output.path
      )
    )
    XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
  }

  func testApplyXdeltaRejectsOutputOutsidePatchTargetTempDirectory() throws {
    let base = tempRoot.appendingPathComponent("base-outside.txt")
    let patch = tempRoot.appendingPathComponent("patch-outside.vcdiff")
    let output = tempRoot.appendingPathComponent("out.txt")

    XCTAssertThrowsError(
      try BundleDropFileOps.applyXdelta(
        basePath: base.path,
        patchPath: patch.path,
        outputPath: output.path
      )
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("bundle-drop/bundles"))
    }
  }

  func testApplyXdeltaRejectsOutputInActiveBundleDirectory() throws {
    let base = tempRoot.appendingPathComponent("base-active.txt")
    let patch = tempRoot.appendingPathComponent("patch-active.vcdiff")
    let activeOutput = tempRoot
      .appendingPathComponent("bundle-drop/bundles/\(String(repeating: "a", count: 64))/main.jsbundle")

    XCTAssertThrowsError(
      try BundleDropFileOps.applyXdelta(
        basePath: base.path,
        patchPath: patch.path,
        outputPath: activeOutput.path
      )
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("active bundle"))
    }
  }

  func testApplyXdeltaRejectsTraversalOutputPath() throws {
    let base = tempRoot.appendingPathComponent("base-traversal.txt")
    let patch = tempRoot.appendingPathComponent("patch-traversal.vcdiff")
    let output = tempRoot
      .appendingPathComponent("bundle-drop/bundles/_patch_target_\(String(repeating: "b", count: 64))/../escape.bin")

    XCTAssertThrowsError(
      try BundleDropFileOps.applyXdelta(
        basePath: base.path,
        patchPath: patch.path,
        outputPath: output.path
      )
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("traversal"))
    }
  }

  func testDownloadToFileWritesSmallHttpResponse() throws {
    MockURLProtocol.handler = { request in
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: nil
      )!
      return (response, [Data("hello".utf8)])
    }

    let dest = tempRoot.appendingPathComponent("downloads/bundle.zip")
    try waitForDownload(url: "https://cdn.example.com/bundle.zip", dest: dest, maxBytes: 100)

    XCTAssertEqual(try Data(contentsOf: dest), Data("hello".utf8))
  }

  func testDownloadToFileRejectsNon2xxResponseAndCleansDestination() throws {
    MockURLProtocol.handler = { request in
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 503,
        httpVersion: nil,
        headerFields: nil
      )!
      return (response, [Data("failure".utf8)])
    }

    let dest = tempRoot.appendingPathComponent("downloads/fail.zip")

    XCTAssertThrowsError(
      try waitForDownload(url: "https://cdn.example.com/fail.zip", dest: dest, maxBytes: 100)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("HTTP 503"))
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: dest.path))
  }

  func testDownloadToFileRejectsOversizedResponseAndCleansPartialFile() throws {
    MockURLProtocol.handler = { request in
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: nil
      )!
      return (response, [Data("12345".utf8), Data("67890".utf8)])
    }

    let dest = tempRoot.appendingPathComponent("downloads/oversized.zip")

    XCTAssertThrowsError(
      try waitForDownload(url: "https://cdn.example.com/oversized.zip", dest: dest, maxBytes: 7)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("Download exceeds"))
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: dest.path))
  }

  private func waitForDownload(
    url: String,
    dest: URL,
    maxBytes: Int64
  ) throws {
    let expectation = expectation(description: "download")
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockURLProtocol.self]
    var downloadResult: Result<Void, Error>?

    BundleDropFileOps.downloadToFile(
      urlString: url,
      destPath: dest.path,
      maxBytes: maxBytes,
      configuration: config
    ) { result in
      downloadResult = result
      expectation.fulfill()
    }

    wait(for: [expectation], timeout: 2)
    switch downloadResult {
    case .success:
      return
    case .failure(let error):
      throw error
    case .none:
      XCTFail("Download did not complete")
    }
  }

  private func patchTargetOutput(_ filename: String) -> URL {
    tempRoot.appendingPathComponent(
      "bundle-drop/bundles/_patch_target_\(String(repeating: "a", count: 64))/\(filename)"
    )
  }

  private var xdeltaFixturePatch: Data {
    Data([
      0xd6, 0xc3, 0xc4, 0x00, 0x04, 0x15, 0x74, 0x61, 0x72, 0x67, 0x65, 0x74,
      0x2e, 0x74, 0x78, 0x74, 0x2f, 0x2f, 0x62, 0x61, 0x73, 0x65, 0x2e, 0x74,
      0x78, 0x74, 0x2f, 0x05, 0x25, 0x00, 0x1a, 0x2b, 0x00, 0x0a, 0x05, 0x02,
      0x5d, 0x5e, 0x0f, 0xb6, 0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0x74, 0x77,
      0x6f, 0x0a, 0x13, 0x13, 0x07, 0x1e, 0x05, 0x00, 0x17,
    ])
  }
}

private final class MockURLProtocol: URLProtocol {
  static var handler: ((URLRequest) throws -> (HTTPURLResponse, [Data]))?

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: BundleDropFileOps.error("Missing mock handler"))
      return
    }

    do {
      let (response, chunks) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      chunks.forEach { client?.urlProtocol(self, didLoad: $0) }
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}
