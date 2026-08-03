package com.bundledrop.expo

import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

internal class BundleDropExpoIdentityModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "BundleDropExpoIdentity"

  override fun getConstants(): Map<String, Any> {
    val packageInfo = reactApplicationContext.packageManager.getPackageInfo(
      reactApplicationContext.packageName,
      0,
    )
    val buildVersion = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.longVersionCode
    } else {
      @Suppress("DEPRECATION")
      packageInfo.versionCode.toLong()
    }

    return mapOf(
      "appVersion" to (packageInfo.versionName ?: ""),
      "appBuildVersion" to buildVersion.toString(),
      "otaStartupEnabled" to BundleDropExpoConfiguration.isOtaStartupEnabled(),
    )
  }
}
