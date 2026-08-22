package com.bundledrop

import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

object BundleDropRuntimeCrypto {
  private const val BASE64_URL_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  fun sha256String(value: String): String =
    MessageDigest.getInstance("SHA-256")
      .digest(value.toByteArray(StandardCharsets.UTF_8))
      .joinToString("") { "%02x".format(it) }

  fun verifyEs256Signature(
    signingInput: String,
    signatureBase64Url: String,
    xBase64Url: String,
    yBase64Url: String,
  ): Boolean {
    val signature = decodeBase64Url(signatureBase64Url)
    val x = decodeBase64Url(xBase64Url)
    val y = decodeBase64Url(yBase64Url)
    require(signature.size == 64) { "ES256 signature must be 64 bytes" }
    require(x.size == 32 && y.size == 32) { "P-256 coordinates must be 32 bytes" }

    val parameters = AlgorithmParameters.getInstance("EC").apply {
      init(ECGenParameterSpec("secp256r1"))
    }.getParameterSpec(ECParameterSpec::class.java)
    val publicKey = KeyFactory.getInstance("EC").generatePublic(
      ECPublicKeySpec(ECPoint(BigInteger(1, x), BigInteger(1, y)), parameters),
    )
    return Signature.getInstance("SHA256withECDSA").run {
      initVerify(publicKey)
      update(signingInput.toByteArray(StandardCharsets.UTF_8))
      verify(joseSignatureToDer(signature))
    }
  }

  private fun decodeBase64Url(value: String): ByteArray {
    require(value.length % 4 != 1) { "Invalid base64url value" }
    require(value.all { BASE64_URL_ALPHABET.indexOf(it) >= 0 }) { "Invalid base64url value" }
    val output = ArrayList<Byte>((value.length * 3) / 4)
    var index = 0
    while (index < value.length) {
      val remaining = value.length - index
      val a = BASE64_URL_ALPHABET.indexOf(value[index])
      val b = BASE64_URL_ALPHABET.indexOf(value[index + 1])
      val c = if (remaining > 2) BASE64_URL_ALPHABET.indexOf(value[index + 2]) else 0
      val d = if (remaining > 3) BASE64_URL_ALPHABET.indexOf(value[index + 3]) else 0
      val bits = (a shl 18) or (b shl 12) or (c shl 6) or d
      output.add(((bits shr 16) and 0xff).toByte())
      if (remaining > 2) output.add(((bits shr 8) and 0xff).toByte())
      if (remaining > 3) output.add((bits and 0xff).toByte())
      index += 4
    }
    return output.toByteArray()
  }

  private fun joseSignatureToDer(signature: ByteArray): ByteArray {
    val r = positiveDerInteger(signature.copyOfRange(0, 32))
    val s = positiveDerInteger(signature.copyOfRange(32, 64))
    val sequenceLength = 2 + r.size + 2 + s.size
    return byteArrayOf(0x30, sequenceLength.toByte(), 0x02, r.size.toByte()) +
      r + byteArrayOf(0x02, s.size.toByte()) + s
  }

  private fun positiveDerInteger(value: ByteArray): ByteArray {
    var first = 0
    while (first < value.lastIndex && value[first] == 0.toByte()) first += 1
    val trimmed = value.copyOfRange(first, value.size)
    return if ((trimmed[0].toInt() and 0x80) != 0) byteArrayOf(0) + trimmed else trimmed
  }
}
