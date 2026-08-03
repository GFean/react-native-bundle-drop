package com.bundledrop

import java.io.File
import java.security.MessageDigest
import org.json.JSONObject

/**
 * Pure OTA bundle resolution logic, decoupled from Android Context for testability.
 * All file system operations go through the provided root directory.
 */
object BundleDropOtaResolver {
  private val bundleHashPattern = Regex("^[a-f0-9]{64}$")

  data class ResolveResult(
    val bundlePath: String?,
    val clearedOta: Boolean = false,
    val storedVersion: String? = null,
  )

  fun readCurrentPointer(bundleDropRoot: File): String? {
    return try {
      val jsonFile = File(bundleDropRoot, "current.json")
      if (!jsonFile.exists()) return null
      val raw = jsonFile.readText()
      val parsed = JSONObject(raw)
      val hash = parsed.optString("hash", "")
      if (!bundleHashPattern.matches(hash)) return null
      val expectedBundle = File(File(File(bundleDropRoot, "bundles"), hash), "main.jsbundle")
      val bundleDir = expectedBundle.parentFile ?: return null
      val manifestFile = File(bundleDir, "bundle-manifest.json")
      if (!manifestFile.exists()) return null
      val manifest = JSONObject(manifestFile.readText())
      if (manifest.optInt("manifestVersion", -1) != 1) {
        return null
      }
      if (manifest.optString("bundleHash", "") != hash) {
        return null
      }
      if (!verifyBundleDir(bundleDir, manifest, hash)) return null
      expectedBundle.absolutePath
    } catch (_: Exception) {
      null
    }
  }

  private fun verifyBundleDir(bundleDir: File, manifest: JSONObject, expectedHash: String): Boolean {
    val files = manifest.optJSONArray("files") ?: return false
    if (manifest.optString("platform", "") != "android") {
      return false
    }
    var mainBundleHash: String? = null
    var jsBundleRoleCount = 0
    var metadataRoleCount = 0
    var metadataPathMatches = false
    var androidImageManifestRoleCount = 0
    var androidImageManifestPathMatches = false

    for (i in 0 until files.length()) {
      val file = files.optJSONObject(i) ?: return false
      val relativePath = file.optString("path", "")
      val role = file.optString("role", "")
      if (!BundleDropBundleVerifier.isSafeManifestPath(relativePath)) return false
      when (role) {
        "jsbundle" -> {
          jsBundleRoleCount += 1
          if (relativePath == "main.jsbundle") {
            mainBundleHash = file.optString("sha256", "")
          }
        }
        "metadata" -> {
          metadataRoleCount += 1
          if (relativePath == "metadata-android.json") {
            metadataPathMatches = true
          }
        }
        "androidImageManifest" -> {
          androidImageManifestRoleCount += 1
          if (relativePath == "image-manifest.json") {
            androidImageManifestPathMatches = true
          }
        }
      }
    }

    if (jsBundleRoleCount != 1 || mainBundleHash != manifest.optString("jsBundleHash", "")) return false
    if (metadataRoleCount != 1 || !metadataPathMatches) return false
    if (androidImageManifestRoleCount != 1 || !androidImageManifestPathMatches) return false
    if (calculateBundleHash(files) != expectedHash) return false
    if (!verifyManifestHash(manifest, files)) return false
    try {
      BundleDropBundleVerifier.verifyManifestFiles(bundleDir, files)
    } catch (_: Exception) {
      return false
    }
    return true
  }

  private fun calculateBundleHash(files: org.json.JSONArray): String {
    val sortedEntries = canonicalFileEntries(files)
    return sha256String("{\"files\":[${sortedEntries.joinToString(",")}],\"manifestVersion\":1}")
  }

  private fun verifyManifestHash(manifest: JSONObject, files: org.json.JSONArray): Boolean {
    val manifestHash = manifest.optString("manifestHash", "")
    if (!bundleHashPattern.matches(manifestHash)) return false
    val requiredFields = listOf(
      "bundleHash",
      "jsBundleHash",
      "platform",
      "runtimeVersion",
      "version",
    )
    if (requiredFields.any { manifest.optString(it, "").isBlank() }) return false
    val canonical = listOf(
      "\"bundleHash\":${quoteCanonicalString(manifest.optString("bundleHash", ""))}",
      "\"files\":[${canonicalFileEntries(files).joinToString(",")}]",
      "\"jsBundleHash\":${quoteCanonicalString(manifest.optString("jsBundleHash", ""))}",
      "\"manifestVersion\":1",
      "\"platform\":${quoteCanonicalString(manifest.optString("platform", ""))}",
      "\"runtimeVersion\":${quoteCanonicalString(manifest.optString("runtimeVersion", ""))}",
      "\"version\":${quoteCanonicalString(manifest.optString("version", ""))}",
    ).joinToString(",", prefix = "{", postfix = "}")
    return sha256String(canonical) == manifestHash
  }

  private fun canonicalFileEntries(files: org.json.JSONArray): List<String> {
    val entries = mutableListOf<Pair<String, String>>()
    for (i in 0 until files.length()) {
      val file = files.getJSONObject(i)
      val relativePath = file.getString("path")
      val executable = if (file.optBoolean("executable", false)) "\"executable\":true," else ""
      entries.add(
        relativePath to "{$executable\"path\":${quoteCanonicalString(relativePath)},\"role\":${quoteCanonicalString(file.getString("role"))},\"sha256\":${quoteCanonicalString(file.getString("sha256"))},\"size\":${file.getLong("size")}}"
      )
    }
    return entries.sortedWith { left, right -> compareUtf8(left.first, right.first) }.map { it.second }
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

  private fun sha256String(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
  }

  fun clearOtaState(bundleDropRoot: File, filesDir: File) {
    val filesToClear = listOf(
      File(bundleDropRoot, "current.json"),
      File(bundleDropRoot, "previous.json"),
      File(bundleDropRoot, "state.json"),
      File(filesDir, "bundle-info.json"),
    )
    filesToClear.forEach {
      try { if (it.exists()) it.delete() } catch (_: Exception) {}
    }
  }

  fun hasOtaState(bundleDropRoot: File, filesDir: File): Boolean {
    return listOf(
      File(bundleDropRoot, "current.json"),
      File(bundleDropRoot, "previous.json"),
      File(bundleDropRoot, "state.json"),
      File(filesDir, "bundle-info.json"),
    ).any { it.exists() }
  }

  fun resolve(
    bundleDropRoot: File,
    filesDir: File,
    currentBinaryVersion: String,
    storedBinaryVersion: String?,
  ): ResolveResult {
    if (storedBinaryVersion != null && storedBinaryVersion != currentBinaryVersion) {
      val hadOtaState = hasOtaState(bundleDropRoot, filesDir)
      clearOtaState(bundleDropRoot, filesDir)
      return ResolveResult(
        bundlePath = null,
        clearedOta = hadOtaState,
        storedVersion = currentBinaryVersion,
      )
    }

    val path = readCurrentPointer(bundleDropRoot)

    if (path == null) {
      return ResolveResult(
        bundlePath = null,
        storedVersion = currentBinaryVersion,
      )
    }

    return ResolveResult(
      bundlePath = path,
      storedVersion = currentBinaryVersion,
    )
  }

  fun readImageManifest(bundlePath: String): String? {
    return try {
      val bundleDir = File(bundlePath).parentFile ?: return null
      val bundleHash = bundleDir.name
      if (!bundleHashPattern.matches(bundleHash)) return null
      val file = File(bundleDir, "image-manifest.json")
      if (!file.exists()) return null
      rootImageManifestPaths(JSONObject(file.readText()), bundleDir, bundleHash).toString()
    } catch (_: Exception) {
      null
    }
  }

  private fun rootImageManifestPaths(
    manifest: JSONObject,
    bundleDir: File,
    bundleHash: String,
  ): JSONObject {
    val rooted = JSONObject()
    val keys = manifest.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      if (!BundleDropBundleVerifier.isSafeManifestPath(key)) throw IllegalArgumentException("Invalid image manifest key")
      val value = manifest.opt(key) as? String ?: throw IllegalArgumentException("Invalid image manifest value")
      rooted.put(key, rootImageManifestPath(value, bundleDir, bundleHash))
    }
    return rooted
  }

  private fun rootImageManifestPath(path: String, bundleDir: File, bundleHash: String): String {
    if (path.contains("\\") || path.contains("\u0000")) {
      throw IllegalArgumentException("Invalid image manifest value")
    }

    val normalizedPath = path
    val rootedPrefix = "bundle-drop/bundles/$bundleHash/"
    if (normalizedPath.startsWith(rootedPrefix)) {
      val relativePath = normalizedPath.removePrefix(rootedPrefix)
      if (!BundleDropBundleVerifier.isSafeManifestPath(relativePath)) throw IllegalArgumentException("Invalid image manifest value")
      return normalizedPath
    }

    val bundleDirMarker = "/bundle-drop/bundles/$bundleHash/"
    val markerIndex = normalizedPath.indexOf(bundleDirMarker)
    if (markerIndex >= 0) {
      val relativePath = normalizedPath.substring(markerIndex + bundleDirMarker.length)
      if (!BundleDropBundleVerifier.isSafeManifestPath(relativePath)) throw IllegalArgumentException("Invalid image manifest value")
      return "$rootedPrefix$relativePath"
    }

    val absoluteBundleDir = bundleDir.absolutePath.replace('\\', '/')
    if (normalizedPath.startsWith("$absoluteBundleDir/")) {
      val relativePath = normalizedPath.removePrefix("$absoluteBundleDir/")
      if (!BundleDropBundleVerifier.isSafeManifestPath(relativePath)) throw IllegalArgumentException("Invalid image manifest value")
      return "$rootedPrefix$relativePath"
    }

    if (normalizedPath.startsWith("/")) {
      throw IllegalArgumentException("Invalid image manifest value")
    }
    if (!BundleDropBundleVerifier.isSafeManifestPath(normalizedPath)) throw IllegalArgumentException("Invalid image manifest value")
    return "$rootedPrefix$normalizedPath"
  }

}
