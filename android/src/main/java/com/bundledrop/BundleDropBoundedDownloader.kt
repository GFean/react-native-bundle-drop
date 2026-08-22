package com.bundledrop

import java.io.File
import java.io.FileOutputStream
import java.io.InterruptedIOException
import java.net.URL
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

internal class BundleDropBoundedDownloadHttpException(
  val status: Int,
  message: String,
) : java.io.IOException(message)

internal class BundleDropBoundedDownloadTooLargeException(message: String) :
  java.io.IOException(message)

internal class BundleDropBoundedDownloadTimeoutException(cause: Throwable) :
  java.io.IOException("Download timed out", cause)

internal object BundleDropBoundedDownloader {
  fun downloadToFile(
    baseClient: OkHttpClient,
    parsedUrl: URL,
    destFile: File,
    maxBytes: Long,
    timeoutMs: Long,
  ) {
    require(maxBytes > 0) { "maxBytes must be positive" }
    require(timeoutMs > 0) { "timeoutMs must be positive" }

    val client = baseClient.newBuilder()
      .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
      .build()
    val request = Request.Builder()
      .url(parsedUrl)
      .get()
      .header("Accept", "application/jose+json, application/json")
      .build()

    try {
      client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) {
          throw BundleDropBoundedDownloadHttpException(
            response.code,
            "HTTP ${response.code}: ${response.message}",
          )
        }

        val body = response.body
          ?: throw java.io.IOException("Manifest response body is missing")
        if (body.contentLength() > maxBytes) {
          throw tooLarge(maxBytes)
        }

        destFile.parentFile?.mkdirs()
        body.byteStream().use { input ->
          FileOutputStream(destFile).use { output ->
            val buffer = ByteArray(8192)
            var totalRead = 0L
            while (true) {
              val bytesRead = input.read(buffer)
              if (bytesRead < 0) break
              if (bytesRead.toLong() > maxBytes - totalRead) {
                throw tooLarge(maxBytes)
              }
              output.write(buffer, 0, bytesRead)
              totalRead += bytesRead
            }
          }
        }
      }
    } catch (error: InterruptedIOException) {
      try { destFile.delete() } catch (_: Exception) {}
      throw BundleDropBoundedDownloadTimeoutException(error)
    } catch (error: Exception) {
      try { destFile.delete() } catch (_: Exception) {}
      throw error
    }
  }

  private fun tooLarge(maxBytes: Long) = BundleDropBoundedDownloadTooLargeException(
    "Download exceeds $maxBytes byte limit",
  )
}
