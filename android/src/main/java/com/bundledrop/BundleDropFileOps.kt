package com.bundledrop

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipInputStream

object BundleDropFileOps {
  private const val PATCH_TARGET_DIR_PREFIX = "_patch_target_"
  private const val ZIP_EOCD_SIGNATURE = 0x06054b50L
  private const val ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50L
  private const val ZIP_SYMLINK_FILE_TYPE = 0xA000
  private const val ZIP_FILE_TYPE_MASK = 0xF000
  private val BUNDLE_HASH_REGEX = Regex("^[a-f0-9]{64}$")

  fun validateHttpUrl(url: String): URL {
    val parsed = URL(url)
    val scheme = parsed.protocol?.lowercase()
    if (scheme != "https" && scheme != "http") {
      throw java.io.IOException("Invalid or non-HTTP URL: $url")
    }
    return parsed
  }

  fun unlinkPath(path: String) {
    val file = File(path)
    if (file.exists()) {
      if (file.isDirectory) file.deleteRecursively() else file.delete()
    }
  }

  fun unzipFile(
    zipPath: String,
    destPath: String,
    maxEntryBytes: Long = 128L * 1024 * 1024,
    maxTotalBytes: Long = 512L * 1024 * 1024,
  ): List<String> {
    val destDir = File(destPath)
    validateZipCentralDirectory(zipPath)
    if (!destDir.exists()) destDir.mkdirs()

    val filenames = mutableListOf<String>()
    val seenEntries = mutableSetOf<String>()
    val buf = ByteArray(8192)
    var totalWritten = 0L
    val destCanonicalPath = destDir.canonicalPath

    ZipInputStream(FileInputStream(zipPath)).use { zis ->
      var entry = zis.nextEntry
      while (entry != null) {
        val normalizedName = normalizeZipEntryName(entry.name)
        if (!seenEntries.add(normalizedName)) {
          throw SecurityException("Duplicate ZIP entry: $normalizedName")
        }

        if (!entry.isDirectory) {
          val outFile = File(destDir, normalizedName)
          if (!outFile.canonicalPath.startsWith(destCanonicalPath + File.separator)) {
            throw SecurityException("Zip entry outside target dir: ${entry.name}")
          }
          outFile.parentFile?.mkdirs()
          var entryWritten = 0L
          FileOutputStream(outFile).use { fos ->
            var len: Int
            while (zis.read(buf).also { len = it } > 0) {
              entryWritten += len
              totalWritten += len
              if (entryWritten > maxEntryBytes) {
                throw java.io.IOException("ZIP entry exceeds ${maxEntryBytes / (1024 * 1024)} MB limit: ${entry.name}")
              }
              if (totalWritten > maxTotalBytes) {
                throw java.io.IOException("ZIP total uncompressed exceeds ${maxTotalBytes / (1024 * 1024)} MB limit")
              }
              fos.write(buf, 0, len)
            }
          }
          if (java.nio.file.Files.isSymbolicLink(outFile.toPath())) {
            try { outFile.delete() } catch (_: Exception) {}
            throw SecurityException("Symlink ZIP entries are not allowed: $normalizedName")
          }
          filenames.add(normalizedName)
        } else {
          val dirFile = File(destDir, normalizedName)
          if (!dirFile.canonicalPath.startsWith(destCanonicalPath + File.separator)) {
            throw SecurityException("Zip entry outside target dir: ${entry.name}")
          }
          dirFile.mkdirs()
        }
        zis.closeEntry()
        entry = zis.nextEntry
      }
    }

    return filenames
  }

  private fun normalizeZipEntryName(name: String?): String {
    if (name.isNullOrEmpty() || name.indexOf('\u0000') >= 0 || name.contains('\\')) {
      throw SecurityException("Unsafe ZIP entry path: $name")
    }
    if (name.startsWith("/") || Regex("^[A-Za-z]:[\\\\/].*").matches(name)) {
      throw SecurityException("Unsafe ZIP entry path: $name")
    }

    val normalized = name.removeSuffix("/")
    if (normalized.isEmpty()) {
      throw SecurityException("Unsafe ZIP entry path: $name")
    }
    if (normalized.split('/').any { it.isEmpty() || it == "." || it == ".." }) {
      throw SecurityException("Unsafe ZIP entry path: $name")
    }
    return normalized
  }

  private fun validateZipCentralDirectory(zipPath: String) {
    RandomAccessFile(zipPath, "r").use { raf ->
      val fileLength = raf.length()
      if (fileLength < 22) {
        throw java.io.IOException("Invalid ZIP: end-of-central-directory not found")
      }

      val readSize = minOf(fileLength, 22L + 65_535L).toInt()
      val tail = ByteArray(readSize)
      raf.seek(fileLength - readSize)
      raf.readFully(tail)

      var eocdOffset = -1
      for (index in readSize - 22 downTo 0) {
        if (readLeInt(tail, index) == ZIP_EOCD_SIGNATURE) {
          eocdOffset = index
          break
        }
      }
      if (eocdOffset < 0) {
        throw java.io.IOException("Invalid ZIP: end-of-central-directory not found")
      }

      val entryCount = readLeShort(tail, eocdOffset + 10)
      val centralDirectoryOffset = readLeInt(tail, eocdOffset + 16)
      raf.seek(centralDirectoryOffset)

      val header = ByteArray(46)
      repeat(entryCount) {
        raf.readFully(header)
        if (readLeInt(header, 0) != ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
          throw java.io.IOException("Invalid ZIP: malformed central directory")
        }

        val nameLength = readLeShort(header, 28)
        val extraLength = readLeShort(header, 30)
        val commentLength = readLeShort(header, 32)
        val externalAttributes = readLeInt(header, 38)
        val nameBytes = ByteArray(nameLength)
        raf.readFully(nameBytes)
        val entryName = String(nameBytes, Charsets.UTF_8)

        if (isSymlinkExternalAttribute(externalAttributes)) {
          throw SecurityException("Symlink ZIP entries are not allowed: $entryName")
        }
        normalizeZipEntryName(entryName)
        raf.skipBytes(extraLength + commentLength)
      }
    }
  }

  private fun readLeShort(bytes: ByteArray, offset: Int): Int {
    return (bytes[offset].toInt() and 0xff) or
      ((bytes[offset + 1].toInt() and 0xff) shl 8)
  }

  private fun readLeInt(bytes: ByteArray, offset: Int): Long {
    return ((bytes[offset].toLong() and 0xffL) or
      ((bytes[offset + 1].toLong() and 0xffL) shl 8) or
      ((bytes[offset + 2].toLong() and 0xffL) shl 16) or
      ((bytes[offset + 3].toLong() and 0xffL) shl 24)) and 0xffffffffL
  }

  private fun isSymlinkExternalAttribute(externalAttributes: Long): Boolean {
    val unixMode = ((externalAttributes shr 16) and 0xffffL).toInt()
    return (unixMode and ZIP_FILE_TYPE_MASK) == ZIP_SYMLINK_FILE_TYPE
  }

  fun moveFile(src: File, dest: File) {
    dest.parentFile?.mkdirs()
    if (!src.renameTo(dest)) {
      try {
        if (src.isDirectory) {
          src.copyRecursively(dest, overwrite = true)
          src.deleteRecursively()
        } else {
          src.copyTo(dest, overwrite = true)
          src.delete()
        }
      } catch (error: Exception) {
        try { if (dest.isDirectory) dest.deleteRecursively() else dest.delete() } catch (_: Exception) {}
        throw error
      }
    }
  }

  fun copyFile(src: File, dest: File) {
    dest.parentFile?.mkdirs()
    src.copyTo(dest, overwrite = true)
  }

  fun sha256File(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(1024 * 64)
      while (true) {
        val read = input.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  fun fileSize(file: File): Long {
    if (!file.exists()) {
      throw java.io.FileNotFoundException("File not found: ${file.absolutePath}")
    }
    return file.length()
  }

  fun supportsXdelta(): Boolean {
    return BundleDropXdeltaNative.supportsXdelta()
  }

  fun applyXdelta(base: File, patch: File, output: File) {
    validateXdeltaOutputPath(output)
    BundleDropXdeltaNative.applyXdelta(base, patch, output)
  }

  private fun validateXdeltaOutputPath(output: File) {
    val rawPath = output.path
    if (rawPath.indexOf('\u0000') >= 0) {
      throw SecurityException("xdelta output path contains a null byte")
    }
    if (rawPath.split('/', '\\').any { it == ".." }) {
      throw SecurityException("xdelta output path must not contain traversal segments")
    }

    val absoluteOutput = output.absoluteFile
    val normalizedPath = absoluteOutput.canonicalPath
    val parts = normalizedPath
      .split(File.separatorChar)
      .filter { it.isNotEmpty() }

    for (index in 0 until parts.size - 3) {
      if (parts[index] != "bundle-drop" || parts[index + 1] != "bundles") {
        continue
      }

      val patchTargetDir = parts[index + 2]
      if (!patchTargetDir.startsWith(PATCH_TARGET_DIR_PREFIX)) {
        throw SecurityException("xdelta output path must not target an active bundle folder")
      }

      val targetHash = patchTargetDir.removePrefix(PATCH_TARGET_DIR_PREFIX)
      if (!BUNDLE_HASH_REGEX.matches(targetHash)) {
        throw SecurityException("xdelta output path must use a valid patch target temp directory")
      }

      return
    }

    throw SecurityException("xdelta output path must be inside bundle-drop/bundles/_patch_target_<bundleHash>")
  }

  fun downloadToFile(
    parsedUrl: URL,
    destFile: File,
    maxBytes: Long = 256L * 1024 * 1024,
    connectTimeout: Int = 30_000,
    readTimeout: Int = 60_000,
  ) {
    var connection: java.net.HttpURLConnection? = null
    try {
      destFile.parentFile?.mkdirs()

      connection = parsedUrl.openConnection() as java.net.HttpURLConnection
      connection.connectTimeout = connectTimeout
      connection.readTimeout = readTimeout
      connection.instanceFollowRedirects = true

      val status = connection.responseCode
      if (status !in 200..299) {
        throw java.io.IOException("HTTP $status: ${connection.responseMessage}")
      }

      var totalRead = 0L
      connection.inputStream.use { input ->
        FileOutputStream(destFile).use { output ->
          val buf = ByteArray(8192)
          var len: Int
          while (input.read(buf).also { len = it } > 0) {
            totalRead += len
            if (totalRead > maxBytes) {
              throw java.io.IOException("Download exceeds ${maxBytes / (1024 * 1024)} MB limit")
            }
            output.write(buf, 0, len)
          }
        }
      }
    } catch (e: Exception) {
      try { destFile.delete() } catch (_: Exception) {}
      throw e
    } finally {
      try { connection?.disconnect() } catch (_: Exception) {}
    }
  }
}
