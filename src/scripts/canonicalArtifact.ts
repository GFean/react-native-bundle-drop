import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  BUNDLE_MANIFEST,
  BundleManifestFile,
  calculateBundleHash,
  createBundleManifest,
  normalizeManifestPath,
} from '../manifest/bundleManifest';

export type CanonicalArtifactPlatform = 'ios' | 'android';
export type CanonicalAssetTraversal = 'strict' | 'legacy-bare';

export type BuildCanonicalArtifactOptions = {
  platform: CanonicalArtifactPlatform;
  appVersion: string;
  runtimeVersion: string;
  bundlePath: string;
  assetsDir: string;
  outputDir: string;
  sourceMapPath?: string;
  assetTraversal?: CanonicalAssetTraversal;
};

export type CanonicalArtifact = {
  outputDir: string;
  bundlePath: string;
  sourceMapPath?: string;
  metadataPath: string;
  zipPath: string;
  runtimeVersion: string;
  hash: string;
  bundleHash: string;
  jsBundleHash: string;
  manifestPath: string;
};

const sha256Buffer = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

const manifestRoleForPath = (filePath: string): BundleManifestFile['role'] => {
  if (filePath === 'main.jsbundle') return 'jsbundle';
  if (filePath.startsWith('metadata-')) return 'metadata';
  if (filePath === 'image-manifest.json') return 'androidImageManifest';
  return 'asset';
};

const createFileEntry = (filePath: string, buffer: Buffer): BundleManifestFile => ({
  path: normalizeManifestPath(filePath),
  size: buffer.length,
  sha256: sha256Buffer(buffer),
  role: manifestRoleForPath(normalizeManifestPath(filePath)),
});

export const normalizeCanonicalAssetPath = (relativePath: string): string => {
  const nativeSeparatorsNormalized = relativePath.replace(/\\/g, '/');
  const normalized = normalizeManifestPath(nativeSeparatorsNormalized);
  if (
    !normalized ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    normalized.split('/').includes('..') ||
    normalized === BUNDLE_MANIFEST ||
    normalized === 'main.jsbundle' ||
    normalized === 'image-manifest.json' ||
    normalized.startsWith('metadata-')
  ) {
    throw new Error(`Unsafe or reserved asset path: ${relativePath}`);
  }
  return normalized;
};

const collectStrictAssets = (assetsDir: string): Array<[string, Buffer]> => {
  const assets: Array<[string, Buffer]> = [];
  const seenCaseInsensitive = new Set<string>();

  const visit = (directory: string) => {
    for (const item of fs.readdirSync(directory)) {
      const fullPath = path.join(directory, item);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Asset symlinks are not supported: ${path.relative(assetsDir, fullPath)}`);
      }
      if (stat.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Unsupported asset entry: ${path.relative(assetsDir, fullPath)}`);
      }

      const relativePath = normalizeCanonicalAssetPath(path.relative(assetsDir, fullPath));
      const collisionKey = relativePath.toLocaleLowerCase('en-US');
      if (seenCaseInsensitive.has(collisionKey)) {
        throw new Error(`Asset path collision: ${relativePath}`);
      }
      seenCaseInsensitive.add(collisionKey);
      assets.push([relativePath, fs.readFileSync(fullPath)]);
    }
  };

  visit(assetsDir);
  return assets;
};

/**
 * Bare React Native bundling historically followed symlinks and keyed assets by
 * their exact relative path. Keep that traversal intact for existing bare apps;
 * Expo exports use the strict collector above.
 */
const collectLegacyBareAssets = (assetsDir: string): Array<[string, Buffer]> => {
  const assets: Array<[string, Buffer]> = [];

  const visit = (directory: string) => {
    for (const item of fs.readdirSync(directory)) {
      const fullPath = path.join(directory, item);
      if (fs.statSync(fullPath).isDirectory()) {
        visit(fullPath);
        continue;
      }

      const relativePath = normalizeManifestPath(path.relative(assetsDir, fullPath));
      assets.push([relativePath, fs.readFileSync(fullPath)]);
    }
  };

  visit(assetsDir);
  return assets;
};

/**
 * Normalizes a framework exporter result into Bundle Drop's frozen manifest and
 * ZIP roles. Framework-specific export commands must finish before this runs.
 */
export function buildCanonicalArtifact(
  options: BuildCanonicalArtifactOptions,
): CanonicalArtifact {
  const {
    platform,
    appVersion,
    runtimeVersion,
    bundlePath,
    assetsDir,
    outputDir,
    sourceMapPath,
    assetTraversal = 'strict',
  } = options;

  if (!appVersion.trim()) throw new Error('Canonical artifact requires an app version');
  if (!runtimeVersion.trim()) throw new Error('Canonical artifact requires a runtime version');
  if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isFile()) {
    throw new Error(`Bundle output missing after bundling: ${bundlePath}`);
  }
  if (!fs.existsSync(assetsDir) || !fs.statSync(assetsDir).isDirectory()) {
    throw new Error(`Assets directory missing after bundling: ${assetsDir}`);
  }

  const fileSuffix = platform;
  const metadataPath = path.join(outputDir, `metadata-${fileSuffix}.json`);
  const manifestPath = path.join(outputDir, BUNDLE_MANIFEST);
  const zipPath = path.join(outputDir, `bundle-${platform}.zip`);
  const bundleBuffer = fs.readFileSync(bundlePath);
  const jsBundleHash = sha256Buffer(bundleBuffer);
  const metadata = {
    platform,
    jsBundleHash,
    bundlePath: 'main.jsbundle',
    sizeInBytes: bundleBuffer.length,
    runtimeVersion,
  };
  const metadataBuffer = Buffer.from(JSON.stringify(metadata, null, 2));
  const stagedFiles = new Map<string, Buffer>([
    ['main.jsbundle', bundleBuffer],
    [`metadata-${fileSuffix}.json`, metadataBuffer],
  ]);
  const imageManifest: Record<string, string> = {};

  const assets = assetTraversal === 'legacy-bare'
    ? collectLegacyBareAssets(assetsDir)
    : collectStrictAssets(assetsDir);
  for (const [assetPath, buffer] of assets) {
    stagedFiles.set(assetPath, buffer);
    if (platform === 'android') {
      imageManifest[assetPath.replace(/^assets\//, '')] = assetPath;
    }
  }

  if (platform === 'android') {
    stagedFiles.set('image-manifest.json', Buffer.from(JSON.stringify(imageManifest, null, 2)));
    console.log(`🧩 Injected image-manifest.json with ${Object.keys(imageManifest).length} entries`);
  }

  const files = [...stagedFiles.entries()].map(([filePath, buffer]) =>
    createFileEntry(filePath, buffer),
  );
  const bundleHash = calculateBundleHash(files);
  const manifest = createBundleManifest({
    bundleHash,
    jsBundleHash,
    platform,
    runtimeVersion,
    version: appVersion,
    files,
  });
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
  stagedFiles.set(BUNDLE_MANIFEST, manifestBuffer);

  fs.writeFileSync(metadataPath, metadataBuffer);
  fs.writeFileSync(manifestPath, manifestBuffer);

  console.log('🧠 Metadata saved');
  console.log('📌 Bundle Hash:', bundleHash);
  console.log('📌 JS Bundle Hash:', jsBundleHash);
  console.log('📦 Zipping bundle...');
  const zip = new AdmZip();
  for (const [filePath, buffer] of stagedFiles.entries()) {
    zip.addFile(filePath, buffer);
  }
  zip.writeZip(zipPath);
  console.log('✅ OTA bundle zipped');

  return {
    outputDir,
    bundlePath,
    sourceMapPath,
    metadataPath,
    zipPath,
    runtimeVersion,
    hash: bundleHash,
    bundleHash,
    jsBundleHash,
    manifestPath,
  };
}
