package com.bundledrop

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BundleDropXdeltaInstrumentedTest {
  @Test
  fun applyXdeltaUsesBundledNativeLibrary() {
    assertTrue(BundleDropFileOps.supportsXdelta())

    val root = freshTestRoot()
    val base = File(root, "base.txt").apply {
      writeText("Bundle Drop xdelta base fixture\nline one\n")
    }
    val patch = File(root, "patch.vcdiff").apply {
      writeBytes(goldenPatch)
    }
    val output = patchTargetOutput(root, "main.jsbundle")

    BundleDropFileOps.applyXdelta(base, patch, output)

    assertArrayEquals(
      "Bundle Drop xdelta target fixture\nline two\n".toByteArray(),
      output.readBytes(),
    )
  }

  @Test
  fun applyXdeltaRemovesPartialOutputOnFailure() {
    val root = freshTestRoot()
    val base = File(root, "base.txt").apply {
      writeText("Bundle Drop xdelta base fixture\nline one\n")
    }
    val patch = File(root, "corrupt.vcdiff").apply {
      writeText("not-a-vcdiff")
    }
    val output = patchTargetOutput(root, "main.jsbundle").apply {
      parentFile?.mkdirs()
      writeText("stale")
    }

    try {
      BundleDropFileOps.applyXdelta(base, patch, output)
      throw AssertionError("Expected corrupt xdelta patch to fail")
    } catch (_: Exception) {
      assertFalse(output.exists())
    }
  }

  private fun freshTestRoot(): File {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    return File(context.cacheDir, "bundle-drop-xdelta-${System.nanoTime()}").apply {
      deleteRecursively()
      mkdirs()
    }
  }

  private fun patchTargetOutput(root: File, filename: String): File =
    File(root, "bundle-drop/bundles/_patch_target_${"a".repeat(64)}/$filename")

  private val goldenPatch = byteArrayOf(
    0xd6.toByte(), 0xc3.toByte(), 0xc4.toByte(), 0x00, 0x04, 0x15, 0x74, 0x61,
    0x72, 0x67, 0x65, 0x74, 0x2e, 0x74, 0x78, 0x74, 0x2f, 0x2f, 0x62, 0x61,
    0x73, 0x65, 0x2e, 0x74, 0x78, 0x74, 0x2f, 0x05, 0x25, 0x00, 0x1a, 0x2b,
    0x00, 0x0a, 0x05, 0x02, 0x5d, 0x5e, 0x0f, 0xb6.toByte(), 0x74, 0x61,
    0x72, 0x67, 0x65, 0x74, 0x74, 0x77, 0x6f, 0x0a, 0x13, 0x13, 0x07, 0x1e,
    0x05, 0x00, 0x17,
  )
}
