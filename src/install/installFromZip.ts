import RNFS from '../native/fs';

import { BUNDLE_DROP_ROOT, platform as devicePlatform } from '../context';
import { ensureDir } from '../fs/fsUtils';
import { InstallPhaseError } from '../errors';
import {
  BUNDLE_MANIFEST,
  BundleManifest,
} from '../manifest/bundleManifest';
import { verifyBundleDir } from './bundleVerification';
import {
  InstallResult,
  assertCanonicalBundleHash,
  finalizeInstall,
} from './bundleInstallShared';

type InstallFromZipParams = {
  downloadUrl: string;
  hash?: string;
  platform?: 'ios' | 'android';
  statusCb?: (status: string) => void;
};

export async function installFromZip(params: InstallFromZipParams): Promise<InstallResult> {
  const { downloadUrl, hash, statusCb, platform = devicePlatform } = params;

  if (!hash) {
    throw new Error('Missing bundle hash');
  }
  assertCanonicalBundleHash(hash);

  const tempDir = `${BUNDLE_DROP_ROOT}/bundles/_tmp_${hash}`;
  const tempZipPath = `${BUNDLE_DROP_ROOT}/bundles/_tmp_${hash}.zip`;

  let fileNames: string[];
  let verifiedHash = hash;
  try {
    try { await RNFS.unlink(tempDir); } catch { /* best-effort cleanup */ }
    await ensureDir(tempDir);

    try {
      await RNFS.downloadFile(downloadUrl, tempZipPath);
    } catch (e) {
      throw new InstallPhaseError('download', e);
    }

    try {
      fileNames = await RNFS.unzip(tempZipPath, tempDir);
    } catch (e) {
      throw new InstallPhaseError('install', e);
    }

    if (!(await RNFS.exists(`${tempDir}/main.jsbundle`))) {
      throw new InstallPhaseError(
        'install',
        new Error('main.jsbundle missing after extraction'),
      );
    }

    try {
      const manifest: BundleManifest | null = await verifyBundleDir(tempDir, hash, platform);
      if (!manifest) {
        throw new Error('Bundle manifest is missing');
      }
      verifiedHash = manifest.bundleHash;
    } catch (e) {
      throw new InstallPhaseError('install', e);
    }
  } catch (e) {
    try { await RNFS.unlink(tempDir); } catch { /* best-effort cleanup */ }
    throw e;
  } finally {
    try { await RNFS.unlink(tempZipPath); } catch { /* best-effort cleanup */ }
  }

  try {
    const fileNamesWithManifest = fileNames.includes(BUNDLE_MANIFEST)
      ? fileNames
      : [...fileNames, BUNDLE_MANIFEST];
    return await finalizeInstall(tempDir, fileNamesWithManifest, verifiedHash, platform, statusCb);
  } catch (e) {
    try { await RNFS.unlink(tempDir); } catch { /* best-effort cleanup */ }
    throw e;
  }
}
