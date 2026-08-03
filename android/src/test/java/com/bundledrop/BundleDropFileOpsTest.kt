package com.bundledrop

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class BundleDropFileOpsTest {

  @get:Rule
  val tempFolder = TemporaryFolder()

  // ---------------------------------------------------------------------------
  // URL scheme validation
  // ---------------------------------------------------------------------------

  @Test
  fun `validateHttpUrl accepts https`() {
    val url = BundleDropFileOps.validateHttpUrl("https://cdn.example.com/bundle.zip")
    assertEquals("https", url.protocol)
  }

  @Test
  fun `validateHttpUrl accepts http`() {
    val url = BundleDropFileOps.validateHttpUrl("http://localhost:4000/bundle.zip")
    assertEquals("http", url.protocol)
  }

  @Test(expected = java.io.IOException::class)
  fun `validateHttpUrl rejects file scheme`() {
    BundleDropFileOps.validateHttpUrl("file:///etc/passwd")
  }

  @Test(expected = java.io.IOException::class)
  fun `validateHttpUrl rejects ftp scheme`() {
    BundleDropFileOps.validateHttpUrl("ftp://ftp.example.com/file")
  }

  @Test(expected = java.net.MalformedURLException::class)
  fun `validateHttpUrl rejects empty string`() {
    BundleDropFileOps.validateHttpUrl("")
  }

  @Test(expected = java.net.MalformedURLException::class)
  fun `validateHttpUrl rejects garbage`() {
    BundleDropFileOps.validateHttpUrl("not-a-url")
  }

  // ---------------------------------------------------------------------------
  // Recursive unlink
  // ---------------------------------------------------------------------------

  @Test
  fun `unlinkPath deletes a single file`() {
    val file = tempFolder.newFile("test.txt")
    assertTrue(file.exists())
    BundleDropFileOps.unlinkPath(file.absolutePath)
    assertFalse(file.exists())
  }

  @Test
  fun `unlinkPath deletes a nested directory recursively`() {
    val dir = tempFolder.newFolder("parent", "child")
    File(dir, "nested.txt").writeText("content")
    val parent = dir.parentFile!!
    assertTrue(parent.exists())

    BundleDropFileOps.unlinkPath(parent.absolutePath)
    assertFalse(parent.exists())
  }

  @Test
  fun `unlinkPath is idempotent on non-existent path`() {
    BundleDropFileOps.unlinkPath("/nonexistent/path/that/does/not/exist")
  }

  // ---------------------------------------------------------------------------
  // Zip extraction -- valid archive
  // ---------------------------------------------------------------------------

  @Test
  fun `unzipFile extracts a valid zip with files and directories`() {
    val zipFile = createZip(
      "main.jsbundle" to "console.log('hello');",
      "assets/icon.png" to "fake-png-data",
    )
    val destDir = tempFolder.newFolder("output")

    val filenames = BundleDropFileOps.unzipFile(zipFile.absolutePath, destDir.absolutePath)

    assertEquals(listOf("main.jsbundle", "assets/icon.png"), filenames)
    assertTrue(File(destDir, "main.jsbundle").exists())
    assertEquals("console.log('hello');", File(destDir, "main.jsbundle").readText())
    assertTrue(File(destDir, "assets/icon.png").exists())
  }

  @Test
  fun `unzipFile creates destDir if it does not exist`() {
    val zipFile = createZip("file.txt" to "data")
    val destDir = File(tempFolder.root, "new-dir")
    assertFalse(destDir.exists())

    BundleDropFileOps.unzipFile(zipFile.absolutePath, destDir.absolutePath)
    assertTrue(destDir.exists())
    assertTrue(File(destDir, "file.txt").exists())
  }

  // ---------------------------------------------------------------------------
  // Zip slip (path traversal)
  // ---------------------------------------------------------------------------

  @Test
  fun `unzipFile rejects zip slip entry`() {
    val zipFile = createZip("../../../etc/passwd" to "root:x:0:0")
    val destDir = tempFolder.newFolder("safe-output")

    try {
      BundleDropFileOps.unzipFile(zipFile.absolutePath, destDir.absolutePath)
      fail("Expected SecurityException for zip slip entry")
    } catch (e: SecurityException) {
      assertTrue(e.message!!.contains("Unsafe ZIP entry path"))
    }
  }

  @Test
  fun `unzipFile rejects zip slip directory entry`() {
    val zipFile = createZipWithDirEntry("../../evil-dir/")
    val destDir = tempFolder.newFolder("safe-output2")

    try {
      BundleDropFileOps.unzipFile(zipFile.absolutePath, destDir.absolutePath)
      fail("Expected SecurityException for zip slip directory")
    } catch (e: SecurityException) {
      assertTrue(e.message!!.contains("Unsafe ZIP entry path"))
    }
  }

  @Test
  fun `unzipFile rejects unsafe separators in entry names`() {
    val zipFile = createZip("assets\\icon.png" to "fake-png-data")
    val destDir = tempFolder.newFolder("unsafe-separator")

    try {
      BundleDropFileOps.unzipFile(zipFile.absolutePath, destDir.absolutePath)
      fail("Expected SecurityException for unsafe separator")
    } catch (e: SecurityException) {
      assertTrue(e.message!!.contains("Unsafe ZIP entry path"))
    }
  }

  // ---------------------------------------------------------------------------
  // Per-entry byte cap
  // ---------------------------------------------------------------------------

  @Test
  fun `unzipFile rejects entry exceeding per-entry byte limit`() {
    val content = "x".repeat(2000)
    val zipFile = createZip("big.txt" to content)
    val destDir = tempFolder.newFolder("capped")

    try {
      BundleDropFileOps.unzipFile(
        zipFile.absolutePath,
        destDir.absolutePath,
        maxEntryBytes = 1000,
        maxTotalBytes = Long.MAX_VALUE,
      )
      fail("Expected IOException for per-entry limit")
    } catch (e: java.io.IOException) {
      assertTrue(e.message!!.contains("ZIP entry exceeds"))
    }
  }

  // ---------------------------------------------------------------------------
  // Total uncompressed byte cap
  // ---------------------------------------------------------------------------

  @Test
  fun `unzipFile rejects archive exceeding total byte limit`() {
    val zipFile = createZip(
      "a.txt" to "x".repeat(600),
      "b.txt" to "y".repeat(600),
    )
    val destDir = tempFolder.newFolder("total-capped")

    try {
      BundleDropFileOps.unzipFile(
        zipFile.absolutePath,
        destDir.absolutePath,
        maxEntryBytes = Long.MAX_VALUE,
        maxTotalBytes = 1000,
      )
      fail("Expected IOException for total limit")
    } catch (e: java.io.IOException) {
      assertTrue(e.message!!.contains("total uncompressed"))
    }
  }

  // ---------------------------------------------------------------------------
  // Empty zip
  // ---------------------------------------------------------------------------

  @Test
  fun `unzipFile handles empty zip`() {
    val zipFile = createEmptyZip()
    val destDir = tempFolder.newFolder("empty-out")

    val filenames = BundleDropFileOps.unzipFile(zipFile.absolutePath, destDir.absolutePath)
    assertTrue(filenames.isEmpty())
  }

  @Test
  fun `unzipFile rejects malformed zip`() {
    val zipFile = File(tempFolder.root, "malformed.zip").apply {
      writeBytes(byteArrayOf(0x50, 0x4b, 0x03, 0x04))
    }
    val destDir = File(tempFolder.root, "malformed-out")

    try {
      BundleDropFileOps.unzipFile(zipFile.absolutePath, destDir.absolutePath)
      fail("Expected IOException for malformed archive")
    } catch (e: java.io.IOException) {
      assertTrue(e.message!!.contains("Invalid ZIP"))
    }

    assertFalse(destDir.exists())
  }

  // ---------------------------------------------------------------------------
  // moveFile
  // ---------------------------------------------------------------------------

  @Test
  fun `moveFile renames a file successfully`() {
    val src = tempFolder.newFile("source.txt")
    src.writeText("data")
    val dest = File(tempFolder.root, "dest.txt")

    BundleDropFileOps.moveFile(src, dest)

    assertFalse(src.exists())
    assertTrue(dest.exists())
    assertEquals("data", dest.readText())
  }

  @Test
  fun `moveFile creates destination parent directories`() {
    val src = tempFolder.newFile("source.txt")
    src.writeText("data")
    val dest = File(tempFolder.root, "deep/nested/dir/dest.txt")

    BundleDropFileOps.moveFile(src, dest)

    assertFalse(src.exists())
    assertTrue(dest.exists())
    assertEquals("data", dest.readText())
  }

  @Test
  fun `moveFile overwrites existing destination`() {
    val src = tempFolder.newFile("source.txt")
    src.writeText("new content")
    val dest = tempFolder.newFile("dest.txt")
    dest.writeText("old content")

    BundleDropFileOps.moveFile(src, dest)

    assertFalse(src.exists())
    assertEquals("new content", dest.readText())
  }

  @Test
  fun `copyFile creates parents and leaves source in place`() {
    val src = tempFolder.newFile("copy-source.txt")
    src.writeText("copy-data")
    val dest = File(tempFolder.root, "copy/deep/dest.txt")

    BundleDropFileOps.copyFile(src, dest)

    assertTrue(src.exists())
    assertTrue(dest.exists())
    assertEquals("copy-data", dest.readText())
  }

  @Test
  fun `sha256File streams file content`() {
    val file = tempFolder.newFile("hash.txt")
    file.writeText("hello")

    assertEquals(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      BundleDropFileOps.sha256File(file),
    )
  }

  @Test
  fun `applyXdelta fails cleanly when native xdelta library is not loaded in host tests`() {
    val base = tempFolder.newFile("base.bin")
    val patch = tempFolder.newFile("patch.vcdiff")
    val output = patchTargetOutput("out.bin")
    base.writeText("base")
    patch.writeText("not-a-vcdiff")

    assertFalse(BundleDropFileOps.supportsXdelta())
    try {
      BundleDropFileOps.applyXdelta(base, patch, output)
      fail("Expected xdelta apply to fail")
    } catch (e: Exception) {
      assertFalse(output.exists())
    }
  }

  @Test
  fun `applyXdelta rejects output outside patch target temp directory`() {
    val base = tempFolder.newFile("base-outside.bin")
    val patch = tempFolder.newFile("patch-outside.vcdiff")
    val output = File(tempFolder.root, "out.bin")

    try {
      BundleDropFileOps.applyXdelta(base, patch, output)
      fail("Expected xdelta output path validation to fail")
    } catch (e: SecurityException) {
      assertTrue(e.message!!.contains("bundle-drop/bundles"))
    }
  }

  @Test
  fun `applyXdelta rejects output in active bundle directory`() {
    val base = tempFolder.newFile("base-active.bin")
    val patch = tempFolder.newFile("patch-active.vcdiff")
    val activeHash = "a".repeat(64)
    val output = File(tempFolder.root, "bundle-drop/bundles/$activeHash/main.jsbundle")

    try {
      BundleDropFileOps.applyXdelta(base, patch, output)
      fail("Expected active bundle output path validation to fail")
    } catch (e: SecurityException) {
      assertTrue(e.message!!.contains("active bundle"))
    }
  }

  @Test
  fun `applyXdelta rejects traversal output path before native apply`() {
    val base = tempFolder.newFile("base-traversal.bin")
    val patch = tempFolder.newFile("patch-traversal.vcdiff")
    val output = File(tempFolder.root, "bundle-drop/bundles/_patch_target_${"b".repeat(64)}/../escape.bin")

    try {
      BundleDropFileOps.applyXdelta(base, patch, output)
      fail("Expected traversal output path validation to fail")
    } catch (e: SecurityException) {
      assertTrue(e.message!!.contains("traversal"))
    }
  }

  // ---------------------------------------------------------------------------
  // downloadToFile
  // ---------------------------------------------------------------------------

  @Test
  fun `downloadToFile writes a successful small response`() {
    withHttpServer(status = 200, body = "bundle-data".toByteArray()) { url ->
      val dest = File(tempFolder.root, "downloads/bundle.zip")

      BundleDropFileOps.downloadToFile(url, dest, maxBytes = 1024)

      assertTrue(dest.exists())
      assertEquals("bundle-data", dest.readText())
    }
  }

  @Test
  fun `downloadToFile rejects non-2xx response and cleans destination`() {
    withHttpServer(status = 500, body = "server error".toByteArray()) { url ->
      val dest = tempFolder.newFile("stale.zip")
      dest.writeText("stale")

      try {
        BundleDropFileOps.downloadToFile(url, dest, maxBytes = 1024)
        fail("Expected IOException for non-2xx response")
      } catch (e: java.io.IOException) {
        assertTrue(e.message!!.contains("HTTP 500"))
      }

      assertFalse(dest.exists())
    }
  }

  @Test
  fun `downloadToFile rejects oversized response and cleans partial file`() {
    withHttpServer(status = 200, body = "x".repeat(64).toByteArray()) { url ->
      val dest = File(tempFolder.root, "oversized/bundle.zip")

      try {
        BundleDropFileOps.downloadToFile(url, dest, maxBytes = 16)
        fail("Expected IOException for oversized download")
      } catch (e: java.io.IOException) {
        assertTrue(e.message!!.contains("Download exceeds"))
      }

      assertFalse(dest.exists())
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private fun createZip(vararg entries: Pair<String, String>): File {
    val zipFile = File(tempFolder.root, "test-${System.nanoTime()}.zip")
    ZipOutputStream(FileOutputStream(zipFile)).use { zos ->
      for ((name, content) in entries) {
        zos.putNextEntry(ZipEntry(name))
        zos.write(content.toByteArray())
        zos.closeEntry()
      }
    }
    return zipFile
  }

  private fun createZipWithDirEntry(dirName: String): File {
    val zipFile = File(tempFolder.root, "slipdir-${System.nanoTime()}.zip")
    ZipOutputStream(FileOutputStream(zipFile)).use { zos ->
      zos.putNextEntry(ZipEntry(dirName))
      zos.closeEntry()
    }
    return zipFile
  }

  private fun createEmptyZip(): File {
    val zipFile = File(tempFolder.root, "empty-${System.nanoTime()}.zip")
    ZipOutputStream(FileOutputStream(zipFile)).use { /* no entries */ }
    return zipFile
  }

  private fun patchTargetOutput(filename: String): File =
    File(tempFolder.root, "bundle-drop/bundles/_patch_target_${"a".repeat(64)}/$filename")

  private fun withHttpServer(status: Int, body: ByteArray, test: (URL) -> Unit) {
    val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    val serverError = AtomicReference<Throwable?>()
    val thread = Thread {
      try {
        server.accept().use { socket ->
          socket.soTimeout = 5_000
          val reader = BufferedReader(InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII))
          while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
          }

          val header =
            "HTTP/1.1 $status ${reasonPhrase(status)}\r\n" +
              "Content-Length: ${body.size}\r\n" +
              "Connection: close\r\n" +
              "\r\n"
          socket.getOutputStream().use { output ->
            output.write(header.toByteArray(StandardCharsets.US_ASCII))
            output.write(body)
            output.flush()
          }
        }
      } catch (e: SocketException) {
        if (!server.isClosed) serverError.set(e)
      } catch (e: Throwable) {
        serverError.set(e)
      }
    }
    thread.start()

    try {
      test(URL("http://127.0.0.1:${server.localPort}/bundle.zip"))
    } finally {
      server.close()
      thread.join(5_000)
      serverError.get()?.let { throw AssertionError("HTTP test server failed", it) }
    }
  }

  private fun reasonPhrase(status: Int): String =
    when (status) {
      200 -> "OK"
      500 -> "Internal Server Error"
      else -> "Status"
    }
}
