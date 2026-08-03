package com.bundledrop.expo

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

internal object BundleDropExpoConfiguration {
  private const val ENABLED_META_DATA = "com.bundledrop.EXPO_ENABLED"

  @Volatile
  private var otaStartupEnabled = false

  fun isEnabled(context: Context): Boolean {
    val applicationInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.getApplicationInfo(
        context.packageName,
        PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()),
      )
    } else {
      @Suppress("DEPRECATION")
      context.packageManager.getApplicationInfo(
        context.packageName,
        PackageManager.GET_META_DATA,
      )
    }

    return applicationInfo.metaData?.getBoolean(ENABLED_META_DATA, false) == true
  }

  fun resolveOtaStartupEnabled(context: Context, useDeveloperSupport: Boolean): Boolean {
    return (!useDeveloperSupport && isEnabled(context)).also { otaStartupEnabled = it }
  }

  fun isOtaStartupEnabled(): Boolean = otaStartupEnabled
}
