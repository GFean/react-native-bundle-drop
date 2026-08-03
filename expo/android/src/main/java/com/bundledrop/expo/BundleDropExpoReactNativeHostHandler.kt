package com.bundledrop.expo

import android.content.Context
import com.bundledrop.BundleDropNativePaths
import expo.modules.core.interfaces.ReactNativeHostHandler

internal class BundleDropExpoReactNativeHostHandler(
  private val context: Context,
) : ReactNativeHostHandler {
  override fun getJSBundleFile(useDeveloperSupport: Boolean): String? {
    if (!BundleDropExpoConfiguration.resolveOtaStartupEnabled(context, useDeveloperSupport)) {
      return null
    }
    return BundleDropNativePaths.getDownloadedBundlePath(context)
  }
}
