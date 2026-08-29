import RNFS from '../native/fs';

import { BUNDLE_DROP_ROOT, platform as devicePlatform } from '../context';
import { ensureDir } from '../fs/fsUtils';
import { readCurrentBundleHash } from '../fs/bundlePointer';
import { InstallPhaseError, isInstallPhaseError } from '../errors';
import {
  BUNDLE_MANIFEST,
  BundleManifestFile,
  BundleManifest,
  assertValidBundleManifest,
  normalizeManifestPath,
} from '../manifest/bundleManifest';
import {
  readJsonFile,
  readValidatedBundleManifestFromDir,
  verifyBundleDir,
} from '../install/bundleVerification';
import {
  InstallResult,
  assertCanonicalBundleHash,
  finalizeInstall,
} from '../install/bundleInstallShared';
import {
  applyPatchOperation,
  resolvePatchOperation,
  SupportedPatchAlgorithm,
} from './patchOperations';

type InstallFromPatchSetParams = {
  patchesUrl: string;
  patchSetHash: string;
  manifestUrl?: string | null;
  missingAssetsUrl?: string | null;
  missingAssetsHash?: string | null;
  baseHash: string;
  targetHash: string;
  algorithm: SupportedPatchAlgorithm;
  platform?: 'ios' | 'android';
  statusCb?: (status: string) => void;
  expectedManifestHash?: string;
  expectedJsBundleHash?: string;
};

const reconstructPatchTarget = async (
  baseDir: string,
  baseHash: string,
  platform: 'ios' | 'android',
  patchDir: string,
  targetDir: string,
  targetManifest: BundleManifest,
  algorithm: SupportedPatchAlgorithm,
) => {
  const baseManifest = await readValidatedBundleManifestFromDir(baseDir, baseHash, platform);
  if (!baseManifest) {
    throw new Error('Base bundle manifest is missing');
  }
  const baseFilesByPath = new Map(
    baseManifest.files.map(file => [normalizeManifestPath(file.path), file]),
  );

  for (const file of targetManifest.files) {
    const operation = await resolvePatchOperation({
      baseDir,
      patchDir,
      targetDir,
      targetFile: file,
      baseFilesByPath,
      algorithm,
    });
    await applyPatchOperation(operation);
  }
};

export async function installFromPatchSet(params: InstallFromPatchSetParams): Promise<InstallResult> {
  const {
    patchesUrl,
    patchSetHash,
    manifestUrl,
    missingAssetsUrl,
    missingAssetsHash,
    baseHash,
    targetHash,
    algorithm,
    statusCb,
    platform = devicePlatform,
    expectedManifestHash,
    expectedJsBundleHash,
  } = params;
  assertCanonicalBundleHash(baseHash, 'base hash');
  assertCanonicalBundleHash(targetHash, 'target hash');

  const currentHash = await readCurrentBundleHash();
  if (currentHash !== baseHash) {
    throw new InstallPhaseError('install', new Error('Patch base hash does not match current bundle'));
  }

  const baseDir = `${BUNDLE_DROP_ROOT}/bundles/${baseHash}`;
  const patchDir = `${BUNDLE_DROP_ROOT}/bundles/_patch_${targetHash}`;
  const targetTempDir = `${BUNDLE_DROP_ROOT}/bundles/_patch_target_${targetHash}`;
  const tempZipPath = `${BUNDLE_DROP_ROOT}/bundles/_patch_${targetHash}.zip`;
  let targetManifest: BundleManifest;

  try {
    try { await RNFS.unlink(patchDir); } catch { /* best-effort cleanup */ }
    try { await RNFS.unlink(targetTempDir); } catch { /* best-effort cleanup */ }
    await ensureDir(patchDir);
    await ensureDir(targetTempDir);

    try {
      await RNFS.downloadFile(patchesUrl, tempZipPath);
    } catch (e) {
      throw new InstallPhaseError('download', e);
    }
    const actualPatchSetHash = await RNFS.sha256File(tempZipPath);
    if (actualPatchSetHash !== patchSetHash) {
      throw new InstallPhaseError('install', new Error('Patch set hash mismatch'));
    }

    let patchFileNames: string[];
    try {
      patchFileNames = await RNFS.unzip(tempZipPath, patchDir);
    } catch (e) {
      throw new InstallPhaseError('install', e);
    }

    if (!patchFileNames.includes(BUNDLE_MANIFEST)) {
      if (!manifestUrl) {
        throw new InstallPhaseError('install', new Error('Patch set missing target manifest'));
      }
      try {
        await RNFS.downloadFile(manifestUrl, `${patchDir}/${BUNDLE_MANIFEST}`);
        patchFileNames.push(BUNDLE_MANIFEST);
      } catch (e) {
        throw new InstallPhaseError('download', e);
      }
    }

    if (missingAssetsUrl) {
      if (!missingAssetsHash) {
        throw new InstallPhaseError(
          'install',
          new Error('Missing assets archive hash is required'),
        );
      }
      const assetsZipPath = `${BUNDLE_DROP_ROOT}/bundles/_patch_assets_${targetHash}.zip`;
      try {
        try {
          await RNFS.downloadFile(missingAssetsUrl, assetsZipPath);
        } catch (e) {
          throw new InstallPhaseError('download', e);
        }
        if ((await RNFS.sha256File(assetsZipPath)) !== missingAssetsHash) {
          throw new Error('Missing assets archive hash mismatch');
        }
        await RNFS.unzip(assetsZipPath, `${patchDir}/missing-assets`);
      } catch (e) {
        throw isInstallPhaseError(e) ? e : new InstallPhaseError('install', e);
      } finally {
        try { await RNFS.unlink(assetsZipPath); } catch { /* best-effort cleanup */ }
      }
    }

    try {
      targetManifest = await readJsonFile<BundleManifest>(`${patchDir}/${BUNDLE_MANIFEST}`);
      assertValidBundleManifest(targetManifest, targetHash, platform);
      if (expectedManifestHash && targetManifest.manifestHash !== expectedManifestHash) {
        throw new Error('Signed manifest hash does not match patch target manifest');
      }
      if (expectedJsBundleHash && targetManifest.jsBundleHash !== expectedJsBundleHash) {
        throw new Error('Signed JavaScript bundle hash does not match patch target manifest');
      }
      await reconstructPatchTarget(baseDir, baseHash, platform, patchDir, targetTempDir, targetManifest, algorithm);
      await RNFS.writeFile(
        `${targetTempDir}/${BUNDLE_MANIFEST}`,
        JSON.stringify(targetManifest, null, 2),
        'utf8',
      );
      await verifyBundleDir(targetTempDir, targetHash, platform);
    } catch (e) {
      throw new InstallPhaseError('install', e);
    }

    statusCb?.('🧩 Patch reconstructed and verified');
    const fileNames = targetManifest.files.map((file: BundleManifestFile) => normalizeManifestPath(file.path));
    if (!fileNames.includes(BUNDLE_MANIFEST)) {
      fileNames.push(BUNDLE_MANIFEST);
    }
    return await finalizeInstall(targetTempDir, fileNames, targetHash, platform, statusCb);
  } catch (e) {
    try { await RNFS.unlink(targetTempDir); } catch { /* best-effort cleanup */ }
    throw e;
  } finally {
    try { await RNFS.unlink(tempZipPath); } catch { /* best-effort cleanup */ }
    try { await RNFS.unlink(patchDir); } catch { /* best-effort cleanup */ }
  }
}
