import XCTest
import BundleDropZipExtractorObjC

final class BundleDropZipExtractorTests: XCTestCase {
  private var tempRoot: URL!

  override func setUpWithError() throws {
    tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("BundleDropZipExtractorTests-\(UUID().uuidString)", isDirectory: true)
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

  func testExtractsValidZipWithFilesAndDirectories() throws {
    let zip = try writeZip(entries: [
      ZipEntry(name: "main.jsbundle", data: Data("console.log('hello');".utf8)),
      ZipEntry(name: "assets/icon.png", data: Data("fake-png-data".utf8)),
    ])
    let dest = tempRoot.appendingPathComponent("output", isDirectory: true)

    let filenames = try BundleDropZipExtractor.extractZip(
      atPath: zip.path,
      toDirectory: dest.path
    )

    XCTAssertEqual(filenames, ["main.jsbundle", "assets/icon.png"])
    XCTAssertEqual(
      try String(contentsOf: dest.appendingPathComponent("main.jsbundle")),
      "console.log('hello');"
    )
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: dest.appendingPathComponent("assets/icon.png").path
    ))
  }

  func testExtractCreatesDestinationDirectory() throws {
    let zip = try writeZip(entries: [
      ZipEntry(name: "file.txt", data: Data("data".utf8)),
    ])
    let dest = tempRoot.appendingPathComponent("new-dir", isDirectory: true)
    XCTAssertFalse(FileManager.default.fileExists(atPath: dest.path))

    _ = try BundleDropZipExtractor.extractZip(atPath: zip.path, toDirectory: dest.path)

    XCTAssertTrue(FileManager.default.fileExists(atPath: dest.path))
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: dest.appendingPathComponent("file.txt").path
    ))
  }

  func testRejectsZipSlipFileEntry() throws {
    let zip = try writeZip(entries: [
      ZipEntry(name: "../../../etc/passwd", data: Data("root:x:0:0".utf8)),
    ])
    let dest = tempRoot.appendingPathComponent("safe-output", isDirectory: true)

    XCTAssertThrowsError(try BundleDropZipExtractor.extractZip(
      atPath: zip.path,
      toDirectory: dest.path
    )) { error in
      XCTAssertTrue(error.localizedDescription.contains("Unsafe ZIP entry path"))
    }
  }

  func testRejectsZipSlipDirectoryEntry() throws {
    let zip = try writeZip(entries: [
      ZipEntry(name: "../../evil-dir/", data: Data(), isDirectory: true),
    ])
    let dest = tempRoot.appendingPathComponent("safe-output2", isDirectory: true)

    XCTAssertThrowsError(try BundleDropZipExtractor.extractZip(
      atPath: zip.path,
      toDirectory: dest.path
    )) { error in
      XCTAssertTrue(error.localizedDescription.contains("Unsafe ZIP entry path"))
    }
  }

  func testRejectsUnsafeSeparatorEntry() throws {
    let zip = try writeZip(entries: [
      ZipEntry(name: "assets\\icon.png", data: Data("fake-png-data".utf8)),
    ])
    let dest = tempRoot.appendingPathComponent("unsafe-separator", isDirectory: true)

    XCTAssertThrowsError(try BundleDropZipExtractor.extractZip(
      atPath: zip.path,
      toDirectory: dest.path
    )) { error in
      XCTAssertTrue(error.localizedDescription.contains("Unsafe ZIP entry path"))
    }
  }

  func testRejectsEntryExceedingPerEntryLimit() throws {
    let zip = try writeZip(entries: [
      ZipEntry(name: "big.txt", data: Data(repeating: 1, count: 2_000)),
    ])
    let dest = tempRoot.appendingPathComponent("entry-cap", isDirectory: true)

    XCTAssertThrowsError(try BundleDropZipExtractor.extractZip(
      atPath: zip.path,
      toDirectory: dest.path,
      maxZipFileSize: 10_000,
      maxEntrySize: 1_000,
      maxTotalUncompressed: UInt.max
    )) { error in
      XCTAssertTrue(error.localizedDescription.contains("ZIP entry too large"))
    }
  }

  func testRejectsArchiveExceedingTotalUncompressedLimit() throws {
    let zip = try writeZip(entries: [
      ZipEntry(name: "a.txt", data: Data(repeating: 1, count: 600)),
      ZipEntry(name: "b.txt", data: Data(repeating: 2, count: 600)),
    ])
    let dest = tempRoot.appendingPathComponent("total-cap", isDirectory: true)

    XCTAssertThrowsError(try BundleDropZipExtractor.extractZip(
      atPath: zip.path,
      toDirectory: dest.path,
      maxZipFileSize: 10_000,
      maxEntrySize: UInt.max,
      maxTotalUncompressed: 1_000
    )) { error in
      XCTAssertTrue(error.localizedDescription.contains("total uncompressed"))
    }
  }

  func testHandlesEmptyZip() throws {
    let zip = try writeZip(entries: [])
    let dest = tempRoot.appendingPathComponent("empty", isDirectory: true)

    let filenames = try BundleDropZipExtractor.extractZip(
      atPath: zip.path,
      toDirectory: dest.path
    )

    XCTAssertTrue(filenames.isEmpty)
  }

  func testRejectsMalformedZipWithoutEndOfCentralDirectory() throws {
    let zip = tempRoot.appendingPathComponent("malformed.zip")
    try Data([0x50, 0x4b, 0x03, 0x04]).write(to: zip)
    let dest = tempRoot.appendingPathComponent("malformed", isDirectory: true)

    XCTAssertThrowsError(try BundleDropZipExtractor.extractZip(
      atPath: zip.path,
      toDirectory: dest.path
    )) { error in
      XCTAssertTrue(error.localizedDescription.contains("end-of-central-directory"))
    }

    XCTAssertFalse(FileManager.default.fileExists(atPath: dest.path))
  }

  private func writeZip(entries: [ZipEntry]) throws -> URL {
    let zip = tempRoot.appendingPathComponent("test-\(UUID().uuidString).zip")
    try makeZip(entries: entries).write(to: zip)
    return zip
  }
}

private struct ZipEntry {
  let name: String
  let data: Data
  let isDirectory: Bool

  init(name: String, data: Data, isDirectory: Bool = false) {
    self.name = name
    self.data = data
    self.isDirectory = isDirectory
  }
}

private func makeZip(entries: [ZipEntry]) -> Data {
  var localFileData = Data()
  var centralDirectory = Data()

  entries.forEach { entry in
    let nameData = Data(entry.name.utf8)
    let content = entry.isDirectory ? Data() : entry.data
    let localHeaderOffset = UInt32(localFileData.count)

    localFileData.appendUInt32LE(0x04034b50)
    localFileData.appendUInt16LE(20)
    localFileData.appendUInt16LE(0)
    localFileData.appendUInt16LE(0)
    localFileData.appendUInt16LE(0)
    localFileData.appendUInt16LE(0)
    localFileData.appendUInt32LE(0)
    localFileData.appendUInt32LE(UInt32(content.count))
    localFileData.appendUInt32LE(UInt32(content.count))
    localFileData.appendUInt16LE(UInt16(nameData.count))
    localFileData.appendUInt16LE(0)
    localFileData.append(nameData)
    localFileData.append(content)

    centralDirectory.appendUInt32LE(0x02014b50)
    centralDirectory.appendUInt16LE(20)
    centralDirectory.appendUInt16LE(20)
    centralDirectory.appendUInt16LE(0)
    centralDirectory.appendUInt16LE(0)
    centralDirectory.appendUInt16LE(0)
    centralDirectory.appendUInt16LE(0)
    centralDirectory.appendUInt32LE(0)
    centralDirectory.appendUInt32LE(UInt32(content.count))
    centralDirectory.appendUInt32LE(UInt32(content.count))
    centralDirectory.appendUInt16LE(UInt16(nameData.count))
    centralDirectory.appendUInt16LE(0)
    centralDirectory.appendUInt16LE(0)
    centralDirectory.appendUInt16LE(0)
    centralDirectory.appendUInt16LE(0)
    centralDirectory.appendUInt32LE(entry.isDirectory ? 0x10 : 0)
    centralDirectory.appendUInt32LE(localHeaderOffset)
    centralDirectory.append(nameData)
  }

  let centralDirectoryOffset = UInt32(localFileData.count)
  let centralDirectorySize = UInt32(centralDirectory.count)
  localFileData.append(centralDirectory)
  localFileData.appendUInt32LE(0x06054b50)
  localFileData.appendUInt16LE(0)
  localFileData.appendUInt16LE(0)
  localFileData.appendUInt16LE(UInt16(entries.count))
  localFileData.appendUInt16LE(UInt16(entries.count))
  localFileData.appendUInt32LE(centralDirectorySize)
  localFileData.appendUInt32LE(centralDirectoryOffset)
  localFileData.appendUInt16LE(0)
  return localFileData
}

private extension Data {
  mutating func appendUInt16LE(_ value: UInt16) {
    append(UInt8(value & 0xff))
    append(UInt8((value >> 8) & 0xff))
  }

  mutating func appendUInt32LE(_ value: UInt32) {
    append(UInt8(value & 0xff))
    append(UInt8((value >> 8) & 0xff))
    append(UInt8((value >> 16) & 0xff))
    append(UInt8((value >> 24) & 0xff))
  }
}
