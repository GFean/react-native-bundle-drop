package com.bundledrop

import java.io.File
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BundleDropOtaResolverBranchCoverageTest {

  @get:Rule
  val tempFolder = TemporaryFolder()

  @Test
  fun `readCurrentPointer rejects manifest with mismatched bundle hash`() {
    val root = tempFolder.newFolder("bundle-drop")
    val currentHash = "a".repeat(64)
    val bundleDir = File(root, "bundles/$currentHash").apply { mkdirs() }

    File(bundleDir, "bundle-manifest.json").writeText(
      """{"manifestVersion":1,"bundleHash":"${"b".repeat(64)}"}"""
    )
    File(root, "current.json").writeText("""{"hash":"$currentHash"}""")

    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer rejects unsafe manifest paths after platform is accepted`() {
    val unsafePaths = listOf(
      "",
      "/main.jsbundle",
      "assets\\icon.png",
      "assets\u0000icon.png",
      "assets/./icon.png",
      "assets/../icon.png",
    )

    unsafePaths.forEachIndexed { index, unsafePath ->
      val root = tempFolder.newFolder("bundle-drop-unsafe-$index")
      val hash = "${index + 1}".repeat(64)

      writeCurrentWithManifest(
        root = root,
        hash = hash,
        manifestJson = listOf(
          "\"manifestVersion\":1",
          "\"bundleHash\":\"$hash\"",
          "\"platform\":\"android\"",
          "\"files\":[{\"path\":${quoteCanonicalString(unsafePath)},\"role\":\"asset\",\"sha256\":\"${"0".repeat(64)}\",\"size\":0}]",
        ).joinToString(",", prefix = "{", postfix = "}"),
      )

      assertNull(BundleDropOtaResolver.readCurrentPointer(root))
    }
  }

  @Test
  fun `readCurrentPointer rejects duplicate manifest paths after first file passes early checks`() {
    val root = tempFolder.newFolder("bundle-drop-duplicate")
    val hash = "c".repeat(64)
    val bundleDir = File(root, "bundles/$hash").apply { mkdirs() }
    val asset = File(bundleDir, "asset.txt").apply { writeText("asset") }

    writeCurrentWithManifest(
      root = root,
      hash = hash,
      manifestJson = listOf(
        "\"manifestVersion\":1",
        "\"bundleHash\":\"$hash\"",
        "\"platform\":\"android\"",
        "\"files\":[${fileEntryJson("asset.txt", "asset", asset)},${fileEntryJson("asset.txt", "asset", asset)}]",
      ).joinToString(",", prefix = "{", postfix = "}"),
    )

    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer rejects invalid manifest hash after required files pass`() {
    val root = tempFolder.newFolder("bundle-drop-invalid-manifest-hash")
    val bundleFile = writeValidBundle(root)
    val manifestFile = File(bundleFile.parentFile, "bundle-manifest.json")

    manifestFile.writeText(
      manifestFile.readText().replace(
        Regex("\"manifestHash\":\"[a-f0-9]{64}\""),
        "\"manifestHash\":\"not-a-valid-hash\"",
      )
    )

    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer accepts canonical manifest strings with escaped characters`() {
    val root = tempFolder.newFolder("bundle-drop-escaped-canonical-strings")
    val bundleFile = writeValidBundle(
      root = root,
      extraFiles = listOf(
        ManifestFile(
          path = "assets/escaped-role.txt",
          role = "asset\"\\\b\u000c\n\r\t\u0001end",
          content = "asset",
        ),
      ),
      runtimeVersion = "runtime\"\\\b\u000c\n\r\t\u0001end",
      version = "version\"\\\b\u000c\n\r\t\u0001end",
    )

    assertEquals(bundleFile.absolutePath, BundleDropOtaResolver.readCurrentPointer(root))
  }

  private fun writeCurrentWithManifest(root: File, hash: String, manifestJson: String) {
    val bundleDir = File(root, "bundles/$hash").apply { mkdirs() }
    File(bundleDir, "bundle-manifest.json").writeText(manifestJson)
    File(root, "current.json").writeText("""{"hash":"$hash"}""")
  }

  private data class ManifestFile(
    val path: String,
    val role: String,
    val content: String,
    val executable: Boolean = false,
  ) {
    val size: Long = content.toByteArray(Charsets.UTF_8).size.toLong()
    val sha256: String = sha256String(content)
  }

  private fun writeValidBundle(
    root: File,
    extraFiles: List<ManifestFile> = emptyList(),
    runtimeVersion: String = "1.0.0",
    version: String = "1.0.0",
  ): File {
    val files = listOf(
      ManifestFile("main.jsbundle", "jsbundle", "bundle"),
      ManifestFile("metadata-android.json", "metadata", "{}"),
      ManifestFile("image-manifest.json", "androidImageManifest", "{}"),
    ) + extraFiles
    val bundleHash = calculateBundleHash(files)
    val bundleDir = File(root, "bundles/$bundleHash").apply { mkdirs() }

    files.forEach { file ->
      val output = File(bundleDir, file.path)
      output.parentFile?.mkdirs()
      output.writeText(file.content)
    }
    File(bundleDir, "bundle-manifest.json").writeText(
      manifestJson(
        bundleHash = bundleHash,
        files = files,
        runtimeVersion = runtimeVersion,
        version = version,
      )
    )
    File(root, "current.json").writeText("""{"hash":"$bundleHash"}""")

    return File(bundleDir, "main.jsbundle")
  }

  private fun manifestJson(
    bundleHash: String,
    files: List<ManifestFile>,
    runtimeVersion: String,
    version: String,
  ): String {
    val jsBundleHash = files.first { it.path == "main.jsbundle" && it.role == "jsbundle" }.sha256
    val manifestHash = sha256String(
      listOf(
        "\"bundleHash\":${quoteCanonicalString(bundleHash)}",
        "\"files\":[${canonicalFileEntries(files).joinToString(",")}]",
        "\"jsBundleHash\":${quoteCanonicalString(jsBundleHash)}",
        "\"manifestVersion\":1",
        "\"platform\":\"android\"",
        "\"runtimeVersion\":${quoteCanonicalString(runtimeVersion)}",
        "\"version\":${quoteCanonicalString(version)}",
      ).joinToString(",", prefix = "{", postfix = "}")
    )

    return listOf(
      "\"manifestVersion\":1",
      "\"bundleHash\":${quoteCanonicalString(bundleHash)}",
      "\"jsBundleHash\":${quoteCanonicalString(jsBundleHash)}",
      "\"platform\":\"android\"",
      "\"runtimeVersion\":${quoteCanonicalString(runtimeVersion)}",
      "\"version\":${quoteCanonicalString(version)}",
      "\"manifestHash\":${quoteCanonicalString(manifestHash)}",
      "\"files\":[${files.joinToString(",") { fileEntryJson(it) }}]",
    ).joinToString(",", prefix = "{", postfix = "}")
  }

  private fun calculateBundleHash(files: List<ManifestFile>): String {
    return sha256String(
      "{\"files\":[${canonicalFileEntries(files).joinToString(",")}],\"manifestVersion\":1}"
    )
  }

  private fun canonicalFileEntries(files: List<ManifestFile>): List<String> {
    return files
      .sortedWith { left, right -> compareUtf8(left.path, right.path) }
      .map { fileEntryJson(it) }
  }

  private fun fileEntryJson(path: String, role: String, file: File): String {
    return "{\"path\":${quoteCanonicalString(path)},\"role\":${quoteCanonicalString(role)},\"sha256\":${quoteCanonicalString(sha256File(file))},\"size\":${file.length()}}"
  }

  private fun fileEntryJson(file: ManifestFile): String {
    val executable = if (file.executable) "\"executable\":true," else ""
    return "{$executable\"path\":${quoteCanonicalString(file.path)},\"role\":${quoteCanonicalString(file.role)},\"sha256\":${quoteCanonicalString(file.sha256)},\"size\":${file.size}}"
  }

  private fun quoteCanonicalString(value: String): String {
    val result = StringBuilder(value.length + 2)
    result.append('"')
    value.forEach { char ->
      when (char) {
        '"' -> result.append("\\\"")
        '\\' -> result.append("\\\\")
        '\b' -> result.append("\\b")
        '\u000c' -> result.append("\\f")
        '\n' -> result.append("\\n")
        '\r' -> result.append("\\r")
        '\t' -> result.append("\\t")
        else -> {
          if (char.code < 0x20) {
            result.append("\\u")
            result.append(char.code.toString(16).padStart(4, '0'))
          } else {
            result.append(char)
          }
        }
      }
    }
    result.append('"')
    return result.toString()
  }

  private fun compareUtf8(left: String, right: String): Int {
    val leftBytes = left.toByteArray(Charsets.UTF_8)
    val rightBytes = right.toByteArray(Charsets.UTF_8)
    val length = minOf(leftBytes.size, rightBytes.size)
    for (i in 0 until length) {
      val leftByte = leftBytes[i].toInt() and 0xff
      val rightByte = rightBytes[i].toInt() and 0xff
      if (leftByte != rightByte) return leftByte - rightByte
    }
    return leftBytes.size - rightBytes.size
  }

  private fun sha256File(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val read = input.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  companion object {
    private fun sha256String(value: String): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
      return digest.joinToString("") { "%02x".format(it) }
    }
  }
}
