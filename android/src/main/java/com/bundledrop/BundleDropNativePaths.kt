package com.bundledrop

import android.content.Context
import android.util.Log
import java.io.File
import org.json.JSONObject

/**
 * Resolves the on-disk OTA JS bundle path (no React / bridge types).
 *
 * Shared by [BundleDropModule] so cold-start `resolveJSBundleFile`, the JS bridge
 * `getDownloadedBundlePath`, and tests use the same logic — including the OTA-disabled gate.
 */
object BundleDropNativePaths {
  private const val KEY_BINARY_VERSION = "binary_version"
  private const val BUILD_IDENTITY_ASSET = "bundle-drop/build-identity.json"

  internal fun binaryVersionKey(
    versionName: String,
    versionCode: Long,
    runtimeVersion: String?,
  ): String {
    val binaryVersion = "$versionName-$versionCode"
    return if (runtimeVersion?.trim().isNullOrEmpty()) {
      binaryVersion
    } else {
      "runtime:$runtimeVersion|binary:$binaryVersion"
    }
  }

  private fun getBinaryVersionKey(context: Context, runtimeVersion: String?): String {
    val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
    val versionName = pInfo.versionName ?: "unknown"
    @Suppress("DEPRECATION")
    val versionCode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
      pInfo.longVersionCode
    } else {
      pInfo.versionCode.toLong()
    }
    return binaryVersionKey(versionName, versionCode, runtimeVersion)
  }

  internal fun readEmbeddedRuntimeVersion(context: Context): String? {
    return try {
      context.assets.open(BUILD_IDENTITY_ASSET).bufferedReader().use { reader ->
        JSONObject(reader.readText())
          .optString("runtimeVersion", "")
          .takeIf { it.trim().isNotEmpty() }
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun getStoredBinaryVersion(context: Context): String? {
    return context.getSharedPreferences(BundleDropOtaPrefs.PREFS_NAME, Context.MODE_PRIVATE)
      .getString(KEY_BINARY_VERSION, null)
  }

  private fun setStoredBinaryVersion(context: Context, version: String) {
    context.getSharedPreferences(BundleDropOtaPrefs.PREFS_NAME, Context.MODE_PRIVATE)
      .edit().putString(KEY_BINARY_VERSION, version).apply()
  }

  @JvmStatic
  fun getDownloadedBundlePath(context: Context): String? {
    if (!BundleDropOtaPrefs.isOtaEnabled(context)) return null
    return getDownloadedBundlePath(context, readEmbeddedRuntimeVersion(context))
  }

  internal fun getDownloadedBundlePath(context: Context, runtimeVersion: String?): String? {
    val bundleDropRoot = File(context.filesDir, "bundle-drop")
    val result = BundleDropOtaResolver.resolve(
      bundleDropRoot = bundleDropRoot,
      filesDir = context.filesDir,
      currentBinaryVersion = getBinaryVersionKey(context, runtimeVersion),
      storedBinaryVersion = getStoredBinaryVersion(context),
    )

    result.storedVersion?.let { setStoredBinaryVersion(context, it) }

    if (result.bundlePath == null) {
      if (result.clearedOta) {
        Log.d("BundleDrop", "Binary updated, clearing OTA bundle")
      } else {
        Log.d("BundleDrop", "📦 No OTA bundle found.")
      }
    } else {
      Log.d("BundleDrop", "🔁 Using OTA bundle at: ${result.bundlePath}")
    }

    return result.bundlePath
  }
}
