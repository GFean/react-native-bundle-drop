import { installFromZip } from '../../install/installFromZip';
import { installFromPatchSet } from '../../patch-engine/installFromPatchSet';
import {
  ASSET_ONLY_PATCH_ALGORITHM,
  XDELTA_PATCH_ALGORITHM,
} from '../../patch-engine/patchOperations';
import { InstallPhaseError } from '../../errors';
import {
  BUNDLE_MANIFEST,
  BundleManifestFile,
  calculateBundleHash,
  calculateManifestHash,
  createBundleManifest,
} from '../../manifest/bundleManifest';
import { setMockPlatform } from '../mocks/context';
import { imageManifest } from '../mocks/image-manifest';
import { mockInjectBundleDropImageResolver } from '../mocks/injectImageResolver';
import {
  configureUnzipEntries,
  getMockFile,
  mockApplyXdelta,
  mockDownloadFile,
  mockMoveFile,
  mockVerifyBundleFiles,
  mockUnzip,
  mockUnlink,
  setMockFile,
} from '../mocks/native/fs';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));
jest.mock('../../image-manifest', () => require('../mocks/image-manifest'));
jest.mock('../../injectImageResolver', () => require('../mocks/injectImageResolver'));

const DOWNLOAD_URL = 'https://cdn.example.com/bundles/test.zip';

const sha256 = (content: string) =>
  require('crypto').createHash('sha256').update(Buffer.from(content)).digest('hex');
const DOWNLOADED_ZIP_HASH = sha256('__downloaded_zip__');

const withRequiredManifestFiles = (
  files: Record<string, { content: string; role: BundleManifestFile['role'] }>,
  platform: string,
) => {
  const complete = { ...files };
  const metadataPath = platform === 'ios' ? 'metadata-ios.json' : 'metadata-android.json';
  if (!Object.values(complete).some(file => file.role === 'metadata')) {
    complete[metadataPath] = { content: '{}', role: 'metadata' };
  }
  if (platform === 'android' && !Object.values(complete).some(file => file.role === 'androidImageManifest')) {
    complete['image-manifest.json'] = { content: '{}', role: 'androidImageManifest' };
  }
  return complete;
};

const makeManifest = (
  files: Record<string, { content: string; role: BundleManifestFile['role'] }>,
  overrides?: Partial<ReturnType<typeof createBundleManifest>>,
) => {
  const platform = overrides?.platform ?? 'android';
  const completeFiles = withRequiredManifestFiles(files, platform);
  const entries = Object.entries(completeFiles).map(([path, file]) => ({
    path,
    role: file.role,
    size: Buffer.byteLength(file.content),
    sha256: sha256(file.content),
  }));
  const bundleHash = calculateBundleHash(entries);
  return createBundleManifest({
    bundleHash,
    jsBundleHash: entries.find(entry => entry.path === 'main.jsbundle')?.sha256 ?? bundleHash,
    platform,
    runtimeVersion: '1.0.0',
    version: '1.0.0',
    files: entries,
    ...overrides,
  });
};

describe('install/installFromZip', () => {
  it('rejects unsafe bundle hash path segments before downloading', async () => {
    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: '../unsafe',
        platform: 'android',
      })
    ).rejects.toThrow('Invalid bundle hash: expected 64 lowercase hex characters');

    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it('rejects legacy manifestless installs', async () => {
    setMockPlatform('android');
    configureUnzipEntries({
      'main.jsbundle': 'bundle',
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: 'a'.repeat(64),
        platform: 'android',
      })
    ).rejects.toThrow('Bundle manifest is missing');
  });

  it('rejects invalid canonical hashes for patch installs', async () => {
    setMockPlatform('android');
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: 'A'.repeat(64),
      bundlePath: `/mock/doc/bundle-drop/bundles/${'A'.repeat(64)}/main.jsbundle`,
    }));
    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: 'A'.repeat(64),
        targetHash: sha256('target'),
        algorithm: XDELTA_PATCH_ALGORITHM,
      }),
    ).rejects.toThrow('Invalid base hash: expected 64 lowercase hex characters');
  });

  it('installs an Android bundle and leaves current-process image mappings untouched', async () => {
    setMockPlatform('android');
    const metadata = JSON.stringify({
      bundleVersion: 7,
      version: '1.2.3',
      runtimeVersion: '1.0.0',
    });
    const imageManifestJson = JSON.stringify({
      'bundled/logo': 'prebuilt/logo.png',
    });
    const manifest = makeManifest({
      'main.jsbundle': { content: 'console.log("bundle");', role: 'jsbundle' as const },
      'metadata-android.json': { content: metadata, role: 'metadata' as const },
      'image-manifest.json': { content: imageManifestJson, role: 'androidImageManifest' as const },
      'assets/logo.png': { content: 'logo-image', role: 'asset' as const },
      'raw/legal.pdf': { content: 'legal-pdf', role: 'asset' as const },
      'res/drawable/icon.png': { content: 'icon-image', role: 'asset' as const },
    });
    configureUnzipEntries({
      'main.jsbundle': 'console.log("bundle");',
      'metadata-android.json': metadata,
      'image-manifest.json': imageManifestJson,
      'assets/logo.png': 'logo-image',
      'raw/legal.pdf': 'legal-pdf',
      'res/drawable/icon.png': 'icon-image',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });
    Object.assign(imageManifest, {
      'existing/logo': 'bundle-drop/bundles/current/assets/logo.png',
    });

    const statusSpy = jest.fn();
    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
        statusCb: statusSpy,
      })
    ).resolves.toEqual({
      bundlePath: `/mock/doc/bundle-drop/bundles/${manifest.bundleHash}/main.jsbundle`,
      metadataFromZip: {
        bundleVersion: 7,
        version: '1.2.3',
        hash: manifest.bundleHash,
        runtimeVersion: '1.0.0',
      },
    });

    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${manifest.bundleHash}/main.jsbundle`)).toBe(
      'console.log("bundle");'
    );
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${manifest.bundleHash}/assets/logo.png`)).toBe(
      'logo-image'
    );

    expect(mockDownloadFile).toHaveBeenCalledWith(
      DOWNLOAD_URL,
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}.zip`,
    );
    expect(mockUnzip).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}.zip`,
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}`,
    );
    expect(mockVerifyBundleFiles).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}`,
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}/${BUNDLE_MANIFEST}`,
    );
    expect(mockUnlink).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}.zip`,
    );

    expect(imageManifest).toEqual({
      'existing/logo': 'bundle-drop/bundles/current/assets/logo.png',
    });
    expect(mockInjectBundleDropImageResolver).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith('📁 7 files extracted');
  });

  it('parses iOS metadata without touching the Android image resolver', async () => {
    setMockPlatform('ios');
    const metadata = JSON.stringify({
      bundleVersion: 3,
      version: '2.0.0',
      runtimeVersion: '2.0.0',
    });
    const manifest = makeManifest({
      'main.jsbundle': { content: 'console.log("ios");', role: 'jsbundle' as const },
      'metadata-ios.json': { content: metadata, role: 'metadata' as const },
      'assets/splash.png': { content: 'splash-image', role: 'asset' as const },
    }, { platform: 'ios' });
    configureUnzipEntries({
      'main.jsbundle': 'console.log("ios");',
      'metadata-ios.json': metadata,
      'assets/splash.png': 'splash-image',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'ios',
      })
    ).resolves.toEqual({
      bundlePath: `/mock/lib/bundle-drop/bundles/${manifest.bundleHash}/main.jsbundle`,
      metadataFromZip: {
        bundleVersion: 3,
        version: '2.0.0',
        hash: manifest.bundleHash,
        runtimeVersion: '2.0.0',
      },
    });

    expect(getMockFile(`/mock/lib/bundle-drop/bundles/${manifest.bundleHash}/main.jsbundle`)).toBe(
      'console.log("ios");'
    );
    expect(mockInjectBundleDropImageResolver).not.toHaveBeenCalled();
    expect(imageManifest).toEqual({});
  });

  it('rejects full ZIP installs when the manifest platform does not match the requested platform', async () => {
    setMockPlatform('android');
    const metadata = JSON.stringify({
      version: '1.2.3',
      runtimeVersion: '1.0.0',
    });
    const manifest = makeManifest({
      'main.jsbundle': { content: 'console.log("ios-on-android");', role: 'jsbundle' as const },
      'metadata-ios.json': { content: metadata, role: 'metadata' as const },
    }, { platform: 'ios' });
    configureUnzipEntries({
      'main.jsbundle': 'console.log("ios-on-android");',
      'metadata-ios.json': metadata,
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).rejects.toThrow('Bundle manifest platform mismatch: expected android, got ios');

    expect(mockVerifyBundleFiles).not.toHaveBeenCalled();
    expect(mockMoveFile).not.toHaveBeenCalled();
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${manifest.bundleHash}/main.jsbundle`)).toBeUndefined();
  });

  it('throws when the bundle hash param is missing', async () => {
    setMockPlatform('android');
    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        platform: 'android',
      })
    ).rejects.toThrow('Missing bundle hash');
  });

  it('rejects manifestless full installs', async () => {
    setMockPlatform('android');
    const legacyBundle = 'console.log("legacy");';
    const legacyHash = sha256(legacyBundle);
    configureUnzipEntries({
      'main.jsbundle': legacyBundle,
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: legacyHash,
        platform: 'android',
      }),
    ).rejects.toThrow('Bundle manifest is missing');
  });

  it('does not accept alternate manifest filenames as a bundle manifest', async () => {
    setMockPlatform('android');
    const manifest = makeManifest({
      'main.jsbundle': { content: 'bundle', role: 'jsbundle' as const },
    });
    configureUnzipEntries({
      'main.jsbundle': 'bundle',
      'bundle-manifest-extra.json': JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).rejects.toThrow('Bundle manifest is missing');
  });

  it('verifies a canonical manifest full install and promotes by canonical bundleHash', async () => {
    setMockPlatform('android');
    const jsBundleHash = sha256('console.log("verified");');
    const metadata = JSON.stringify({
      jsBundleHash,
      bundleVersion: 9,
    });
    const files = {
      'main.jsbundle': { content: 'console.log("verified");', role: 'jsbundle' as const },
      'metadata-android.json': {
        content: metadata,
        role: 'metadata' as const,
      },
      'assets/logo.png': { content: 'logo-v2', role: 'asset' as const },
    };
    const finalManifest = makeManifest(files, { jsBundleHash });

    configureUnzipEntries({
      'main.jsbundle': files['main.jsbundle'].content,
      'metadata-android.json': metadata,
      'assets/logo.png': files['assets/logo.png'].content,
      [BUNDLE_MANIFEST]: JSON.stringify(finalManifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: finalManifest.bundleHash,
        platform: 'android',
      }),
    ).resolves.toEqual({
      bundlePath: `/mock/doc/bundle-drop/bundles/${finalManifest.bundleHash}/main.jsbundle`,
      metadataFromZip: {
        bundleVersion: 9,
        hash: finalManifest.bundleHash,
        runtimeVersion: '1.0.0',
        version: '1.0.0',
      },
    });
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${finalManifest.bundleHash}/assets/logo.png`)).toBe('logo-v2');
  });

  it('keeps the manifest in promoted file metadata when unzip does not list it', async () => {
    setMockPlatform('android');
    const metadata = JSON.stringify({ bundleVersion: 14 });
    const manifest = makeManifest({
      'main.jsbundle': { content: 'console.log("hidden-manifest");', role: 'jsbundle' as const },
      'metadata-android.json': { content: metadata, role: 'metadata' as const },
    });

    mockUnzip.mockImplementationOnce(async (_zipPath, destPath) => {
      setMockFile(`${destPath}/main.jsbundle`, 'console.log("hidden-manifest");');
      setMockFile(`${destPath}/metadata-android.json`, metadata);
      setMockFile(`${destPath}/${BUNDLE_MANIFEST}`, JSON.stringify(manifest));
      return ['main.jsbundle', 'metadata-android.json'];
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).resolves.toEqual({
      bundlePath: `/mock/doc/bundle-drop/bundles/${manifest.bundleHash}/main.jsbundle`,
      metadataFromZip: {
        bundleVersion: 14,
        hash: manifest.bundleHash,
        runtimeVersion: '1.0.0',
        version: '1.0.0',
      },
    });
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${manifest.bundleHash}/${BUNDLE_MANIFEST}`)).toBe(
      JSON.stringify(manifest),
    );
  });

  it('rejects full installs that contain unmanifested files', async () => {
    setMockPlatform('android');
    const manifest = makeManifest({
      'main.jsbundle': { content: 'bundle', role: 'jsbundle' as const },
    });
    configureUnzipEntries({
      'main.jsbundle': 'bundle',
      'assets/unlisted.png': 'unlisted',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).rejects.toThrow('Unmanifested file in bundle archive: assets/unlisted.png');
  });

  it('reuses an existing verified target folder without deleting the active bundle', async () => {
    setMockPlatform('android');
    const manifest = makeManifest({
      'main.jsbundle': { content: 'existing', role: 'jsbundle' as const },
      'metadata-android.json': { content: JSON.stringify({ bundleVersion: 10 }), role: 'metadata' as const },
    });
    const bundleDir = `/mock/doc/bundle-drop/bundles/${manifest.bundleHash}`;
    setMockFile(`${bundleDir}/main.jsbundle`, 'existing');
    setMockFile(`${bundleDir}/metadata-android.json`, JSON.stringify({ bundleVersion: 10 }));
    setMockFile(`${bundleDir}/${BUNDLE_MANIFEST}`, JSON.stringify(manifest));
    configureUnzipEntries({
      'main.jsbundle': 'existing',
      'metadata-android.json': JSON.stringify({ bundleVersion: 10 }),
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).resolves.toEqual({
      bundlePath: `${bundleDir}/main.jsbundle`,
      metadataFromZip: {
        bundleVersion: 10,
        hash: manifest.bundleHash,
        runtimeVersion: '1.0.0',
        version: '1.0.0',
      },
    });

    expect(mockMoveFile).not.toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}`,
      bundleDir,
    );
    expect(getMockFile(`${bundleDir}/main.jsbundle`)).toBe('existing');
    expect(mockUnlink).toHaveBeenCalledWith(`/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}`);
  });

  it('replaces invalid inactive target folders with the verified temp install', async () => {
    setMockPlatform('android');
    const manifest = makeManifest({
      'main.jsbundle': { content: 'replacement', role: 'jsbundle' as const },
    });
    const bundleDir = `/mock/doc/bundle-drop/bundles/${manifest.bundleHash}`;
    setMockFile(`${bundleDir}/main.jsbundle`, 'corrupt');
    configureUnzipEntries({
      'main.jsbundle': 'replacement',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).resolves.toEqual({
      bundlePath: `${bundleDir}/main.jsbundle`,
      metadataFromZip: {
        hash: manifest.bundleHash,
        runtimeVersion: '1.0.0',
        version: '1.0.0',
      },
    });
    expect(mockUnlink).toHaveBeenCalledWith(bundleDir);
    expect(mockMoveFile).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}`,
      bundleDir,
    );
    expect(getMockFile(`${bundleDir}/main.jsbundle`)).toBe('replacement');
  });

  it('replaces inactive target folders that have invalid manifests', async () => {
    setMockPlatform('android');
    const manifest = makeManifest({
      'main.jsbundle': { content: 'replacement', role: 'jsbundle' as const },
    });
    const bundleDir = `/mock/doc/bundle-drop/bundles/${manifest.bundleHash}`;
    setMockFile(`${bundleDir}/main.jsbundle`, 'corrupt');
    setMockFile(`${bundleDir}/${BUNDLE_MANIFEST}`, JSON.stringify({
      ...manifest,
      manifestHash: 'f'.repeat(64),
    }));
    configureUnzipEntries({
      'main.jsbundle': 'replacement',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).resolves.toEqual(expect.objectContaining({
      bundlePath: `${bundleDir}/main.jsbundle`,
    }));
    expect(mockUnlink).toHaveBeenCalledWith(bundleDir);
    expect(getMockFile(`${bundleDir}/main.jsbundle`)).toBe('replacement');
  });

  it('does not replace an invalid folder when it is the active bundle pointer', async () => {
    setMockPlatform('android');
    const manifest = makeManifest({
      'main.jsbundle': { content: 'replacement', role: 'jsbundle' as const },
    });
    const bundleDir = `/mock/doc/bundle-drop/bundles/${manifest.bundleHash}`;
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: manifest.bundleHash,
      updatedAt: '2026-03-01T00:00:00.000Z',
    }));
    setMockFile(`${bundleDir}/main.jsbundle`, 'corrupt-active');
    configureUnzipEntries({
      'main.jsbundle': 'replacement',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).rejects.toThrow('Active bundle folder failed verification');
    expect(mockUnlink).not.toHaveBeenCalledWith(bundleDir);
    expect(mockMoveFile).not.toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}`,
      bundleDir,
    );
  });

  it('does not replace an active folder when its manifest fails verification', async () => {
    setMockPlatform('android');
    const manifest = makeManifest({
      'main.jsbundle': { content: 'replacement', role: 'jsbundle' as const },
    });
    const bundleDir = `/mock/doc/bundle-drop/bundles/${manifest.bundleHash}`;
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: manifest.bundleHash,
      updatedAt: '2026-03-01T00:00:00.000Z',
    }));
    setMockFile(`${bundleDir}/main.jsbundle`, 'corrupt-active');
    setMockFile(`${bundleDir}/${BUNDLE_MANIFEST}`, JSON.stringify({
      ...manifest,
      manifestHash: 'f'.repeat(64),
    }));
    configureUnzipEntries({
      'main.jsbundle': 'replacement',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).rejects.toThrow('Active bundle folder failed verification');
    expect(mockUnlink).not.toHaveBeenCalledWith(bundleDir);
    expect(mockMoveFile).not.toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}`,
      bundleDir,
    );
  });

  it('rejects full installs when a manifest file hash does not match extracted content', async () => {
    setMockPlatform('android');
    const manifest = makeManifest({
      'main.jsbundle': { content: 'console.log("expected");', role: 'jsbundle' as const },
    });
    configureUnzipEntries({
      'main.jsbundle': 'console.log("tampered");',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    const err = await installFromZip({
      downloadUrl: DOWNLOAD_URL,
      hash: manifest.bundleHash,
      platform: 'android',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InstallPhaseError);
    expect((err as InstallPhaseError).phase).toBe('install');
    expect((err as InstallPhaseError).message).toContain('Manifest file hash mismatch');
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${manifest.bundleHash}/main.jsbundle`)).toBeUndefined();
  });

  it('rejects full installs when a manifest file is missing or has the wrong size', async () => {
    setMockPlatform('android');
    const missingManifest = makeManifest({
      'main.jsbundle': { content: 'bundle', role: 'jsbundle' as const },
      'assets/missing.png': { content: 'missing', role: 'asset' as const },
    });
    configureUnzipEntries({
      'main.jsbundle': 'bundle',
      [BUNDLE_MANIFEST]: JSON.stringify(missingManifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: missingManifest.bundleHash,
        platform: 'android',
      }),
    ).rejects.toThrow('Manifest file missing: assets/missing.png');

    const sizeMismatchManifest = makeManifest({
      'main.jsbundle': { content: 'bundle', role: 'jsbundle' as const },
    });
    const mainBundleEntry = sizeMismatchManifest.files.find(file => file.path === 'main.jsbundle');
    if (!mainBundleEntry) throw new Error('test manifest missing main.jsbundle');
    mainBundleEntry.size += 1;
    sizeMismatchManifest.bundleHash = calculateBundleHash(sizeMismatchManifest.files);
    sizeMismatchManifest.manifestHash = calculateManifestHash(sizeMismatchManifest);
    configureUnzipEntries({
      'main.jsbundle': 'bundle',
      [BUNDLE_MANIFEST]: JSON.stringify(sizeMismatchManifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: sizeMismatchManifest.bundleHash,
        platform: 'android',
      }),
    ).rejects.toThrow('Manifest file size mismatch for main.jsbundle');
  });

  it('cleans temp extraction when promotion does not produce a bundle file', async () => {
    setMockPlatform('android');
    const manifest = makeManifest({
      'main.jsbundle': { content: 'bundle', role: 'jsbundle' as const },
    });
    configureUnzipEntries({
      'main.jsbundle': 'bundle',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });
    mockMoveFile.mockImplementationOnce(async () => undefined);

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
        platform: 'android',
      }),
    ).rejects.toThrow('main.jsbundle missing after promotion');

    expect(mockUnlink).toHaveBeenCalledWith(`/mock/doc/bundle-drop/bundles/_tmp_${manifest.bundleHash}`);
  });

  it('uses the default device platform and tolerates empty metadata', async () => {
    setMockPlatform('android');
    const metadata = JSON.stringify({});
    const manifest = makeManifest({
      'main.jsbundle': { content: 'console.log("default-platform");', role: 'jsbundle' as const },
      'metadata-android.json': { content: metadata, role: 'metadata' as const },
    });
    configureUnzipEntries({
      'main.jsbundle': 'console.log("default-platform");',
      'metadata-android.json': metadata,
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    await expect(
      installFromZip({
        downloadUrl: DOWNLOAD_URL,
        hash: manifest.bundleHash,
      }),
    ).resolves.toEqual({
      bundlePath: `/mock/doc/bundle-drop/bundles/${manifest.bundleHash}/main.jsbundle`,
      metadataFromZip: {
        hash: manifest.bundleHash,
        runtimeVersion: '1.0.0',
        version: '1.0.0',
      },
    });
  });

  it('warns on invalid metadata while still installing the bundle', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    setMockPlatform('android');
    const metadata = '{invalid json';
    const imageManifestJson = '{invalid json';
    const manifest = makeManifest({
      'main.jsbundle': { content: 'console.log("warn-path");', role: 'jsbundle' as const },
      'metadata-android.json': { content: metadata, role: 'metadata' as const },
      'image-manifest.json': { content: imageManifestJson, role: 'androidImageManifest' as const },
      'assets/logo.png': { content: 'logo-image', role: 'asset' as const },
    });
    configureUnzipEntries({
      'main.jsbundle': 'console.log("warn-path");',
      'metadata-android.json': metadata,
      'image-manifest.json': imageManifestJson,
      'assets/logo.png': 'logo-image',
      [BUNDLE_MANIFEST]: JSON.stringify(manifest),
    });

    try {
      const statusSpy = jest.fn();
      await expect(
        installFromZip({
          downloadUrl: DOWNLOAD_URL,
          hash: manifest.bundleHash,
          platform: 'android',
          statusCb: statusSpy,
        }),
      ).resolves.toEqual({
        bundlePath: `/mock/doc/bundle-drop/bundles/${manifest.bundleHash}/main.jsbundle`,
        metadataFromZip: {
          hash: manifest.bundleHash,
          runtimeVersion: '1.0.0',
          version: '1.0.0',
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '⚠️ Failed to parse bundle metadata from zip',
        expect.any(Error),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        '❌ Failed to parse image manifest:',
        expect.any(Error),
      );
      expect(statusSpy).not.toHaveBeenCalledWith('❌ Failed to parse image manifest');
      expect(imageManifest).toEqual({});
      expect(mockInjectBundleDropImageResolver).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fails with install phase error and cleans up bundleDir when main.jsbundle is missing', async () => {
    setMockPlatform('android');
    const hash = sha256('hash-no-bundle');
    configureUnzipEntries({
      'metadata-android.json': JSON.stringify({ hash: 'hash-no-bundle' }),
    });

    const err = await installFromZip({
      downloadUrl: DOWNLOAD_URL,
      hash,
      platform: 'android',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InstallPhaseError);
    expect((err as InstallPhaseError).phase).toBe('install');
    expect((err as InstallPhaseError).message).toBe('main.jsbundle missing after extraction');
    expect(mockUnlink).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${hash}`,
    );
    expect(mockUnlink).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${hash}.zip`,
    );
  });

  it('cleans up bundleDir when unzip fails', async () => {
    const hash = sha256('hash-cleanup');
    mockUnzip.mockRejectedValueOnce(new Error('corrupt archive'));

    await installFromZip({
      downloadUrl: DOWNLOAD_URL,
      hash,
      platform: 'android',
    }).catch(() => {});

    expect(mockUnlink).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${hash}`,
    );
    expect(mockUnlink).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_tmp_${hash}.zip`,
    );
  });

  it('wraps unzip failures as InstallPhaseError with install phase and cleans up both dirs', async () => {
    const hash = sha256('hash-bad');
    mockUnzip.mockRejectedValueOnce(new Error('corrupt archive'));

    const err = await installFromZip({
      downloadUrl: DOWNLOAD_URL,
      hash,
      platform: 'android',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InstallPhaseError);
    expect((err as InstallPhaseError).phase).toBe('install');
    expect((err as InstallPhaseError).message).toBe('corrupt archive');
    expect((err as InstallPhaseError).originalCause).toBeInstanceOf(Error);
    expect(mockUnlink).toHaveBeenCalledWith(`/mock/doc/bundle-drop/bundles/_tmp_${hash}`);
    expect(mockUnlink).toHaveBeenCalledWith(`/mock/doc/bundle-drop/bundles/_tmp_${hash}.zip`);
  });

  it('wraps download failures as InstallPhaseError with download phase and cleans up both dirs', async () => {
    const hash = sha256('hash-dl-fail');
    mockDownloadFile.mockRejectedValueOnce(new Error('network error'));

    const err = await installFromZip({
      downloadUrl: DOWNLOAD_URL,
      hash,
      platform: 'android',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InstallPhaseError);
    expect((err as InstallPhaseError).phase).toBe('download');
    expect((err as InstallPhaseError).message).toBe('network error');
    expect((err as InstallPhaseError).originalCause).toBeInstanceOf(Error);
    expect(mockUnlink).toHaveBeenCalledWith(`/mock/doc/bundle-drop/bundles/_tmp_${hash}`);
    expect(mockUnlink).toHaveBeenCalledWith(`/mock/doc/bundle-drop/bundles/_tmp_${hash}.zip`);
  });

  it('reconstructs and promotes a patch set from unchanged base files and changed full files', async () => {
    setMockPlatform('android');
    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'console.log("base");', role: 'jsbundle' as const },
      'metadata-android.json': { content: JSON.stringify({ bundleVersion: 21 }), role: 'metadata' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'console.log("base");');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/metadata-android.json`, JSON.stringify({ bundleVersion: 21 }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));

    const targetMetadata = JSON.stringify({ bundleVersion: 22 });
    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'console.log("base");', role: 'jsbundle' as const },
      'metadata-android.json': { content: targetMetadata, role: 'metadata' as const },
    });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(targetManifest),
      'files/full/metadata-android.json': targetMetadata,
    });
    const statusSpy = jest.fn();

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: baseManifest.bundleHash,
        targetHash: targetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        statusCb: statusSpy,
      }),
    ).resolves.toEqual({
      bundlePath: `/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/main.jsbundle`,
      metadataFromZip: {
        bundleVersion: 22,
        hash: targetManifest.bundleHash,
        runtimeVersion: '1.0.0',
        version: '1.0.0',
      },
    });

    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/main.jsbundle`)).toBe('console.log("base");');
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/metadata-android.json`)).toBe(targetMetadata);
    expect(statusSpy).toHaveBeenCalledWith('🧩 Patch reconstructed and verified');
  });

  it('rejects patch installs when the target manifest platform does not match the requested platform', async () => {
    setMockPlatform('android');
    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'base');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));

    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'ios target', role: 'jsbundle' as const },
      'metadata-ios.json': { content: '{}', role: 'metadata' as const },
    }, { platform: 'ios' });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(targetManifest),
      'files/full/main.jsbundle': 'ios target',
    });

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: baseManifest.bundleHash,
        targetHash: targetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Bundle manifest platform mismatch: expected android, got ios');

    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/main.jsbundle`)).toBeUndefined();
  });

  it('downloads the target manifest when a patch set omits embedded manifest metadata', async () => {
    setMockPlatform('android');
    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
    });
    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'target', role: 'jsbundle' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'base');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));
    configureUnzipEntries({
      'files/full/main.jsbundle': 'target',
    });
    mockDownloadFile.mockImplementation(async (_url: string, destPath: string) => {
      setMockFile(destPath, destPath.endsWith(BUNDLE_MANIFEST) ? JSON.stringify(targetManifest) : '__downloaded_zip__');
    });

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        manifestUrl: 'https://cdn.example.com/manifest.json',
        baseHash: baseManifest.bundleHash,
        targetHash: targetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      })
    ).resolves.toEqual({
      bundlePath: `/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/main.jsbundle`,
      metadataFromZip: {
        hash: targetManifest.bundleHash,
        runtimeVersion: '1.0.0',
        version: '1.0.0',
      },
    });

    expect(mockDownloadFile).toHaveBeenCalledWith(
      'https://cdn.example.com/manifest.json',
      `/mock/doc/bundle-drop/bundles/_patch_${targetManifest.bundleHash}/${BUNDLE_MANIFEST}`,
    );
  });

  it('verifies patch set hashes and missing asset archives before reconstruction', async () => {
    setMockPlatform('android');
    const testBaseHash = sha256('base-hash');
    const testTargetHash = sha256('target-hash');
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: testBaseHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${testBaseHash}/main.jsbundle`,
    }));

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: 'bad-hash',
        baseHash: testBaseHash,
        targetHash: testTargetHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Patch set hash mismatch');

    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'base');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));
    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
      'assets/logo.png': { content: 'logo', role: 'asset' as const },
    });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(targetManifest),
      'assets/logo.png': 'logo',
    });

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        missingAssetsUrl: 'https://cdn.example.com/missing-assets.zip',
        missingAssetsHash: 'bad-assets-hash',
        baseHash: baseManifest.bundleHash,
        targetHash: targetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Missing assets archive hash mismatch');
  });

  it('rejects missing-assets transport without an archive hash before downloading assets', async () => {
    setMockPlatform('android');
    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'base');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));
    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
      'assets/logo.png': { content: 'logo', role: 'asset' as const },
    });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(targetManifest),
      'assets/logo.png': 'logo',
    });

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        missingAssetsUrl: 'https://cdn.example.com/missing-assets.zip',
        baseHash: baseManifest.bundleHash,
        targetHash: targetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Missing assets archive hash is required');

    expect(mockDownloadFile).toHaveBeenCalledWith(
      'https://cdn.example.com/patch.zip',
      `/mock/doc/bundle-drop/bundles/_patch_${targetManifest.bundleHash}.zip`,
    );
    expect(mockDownloadFile).not.toHaveBeenCalledWith(
      'https://cdn.example.com/missing-assets.zip',
      expect.any(String),
    );
  });

  it('uses a verified missing assets archive during patch reconstruction', async () => {
    setMockPlatform('android');
    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'base');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));
    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
      'assets/logo.png': { content: 'logo', role: 'asset' as const },
    });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(targetManifest),
      'assets/logo.png': 'logo',
    });

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        missingAssetsUrl: 'https://cdn.example.com/missing-assets.zip',
        missingAssetsHash: DOWNLOADED_ZIP_HASH,
        baseHash: baseManifest.bundleHash,
        targetHash: targetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).resolves.toEqual({
      bundlePath: `/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/main.jsbundle`,
      metadataFromZip: {
        hash: targetManifest.bundleHash,
        runtimeVersion: '1.0.0',
        version: '1.0.0',
      },
    });
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/assets/logo.png`)).toBe('logo');
  });

  it('applies xdelta patches through the native primitive', async () => {
    setMockPlatform('android');
    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'base');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));
    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'target', role: 'jsbundle' as const },
    });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(targetManifest),
      'files/xdelta/main.jsbundle.vcdiff': 'delta',
    });
    (mockApplyXdelta as jest.Mock).mockImplementationOnce(async (_base, _patch, output) => {
      setMockFile(output, 'target');
    });

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: baseManifest.bundleHash,
        targetHash: targetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).resolves.toEqual({
      bundlePath: `/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/main.jsbundle`,
      metadataFromZip: {
        hash: targetManifest.bundleHash,
        runtimeVersion: '1.0.0',
        version: '1.0.0',
      },
    });
    expect(mockApplyXdelta).toHaveBeenCalled();
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/main.jsbundle`)).toBe('target');
  });

  it('reconstructs asset-only patch sets without applying xdelta entries', async () => {
    setMockPlatform('android');
    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
      'assets/logo.png': { content: 'old-logo', role: 'asset' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'base');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/assets/logo.png`, 'old-logo');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));

    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'target', role: 'jsbundle' as const },
      'assets/logo.png': { content: 'new-logo', role: 'asset' as const },
    });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(targetManifest),
      'files/full/main.jsbundle': 'target',
      'assets/logo.png': 'new-logo',
    });

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        missingAssetsUrl: 'https://cdn.example.com/missing-assets.zip',
        missingAssetsHash: DOWNLOADED_ZIP_HASH,
        baseHash: baseManifest.bundleHash,
        targetHash: targetManifest.bundleHash,
        algorithm: ASSET_ONLY_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).resolves.toEqual(expect.objectContaining({
      bundlePath: `/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/main.jsbundle`,
    }));

    expect(mockApplyXdelta).not.toHaveBeenCalled();
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/main.jsbundle`)).toBe('target');
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${targetManifest.bundleHash}/assets/logo.png`)).toBe('new-logo');
    expect(mockVerifyBundleFiles).not.toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}`,
      expect.any(String),
    );
    expect(mockVerifyBundleFiles).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/_patch_target_${targetManifest.bundleHash}`,
      `/mock/doc/bundle-drop/bundles/_patch_target_${targetManifest.bundleHash}/${BUNDLE_MANIFEST}`,
    );
  });

  it('does not use xdelta entries for asset-only patch sets', async () => {
    setMockPlatform('android');
    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'base');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));

    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'target', role: 'jsbundle' as const },
    });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(targetManifest),
      'files/xdelta/main.jsbundle.vcdiff': 'delta',
    });

    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: baseManifest.bundleHash,
        targetHash: targetManifest.bundleHash,
        algorithm: ASSET_ONLY_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Patch set missing full content for changed file: main.jsbundle');
    expect(mockApplyXdelta).not.toHaveBeenCalled();
  });

  it('fails patch installs cleanly for base mismatches, missing manifests, missing base manifests, and xdelta patches', async () => {
    setMockPlatform('android');
    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: 'base-missing',
        targetHash: 'target',
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Invalid base hash: expected 64 lowercase hex characters');

    const testBaseHash = sha256('base-hash');
    const testTargetHash = sha256('target-hash');
    const actualCurrentHash = sha256('actual-current-hash');
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: actualCurrentHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${actualCurrentHash}/main.jsbundle`,
    }));
    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: testBaseHash,
        targetHash: testTargetHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Patch base hash does not match current bundle');

    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: testBaseHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${testBaseHash}/main.jsbundle`,
    }));
    configureUnzipEntries({
      'files/full/main.jsbundle': 'bundle',
    });
    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: testBaseHash,
        targetHash: testTargetHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Patch set missing target manifest');

    configureUnzipEntries({
      'files/full/main.jsbundle': 'bundle',
    });
    mockDownloadFile.mockImplementationOnce(async (_url, destPath) => {
      setMockFile(destPath, '__downloaded_zip__');
    }).mockRejectedValueOnce(new Error('manifest url expired'));
    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        manifestUrl: 'https://cdn.example.com/manifest.json',
        baseHash: testBaseHash,
        targetHash: testTargetHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('manifest url expired');

    const targetManifest = makeManifest({
      'main.jsbundle': { content: 'target', role: 'jsbundle' as const },
    });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(targetManifest),
      'files/full/main.jsbundle': 'target',
    });
    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: testBaseHash,
        targetHash: targetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Base bundle manifest is missing');

    const baseManifest = makeManifest({
      'main.jsbundle': { content: 'base', role: 'jsbundle' as const },
    });
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: baseManifest.bundleHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
    }));
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`, 'base');
    setMockFile(`/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/${BUNDLE_MANIFEST}`, JSON.stringify(baseManifest));
    const changedTargetManifest = makeManifest({
      'main.jsbundle': { content: 'target', role: 'jsbundle' as const },
    });
    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(changedTargetManifest),
      'files/xdelta/main.jsbundle.vcdiff': 'delta',
    });
    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: baseManifest.bundleHash,
        targetHash: changedTargetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('xdelta3-vcdiff apply is not available in the test mock');
    expect(mockApplyXdelta).toHaveBeenCalledWith(
      `/mock/doc/bundle-drop/bundles/${baseManifest.bundleHash}/main.jsbundle`,
      '/mock/doc/bundle-drop/bundles/_patch_' + changedTargetManifest.bundleHash + '/files/xdelta/main.jsbundle.vcdiff',
      '/mock/doc/bundle-drop/bundles/_patch_target_' + changedTargetManifest.bundleHash + '/main.jsbundle',
    );
    expect(getMockFile(`/mock/doc/bundle-drop/bundles/${changedTargetManifest.bundleHash}/main.jsbundle`)).toBeUndefined();

    configureUnzipEntries({
      [BUNDLE_MANIFEST]: JSON.stringify(changedTargetManifest),
    });
    await expect(
      installFromPatchSet({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: DOWNLOADED_ZIP_HASH,
        baseHash: baseManifest.bundleHash,
        targetHash: changedTargetManifest.bundleHash,
        algorithm: XDELTA_PATCH_ALGORITHM,
        platform: 'android',
      }),
    ).rejects.toThrow('Patch set missing full content for changed file: main.jsbundle');
  });

  it('wraps patch-set download and unzip failures by phase', async () => {
    setMockPlatform('android');
    const testBaseHash = sha256('base-hash');
    const testTargetHash = sha256('target-hash');
    setMockFile('/mock/doc/bundle-drop/current.json', JSON.stringify({
      hash: testBaseHash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${testBaseHash}/main.jsbundle`,
    }));
    mockDownloadFile.mockRejectedValueOnce(new Error('patch url expired'));

    const downloadErr = await installFromPatchSet({
      patchesUrl: 'https://cdn.example.com/patch.zip',
      patchSetHash: DOWNLOADED_ZIP_HASH,
      baseHash: testBaseHash,
      targetHash: testTargetHash,
      algorithm: XDELTA_PATCH_ALGORITHM,
      platform: 'android',
    }).catch((e: unknown) => e);

    expect(downloadErr).toBeInstanceOf(InstallPhaseError);
    expect((downloadErr as InstallPhaseError).phase).toBe('download');

    mockUnzip.mockRejectedValueOnce(new Error('corrupt patch set'));
    const installErr = await installFromPatchSet({
      patchesUrl: 'https://cdn.example.com/patch.zip',
      patchSetHash: DOWNLOADED_ZIP_HASH,
      baseHash: testBaseHash,
      targetHash: testTargetHash,
      algorithm: XDELTA_PATCH_ALGORITHM,
      platform: 'android',
    }).catch((e: unknown) => e);

    expect(installErr).toBeInstanceOf(InstallPhaseError);
    expect((installErr as InstallPhaseError).phase).toBe('install');
  });
});
