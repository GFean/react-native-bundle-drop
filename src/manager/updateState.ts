import { getDownloadedBundlePathNative, restartReactNativeNative } from '../native/bundleDropNative';
import { BundleInfo, readBundleInfo, updateBundleInfo } from '../bundleInfo';
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

export const reconcileAppliedBundleOnLaunch = async (cached?: {
  bundleInfo?: BundleInfo | null;
  bundlePath?: string | null;
}) => {
  const state = await getUpdateState(cached);
  if (!state.hasBundle) return;

  if (!state.info?.pendingApply) {
    reportInstalledIfReady(state).catch(() => {});
    return;
  }

  await updateBundleInfo({ pendingApply: false, installedAt: new Date().toISOString() });
  // Fire-and-forget: don't block the startup path for server reporting
  reportInstalledIfReady({
    hasBundle: true,
    info: state.info ? { ...state.info, pendingApply: false } : state.info,
  }).catch(() => {});
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
