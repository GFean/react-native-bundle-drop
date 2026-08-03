package com.bundledrop

import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest

class BundleDropBundleVerifierTest {

  @get:Rule
  val tempFolder = TemporaryFolder()

  @Test
  fun `verifyBundleFiles accepts a complete file tree`() {
    val bundleDir = tempFolder.newFolder("bundle")
    File(bundleDir, "main.jsbundle").writeText("bundle")
    File(bundleDir, "assets").mkdirs()
    File(bundleDir, "assets/logo.png").writeText("logo")
    val manifest = writeManifest(
      bundleDir,
      entry("main.jsbundle", "bundle"),
      entry("assets/logo.png", "logo"),
    )

    BundleDropBundleVerifier.verifyBundleFiles(bundleDir, manifest)
  }

  @Test
  fun `verifyBundleFiles rejects missing files`() {
    val bundleDir = tempFolder.newFolder("missing")
    val manifest = writeManifest(bundleDir, entry("main.jsbundle", "bundle"))

    expectVerifyFailure("Manifest file missing") {
      BundleDropBundleVerifier.verifyBundleFiles(bundleDir, manifest)
    }
  }

  @Test
  fun `verifyBundleFiles rejects size mismatches`() {
    val bundleDir = tempFolder.newFolder("size")
    File(bundleDir, "main.jsbundle").writeText("bundle")
    val manifest = writeManifestRaw(
      bundleDir,
      """{"files":[{"path":"main.jsbundle","size":7,"sha256":"${sha256("bundle")}"}]}""",
    )

    expectVerifyFailure("Manifest file size mismatch") {
      BundleDropBundleVerifier.verifyBundleFiles(bundleDir, manifest)
    }
  }

  @Test
  fun `verifyBundleFiles rejects hash mismatches`() {
    val bundleDir = tempFolder.newFolder("hash")
    File(bundleDir, "main.jsbundle").writeText("tampered")
    val manifest = writeManifest(bundleDir, entry("main.jsbundle", "expected"))

    expectVerifyFailure("Manifest file hash mismatch") {
      BundleDropBundleVerifier.verifyBundleFiles(bundleDir, manifest)
    }
  }

  @Test
  fun `verifyBundleFiles rejects extra files`() {
    val bundleDir = tempFolder.newFolder("extra")
    File(bundleDir, "main.jsbundle").writeText("bundle")
    File(bundleDir, "assets").mkdirs()
    File(bundleDir, "assets/unlisted.png").writeText("extra")
    val manifest = writeManifest(bundleDir, entry("main.jsbundle", "bundle"))

    expectVerifyFailure("Unmanifested file") {
      BundleDropBundleVerifier.verifyBundleFiles(bundleDir, manifest)
    }
  }

  @Test
  fun `verifyBundleFiles rejects unsafe and duplicate paths`() {
    val unsafeDir = tempFolder.newFolder("unsafe")
    val unsafeManifest = writeManifestRaw(
      unsafeDir,
      """{"files":[{"path":"../escape","size":1,"sha256":"${sha256("x")}"}]}""",
    )
    expectVerifyFailure("Invalid manifest path") {
      BundleDropBundleVerifier.verifyBundleFiles(unsafeDir, unsafeManifest)
    }

    val duplicateDir = tempFolder.newFolder("duplicate")
    File(duplicateDir, "main.jsbundle").writeText("bundle")
    val duplicateManifest = writeManifestRaw(
      duplicateDir,
      """{"files":[${entry("main.jsbundle", "bundle")},${entry("main.jsbundle", "bundle")}]}""",
    )
    expectVerifyFailure("Duplicate manifest file path") {
      BundleDropBundleVerifier.verifyBundleFiles(duplicateDir, duplicateManifest)
    }
  }

  @Test
  fun `verifyBundleFiles rejects malformed manifests and manifests without files`() {
    val malformedDir = tempFolder.newFolder("malformed")
    val malformedManifest = writeManifestRaw(malformedDir, "{")
    expectVerifyFailure("Malformed bundle manifest") {
      BundleDropBundleVerifier.verifyBundleFiles(malformedDir, malformedManifest)
    }

    val missingFilesDir = tempFolder.newFolder("missing-files")
    val missingFilesManifest = writeManifestRaw(missingFilesDir, """{"manifestVersion":1}""")
    expectVerifyFailure("Bundle manifest must include files") {
      BundleDropBundleVerifier.verifyBundleFiles(missingFilesDir, missingFilesManifest)
    }
  }

  private fun entry(path: String, content: String): String {
    return """{"path":"$path","size":${content.toByteArray().size},"sha256":"${sha256(content)}"}"""
  }

  private fun writeManifest(bundleDir: File, vararg entries: String): File {
    return writeManifestRaw(bundleDir, """{"files":[${entries.joinToString(",")}]}""")
  }

  private fun writeManifestRaw(bundleDir: File, content: String): File {
    val manifest = File(bundleDir, "bundle-manifest.json")
    manifest.writeText(content)
    return manifest
  }

  private fun sha256(content: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(content.toByteArray())
    return digest.joinToString("") { "%02x".format(it) }
  }

  private fun expectVerifyFailure(expectedMessage: String, block: () -> Unit) {
    try {
      block()
      throw AssertionError("Expected verifier failure")
    } catch (error: Exception) {
      assertTrue(error.message?.contains(expectedMessage) == true)
    }
  }
}
