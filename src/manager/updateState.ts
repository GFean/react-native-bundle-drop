import { getDownloadedBundlePathNative, restartReactNativeNative } from '../native/bundleDropNative';
import {
  BundleInfo,
  deleteBundleInfo,
  readBundleInfo,
  updateBundleInfo,
  writeBundleInfoDurably,
} from '../bundleInfo';
import RNFS from '../native/fs';
import { platform } from '../context';
import { readJsonFile, verifyBundleDir } from '../install/bundleVerification';
import { reportInstalledIfReady } from './reporting';
import { BundleDropError } from '../errors';
import { isBundleHashFailed } from './rollbackState';

export type ApplyUpdateResult =
  | { status: 'applied' }
  | { status: 'noBundle' }
  | { status: 'disabled' }
  | { status: 'alreadyApplied' }
  | { status: 'blocked'; reason: 'BUNDLE_PREVIOUSLY_FAILED'; skippedHash?: string };

export const getUpdateState = async (cached?: {
  bundleInfo?: BundleInfo | null;
  bundlePath?: string | null;
}) => {
  const info = cached?.bundleInfo !== undefined ? cached.bundleInfo : await readBundleInfo();
  const path = cached?.bundlePath !== undefined ? cached.bundlePath : await getDownloadedBundlePathNative();
  const pendingApply = !!path && (info?.pendingApply ?? false);
  return {
    hasBundle: !!path,
    info,
    pendingApply,
  };
};

async function readRecoveredBundleInfo(
  bundlePath: string,
  hash: string,
  previousInfo: BundleInfo | null,
): Promise<BundleInfo> {
  const bundleDir = bundlePath.slice(0, bundlePath.lastIndexOf('/'));
  const manifest = await verifyBundleDir(bundleDir, hash, platform);
  const metadataPath = `${bundleDir}/${
    platform === 'android' ? 'metadata-android.json' : 'metadata-ios.json'
  }`;
  const metadata = await RNFS.exists(metadataPath)
    ? await readJsonFile<Record<string, unknown>>(metadataPath)
    : null;
  const bundleVersion = typeof metadata?.bundleVersion === 'number'
    ? metadata.bundleVersion
    : undefined;
  const metadataVersion = typeof metadata?.version === 'string' ? metadata.version : undefined;
  const metadataRuntimeVersion = typeof metadata?.runtimeVersion === 'string'
    ? metadata.runtimeVersion
    : undefined;
  const alreadyReported = previousInfo?.installedReportedHashes?.includes(hash) === true;

  return {
    hash,
    bundleVersion,
    version: manifest?.version ?? metadataVersion,
    runtimeVersion: manifest?.runtimeVersion ?? metadataRuntimeVersion,
    platform,
    installedAt: new Date().toISOString(),
    pendingApply: false,
    lastInstalledReportedHash: alreadyReported ? hash : undefined,
    installedReportedHashes: previousInfo?.installedReportedHashes,
  };
}

export const reconcileAppliedBundleOnLaunch = async (cached?: {
  bundleInfo?: BundleInfo | null;
  bundlePath?: string | null;
  currentHash?: string | null;
}): Promise<BundleInfo | null> => {
  const bundlePath = cached?.bundlePath !== undefined
    ? cached.bundlePath
    : await getDownloadedBundlePathNative();
  const state = await getUpdateState({ ...cached, bundlePath });
  if (!state.hasBundle) {
    if (state.info) {
      await deleteBundleInfo();
    }
    return null;
  }

  const currentHash = cached?.currentHash;
  if (currentHash && state.info?.hash !== currentHash) {
    const recoveredInfo = await readRecoveredBundleInfo(
      bundlePath as string,
      currentHash,
      state.info,
    );
    await writeBundleInfoDurably(recoveredInfo);
    reportInstalledIfReady({ hasBundle: true, info: recoveredInfo }).catch(() => {});
    return recoveredInfo;
  }

  if (!state.info?.pendingApply) {
    reportInstalledIfReady(state).catch(() => {});
    return state.info || null;
  }

  const appliedInfo = {
    ...state.info,
    pendingApply: false,
    installedAt: new Date().toISOString(),
  };
  await updateBundleInfo(appliedInfo);
  // Fire-and-forget: don't block the startup path for server reporting
  reportInstalledIfReady({
    hasBundle: true,
    info: appliedInfo,
  }).catch(() => {});
  return appliedInfo;
};

export const applyUpdate = async (
  onStatusUpdate?: (status: string) => void,
  onBeforeRestart?: () => void,
): Promise<ApplyUpdateResult> => {
  try {
    const info = await readBundleInfo();
    const path = await getDownloadedBundlePathNative();

    if (!path) {
      onStatusUpdate?.('⚠️ No downloaded bundle to apply');
      return { status: 'noBundle' };
    }

    if (info?.pendingApply === false) {
      onStatusUpdate?.('ℹ️ Bundle already applied');
      return { status: 'alreadyApplied' };
    }

    if (await isBundleHashFailed(info?.hash)) {
      onStatusUpdate?.('⚠️ Update previously failed on this device');
      return {
        status: 'blocked',
        reason: 'BUNDLE_PREVIOUSLY_FAILED',
        skippedHash: info?.hash,
      };
    }

    onStatusUpdate?.('♻️ Applying downloaded bundle...');
    await updateBundleInfo({ pendingApply: false, installedAt: new Date().toISOString() });

    onBeforeRestart?.();
    restartReactNativeNative();
    return { status: 'applied' };
  } catch (e) {
    throw new BundleDropError({
      message: 'Failed to apply update',
      code: 'APPLY_FAILED',
      step: 'apply',
      cause: e,
    });
  }
};
