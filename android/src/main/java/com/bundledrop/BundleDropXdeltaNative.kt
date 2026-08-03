package com.bundledrop

import java.io.File
import java.io.IOException

internal object BundleDropXdeltaNative {
  private val loadError: Throwable?

  init {
    var error: Throwable? = null
    try {
      System.loadLibrary("bundledropxdelta")
    } catch (e: Throwable) {
      error = e
    }
    loadError = error
  }

  private external fun nativeSupportsXdelta(): Boolean
  private external fun nativeVersion(): String
  private external fun nativeApplyXdelta(basePath: String, patchPath: String, outputPath: String): String?

  fun supportsXdelta(): Boolean {
    if (loadError != null) return false
    return try {
      nativeSupportsXdelta()
    } catch (_: Throwable) {
      false
    }
  }

  fun version(): String? {
    if (loadError != null) return null
    return try {
      nativeVersion()
    } catch (_: Throwable) {
      null
    }
  }

  fun applyXdelta(base: File, patch: File, output: File) {
    if (loadError != null) {
      throw IOException("xdelta3-vcdiff native apply is not linked", loadError)
    }
    output.parentFile?.mkdirs()
    val error = try {
      nativeApplyXdelta(base.absolutePath, patch.absolutePath, output.absolutePath)
    } catch (e: Throwable) {
      try { output.delete() } catch (_: Exception) {}
      throw IOException("xdelta3-vcdiff native apply failed", e)
    }
    if (error != null) {
      try { output.delete() } catch (_: Exception) {}
      throw IOException(error)
    }
  }
}
