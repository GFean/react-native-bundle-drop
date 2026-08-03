package com.bundledrop

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class BundleDropOtaPrefsTest {

  @After
  fun tearDown() {
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    BundleDropOtaPrefs.preferences(ctx).edit().clear().commit()
  }

  @Test
  fun `readIsOtaEnabled defaults true when no keys`() {
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    val prefs = BundleDropOtaPrefs.preferences(ctx)
    prefs.edit().clear().commit()
    assertTrue(BundleDropOtaPrefs.readIsOtaEnabled(prefs))
    assertTrue(BundleDropOtaPrefs.isOtaEnabled(ctx))
  }

  @Test
  fun `readIsOtaEnabled reads false from canonical key`() {
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    BundleDropOtaPrefs.writeOtaEnabled(ctx, false)
    assertFalse(BundleDropOtaPrefs.isOtaEnabled(ctx))
  }

}
