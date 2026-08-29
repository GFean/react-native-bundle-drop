package com.bundledrop

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest

class BundleDropOtaResolverTest {

  @get:Rule
  val tempFolder = TemporaryFolder()

  private val validHash = "cefdc9909cadeb57b385a2b64197f8116c2a4c0103f1857e8b01e18a96781eda"

  @Test
  fun `resolve result defaults stored version to null`() {
    val result = BundleDropOtaResolver.ResolveResult(bundlePath = "bundle")

    assertEquals("bundle", result.bundlePath)
    assertFalse(result.clearedOta)
    assertNull(result.storedVersion)
  }

  // ---------------------------------------------------------------------------
  // readCurrentPointer
  // ---------------------------------------------------------------------------

  @Test
  fun `readCurrentPointer returns derived path when current json hash is valid and file exists`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)

    File(root, "current.json").writeText("""{"hash":"$validHash","updatedAt":123}""")

    val result = BundleDropOtaResolver.readCurrentPointer(root)
    assertEquals(bundleFile.absolutePath, result)
  }

  @Test
  fun `readBundleForHash verifies an installed bundle without trusting a pointer`() {
    val root = tempFolder.newFolder("bundle-drop-by-hash")
    val bundleFile = makeBundle(root)

    assertEquals(bundleFile.absolutePath, BundleDropOtaResolver.readBundleForHash(root, validHash))
    assertEquals("1.0.0", BundleDropOtaResolver.readBundleRuntimeVersion(root, validHash))
    assertNull(BundleDropOtaResolver.readBundleForHash(root, "not-a-hash"))
    assertNull(BundleDropOtaResolver.readBundleRuntimeVersion(root, "a".repeat(64)))

    File(bundleFile.parentFile, "main.jsbundle").delete()
    assertNull(BundleDropOtaResolver.readBundleForHash(root, validHash))
  }

  @Test
  fun `readCurrentPointer rejects old manifest version hash domain`() {
    val root = tempFolder.newFolder("bundle-drop")
    val oldHash = "95b6ea4efb34687b23a00ca183d892b22a036eae822956e73665935a3c33ac79"
    val bundleDir = File(root, "bundles/$oldHash").apply { mkdirs() }
    val bundleFile = File(bundleDir, "main.jsbundle").apply { writeText("bundle") }
    File(bundleDir, "bundle-manifest.json").writeText(
      """{"manifestVersion":2,"bundleHash":"$oldHash","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6}]}"""
    )
    File(root, "current.json").writeText(
      """{"hash":"$oldHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )

    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer returns null when current json does not exist`() {
    val root = tempFolder.newFolder("bundle-drop")
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer returns null when bundlePath file is missing on disk`() {
    val root = tempFolder.newFolder("bundle-drop")
    val expectedBundle = File(File(File(root, "bundles"), validHash), "main.jsbundle")
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${expectedBundle.absolutePath}"}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer returns null when bundlePath key is empty string`() {
    val root = tempFolder.newFolder("bundle-drop")
    File(root, "current.json").writeText("""{"hash":"$validHash","bundlePath":""}""")
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer derives path from hash when bundlePath key is missing`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    File(root, "current.json").writeText("""{"hash":"$validHash","otherKey":"value"}""")
    assertEquals(bundleFile.absolutePath, BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer returns null when hash is invalid`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    File(root, "current.json").writeText(
      """{"hash":"abc123","bundlePath":"${bundleFile.absolutePath}"}"""
    )

    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer ignores stale bundlePath from a previous app container`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    val otherBundle = File(root, "bundles/${"b".repeat(64)}/main.jsbundle")
    otherBundle.parentFile!!.mkdirs()
    otherBundle.writeText("bundle")
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${otherBundle.absolutePath}"}"""
    )

    assertEquals(bundleFile.absolutePath, BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer returns null when manifest is missing or mismatched`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleDir = File(root, "bundles/$validHash")
    bundleDir.mkdirs()
    val bundleFile = File(bundleDir, "main.jsbundle").apply { writeText("bundle") }
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )

    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    File(bundleDir, "bundle-manifest.json").writeText("""{"bundleHash":"${"b".repeat(64)}"}""")
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer returns null when manifest file hash or size is invalid`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )
    val manifestFile = File(bundleFile.parentFile, "bundle-manifest.json")

    manifestFile.writeText(manifestJson(validHash, listOf(mainBundleFile(sha256 = "0".repeat(64)))))
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(manifestJson(validHash, listOf(mainBundleFile(size = 7))))
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer returns null when manifest hash is missing or invalid`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )
    val manifestFile = File(bundleFile.parentFile, "bundle-manifest.json")

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","jsBundleHash":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","platform":"android","runtimeVersion":"1.0.0","version":"1.0.0","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      manifestJson(validHash, listOf(mainBundleFile())).replace(
        Regex("\"manifestHash\":\"[a-f0-9]{64}\""),
        "\"manifestHash\":\"${"f".repeat(64)}\"",
      )
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer returns null when manifest identity fields do not match the runtime bundle`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )
    val manifestFile = File(bundleFile.parentFile, "bundle-manifest.json")

    manifestFile.writeText(
      manifestJson(validHash, listOf(mainBundleFile())).replace(
        Regex("\"jsBundleHash\":\"[a-f0-9]{64}\""),
        "\"jsBundleHash\":\"${"0".repeat(64)}\"",
      )
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      manifestJson(validHash, listOf(mainBundleFile())).replace(
        "\"runtimeVersion\":\"1.0.0\"",
        "\"runtimeVersion\":\"\"",
      )
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      manifestJson(validHash, listOf(mainBundleFile())).replace(
        "\"version\":\"1.0.0\"",
        "\"version\":\"\"",
      )
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      manifestJson(validHash, listOf(mainBundleFile())).replace(
        "\"platform\":\"android\"",
        "\"platform\":\"\"",
      )
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer returns null for unsafe duplicate missing or extra manifest files`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )
    val manifestFile = File(bundleFile.parentFile, "bundle-manifest.json")

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","files":[{"path":"../main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6},{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","files":[{"path":"metadata-android.json","role":"metadata","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    makeBundle(root)
    File(bundleFile.parentFile, "extra.txt").writeText("extra")
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer requires android platform metadata and image manifest entries`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )
    val manifestFile = File(bundleFile.parentFile, "bundle-manifest.json")

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"ios","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"android","jsBundleHash":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"android","jsBundleHash":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6},{"path":"metadata-android.json","role":"metadata","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"android","jsBundleHash":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","files":[{"path":"main.jsbundle","role":"asset","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6},{"path":"metadata-android.json","role":"asset","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2},{"path":"image-manifest.json","role":"asset","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"android","jsBundleHash":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6},{"path":"metadata-android.json","role":"asset","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2},{"path":"image-manifest.json","role":"androidImageManifest","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer rejects extra role entries outside canonical paths`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    val bundleDir = bundleFile.parentFile!!
    val manifestFile = File(bundleDir, "bundle-manifest.json")
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )

    File(bundleDir, "other.jsbundle").writeText("other")
    manifestFile.writeText(manifestJson(validHash, listOf(
      mainBundleFile(),
      ManifestFile("other.jsbundle", "jsbundle", sha256String("other"), 5),
    )))
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    File(bundleDir, "metadata-extra.json").writeText("{}")
    manifestFile.writeText(manifestJson(validHash, listOf(
      mainBundleFile(),
      metadataFile(),
      ManifestFile("metadata-extra.json", "metadata", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", 2),
      imageManifestFile(),
    )))
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    File(bundleDir, "image-manifest-extra.json").writeText("{}")
    manifestFile.writeText(manifestJson(validHash, listOf(
      mainBundleFile(),
      metadataFile(),
      imageManifestFile(),
      ManifestFile("image-manifest-extra.json", "androidImageManifest", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", 2),
    )))
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer rejects malformed manifest file arrays and bundle hash mismatches`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )
    val bundleDir = bundleFile.parentFile
    val manifestFile = File(bundleDir, "bundle-manifest.json")

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"android"}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"android","files":["not-an-object"]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"android","jsBundleHash":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6},{"path":"metadata-android.json","role":"metadata","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2},{"path":"image-manifest.json","role":"androidImageManifest","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2},{"path":"missing.txt","role":"asset","sha256":"${"0".repeat(64)}","size":0}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    File(bundleDir, "asset-dir").mkdirs()
    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"android","jsBundleHash":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6},{"path":"metadata-android.json","role":"metadata","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2},{"path":"image-manifest.json","role":"androidImageManifest","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2},{"path":"asset-dir","role":"asset","sha256":"${"0".repeat(64)}","size":0}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))

    File(bundleDir, "extra.txt").writeText("extra")
    manifestFile.writeText(
      """{"manifestVersion":1,"bundleHash":"$validHash","platform":"android","jsBundleHash":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","files":[{"path":"main.jsbundle","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6},{"path":"metadata-android.json","role":"metadata","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2},{"path":"image-manifest.json","role":"androidImageManifest","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","size":2},{"path":"extra.txt","role":"asset","sha256":"c8dee78f8c7b466c881847accc196998bad00e2b96c5ef913dfbe454d3807c96","size":5}]}"""
    )
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer verifies nested executable manifest entries`() {
    val root = tempFolder.newFolder("bundle-drop")
    val hash = "c6c0179ba5e4f8c62d1b1b6e211cea7091adb72b4ccc7b5bc5012f2e354c4c65"
    val bundleDir = File(root, "bundles/$hash").apply { mkdirs() }
    val bundleFile = File(bundleDir, "main.jsbundle").apply { writeText("bundle") }
    writeRequiredAndroidBundleFiles(bundleDir)
    File(bundleDir, "zz").mkdirs()
    File(bundleDir, "zz/tool").writeText("tool")
    File(bundleDir, "bundle-manifest.json").writeText(manifestJson(hash, listOf(
      ManifestFile("zz/tool", "asset", "7c9bbe5ec9b3fb774e8fa0f54247e93c34ddf8e5d16fe3073420de0ae81a262d", 4, executable = true),
      mainBundleFile(),
    )))
    File(root, "current.json").writeText(
      """{"hash":"$hash","bundlePath":"${bundleFile.absolutePath}"}"""
    )

    assertEquals(bundleFile.absolutePath, BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer sorts non ASCII paths by UTF-8 bytes`() {
    val root = tempFolder.newFolder("bundle-drop")
    val hash = "7e97c6719e84f6d0beb23854e41d6c4c216a4ee12b3a8b1eba1ed7445ce99ecf"
    val bundleDir = File(root, "bundles/$hash").apply { mkdirs() }
    val bundleFile = File(bundleDir, "main.jsbundle").apply { writeText("bundle") }
    writeRequiredAndroidBundleFiles(bundleDir)
    File(bundleDir, "z.png").writeText("z")
    File(bundleDir, "é.png").writeText("e")
    File(bundleDir, "bundle-manifest.json").writeText(manifestJson(hash, listOf(
      ManifestFile("é.png", "asset", "3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea", 1),
      ManifestFile("z.png", "asset", "594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06", 1),
      mainBundleFile(),
    )))
    File(root, "current.json").writeText(
      """{"hash":"$hash","bundlePath":"${bundleFile.absolutePath}"}"""
    )

    assertEquals(bundleFile.absolutePath, BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer sorts prefix paths by UTF-8 byte length`() {
    val root = tempFolder.newFolder("bundle-drop")
    val hash = "6ad9e44f29ad8ddc7f0eb44b06034052491cf19277a547c4bb864e54d715edd3"
    val bundleDir = File(root, "bundles/$hash").apply { mkdirs() }
    val bundleFile = File(bundleDir, "main.jsbundle").apply { writeText("bundle") }
    writeRequiredAndroidBundleFiles(bundleDir)
    File(bundleDir, "a").writeText("a")
    File(bundleDir, "aa").writeText("aa")
    File(bundleDir, "bundle-manifest.json").writeText(manifestJson(hash, listOf(
      ManifestFile("aa", "asset", "961b6dd3ede3cb8ecbaacbd68de040cd78eb2ed5889130cceb4c49268ea4d506", 2),
      ManifestFile("a", "asset", "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb", 1),
      mainBundleFile(),
    )))
    File(root, "current.json").writeText(
      """{"hash":"$hash","bundlePath":"${bundleFile.absolutePath}"}"""
    )

    assertEquals(bundleFile.absolutePath, BundleDropOtaResolver.readCurrentPointer(root))
  }

  @Test
  fun `readCurrentPointer rejects absolute backslash null and empty manifest paths`() {
    val root = tempFolder.newFolder("bundle-drop")
    val bundleFile = makeBundle(root)
    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )
    val manifestFile = File(bundleFile.parentFile, "bundle-manifest.json")
    for (unsafePath in listOf("/main.jsbundle", "assets\\main.jsbundle", "", "assets//main.jsbundle")) {
      manifestFile.writeText(
        """{"manifestVersion":1,"bundleHash":"$validHash","files":[{"path":"$unsafePath","role":"jsbundle","sha256":"1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc","size":6}]}"""
      )
      assertNull(BundleDropOtaResolver.readCurrentPointer(root))
    }
  }

  @Test
  fun `readCurrentPointer returns null on malformed JSON`() {
    val root = tempFolder.newFolder("bundle-drop")
    File(root, "current.json").writeText("not valid json {{{")
    assertNull(BundleDropOtaResolver.readCurrentPointer(root))
  }

  // ---------------------------------------------------------------------------
  // clearOtaState
  // ---------------------------------------------------------------------------

  @Test
  fun `clearOtaState deletes all expected state files`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    val current = File(root, "current.json").apply { writeText("{}") }
    val previous = File(root, "previous.json").apply { writeText("{}") }
    val state = File(root, "state.json").apply { writeText("{}") }
    val bundleInfo = File(filesDir, "bundle-info.json").apply { writeText("{}") }

    assertTrue(current.exists())
    assertTrue(previous.exists())
    assertTrue(state.exists())
    assertTrue(bundleInfo.exists())

    BundleDropOtaResolver.clearOtaState(root, filesDir)

    assertFalse(current.exists())
    assertFalse(previous.exists())
    assertFalse(state.exists())
    assertFalse(bundleInfo.exists())
  }

  @Test
  fun `clearOtaState is safe when files do not exist`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    BundleDropOtaResolver.clearOtaState(root, filesDir)
  }

  @Test
  fun `clearOtaState only deletes targeted files and leaves others`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    File(root, "current.json").writeText("{}")
    val unrelated = File(root, "bundles").apply { mkdirs() }
    val kept = File(unrelated, "abc123").apply { mkdirs() }

    BundleDropOtaResolver.clearOtaState(root, filesDir)

    assertFalse(File(root, "current.json").exists())
    assertTrue(kept.exists())
  }

  @Test
  fun `clearOtaState continues when one targeted path cannot be deleted`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    val undeletableCurrent = File(root, "current.json").apply { mkdirs() }
    val child = File(undeletableCurrent, "child.txt").apply { writeText("keeps directory non-empty") }
    val previous = File(root, "previous.json").apply { writeText("{}") }
    val state = File(root, "state.json").apply { writeText("{}") }
    val bundleInfo = File(filesDir, "bundle-info.json").apply { writeText("{}") }

    BundleDropOtaResolver.clearOtaState(root, filesDir)

    assertTrue(undeletableCurrent.exists())
    assertTrue(child.exists())
    assertFalse(previous.exists())
    assertFalse(state.exists())
    assertFalse(bundleInfo.exists())
  }

  // ---------------------------------------------------------------------------
  // resolve -- no OTA bundle
  // ---------------------------------------------------------------------------

  @Test
  fun `resolve returns null and stores version when no bundle exists`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    val result = BundleDropOtaResolver.resolve(
      bundleDropRoot = root,
      filesDir = filesDir,
      currentBinaryVersion = "1.0.0-1",
      storedBinaryVersion = null,
    )

    assertNull(result.bundlePath)
    assertFalse(result.clearedOta)
    assertEquals("1.0.0-1", result.storedVersion)
  }

  // ---------------------------------------------------------------------------
  // resolve -- has OTA bundle, same binary version
  // ---------------------------------------------------------------------------

  @Test
  fun `resolve returns bundle path when OTA exists and binary version matches`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    val bundleFile = makeBundle(root)

    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )

    val result = BundleDropOtaResolver.resolve(
      bundleDropRoot = root,
      filesDir = filesDir,
      currentBinaryVersion = "1.0.0-1",
      storedBinaryVersion = "1.0.0-1",
    )

    assertEquals(bundleFile.absolutePath, result.bundlePath)
    assertFalse(result.clearedOta)
    assertEquals("1.0.0-1", result.storedVersion)
  }

  // ---------------------------------------------------------------------------
  // resolve -- has OTA bundle, first launch (no stored version)
  // ---------------------------------------------------------------------------

  @Test
  fun `resolve returns bundle path on first launch with OTA bundle`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    val bundleFile = makeBundle(root)

    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )

    val result = BundleDropOtaResolver.resolve(
      bundleDropRoot = root,
      filesDir = filesDir,
      currentBinaryVersion = "1.0.0-1",
      storedBinaryVersion = null,
    )

    assertEquals(bundleFile.absolutePath, result.bundlePath)
    assertFalse(result.clearedOta)
  }

  // ---------------------------------------------------------------------------
  // resolve -- binary update clears OTA
  // ---------------------------------------------------------------------------

  @Test
  fun `resolve clears OTA state and returns null when binary version changes`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    val bundleFile = makeBundle(root)

    File(root, "current.json").writeText(
      """{"hash":"$validHash","bundlePath":"${bundleFile.absolutePath}"}"""
    )
    File(root, "state.json").writeText("""{"count":3}""")

    val result = BundleDropOtaResolver.resolve(
      bundleDropRoot = root,
      filesDir = filesDir,
      currentBinaryVersion = "2.0.0-5",
      storedBinaryVersion = "1.0.0-1",
    )

    assertNull(result.bundlePath)
    assertTrue(result.clearedOta)
    assertEquals("2.0.0-5", result.storedVersion)
    assertFalse(File(root, "current.json").exists())
    assertFalse(File(root, "state.json").exists())
  }

  @Test
  fun `resolve clears stale OTA state on binary version change when current json is malformed`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    val current = File(root, "current.json").apply { writeText("not valid json {{{") }
    val previous = File(root, "previous.json").apply { writeText("{}") }
    val state = File(root, "state.json").apply { writeText("{}") }
    val bundleInfo = File(filesDir, "bundle-info.json").apply { writeText("""{"hash":"stale"}""") }

    val result = BundleDropOtaResolver.resolve(
      bundleDropRoot = root,
      filesDir = filesDir,
      currentBinaryVersion = "2.0.0-5",
      storedBinaryVersion = "1.0.0-1",
    )

    assertNull(result.bundlePath)
    assertTrue(result.clearedOta)
    assertEquals("2.0.0-5", result.storedVersion)
    assertFalse(current.exists())
    assertFalse(previous.exists())
    assertFalse(state.exists())
    assertFalse(bundleInfo.exists())
  }

  @Test
  fun `resolve stores version without clearing when binary version changes and no OTA state exists`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    val result = BundleDropOtaResolver.resolve(
      bundleDropRoot = root,
      filesDir = filesDir,
      currentBinaryVersion = "2.0.0-5",
      storedBinaryVersion = "1.0.0-1",
    )

    assertNull(result.bundlePath)
    assertFalse(result.clearedOta)
    assertEquals("2.0.0-5", result.storedVersion)
  }

  @Test
  fun `resolve ignores legacy main jsbundle when current json is absent`() {
    val filesDir = tempFolder.newFolder("files")
    val root = File(filesDir, "bundle-drop")
    root.mkdirs()

    File(filesDir, "main.jsbundle").writeText("legacy bundle")

    val result = BundleDropOtaResolver.resolve(
      bundleDropRoot = root,
      filesDir = filesDir,
      currentBinaryVersion = "1.0.0-1",
      storedBinaryVersion = "1.0.0-1",
    )

    assertNull(result.bundlePath)
    assertFalse(result.clearedOta)
    assertEquals("1.0.0-1", result.storedVersion)
  }

  // ---------------------------------------------------------------------------
  // readImageManifest
  // ---------------------------------------------------------------------------

  @Test
  fun `readImageManifest roots relative paths under current bundle directory`() {
    val bundleDir = tempFolder.newFolder("bundles", validHash)
    val bundleFile = File(bundleDir, "main.jsbundle")
    bundleFile.writeText("bundle")
    val manifest = File(bundleDir, "image-manifest.json")
    manifest.writeText(
      """{"images/icon.png":"assets/images/icon.png","raw/legal.pdf":"raw/legal.pdf"}"""
    )

    val result = BundleDropOtaResolver.readImageManifest(bundleFile.absolutePath)
    val parsed = org.json.JSONObject(result!!)
    assertEquals(
      "bundle-drop/bundles/$validHash/assets/images/icon.png",
      parsed.getString("images/icon.png"),
    )
    assertEquals(
      "bundle-drop/bundles/$validHash/raw/legal.pdf",
      parsed.getString("raw/legal.pdf"),
    )
    assertEquals(2, parsed.length())
    assertFalse(parsed.has("icon"))
    assertFalse(parsed.has("legal.pdf"))
    assertFalse(parsed.has("assets/images/icon.png"))
  }

  @Test
  fun `readImageManifest does not double-root already rooted paths`() {
    val bundleDir = tempFolder.newFolder("bundles", validHash)
    val bundleFile = File(bundleDir, "main.jsbundle")
    bundleFile.writeText("bundle")
    val rootedPath = "bundle-drop/bundles/$validHash/assets/images/icon.png"
    File(bundleDir, "image-manifest.json").writeText(
      """{"images/icon.png":"$rootedPath"}"""
    )

    val result = BundleDropOtaResolver.readImageManifest(bundleFile.absolutePath)
    val parsed = org.json.JSONObject(result!!)
    assertEquals(rootedPath, parsed.getString("images/icon.png"))
    assertEquals(1, parsed.length())
  }

  @Test
  fun `readImageManifest converts absolute bundle paths to document relative paths`() {
    val bundleDir = tempFolder.newFolder("bundles", validHash)
    val bundleFile = File(bundleDir, "main.jsbundle")
    bundleFile.writeText("bundle")
    File(bundleDir, "image-manifest.json").writeText(
      """{"images/icon.png":"${File(bundleDir, "assets/images/icon.png").absolutePath}"}"""
    )

    val result = BundleDropOtaResolver.readImageManifest(bundleFile.absolutePath)
    val parsed = org.json.JSONObject(result!!)
    assertEquals(
      "bundle-drop/bundles/$validHash/assets/images/icon.png",
      parsed.getString("images/icon.png"),
    )
  }

  @Test
  fun `readImageManifest returns null for unsafe image manifest keys and values`() {
    val invalidManifestEntries = listOf(
      "\"../icon.png\":\"assets/images/icon.png\"",
      "\"images/icon.png\":\"../assets/images/icon.png\"",
      "\"images/icon.png\":\"/tmp/assets/images/icon.png\"",
      "\"images/icon.png\":\"bundle-drop/bundles/$validHash/../icon.png\"",
      "\"images/icon.png\":\"assets\\\\images\\\\icon.png\"",
    )

    invalidManifestEntries.forEachIndexed { index, manifestEntry ->
      val bundleDir = tempFolder.newFolder("bundles-unsafe-$index", validHash)
      val bundleFile = File(bundleDir, "main.jsbundle")
      bundleFile.writeText("bundle")
      File(bundleDir, "image-manifest.json").writeText("{$manifestEntry}")

      assertNull(BundleDropOtaResolver.readImageManifest(bundleFile.absolutePath))
    }
  }

  @Test
  fun `readImageManifest returns null when manifest is missing`() {
    val bundleDir = tempFolder.newFolder("bundles", validHash)
    val bundleFile = File(bundleDir, "main.jsbundle")
    bundleFile.writeText("bundle")

    assertNull(BundleDropOtaResolver.readImageManifest(bundleFile.absolutePath))
  }

  @Test
  fun `readImageManifest returns null when bundlePath has no parent directory`() {
    assertNull(BundleDropOtaResolver.readImageManifest("main.jsbundle"))
  }

  private fun makeBundle(root: File, hash: String = validHash): File {
    val bundleDir = File(root, "bundles/$hash")
    bundleDir.mkdirs()
    val bundleFile = File(bundleDir, "main.jsbundle")
    bundleFile.writeText("bundle")
    writeRequiredAndroidBundleFiles(bundleDir)
    File(bundleDir, "bundle-manifest.json").writeText(manifestJson(hash, listOf(mainBundleFile())))
    return bundleFile
  }

  private fun writeRequiredAndroidBundleFiles(bundleDir: File) {
    File(bundleDir, "metadata-android.json").writeText("{}")
    File(bundleDir, "image-manifest.json").writeText("{}")
  }

  private data class ManifestFile(
    val path: String,
    val role: String,
    val sha256: String,
    val size: Long,
    val executable: Boolean = false,
  )

  private fun mainBundleFile(
    sha256: String = "1e6ed65d77d6364eeaed5a745ba5c4985ae2b700dd85d7cf7f027bdf294a33fc",
    size: Long = 6,
  ) = ManifestFile("main.jsbundle", "jsbundle", sha256, size)

  private fun metadataFile() =
    ManifestFile("metadata-android.json", "metadata", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", 2)

  private fun imageManifestFile() =
    ManifestFile("image-manifest.json", "androidImageManifest", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", 2)

  private fun completeManifestFiles(files: List<ManifestFile>): List<ManifestFile> {
    val complete = files.toMutableList()
    if (complete.none { it.role == "metadata" }) complete += metadataFile()
    if (complete.none { it.role == "androidImageManifest" }) complete += imageManifestFile()
    return complete
  }

  private fun manifestJson(
    bundleHash: String,
    files: List<ManifestFile>,
    platform: String = "android",
    runtimeVersion: String = "1.0.0",
    version: String = "1.0.0",
  ): String {
    val completeFiles = completeManifestFiles(files)
    val jsBundleHash = completeFiles.first { it.role == "jsbundle" && it.path == "main.jsbundle" }.sha256
    val manifestHash = sha256String(
      listOf(
        "\"bundleHash\":${quoteCanonicalString(bundleHash)}",
        "\"files\":[${canonicalFileEntries(completeFiles).joinToString(",")}]",
        "\"jsBundleHash\":${quoteCanonicalString(jsBundleHash)}",
        "\"manifestVersion\":1",
        "\"platform\":${quoteCanonicalString(platform)}",
        "\"runtimeVersion\":${quoteCanonicalString(runtimeVersion)}",
        "\"version\":${quoteCanonicalString(version)}",
      ).joinToString(",", prefix = "{", postfix = "}")
    )
    return listOf(
      "\"manifestVersion\":1",
      "\"bundleHash\":${quoteCanonicalString(bundleHash)}",
      "\"jsBundleHash\":${quoteCanonicalString(jsBundleHash)}",
      "\"platform\":${quoteCanonicalString(platform)}",
      "\"runtimeVersion\":${quoteCanonicalString(runtimeVersion)}",
      "\"version\":${quoteCanonicalString(version)}",
      "\"manifestHash\":${quoteCanonicalString(manifestHash)}",
      "\"files\":[${completeFiles.joinToString(",") { fileEntryJson(it) }}]",
    ).joinToString(",", prefix = "{", postfix = "}")
  }

  private fun canonicalFileEntries(files: List<ManifestFile>) =
    files
      .sortedWith { left, right -> compareUtf8(left.path, right.path) }
      .map { fileEntryJson(it) }

  private fun fileEntryJson(file: ManifestFile): String {
    val executable = if (file.executable) "\"executable\":true," else ""
    return "{$executable\"path\":${quoteCanonicalString(file.path)},\"role\":${quoteCanonicalString(file.role)},\"sha256\":${quoteCanonicalString(file.sha256)},\"size\":${file.size}}"
  }

  private fun quoteCanonicalString(value: String): String {
    val result = StringBuilder(value.length + 2)
    result.append('"')
    value.forEach { char ->
      when (char) {
        '"' -> result.append("\\\"")
        '\\' -> result.append("\\\\")
        '\b' -> result.append("\\b")
        '\u000c' -> result.append("\\f")
        '\n' -> result.append("\\n")
        '\r' -> result.append("\\r")
        '\t' -> result.append("\\t")
        else -> {
          if (char.code < 0x20) {
            result.append("\\u")
            result.append(char.code.toString(16).padStart(4, '0'))
          } else {
            result.append(char)
          }
        }
      }
    }
    result.append('"')
    return result.toString()
  }

  private fun compareUtf8(left: String, right: String): Int {
    val leftBytes = left.toByteArray(Charsets.UTF_8)
    val rightBytes = right.toByteArray(Charsets.UTF_8)
    val length = minOf(leftBytes.size, rightBytes.size)
    for (i in 0 until length) {
      val leftByte = leftBytes[i].toInt() and 0xff
      val rightByte = rightBytes[i].toInt() and 0xff
      if (leftByte != rightByte) return leftByte - rightByte
    }
    return leftBytes.size - rightBytes.size
  }

  private fun sha256String(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
  }
}
