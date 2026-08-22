import XCTest
@testable import BundleDropIOSCore

final class BundleDropRuntimeCryptoTests: XCTestCase {
  private let protectedHeader = "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3Qta2V5LTIwMjYtMDgiLCJ0eXAiOiJidW5kbGVkcm9wLW1hbmlmZXN0K2p3cyJ9"
  private let payload = "eyJzY2hlbWFWZXJzaW9uIjoyLCJ0eXBlIjoibGFuZSIsInByb2plY3RTbHVnIjoiZ29sZGVuLXByb2plY3QiLCJjaGFubmVsTmFtZSI6IlByb2R1Y3Rpb24gLyDOsiIsInBsYXRmb3JtIjoiaW9zIiwicnVudGltZVZlcnNpb24iOiIxLjIuMytuYXRpdmUvNDIiLCJnZW5lcmF0aW9uIjo3LCJnZW5lcmF0ZWRBdCI6IjIwMjYtMDgtMTdUMDA6MDA6MDAuMDAwWiIsImV4cGlyZXNBdCI6IjIwOTktMDEtMDFUMDA6MDA6MDAuMDAwWiIsInJlc29sdXRpb25Nb2RlIjoibG9jYWwiLCJwdWJsaXNoaW5nTW9kZSI6ImF1dG9tYXRpYyIsInJvbGxvdXRBbGdvcml0aG0iOiJzaGEyNTYtaW5zdGFsbC1pZC11aW50MzJiZS1tb2QxMDAtdjEiLCJyZXZva2VkSGFzaGVzIjpbXSwicmVsZWFzZXMiOlt7InJlbGVhc2VSZWYiOiJyZWxfZ29sZGVuIiwiYnVuZGxlSGFzaCI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJidW5kbGVWZXJzaW9uIjo3LCJ2ZXJzaW9uIjoiMS4wLjciLCJydW50aW1lVmVyc2lvbiI6IjEuMi4zK25hdGl2ZS80MiIsIm1hbmlmZXN0SGFzaCI6ImJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIiLCJqc0J1bmRsZUhhc2giOiJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjIiwiZnVsbEJ1bmRsZUhhc2giOiJkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkIiwiZnVsbEJ1bmRsZVNpemVCeXRlcyI6MTIzNDU2LCJhdmFpbGFibGUiOnRydWUsImV4cGlyZXNBdCI6bnVsbH1dLCJwdWJsaXNoZWRSb2xsb3V0cyI6W10sInBhdGNoUG9saWN5Ijp7ImVuYWJsZWQiOnRydWUsIm1heFBhdGNoVG9GdWxsUmF0aW8iOjAuN30sInBhdGNoRWRnZXMiOltdLCJjYW5kaWRhdGVTZXRDb21wbGV0ZSI6dHJ1ZX0"
  private let signature = "PnYXxiTNWHH5_aV-875FSk_Lne73VUZHAh59nV_a7oWJl1b2BBWLZ3_0e32Oprtgx5QnZWwMvl_wBznLM6WRdg"
  private let x = "d-g4y_28QdARnFF6HO0T00laLEfHhVFXTmuWHqBWmfM"
  private let y = "_Z_xWbhjDp3IVMtLA_rN3guVyprP34OvBikPWpVQfUI"

  func testSha256GoldenVector() {
    XCTAssertEqual(
      BundleDropRuntimeCrypto.sha256String("alpha"),
      "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8"
    )
  }

  func testCrossRepositoryGoldenSignature() throws {
    XCTAssertTrue(try BundleDropRuntimeCrypto.verifyEs256Signature(
      signingInput: "\(protectedHeader).\(payload)",
      signatureBase64Url: signature,
      xBase64Url: x,
      yBase64Url: y
    ))
  }

  func testTamperingIsRejected() throws {
    XCTAssertFalse(try BundleDropRuntimeCrypto.verifyEs256Signature(
      signingInput: "\(protectedHeader).\(payload)A",
      signatureBase64Url: signature,
      xBase64Url: x,
      yBase64Url: y
    ))
  }
}
