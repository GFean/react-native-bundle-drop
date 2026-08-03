import {
  assertValidBundleManifest,
  base64ToBytes,
  byteLengthFromBase64,
  calculateBundleHash,
  calculateManifestHash,
  canonicalManifestFileEntries,
  createBundleManifest,
  normalizeManifestPath,
  sha256Base64,
  sha256String,
} from '../../manifest/bundleManifest';

const sha256 = (content: string) =>
  require('crypto').createHash('sha256').update(Buffer.from(content)).digest('hex');

describe('manifest/bundleManifest', () => {
  it('hashes strings and base64 file content with padding-aware byte lengths', () => {
    expect(sha256String('hello')).toBe(sha256('hello'));
    expect(sha256Base64(Buffer.from('hello').toString('base64'))).toBe(sha256('hello'));
    expect(base64ToBytes('aA==')).toEqual([104]);
    expect(base64ToBytes('aGk=')).toEqual([104, 105]);
    expect(byteLengthFromBase64('')).toBe(0);
    expect(byteLengthFromBase64(' aGk= ')).toBe(2);
    expect(() => base64ToBytes('not-valid!')).toThrow('Invalid base64 data');
  });

  it('canonicalizes file entries and includes metadata bytes in bundle identity', () => {
    const files = [
      {
        path: 'metadata-android.json',
        role: 'metadata' as const,
        size: 10,
        sha256: '1'.repeat(64),
      },
      {
        path: 'bin/tool',
        role: 'asset' as const,
        size: 4,
        sha256: '2'.repeat(64),
        executable: true,
      },
      {
        path: 'main.jsbundle',
        role: 'jsbundle' as const,
        size: 8,
        sha256: '3'.repeat(64),
      },
    ];

    expect(canonicalManifestFileEntries(files)).toEqual([
      {
        executable: true,
        path: 'bin/tool',
        role: 'asset',
        sha256: '2'.repeat(64),
        size: 4,
      },
      {
        path: 'main.jsbundle',
        role: 'jsbundle',
        sha256: '3'.repeat(64),
        size: 8,
      },
      {
        path: 'metadata-android.json',
        role: 'metadata',
        sha256: '1'.repeat(64),
        size: 10,
      },
    ]);

    const hashA = calculateBundleHash(files);
    const hashB = calculateBundleHash([
      { ...files[0], sha256: '4'.repeat(64) },
      files[1],
      files[2],
    ]);
    expect(hashA).not.toBe(hashB);
  });

  it('sorts manifest paths by UTF-8 bytes', () => {
    const files = [
      {
        path: 'é.png',
        role: 'asset' as const,
        size: 1,
        sha256: sha256('e'),
      },
      {
        path: 'z.png',
        role: 'asset' as const,
        size: 1,
        sha256: sha256('z'),
      },
      {
        path: 'main.jsbundle',
        role: 'jsbundle' as const,
        size: 6,
        sha256: sha256('bundle'),
      },
    ];

    expect(canonicalManifestFileEntries(files).map(file => file.path)).toEqual([
      'main.jsbundle',
      'z.png',
      'é.png',
    ]);
    expect(calculateBundleHash(files)).toBe('c684fb6d78639e8ec405fd8a264125ea866add85939a1f17715ea4b11272680c');

    expect(canonicalManifestFileEntries([
      {
        path: 'aa',
        role: 'asset' as const,
        size: 2,
        sha256: sha256('aa'),
      },
      {
        path: 'a',
        role: 'asset' as const,
        size: 1,
        sha256: sha256('a'),
      },
      {
        path: 'main.jsbundle',
        role: 'jsbundle' as const,
        size: 6,
        sha256: sha256('bundle'),
      },
    ]).map(file => file.path)).toEqual(['a', 'aa', 'main.jsbundle']);
  });

  it('rejects unsafe manifest paths', () => {
    for (const path of ['', ' assets/icon.png', '/asset.png', '../asset.png', 'assets/../asset.png', 'assets//icon.png', 'C:\\tmp\\asset.png', 'assets\\icon.png']) {
      expect(() => normalizeManifestPath(path)).toThrow('Invalid manifest path');
    }
    expect(() => normalizeManifestPath(42 as unknown as string)).toThrow('Manifest path must be a string');
    expect(normalizeManifestPath('assets/icon.png')).toBe('assets/icon.png');
  });

  it('creates and validates manifest hashes', () => {
    const files = [
      {
        path: 'main.jsbundle',
        role: 'jsbundle' as const,
        size: 7,
        sha256: sha256('bundle'),
      },
      {
        path: 'metadata-ios.json',
        role: 'metadata' as const,
        size: 19,
        sha256: sha256('{"version":"1.2.3"}'),
      },
    ];
    const bundleHash = calculateBundleHash(files);
    const manifest = createBundleManifest({
      bundleHash,
      jsBundleHash: files[0].sha256,
      platform: 'ios',
      runtimeVersion: '1.0.0',
      version: '1.2.3',
      files,
    });

    expect(manifest.manifestHash).toBe(calculateManifestHash({
      manifestVersion: 1,
      bundleHash,
      jsBundleHash: files[0].sha256,
      platform: 'ios',
      runtimeVersion: '1.0.0',
      version: '1.2.3',
      files,
    }));
    expect(() => assertValidBundleManifest(manifest, bundleHash, 'ios')).not.toThrow();
    expect(() => assertValidBundleManifest(manifest, bundleHash, 'android')).toThrow(
      'Bundle manifest platform mismatch: expected android, got ios',
    );
  });

  it('keeps timestamps outside canonical manifest identity', () => {
    const files = [
      {
        path: 'main.jsbundle',
        role: 'jsbundle' as const,
        size: 7,
        sha256: sha256('bundle'),
      },
      {
        path: 'metadata-ios.json',
        role: 'metadata' as const,
        size: 19,
        sha256: sha256('{"version":"1.2.3"}'),
      },
    ];
    const bundleHash = calculateBundleHash(files);
    const manifest = createBundleManifest({
      bundleHash,
      jsBundleHash: files[0].sha256,
      platform: 'ios',
      runtimeVersion: '1.0.0',
      version: '1.2.3',
      files,
    });

    expect(manifest).not.toHaveProperty('createdAt');
    expect(manifest.manifestHash).toBe(calculateManifestHash({
      manifestVersion: 1,
      bundleHash,
      jsBundleHash: files[0].sha256,
      platform: 'ios',
      runtimeVersion: '1.0.0',
      version: '1.2.3',
      files,
    }));
  });

  it('rejects invalid bundle manifests before activation', () => {
    const files = [
      {
        path: 'main.jsbundle',
        role: 'jsbundle' as const,
        size: 7,
        sha256: sha256('bundle'),
      },
      {
        path: 'metadata-android.json',
        role: 'metadata' as const,
        size: 19,
        sha256: sha256('{"version":"1.2.3"}'),
      },
      {
        path: 'image-manifest.json',
        role: 'androidImageManifest' as const,
        size: 2,
        sha256: sha256('{}'),
      },
    ];
    const bundleHash = calculateBundleHash(files);
    const manifest = createBundleManifest({
      bundleHash,
      jsBundleHash: files[0].sha256,
      platform: 'android',
      runtimeVersion: '1.0.0',
      version: '1.2.3',
      files,
    });

    expect(() =>
      assertValidBundleManifest({ ...manifest, manifestVersion: 2 as 1 })
    ).toThrow('Invalid bundle manifest version');
    expect(() =>
      assertValidBundleManifest({ ...manifest, bundleHash: '' })
    ).toThrow('Bundle manifest is missing bundleHash');
    expect(() =>
      assertValidBundleManifest({ ...manifest, runtimeVersion: '' })
    ).toThrow('Bundle manifest is missing runtimeVersion');
    expect(() =>
      assertValidBundleManifest({ ...manifest, version: '' })
    ).toThrow('Bundle manifest is missing version');
    expect(() =>
      assertValidBundleManifest({ ...manifest, files: [] })
    ).toThrow('Bundle manifest must include files');
    expect(() =>
      assertValidBundleManifest(manifest, 'f'.repeat(64))
    ).toThrow('Bundle manifest hash mismatch');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        files: manifest.files.map(file =>
          file.role === 'jsbundle' ? { ...file, sha256: sha256('tampered') } : file,
        ),
      })
    ).toThrow('jsBundleHash does not match manifest jsbundle file');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        files: manifest.files.map(file =>
          file.role === 'jsbundle' ? { ...file, path: 'index.jsbundle' } : file,
        ),
      })
    ).toThrow('Bundle manifest must include exactly one main.jsbundle file');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        platform: 'web',
      })
    ).toThrow('Bundle manifest platform must be ios or android');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        files: manifest.files.filter(file => file.role !== 'metadata'),
      })
    ).toThrow('Bundle manifest must include exactly one metadata-android.json metadata file');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        files: manifest.files.filter(file => file.role !== 'androidImageManifest'),
      })
    ).toThrow('Android bundle manifest must include image-manifest.json');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        platform: 'ios',
        files: [
          manifest.files.find(file => file.role === 'jsbundle')!,
          {
            path: 'metadata-ios.json',
            role: 'metadata',
            size: 2,
            sha256: sha256('{}'),
          },
          manifest.files.find(file => file.role === 'androidImageManifest')!,
        ],
      })
    ).toThrow('iOS bundle manifest must not include Android image-manifest.json');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        files: [
          ...manifest.files,
          {
            path: 'assets/icon.png',
            role: 'asset',
            size: 4,
            sha256: sha256('icon'),
          },
        ],
      })
    ).toThrow('Bundle hash verification failed');
    const manifestWithoutHash = { ...manifest } as Partial<typeof manifest>;
    delete manifestWithoutHash.manifestHash;
    expect(() =>
      assertValidBundleManifest(manifestWithoutHash as typeof manifest)
    ).toThrow('Bundle manifest is missing manifestHash');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        manifestHash: 'bad',
      })
    ).toThrow('Bundle manifest has invalid manifestHash');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        manifestHash: 'e'.repeat(64),
      })
    ).toThrow('Bundle manifest hash verification failed');
    expect(() =>
      assertValidBundleManifest({
        ...manifest,
        files: [{ ...manifest.files[0] }, { ...manifest.files[0] }],
      })
    ).toThrow('Duplicate manifest file path');
  });
});
