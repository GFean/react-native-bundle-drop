package com.bundledrop

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class BundleDropNativePathsTest {
  private val validHash = "97739904ea21a6e1d8ee11a8b1fffcd1b90a7e536036c24a53e4e030f06b7248"

  @After
  fun tearDown() {
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    BundleDropOtaPrefs.preferences(ctx).edit().clear().commit()
    File(ctx.filesDir, "bundle-drop").deleteRecursively()
  }

  @Test
  fun `getDownloadedBundlePath returns null when OTA disabled even if current json points at bundle`() {
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    BundleDropOtaPrefs.writeOtaEnabled(ctx, false)

    val root = File(ctx.filesDir, "bundle-drop")
    root.mkdirs()
    val bundleDir = File(root, "bundles/$validHash")
    bundleDir.mkdirs()
    val bundleFile = File(bundleDir, "main.jsbundle").apply { writeText("bundle") }
    File(bundleDir, "bundle-manifest.json").writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6}]}"""
    )
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}""",
    )

    assertNull(BundleDropNativePaths.getDownloadedBundlePath(ctx))
  }

  @Test
  fun `binary version key includes an embedded Expo runtime and preserves the bare fallback`() {
    assertEquals(
      "runtime:runtime-2|binary:1.2.3-8",
      BundleDropNativePaths.binaryVersionKey("1.2.3", 8, "runtime-2"),
    )
    assertEquals(
      "1.2.3-8",
      BundleDropNativePaths.binaryVersionKey("1.2.3", 8, null),
    )
    assertEquals(
      "1.2.3-8",
      BundleDropNativePaths.binaryVersionKey("1.2.3", 8, "  "),
    )
  }

  @Test
  fun `runtime change clears stale OTA state before React starts`() {
    val ctx = ApplicationProvider.getApplicationContext<Context>()
    val root = File(ctx.filesDir, "bundle-drop").apply { mkdirs() }
    val currentPointer = File(root, "current.json").apply { writeText("stale OTA pointer") }
    BundleDropOtaPrefs.preferences(ctx).edit()
      .putString("binary_version", "runtime:runtime-1|binary:1.2.3-8")
      .commit()

    assertNull(BundleDropNativePaths.getDownloadedBundlePath(ctx, "runtime-2"))

    assertFalse(currentPointer.exists())
    val storedVersion = BundleDropOtaPrefs.preferences(ctx)
      .getString("binary_version", null)
    assertTrue(storedVersion?.startsWith("runtime:runtime-2|binary:") == true)
  }
}
