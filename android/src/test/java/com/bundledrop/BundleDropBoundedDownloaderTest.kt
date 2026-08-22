package com.bundledrop

import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.GZIPOutputStream
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BundleDropBoundedDownloaderTest {
  @get:Rule
  val tempFolder = TemporaryFolder()

  private val client = OkHttpClient.Builder().build()

  @Test
  fun `accepts the exact byte limit and rejects one byte over`() {
    val exactBody = "x".repeat(16).toByteArray()
    withResponse(
      headers = listOf("Content-Length: ${exactBody.size}"),
      writeBody = { it.write(exactBody) },
    ) { url ->
      val dest = File(tempFolder.root, "exact/manifest.jws")
      BundleDropBoundedDownloader.downloadToFile(client, url, dest, 16, 2_000)
      assertEquals(16, dest.length())
    }

    val oversizedBody = "x".repeat(17).toByteArray()
    withResponse(
      headers = listOf("Content-Length: ${oversizedBody.size}"),
      writeBody = { it.write(oversizedBody) },
      allowClientDisconnect = true,
    ) { url ->
      val dest = File(tempFolder.root, "oversized/manifest.jws")
      assertTooLarge {
        BundleDropBoundedDownloader.downloadToFile(client, url, dest, 16, 2_000)
      }
      assertFalse(dest.exists())
    }
  }

  @Test
  fun `enforces streamed bytes when content length is underreported`() {
    val body = "x".repeat(17).toByteArray()
    withResponse(
      headers = listOf(
        "Content-Length: 1",
        "Transfer-Encoding: chunked",
      ),
      writeBody = { output ->
        output.write("${body.size.toString(16)}\r\n".toByteArray(StandardCharsets.US_ASCII))
        output.write(body)
        output.write("\r\n0\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
      },
      allowClientDisconnect = true,
    ) { url ->
      val dest = File(tempFolder.root, "underreported/manifest.jws")
      assertTooLarge {
        BundleDropBoundedDownloader.downloadToFile(client, url, dest, 16, 2_000)
      }
      assertFalse(dest.exists())
    }
  }

  @Test
  fun `enforces the decoded limit for a compressed response`() {
    val compressedBody = ByteArrayOutputStream().use { output ->
      GZIPOutputStream(output).use { gzip ->
        gzip.write("x".repeat(4096).toByteArray())
      }
      output.toByteArray()
    }
    assertTrue(compressedBody.size < 100)

    withResponse(
      headers = listOf(
        "Content-Encoding: gzip",
        "Content-Length: ${compressedBody.size}",
      ),
      writeBody = { it.write(compressedBody) },
      allowClientDisconnect = true,
    ) { url ->
      val dest = File(tempFolder.root, "compressed/manifest.jws")
      assertTooLarge {
        BundleDropBoundedDownloader.downloadToFile(client, url, dest, 100, 2_000)
      }
      assertFalse(dest.exists())
    }
  }

  @Test
  fun `call timeout stops a trickle response and removes the partial file`() {
    withResponse(
      headers = listOf("Transfer-Encoding: chunked"),
      writeBody = { output ->
        repeat(20) {
          output.write("1\r\nx\r\n".toByteArray(StandardCharsets.US_ASCII))
          output.flush()
          Thread.sleep(80)
        }
        output.write("0\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
      },
      allowClientDisconnect = true,
    ) { url ->
      val dest = File(tempFolder.root, "timeout/manifest.jws")
      val startedAt = System.nanoTime()
      try {
        BundleDropBoundedDownloader.downloadToFile(client, url, dest, 1024, 150)
        fail("Expected the whole-call deadline to stop the download")
      } catch (error: BundleDropBoundedDownloadTimeoutException) {
        val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000
        assertTrue("call timeout took ${elapsedMs}ms", elapsedMs < 1_000)
      }
      assertFalse(dest.exists())
    }
  }

  private fun assertTooLarge(block: () -> Unit) {
    try {
      block()
      fail("Expected bounded download to reject the response")
    } catch (_: BundleDropBoundedDownloadTooLargeException) {
      // Expected.
    }
  }

  private fun withResponse(
    headers: List<String>,
    writeBody: (java.io.OutputStream) -> Unit,
    allowClientDisconnect: Boolean = false,
    test: (URL) -> Unit,
  ) {
    val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    val serverError = AtomicReference<Throwable?>()
    val thread = Thread {
      try {
        server.accept().use { socket ->
          socket.soTimeout = 5_000
          val reader = BufferedReader(
            InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII),
          )
          while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
          }

          socket.getOutputStream().use { output ->
            val responseHeaders = buildString {
              append("HTTP/1.1 200 OK\r\n")
              headers.forEach { append(it).append("\r\n") }
              append("Connection: close\r\n\r\n")
            }
            output.write(responseHeaders.toByteArray(StandardCharsets.US_ASCII))
            output.flush()
            writeBody(output)
            output.flush()
          }
        }
      } catch (error: SocketException) {
        if (!server.isClosed && !allowClientDisconnect) serverError.set(error)
      } catch (error: Throwable) {
        serverError.set(error)
      }
    }
    thread.start()

    try {
      test(URL("http://127.0.0.1:${server.localPort}/manifest.jws"))
    } finally {
      server.close()
      thread.join(5_000)
      serverError.get()?.let { throw AssertionError("HTTP test server failed", it) }
    }
  }
}
