import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  BUNDLE_MANIFEST,
  BundleManifestFile,
  calculateBundleHash,
  createBundleManifest,
  normalizeManifestPath,
} from '../../manifest/bundleManifest';
import {
  buildCanonicalArtifact,
  normalizeCanonicalAssetPath,
} from '../../scripts/canonicalArtifact';

type BareArtifactFixture = {
  platform: 'ios' | 'android';
  appVersion: string;
  runtimeVersion: string;
  bundlePath: string;
  assetsDir: string;
  outputDir: string;
};

const sha256Buffer = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

const legacyRoleForPath = (filePath: string): BundleManifestFile['role'] => {
  if (filePath === 'main.jsbundle') return 'jsbundle';
  if (filePath.startsWith('metadata-')) return 'metadata';
  if (filePath === 'image-manifest.json') return 'androidImageManifest';
  return 'asset';
};

/**
 * Reference implementation copied from the pre-canonical bare bundler. Keeping
 * this independent makes byte drift in the extracted builder visible.
 */
function buildLegacyBareArtifact(options: BareArtifactFixture) {
  const bundleBuffer = fs.readFileSync(options.bundlePath);
  const jsBundleHash = sha256Buffer(bundleBuffer);
  const metadata = {
    platform: options.platform,
    jsBundleHash,
    bundlePath: 'main.jsbundle',
    sizeInBytes: bundleBuffer.length,
    runtimeVersion: options.runtimeVersion,
  };
  const metadataName = `metadata-${options.platform}.json`;
  const metadataBuffer = Buffer.from(JSON.stringify(metadata, null, 2));
  const stagedFiles = new Map<string, Buffer>([
    ['main.jsbundle', bundleBuffer],
    [metadataName, metadataBuffer],
  ]);
  const imageManifest: Record<string, string> = {};

  const addAssets = (directory: string) => {
    for (const item of fs.readdirSync(directory)) {
      const fullPath = path.join(directory, item);
      if (fs.statSync(fullPath).isDirectory()) {
        addAssets(fullPath);
        continue;
      }
      const relativePath = normalizeManifestPath(path.relative(options.assetsDir, fullPath));
      stagedFiles.set(relativePath, fs.readFileSync(fullPath));
      if (options.platform === 'android') {
        imageManifest[relativePath.replace(/^assets\//, '')] = relativePath;
      }
    }
  };
  addAssets(options.assetsDir);

  if (options.platform === 'android') {
    stagedFiles.set(
      'image-manifest.json',
      Buffer.from(JSON.stringify(imageManifest, null, 2)),
    );
  }

  const files = [...stagedFiles.entries()].map(([filePath, buffer]) => ({
    path: normalizeManifestPath(filePath),
    size: buffer.length,
    sha256: sha256Buffer(buffer),
    role: legacyRoleForPath(normalizeManifestPath(filePath)),
  }));
  const bundleHash = calculateBundleHash(files);
  const manifestBuffer = Buffer.from(JSON.stringify(createBundleManifest({
    bundleHash,
    jsBundleHash,
    platform: options.platform,
    runtimeVersion: options.runtimeVersion,
    version: options.appVersion,
    files,
  }), null, 2));
  stagedFiles.set(BUNDLE_MANIFEST, manifestBuffer);

  const metadataPath = path.join(options.outputDir, metadataName);
  const manifestPath = path.join(options.outputDir, BUNDLE_MANIFEST);
  const zipPath = path.join(options.outputDir, `bundle-${options.platform}.zip`);
  fs.writeFileSync(metadataPath, metadataBuffer);
  fs.writeFileSync(manifestPath, manifestBuffer);
  const zip = new AdmZip();
  for (const [filePath, buffer] of stagedFiles) {
    zip.addFile(filePath, buffer);
  }
  zip.writeZip(zipPath);

  return { bundleHash, jsBundleHash, metadataPath, manifestPath, zipPath };
}

describe('buildCanonicalArtifact', () => {
  let root: string;
  let outputDir: string;
  let assetsDir: string;
  let bundlePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-artifact-'));
    outputDir = path.join(root, 'dist');
    assetsDir = path.join(outputDir, 'assets');
    bundlePath = path.join(outputDir, 'main.jsbundle');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(bundlePath, 'global.__bundle = true;');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('builds the frozen iOS manifest and ZIP roles', () => {
    fs.mkdirSync(path.join(assetsDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'assets', 'logo.png'), 'png');

    const result = buildCanonicalArtifact({
      platform: 'ios',
      appVersion: '1.2.3',
      runtimeVersion: 'runtime-1',
      bundlePath,
      assetsDir,
      outputDir,
    });

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      platform: 'ios',
      version: '1.2.3',
      runtimeVersion: 'runtime-1',
    });
    expect(manifest.files.map((file: { path: string; role: string }) => [file.path, file.role]))
      .toEqual([
        ['assets/logo.png', 'asset'],
        ['main.jsbundle', 'jsbundle'],
        ['metadata-ios.json', 'metadata'],
      ]);
    expect(new AdmZip(result.zipPath).getEntries().map(entry => entry.entryName)).toEqual([
      'assets/logo.png',
      'bundle-manifest.json',
      'main.jsbundle',
      'metadata-ios.json',
    ]);
  });

  it('adds the existing Android image-manifest role and aliases', () => {
    fs.mkdirSync(path.join(assetsDir, 'drawable-mdpi'), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'drawable-mdpi', 'icon.png'), 'png');

    const result = buildCanonicalArtifact({
      platform: 'android',
      appVersion: '2.0.0',
      runtimeVersion: 'runtime-2',
      bundlePath,
      assetsDir,
      outputDir,
      sourceMapPath: path.join(outputDir, 'main.jsbundle.map'),
    });

    const imageManifest = JSON.parse(
      new AdmZip(result.zipPath).readAsText('image-manifest.json'),
    );
    expect(imageManifest).toEqual({ 'drawable-mdpi/icon.png': 'drawable-mdpi/icon.png' });
    expect(result.sourceMapPath).toBe(path.join(outputDir, 'main.jsbundle.map'));
  });

  it.each(['ios', 'android'] as const)(
    'is byte-equivalent to the pre-refactor bare %s artifact',
    platform => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-01-02T03:04:06.000Z'));
      try {
        const createBareFixture = (name: string): BareArtifactFixture => {
          const fixtureOutput = path.join(root, name);
          const fixtureAssets = path.join(fixtureOutput, 'assets');
          const fixtureBundle = path.join(fixtureOutput, 'main.jsbundle');
          fs.mkdirSync(path.join(fixtureAssets, 'assets', 'images'), { recursive: true });
          fs.writeFileSync(fixtureBundle, 'global.__bare_bundle = "golden";\n');
          fs.writeFileSync(path.join(fixtureAssets, 'assets', 'images', 'logo.png'), 'png-bytes');
          fs.writeFileSync(path.join(fixtureAssets, 'data.bin'), Buffer.from([0, 1, 2, 255]));
          return {
            platform,
            appVersion: '3.2.1',
            runtimeVersion: 'bare-runtime-7',
            bundlePath: fixtureBundle,
            assetsDir: fixtureAssets,
            outputDir: fixtureOutput,
          };
        };

        const legacy = buildLegacyBareArtifact(createBareFixture('legacy'));
        const canonical = buildCanonicalArtifact({
          ...createBareFixture('canonical'),
          assetTraversal: 'legacy-bare',
        });

        expect(canonical.bundleHash).toBe(legacy.bundleHash);
        expect(canonical.jsBundleHash).toBe(legacy.jsBundleHash);
        expect(fs.readFileSync(canonical.metadataPath)).toEqual(fs.readFileSync(legacy.metadataPath));
        expect(fs.readFileSync(canonical.manifestPath)).toEqual(fs.readFileSync(legacy.manifestPath));
        expect(fs.readFileSync(canonical.zipPath)).toEqual(fs.readFileSync(legacy.zipPath));
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(['ios', 'android'] as const)(
    'keeps pre-refactor bare %s traversal byte-equivalent for symlinks and reserved names',
    platform => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-01-02T03:04:06.000Z'));
      try {
        const externalAsset = path.join(root, `external-${platform}.bin`);
        fs.writeFileSync(externalAsset, 'linked-asset');

        const createBareFixture = (name: string): BareArtifactFixture => {
          const fixtureOutput = path.join(root, name);
          const fixtureAssets = path.join(fixtureOutput, 'assets');
          const fixtureBundle = path.join(fixtureOutput, 'main.jsbundle');
          fs.mkdirSync(fixtureAssets, { recursive: true });
          fs.writeFileSync(fixtureBundle, 'global.__bare_bundle = "compatibility";\n');
          fs.symlinkSync(externalAsset, path.join(fixtureAssets, 'linked.bin'));
          fs.writeFileSync(path.join(fixtureAssets, 'main.jsbundle'), 'reserved-main');
          fs.writeFileSync(
            path.join(fixtureAssets, `metadata-${platform}.json`),
            'reserved-metadata',
          );
          fs.writeFileSync(path.join(fixtureAssets, BUNDLE_MANIFEST), 'reserved-manifest');
          if (platform === 'android') {
            fs.writeFileSync(
              path.join(fixtureAssets, 'image-manifest.json'),
              'reserved-image-manifest',
            );
          }
          fs.writeFileSync(path.join(fixtureAssets, 'Logo.png'), 'uppercase');
          fs.writeFileSync(path.join(fixtureAssets, 'logo.png'), 'lowercase');
          return {
            platform,
            appVersion: '3.2.1',
            runtimeVersion: 'bare-runtime-7',
            bundlePath: fixtureBundle,
            assetsDir: fixtureAssets,
            outputDir: fixtureOutput,
          };
        };

        const legacyOptions = createBareFixture(`legacy-compat-${platform}`);
        const canonicalOptions = createBareFixture(`canonical-compat-${platform}`);
        const legacy = buildLegacyBareArtifact(legacyOptions);
        const canonical = buildCanonicalArtifact({
          ...canonicalOptions,
          assetTraversal: 'legacy-bare',
        });

        expect(canonical.bundleHash).toBe(legacy.bundleHash);
        expect(canonical.jsBundleHash).toBe(legacy.jsBundleHash);
        expect(fs.readFileSync(canonical.metadataPath)).toEqual(fs.readFileSync(legacy.metadataPath));
        expect(fs.readFileSync(canonical.manifestPath)).toEqual(fs.readFileSync(legacy.manifestPath));
        expect(fs.readFileSync(canonical.zipPath)).toEqual(fs.readFileSync(legacy.zipPath));
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('keeps case-variant paths distinct in legacy bare traversal on every host filesystem', () => {
    const realAsset = path.join(assetsDir, 'logo.png');
    fs.writeFileSync(realAsset, 'logo');
    const realReaddirSync = fs.readdirSync.bind(fs);
    const realStatSync = fs.statSync.bind(fs);
    const realReadFileSync = fs.readFileSync.bind(fs);
    const assetStat = realStatSync(realAsset);
    const readdirSpy = jest.spyOn(fs, 'readdirSync').mockImplementation(((directory: fs.PathLike) => {
      if (path.resolve(directory.toString()) === path.resolve(assetsDir)) {
        return ['Logo.png', 'logo.png'];
      }
      return realReaddirSync(directory);
    }) as typeof fs.readdirSync);
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(((filePath: fs.PathLike) => {
      if (['Logo.png', 'logo.png'].includes(path.basename(filePath.toString()))) {
        return assetStat;
      }
      return realStatSync(filePath);
    }) as typeof fs.statSync);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(((filePath: fs.PathLike) => {
      if (path.basename(filePath.toString()) === 'Logo.png') return Buffer.from('uppercase');
      if (path.basename(filePath.toString()) === 'logo.png') return Buffer.from('lowercase');
      return realReadFileSync(filePath);
    }) as typeof fs.readFileSync);

    let result: ReturnType<typeof buildCanonicalArtifact> | undefined;
    try {
      result = buildCanonicalArtifact({
        platform: 'ios',
        appVersion: '1.0.0',
        runtimeVersion: 'runtime-1',
        bundlePath,
        assetsDir,
        outputDir,
        assetTraversal: 'legacy-bare',
      });
    } finally {
      readdirSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
    }

    expect(result).toBeDefined();
    const manifest = JSON.parse(fs.readFileSync(result!.manifestPath, 'utf8'));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
      'Logo.png',
      'logo.png',
      'main.jsbundle',
      'metadata-ios.json',
    ]);
  });

  it('normalizes Windows-native separators before canonical path validation', () => {
    expect(normalizeCanonicalAssetPath('assets\\images\\logo.png')).toBe(
      'assets/images/logo.png',
    );
  });

  it.each([
    '..\\outside.png',
    'C:\\outside.png',
    '\\\\server\\share\\outside.png',
  ])('still rejects unsafe Windows asset paths: %s', unsafePath => {
    expect(() => normalizeCanonicalAssetPath(unsafePath)).toThrow();
  });

  it.each([
    ['', 'runtime-1', 'app version'],
    ['1.0.0', '', 'runtime version'],
  ])('rejects missing required identity values', (appVersion, runtimeVersion, message) => {
    expect(() => buildCanonicalArtifact({
      platform: 'ios',
      appVersion,
      runtimeVersion,
      bundlePath,
      assetsDir,
      outputDir,
    })).toThrow(message);
  });

  it('rejects missing exporter outputs', () => {
    fs.unlinkSync(bundlePath);
    expect(() => buildCanonicalArtifact({
      platform: 'ios',
      appVersion: '1.0.0',
      runtimeVersion: 'runtime-1',
      bundlePath,
      assetsDir,
      outputDir,
    })).toThrow('Bundle output missing');

    fs.writeFileSync(bundlePath, 'bundle');
    fs.rmSync(assetsDir, { recursive: true });
    expect(() => buildCanonicalArtifact({
      platform: 'ios',
      appVersion: '1.0.0',
      runtimeVersion: 'runtime-1',
      bundlePath,
      assetsDir,
      outputDir,
    })).toThrow('Assets directory missing');
  });

  it('keeps strict Expo traversal for symlinks and case-insensitive asset collisions', () => {
    const external = path.join(root, 'external.png');
    fs.writeFileSync(external, 'external');
    fs.symlinkSync(external, path.join(assetsDir, 'linked.png'));
    expect(() => buildCanonicalArtifact({
      platform: 'ios', appVersion: '1', runtimeVersion: '1', bundlePath, assetsDir, outputDir,
    })).toThrow('Asset symlinks are not supported');

    fs.unlinkSync(path.join(assetsDir, 'linked.png'));
    fs.writeFileSync(path.join(assetsDir, 'Logo.png'), 'one');
    fs.writeFileSync(path.join(assetsDir, 'logo.png'), 'two');
    const buildWithCollision = () => buildCanonicalArtifact({
      platform: 'ios', appVersion: '1', runtimeVersion: '1', bundlePath, assetsDir, outputDir,
    });
    if (fs.readdirSync(assetsDir).filter(file => file.toLowerCase() === 'logo.png').length === 2) {
      expect(buildWithCollision).toThrow('Asset path collision');
    } else {
      expect(buildWithCollision).not.toThrow();
    }
  });

  it('keeps strict Expo traversal for reserved artifact names', () => {
    fs.writeFileSync(path.join(assetsDir, 'bundle-manifest.json'), '{}');
    expect(() => buildCanonicalArtifact({
      platform: 'ios', appVersion: '1', runtimeVersion: '1', bundlePath, assetsDir, outputDir,
    })).toThrow('Unsafe or reserved asset path');
  });

  it('rejects unsupported filesystem entries in the asset tree', () => {
    fs.writeFileSync(path.join(assetsDir, 'device-entry'), 'not used');
    const lstatSpy = jest.spyOn(fs, 'lstatSync').mockReturnValue({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => false,
    } as fs.Stats);

    try {
      expect(() => buildCanonicalArtifact({
        platform: 'ios', appVersion: '1', runtimeVersion: '1', bundlePath, assetsDir, outputDir,
      })).toThrow('Unsupported asset entry: device-entry');
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('rejects case-insensitive collisions independently of host filesystem casing', () => {
    fs.writeFileSync(path.join(assetsDir, 'logo.png'), 'logo');
    const readdirSpy = jest.spyOn(fs, 'readdirSync').mockReturnValue(
      ['Logo.png', 'logo.png'] as unknown as ReturnType<typeof fs.readdirSync>,
    );

    try {
      expect(() => buildCanonicalArtifact({
        platform: 'ios', appVersion: '1', runtimeVersion: '1', bundlePath, assetsDir, outputDir,
      })).toThrow('Asset path collision: logo.png');
    } finally {
      readdirSpy.mockRestore();
    }
  });
});
