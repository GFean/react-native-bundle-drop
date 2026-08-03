package com.bundledrop

import android.content.Context
import android.content.SharedPreferences

/**
 * Persist whether the native bundle resolver may load an OTA JS bundle on cold start.
 *
 * **Storage:** [PREFS_NAME] SharedPreferences file. [KEY_OTA_ENABLED] matches iOS
 * `BundleDropLocator.otaEnabledKey` (`bundledrop_ota_enabled`) for cross-platform debugging.
 */
object BundleDropOtaPrefs {
  const val PREFS_NAME = "BundleDropPrefs"
  const val KEY_OTA_ENABLED = "bundledrop_ota_enabled"

  fun preferences(context: Context): SharedPreferences =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  fun isOtaEnabled(context: Context): Boolean = readIsOtaEnabled(preferences(context))

  fun readIsOtaEnabled(prefs: SharedPreferences): Boolean {
    if (!prefs.contains(KEY_OTA_ENABLED)) return true
    return prefs.getBoolean(KEY_OTA_ENABLED, true)
  }

  fun writeOtaEnabled(context: Context, enabled: Boolean) {
    preferences(context).edit()
      .putBoolean(KEY_OTA_ENABLED, enabled)
      .apply()
  }
}
