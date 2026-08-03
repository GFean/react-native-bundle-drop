import RNFS from '../native/fs';

import { BUNDLE_DROP_ROOT } from '../context';
import { BundleInfo } from '../bundleInfo';
import { readCurrentBundlePointer } from '../fs/bundlePointer';
import { ensureDir } from '../fs/fsUtils';
import { InstallPhaseError } from '../errors';
import {
  BUNDLE_MANIFEST,
  BundleManifest,
} from '../manifest/bundleManifest';
import { readJsonFile, verifyBundleDir } from './bundleVerification';

export const assertCanonicalBundleHash = (hash: string, label = 'bundle hash') => {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Invalid ${label}: expected 64 lowercase hex characters`);
  }
};

export type InstallResult = {
  bundlePath: string;
  metadataFromZip: Partial<BundleInfo>;
};

export const ensureParentDir = async (path: string) => {
  const lastSlash = path.lastIndexOf('/');
  /* istanbul ignore if -- patch reconstruction writes absolute bundle paths. */
  if (lastSlash <= 0) return;
  await ensureDir(path.slice(0, lastSlash));
};

const ensureMainBundleExists = async (dir: string) => {
  if (!(await RNFS.exists(`${dir}/main.jsbundle`))) {
    throw new InstallPhaseError(
      'install',
      new Error('main.jsbundle missing after promotion'),
    );
  }
};

const metadataFileForPlatform = (platform: 'ios' | 'android') =>
  platform === 'android' ? 'metadata-android.json' : 'metadata-ios.json';

const parseMetadataFromDir = async (
  bundleDir: string,
  fileNames: string[],
  platform: 'ios' | 'android',
): Promise<Partial<BundleInfo>> => {
  const metadataFromZip: Partial<BundleInfo> = {};
  const metadataFile = metadataFileForPlatform(platform);

  if (fileNames.includes(BUNDLE_MANIFEST)) {
    const manifest = await readJsonFile<BundleManifest>(`${bundleDir}/${BUNDLE_MANIFEST}`);
    metadataFromZip.hash = manifest.bundleHash;
    metadataFromZip.runtimeVersion = manifest.runtimeVersion;
    metadataFromZip.version = manifest.version;
  }

  if (fileNames.includes(metadataFile)) {
    try {
      const parsed = await readJsonFile<Record<string, unknown>>(`${bundleDir}/${metadataFile}`);
      if (typeof parsed.bundleVersion === 'number') {
        metadataFromZip.bundleVersion = parsed.bundleVersion;
      }
      if (typeof parsed.version === 'string') {
        metadataFromZip.version = parsed.version;
      }
      if (typeof parsed.runtimeVersion === 'string') {
        metadataFromZip.runtimeVersion = parsed.runtimeVersion;
      }
    } catch (e) {
      console.warn('⚠️ Failed to parse bundle metadata from zip', e);
    }
  }

  return metadataFromZip;
};

export const finalizeInstall = async (
  verifiedTempDir: string,
  fileNames: string[],
  hash: string,
  platform: 'ios' | 'android',
  statusCb?: (status: string) => void,
): Promise<InstallResult> => {
  const bundleDir = `${BUNDLE_DROP_ROOT}/bundles/${hash}`;
  const bundlePath = `${bundleDir}/main.jsbundle`;
  if (await RNFS.exists(bundleDir)) {
    let existingManifest: BundleManifest | null = null;
    try {
      existingManifest = await verifyBundleDir(bundleDir, hash, platform);
    } catch (e) {
      const currentPointer = await readCurrentBundlePointer();
      if (currentPointer?.hash === hash) {
        throw new Error('Active bundle folder failed verification');
      }
    }
    if (existingManifest) {
      await ensureMainBundleExists(bundleDir);
      const metadataFromZip = await parseMetadataFromDir(bundleDir, fileNames, platform);
      try { await RNFS.unlink(verifiedTempDir); } catch { /* best-effort cleanup */ }
      return { bundlePath, metadataFromZip };
    }

    const currentPointer = await readCurrentBundlePointer();
    if (currentPointer?.hash === hash) {
      throw new Error('Active bundle folder failed verification');
    }
    await RNFS.unlink(bundleDir);
  }
  await RNFS.moveFile(verifiedTempDir, bundleDir);

  await ensureMainBundleExists(bundleDir);

  statusCb?.(`📁 ${fileNames.length} files extracted`);
  const metadataFromZip = await parseMetadataFromDir(bundleDir, fileNames, platform);
  return { bundlePath, metadataFromZip };
};
