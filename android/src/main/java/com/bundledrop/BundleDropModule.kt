package com.bundledrop

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.bridge.*
import java.io.File

class BundleDropModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var downloadedBundlePath: String? = null

  companion object {
    var latestBundlePath: String? = null
      private set

    fun getDownloadedBundlePath(context: Context): String? =
      BundleDropNativePaths.getDownloadedBundlePath(context)

    @JvmStatic
    fun resolveJSBundleFile(context: Context, fallback: String?): String? {
      val path = getDownloadedBundlePath(context)
      return if (!path.isNullOrEmpty()) path else fallback
    }
  }

  override fun getName(): String = "BundleDrop"

  @ReactMethod
  fun getDownloadedBundlePath(promise: Promise) {
    val path = getDownloadedBundlePath(reactApplicationContext)
    downloadedBundlePath = path
    latestBundlePath = path
    promise.resolve(path)
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

  override fun getConstants(): MutableMap<String, Any> {
    val map = mutableMapOf<String, Any>()
    downloadedBundlePath?.let {
      map["downloadedBundlePath"] = it
    }
    val context = reactApplicationContext
    map["DocumentDirectoryPath"] = context.filesDir.absolutePath
    map["LibraryDirectoryPath"] = context.filesDir.absolutePath
    return map
  }
}
