package com.bundledrop

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.network.OkHttpClientProvider
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

class BundleDropModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    fun getDownloadedBundlePath(context: Context): String? =
      BundleDropNativePaths.getDownloadedBundlePathPassive(context)

    @JvmStatic
    fun resolveJSBundleFile(context: Context, fallback: String?): String? {
      val path = BundleDropNativePaths.getDownloadedBundlePath(context)
      return if (!path.isNullOrEmpty()) path else fallback
    }
  }

  override fun getName(): String = "BundleDrop"

  @ReactMethod
  fun getDownloadedBundlePath(promise: Promise) {
    promise.resolve(getDownloadedBundlePath(reactApplicationContext))
  }

  @ReactMethod
  fun restartReactNative() {
    val activity = reactApplicationContext.currentActivity ?: return
    val context = reactApplicationContext

    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    if (intent == null) {
      Log.e("BundleDrop", "❌ Could not get launch intent for package")
      return
    }

    try {
      intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.finish()
      context.startActivity(intent)
      Runtime.getRuntime().exit(0)

      Log.d("BundleDrop", "🔁 Restarting app with new bundle...")
    } catch (e: Exception) {
      Log.e("BundleDrop", "❌ Failed to restart app: ${e.message}", e)
    }
  }

  @ReactMethod
  fun setOtaEnabled(enabled: Boolean, promise: Promise) {
    try {
      BundleDropOtaPrefs.writeOtaEnabled(reactApplicationContext, enabled)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERR_SET_OTA_ENABLED", e.message, e)
    }
  }

  @ReactMethod
  fun activateStartupCandidate(
    hash: String,
    maxCrashCount: Double,
    healthCheckMode: String,
    healthyAfterSec: Double,
    promise: Promise,
  ) {
    try {
      require(maxCrashCount.isFinite() && maxCrashCount >= 0 && maxCrashCount % 1.0 == 0.0) {
        "maxCrashCount must be a non-negative integer"
      }
      require(maxCrashCount <= Int.MAX_VALUE) { "maxCrashCount is outside the supported range" }
      val result = BundleDropStartupRecovery.controller(reactApplicationContext)
        .activateCandidate(hash, maxCrashCount.toInt(), healthCheckMode, healthyAfterSec)
      promise.resolve(Arguments.createMap().apply {
        putString("hash", result.hash)
        putString("bundlePath", result.bundlePath)
      })
    } catch (error: Exception) {
      promise.reject("ERR_STARTUP_RECOVERY_ACTIVATE", error.message, error)
    }
  }

  @ReactMethod
  fun markStartupHealthy(hash: String, attemptId: String, promise: Promise) {
    try {
      val marked = BundleDropStartupRecovery.controller(reactApplicationContext)
        .markHealthy(hash, attemptId)
      promise.resolve(marked)
    } catch (error: Exception) {
      promise.reject("ERR_STARTUP_RECOVERY_HEALTH", error.message, error)
    }
  }

  @ReactMethod
  fun getStartupRecoveryState(promise: Promise) {
    try {
      val state = BundleDropStartupRecovery.controller(reactApplicationContext).snapshot()
      promise.resolve(jsonObjectToWritableMap(state))
    } catch (error: Exception) {
      promise.reject("ERR_STARTUP_RECOVERY_STATE", error.message, error)
    }
  }

  @ReactMethod
  fun setStartupRecoveryRevokedHashes(hashes: ReadableArray, promise: Promise) {
    try {
      val values = buildSet {
        for (index in 0 until hashes.size()) {
          val hash = hashes.getString(index)
            ?: throw IllegalArgumentException("Revoked bundle hashes must be strings")
          add(hash)
        }
      }
      promise.resolve(
        BundleDropStartupRecovery.controller(reactApplicationContext)
          .setRevokedHashes(values),
      )
    } catch (error: Exception) {
      promise.reject("ERR_STARTUP_RECOVERY_REVOKE", error.message, error)
    }
  }

  @ReactMethod
  fun acknowledgeStartupRecovery(eventId: String, promise: Promise) {
    try {
      promise.resolve(
        BundleDropStartupRecovery.controller(reactApplicationContext)
          .acknowledgeRecovery(eventId),
      )
    } catch (error: Exception) {
      promise.reject("ERR_STARTUP_RECOVERY_ACK", error.message, error)
    }
  }

  @ReactMethod
  fun rollbackStartupBundle(forceEmbedded: Boolean, promise: Promise) {
    try {
      val result = BundleDropStartupRecovery.controller(reactApplicationContext)
        .rollbackStartupBundle(forceEmbedded)
      promise.resolve(Arguments.createMap().apply {
        putBoolean("rolledBack", result.rolledBack)
        putBoolean("toEmbedded", result.toEmbedded)
        result.hash?.let { putString("hash", it) }
      })
    } catch (error: Exception) {
      promise.reject("ERR_STARTUP_RECOVERY_ROLLBACK", error.message, error)
    }
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getImageManifestSync(): String? {
    return readImageManifestRaw()
  }

  @ReactMethod
  fun getImageManifest(promise: Promise) {
    promise.resolve(readImageManifestRaw())
  }

  private fun readImageManifestRaw(): String? {
    val context = reactApplicationContext
    val bundleDropRoot = File(context.filesDir, "bundle-drop")
    val current = BundleDropOtaResolver.readCurrentPointer(bundleDropRoot) ?: return null
    return BundleDropOtaResolver.readImageManifest(current)
  }

  // ---------------------------------------------------------------------------
  // FS primitives (replaces react-native-fs dependency)
  // ---------------------------------------------------------------------------

  @ReactMethod
  fun fsExists(path: String, promise: Promise) {
    promise.resolve(File(path).exists())
  }

  @ReactMethod
  fun fsReadFile(path: String, encoding: String, promise: Promise) {
    try {
      val file = File(path)
      if (!file.exists()) {
        promise.reject("ENOENT", "File not found: $path")
        return
      }
      if (encoding == "base64") {
        val bytes = file.readBytes()
        promise.resolve(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
      } else {
        promise.resolve(file.readText(Charsets.UTF_8))
      }
    } catch (e: Exception) {
      promise.reject("ERR_READ", e.message, e)
    }
  }

  @ReactMethod
  fun fsWriteFile(path: String, content: String, encoding: String, promise: Promise) {
    try {
      val file = File(path)
      file.parentFile?.mkdirs()
      if (encoding == "base64") {
        val bytes = android.util.Base64.decode(content, android.util.Base64.DEFAULT)
        file.writeBytes(bytes)
      } else {
        file.writeText(content, Charsets.UTF_8)
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERR_WRITE", e.message, e)
    }
  }

  @ReactMethod
  fun fsMkdir(path: String, promise: Promise) {
    try {
      val dir = File(path)
      if (!dir.exists()) dir.mkdirs()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERR_MKDIR", e.message, e)
    }
  }

  @ReactMethod
  fun fsReadDir(path: String, promise: Promise) {
    try {
      val dir = File(path)
      val names = dir.list() ?: emptyArray()
      val result = Arguments.createArray()
      names.forEach { result.pushString(it) }
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("ERR_READDIR", e.message, e)
    }
  }

  @ReactMethod
  fun fsUnlink(path: String, promise: Promise) {
    try {
      BundleDropFileOps.unlinkPath(path)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERR_UNLINK", e.message, e)
    }
  }

  @ReactMethod
  fun fsMoveFile(src: String, dest: String, promise: Promise) {
    try {
      BundleDropFileOps.moveFile(File(src), File(dest))
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERR_MOVE", e.message, e)
    }
  }

  @ReactMethod
  fun fsCopyFile(src: String, dest: String, promise: Promise) {
    try {
      BundleDropFileOps.copyFile(File(src), File(dest))
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ERR_COPY", e.message, e)
    }
  }

  @ReactMethod
  fun fsSha256File(path: String, promise: Promise) {
    try {
      promise.resolve(BundleDropFileOps.sha256File(File(path)))
    } catch (e: Exception) {
      promise.reject("ERR_SHA256", e.message, e)
    }
  }

  @ReactMethod
  fun fsSha256String(value: String, promise: Promise) {
    try {
      promise.resolve(BundleDropRuntimeCrypto.sha256String(value))
    } catch (e: Exception) {
      promise.reject("ERR_SHA256", e.message, e)
    }
  }

  @ReactMethod
  fun fsVerifyEs256Signature(
    signingInput: String,
    signatureBase64Url: String,
    xBase64Url: String,
    yBase64Url: String,
    promise: Promise,
  ) {
    try {
      promise.resolve(
        BundleDropRuntimeCrypto.verifyEs256Signature(
          signingInput,
          signatureBase64Url,
          xBase64Url,
          yBase64Url,
        ),
      )
    } catch (e: Exception) {
      promise.reject("ERR_ES256_VERIFY", e.message, e)
    }
  }

  @ReactMethod
  fun fsFileSize(path: String, promise: Promise) {
    try {
      promise.resolve(BundleDropFileOps.fileSize(File(path)).toDouble())
    } catch (e: Exception) {
      promise.reject("ERR_FILE_SIZE", e.message, e)
    }
  }

  @ReactMethod
  fun fsApplyXdelta(basePath: String, patchPath: String, outputPath: String, promise: Promise) {
    Thread {
      try {
        BundleDropFileOps.applyXdelta(File(basePath), File(patchPath), File(outputPath))
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("ERR_XDELTA", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun fsVerifyBundleFiles(bundleDir: String, manifestPath: String, promise: Promise) {
    Thread {
      try {
        BundleDropBundleVerifier.verifyBundleFiles(File(bundleDir), File(manifestPath))
        val result = Arguments.createMap()
        result.putBoolean("verified", true)
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("ERR_VERIFY_BUNDLE", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun fsSupportsXdelta(promise: Promise) {
    promise.resolve(BundleDropFileOps.supportsXdelta())
  }

  @ReactMethod
  fun fsUnzip(zipPath: String, destPath: String, promise: Promise) {
    Thread {
      try {
        val filenames = BundleDropFileOps.unzipFile(zipPath, destPath)
        val result = Arguments.createArray()
        filenames.forEach { result.pushString(it) }
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("ERR_UNZIP", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun fsDownloadFile(url: String, destPath: String, promise: Promise) {
    Thread {
      try {
        val parsedUrl = BundleDropFileOps.validateHttpUrl(url)
        BundleDropFileOps.downloadToFile(parsedUrl, File(destPath))
        promise.resolve(null)
      } catch (e: Exception) {
        try { File(destPath).delete() } catch (_: Exception) {}
        promise.reject("ERR_DOWNLOAD", e.message, e)
      }
    }.start()
  }

  @ReactMethod
  fun fsDownloadFileBounded(
    url: String,
    destPath: String,
    maxBytes: Double,
    timeoutMs: Double,
    promise: Promise,
  ) {
    Thread {
      try {
        require(maxBytes.isFinite() && maxBytes >= 1) { "maxBytes must be positive" }
        require(timeoutMs.isFinite() && timeoutMs >= 1 && timeoutMs <= Int.MAX_VALUE) {
          "timeoutMs is outside the supported range"
        }
        val parsedUrl = BundleDropFileOps.validateHttpUrl(url)
        BundleDropBoundedDownloader.downloadToFile(
          OkHttpClientProvider.getOkHttpClient(),
          parsedUrl,
          File(destPath),
          maxBytes = maxBytes.toLong(),
          timeoutMs = timeoutMs.toLong(),
        )
        promise.resolve(null)
      } catch (e: Exception) {
        try { File(destPath).delete() } catch (_: Exception) {}
        val code = when {
          e is BundleDropBoundedDownloadTimeoutException -> "ERR_DOWNLOAD_TIMEOUT"
          e is BundleDropBoundedDownloadTooLargeException -> "ERR_DOWNLOAD_TOO_LARGE"
          e is BundleDropBoundedDownloadHttpException -> "ERR_DOWNLOAD_HTTP"
          else -> "ERR_DOWNLOAD_NETWORK"
        }
        val message = e.message.orEmpty()
        promise.reject(code, message.ifEmpty { "Manifest download failed" }, e)
      }
    }.start()
  }

  override fun getConstants(): MutableMap<String, Any> {
    val map = mutableMapOf<String, Any>()
    map["startupRecoveryProtocolVersion"] = BundleDropStartupRecoveryController.PROTOCOL_VERSION
    @Suppress("UNCHECKED_CAST")
    (map as MutableMap<String, Any?>)["startupRecoverySelectedHash"] =
      BundleDropStartupRecovery.startupSelectedHash()
    BundleDropStartupRecovery.startupAttempt()?.let { (hash, attemptId) ->
      map["startupRecoveryAttemptHash"] = hash
      map["startupRecoveryAttemptId"] = attemptId
    }
    val context = reactApplicationContext
    map["DocumentDirectoryPath"] = context.filesDir.absolutePath
    map["LibraryDirectoryPath"] = context.filesDir.absolutePath
    return map
  }

  private fun jsonObjectToWritableMap(json: JSONObject): WritableMap {
    val map = Arguments.createMap()
    val keys = json.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      putJsonValue(map, key, json.opt(key))
    }
    return map
  }

  private fun jsonArrayToWritableArray(json: JSONArray): WritableArray {
    val array = Arguments.createArray()
    for (index in 0 until json.length()) {
      when (val value = json.opt(index)) {
        null, JSONObject.NULL -> array.pushNull()
        is JSONObject -> array.pushMap(jsonObjectToWritableMap(value))
        is JSONArray -> array.pushArray(jsonArrayToWritableArray(value))
        is Boolean -> array.pushBoolean(value)
        is Number -> array.pushDouble(value.toDouble())
        else -> array.pushString(value.toString())
      }
    }
    return array
  }

  private fun putJsonValue(map: WritableMap, key: String, value: Any?) {
    when (value) {
      null, JSONObject.NULL -> map.putNull(key)
      is JSONObject -> map.putMap(key, jsonObjectToWritableMap(value))
      is JSONArray -> map.putArray(key, jsonArrayToWritableArray(value))
      is Boolean -> map.putBoolean(key, value)
      is Number -> map.putDouble(key, value.toDouble())
      else -> map.putString(key, value.toString())
    }
  }
}
