import CryptoKit
import Foundation

enum BundleDropRuntimeCrypto {
  static func sha256String(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  static func verifyEs256Signature(
    signingInput: String,
    signatureBase64Url: String,
    xBase64Url: String,
    yBase64Url: String
  ) throws -> Bool {
    let signatureBytes = try decodeBase64Url(signatureBase64Url)
    let x = try decodeBase64Url(xBase64Url)
    let y = try decodeBase64Url(yBase64Url)
    guard signatureBytes.count == 64 else {
      throw error("ES256 signature must be 64 bytes")
    }
    guard x.count == 32 && y.count == 32 else {
      throw error("P-256 coordinates must be 32 bytes")
    }

    let publicKey = try P256.Signing.PublicKey(
      x963Representation: Data([0x04]) + x + y
    )
    let signature = try P256.Signing.ECDSASignature(rawRepresentation: signatureBytes)
    return publicKey.isValidSignature(signature, for: Data(signingInput.utf8))
  }

  private static func decodeBase64Url(_ value: String) throws -> Data {
    var normalized = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
    guard let data = Data(base64Encoded: normalized) else {
      throw error("Invalid base64url value")
    }
    return data
  }

  private static func error(_ message: String) -> NSError {
    NSError(domain: "BundleDrop", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
