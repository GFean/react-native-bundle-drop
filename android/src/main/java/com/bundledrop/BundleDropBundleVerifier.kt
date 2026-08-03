package com.bundledrop

import org.json.JSONObject
import java.io.File
import java.io.IOException

object BundleDropBundleVerifier {
  private const val MANIFEST_FILE = "bundle-manifest.json"

  fun verifyBundleFiles(bundleDir: File, manifestFile: File) {
    val manifest = try {
      JSONObject(manifestFile.readText(Charsets.UTF_8))
    } catch (e: Exception) {
      throw IOException("Malformed bundle manifest", e)
    }
    val files = manifest.optJSONArray("files")
      ?: throw IOException("Bundle manifest must include files")
    verifyManifestFiles(bundleDir, files)
  }

  fun verifyManifestFiles(bundleDir: File, files: org.json.JSONArray) {
    val allowed = mutableSetOf(MANIFEST_FILE)

    for (i in 0 until files.length()) {
      val file = files.optJSONObject(i)
        ?: throw IOException("Invalid manifest file entry at index $i")
      val relativePath = file.optString("path", "")
      if (!isSafeManifestPath(relativePath)) {
        throw SecurityException("Invalid manifest path: $relativePath")
      }
      if (!allowed.add(relativePath)) {
        throw IOException("Duplicate manifest file path: $relativePath")
      }

      val expectedSize = file.optLong("size", -1L)
      val expectedSha = file.optString("sha256", "")
      val fullPath = File(bundleDir, relativePath)
      if (!fullPath.exists()) {
        throw IOException("Manifest file missing: $relativePath")
      }
      if (fullPath.isDirectory) {
        throw IOException("Manifest file is a directory: $relativePath")
      }
      if (fullPath.length() != expectedSize) {
        throw IOException("Manifest file size mismatch for $relativePath")
      }
      if (BundleDropFileOps.sha256File(fullPath) != expectedSha) {
        throw IOException("Manifest file hash mismatch for $relativePath")
      }
    }

    val actualFiles = listRelativeFiles(bundleDir)
    val extraFile = actualFiles.firstOrNull { !allowed.contains(it) }
    if (extraFile != null) {
      throw IOException("Unmanifested file in bundle archive: $extraFile")
    }
  }

  fun isSafeManifestPath(path: String): Boolean {
    return path.isNotBlank() &&
      !path.startsWith("/") &&
      !path.contains("\\") &&
      !path.contains("\u0000") &&
      path.split("/").none { it.isBlank() || it == "." || it == ".." }
  }

  private fun listRelativeFiles(root: File, dir: File = root, prefix: String = ""): List<String> {
    return dir.listFiles()?.flatMap { file ->
      val relativePath = if (prefix.isBlank()) file.name else "$prefix/${file.name}"
      if (file.isDirectory) listRelativeFiles(root, file, relativePath) else listOf(relativePath)
    } ?: emptyList()
  }
}
