import { config, defaultChannel, platform as devicePlatform } from '../context';
import { BundleInfo, readBundleInfo, writeBundleInfo } from '../bundleInfo';
import {
  deleteCurrentBundlePointer,
  readCurrentBundlePointer,
  readPreviousBundlePointer,
  restorePreviousBundlePointer,
  setCurrentBundlePointer,
  writeCurrentBundlePointer,
  type BundlePointer,
} from '../fs/bundlePointer';
import { installFromZip } from '../install/installFromZip';
import { tryInstallPatchTransport } from '../patch-engine/patchTransport';
import { getDownloadedBundlePathNative } from '../native/bundleDropNative';
import { authorizeRuntimeDeliveryUpdate, checkForUpdate } from './updateCheck';
import { BundleDropError, isInstallPhaseError } from '../errors';
import { isBundleHashFailed, markCandidateActivated } from './rollbackState';
import type { OtaPatchSet, UpdateCheckResponse } from '../api/types';
import { isArtifactCapabilityRejected } from '../runtime-delivery/artifactCapability';

async function restoreCurrentPointer(pointer: BundlePointer | null): Promise<void> {
  if (pointer) {
    await writeCurrentBundlePointer({ ...pointer, updatedAt: new Date().toISOString() });
    return;
  }

  await deleteCurrentBundlePointer();
}

export type DownloadUpdateResult =
  | { status: 'staged'; bundlePath: string; hash: string }
  | { status: 'upToDate'; reason?: string; skippedFailedBundle?: boolean; skippedHash?: string }
  | { status: 'disabled' }
  | { status: 'incompatible' }
  | { status: 'rollback'; reason?: string };

type DownloadOptions = {
  channelName?: string;
  resolvedTarget?: {
    hash: string;
    downloadUrl?: string;
    bundleVersion?: number;
    version?: string;
    runtimeVersion?: string;
    manifestUrl?: string;
    mode?: 'full' | 'patch';
    baseHash?: string;
    patchSet?: OtaPatchSet;
    fallback?: {
      mode: 'full';
      downloadUrl: string;
    };
    runtimeDelivery?: UpdateCheckResponse['runtimeDelivery'];
  };
};

function isSameRuntimeDeliverySelection(
  selected: UpdateCheckResponse,
  refreshed: UpdateCheckResponse | null,
): refreshed is UpdateCheckResponse {
  if (
    !refreshed ||
    refreshed.action !== 'INSTALL' ||
    refreshed.hash !== selected.hash ||
    refreshed.runtimeVersion !== selected.runtimeVersion ||
    !selected.runtimeDelivery ||
    !refreshed.runtimeDelivery
  ) {
    return false;
  }

  const before = selected.runtimeDelivery;
  const after = refreshed.runtimeDelivery;
  return before.generation === after.generation &&
    before.targetReleaseRef === after.targetReleaseRef &&
    before.selectedMode === after.selectedMode &&
    (before.baseHash ?? null) === (after.baseHash ?? null) &&
    (before.patchAlgorithm ?? null) === (after.patchAlgorithm ?? null) &&
    (before.patchSetHash ?? null) === (after.patchSetHash ?? null) &&
    (before.patchArtifactRef ?? null) === (after.patchArtifactRef ?? null) &&
    (before.missingAssetsHash ?? null) === (after.missingAssetsHash ?? null) &&
    (before.manifestHash ?? null) === (after.manifestHash ?? null) &&
    (before.jsBundleHash ?? null) === (after.jsBundleHash ?? null) &&
    (before.fullBundleHash ?? null) === (after.fullBundleHash ?? null);
}

async function downloadAndStageUpdate(
  options?: DownloadOptions,
  onStatusUpdate?: (status: string) => void,
): Promise<DownloadUpdateResult> {
  const { project } = config;
  const channelName = options?.channelName || defaultChannel;
  const platform = devicePlatform;
  const statusCb = onStatusUpdate;
  const resolvedTarget = options?.resolvedTarget;

  // Resolve target via /ota/resolve unless the caller already provided it.
  const unresolvedCheckResult = resolvedTarget
    ? {
      action: 'INSTALL' as const,
      channelName,
      hash: resolvedTarget.hash,
      bundleHash: resolvedTarget.hash,
      downloadUrl: resolvedTarget.downloadUrl,
      bundleVersion: resolvedTarget.bundleVersion,
      version: resolvedTarget.version,
      runtimeVersion: resolvedTarget.runtimeVersion,
      manifestUrl: resolvedTarget.manifestUrl,
      mode: resolvedTarget.mode ?? 'full',
      baseHash: resolvedTarget.baseHash,
      patchSet: resolvedTarget.patchSet,
      fallback: resolvedTarget.fallback,
      runtimeDelivery: resolvedTarget.runtimeDelivery,
    }
    : await checkForUpdate(channelName, statusCb);
  let checkResult = unresolvedCheckResult
    ? await authorizeRuntimeDeliveryUpdate(unresolvedCheckResult)
    : null;

  if (!checkResult) {
    throw new BundleDropError({
      message: 'Failed to resolve update decision',
      code: 'RESOLVE_FAILED',
      step: 'resolve',
      context: { channelName, platform, projectSlug: project.slug },
    });
  }

  if (checkResult.incompatible) {
    statusCb?.('⛔️ No compatible update for this binary');
    return { status: 'incompatible' };
  }

  if (checkResult.action === 'NOOP') {
    statusCb?.(
      checkResult.skippedFailedBundle
        ? '✅ Current bundle retained; requested update previously failed on this device'
        : '✅ You have the latest version',
    );
    return checkResult.skippedFailedBundle
      ? {
          status: 'upToDate',
          reason: checkResult.reason,
          skippedFailedBundle: true,
          skippedHash: checkResult.skippedHash,
        }
      : { status: 'upToDate', reason: checkResult.reason };
  }

  if (checkResult.action === 'ROLLBACK') {
    statusCb?.('↩️ Rollback requested');
    return { status: 'rollback', reason: checkResult.reason };
  }

  const serverHash = checkResult.hash;
  const serverBundleVersion = checkResult.bundleVersion;
  const serverVersion = checkResult.version;
  const serverRuntimeVersion = checkResult.runtimeVersion;
  try {
    if (!serverHash) {
      throw new BundleDropError({
        message: 'Missing bundleHash from ota resolve response',
        code: 'HASH_MISSING',
        step: 'resolve',
        context: { channelName, platform, projectSlug: project.slug },
      });
    }

    const hash = serverHash;
    if (await isBundleHashFailed(hash)) {
      statusCb?.('✅ Current bundle retained; selected update previously failed on this device');
      return {
        status: 'upToDate',
        reason: 'BUNDLE_PREVIOUSLY_FAILED',
        skippedFailedBundle: true,
        skippedHash: hash,
      };
    }

    let installResult;
    let capabilityRefreshAttempted = false;
    let patchFallbackSelected = false;
    while (true) {
      const fullBundleZipUrl = checkResult.mode === 'patch'
        ? checkResult.fallback?.downloadUrl || null
        : checkResult.downloadUrl || null;
      if (!fullBundleZipUrl) {
        throw new BundleDropError({
          message: 'Missing downloadUrl from ota resolve response',
          code: 'DOWNLOAD_URL_MISSING',
          step: 'resolve',
          context: { channelName, platform, projectSlug: project.slug },
        });
      }

      try {
        installResult = patchFallbackSelected ? null : await tryInstallPatchTransport({
          target: {
            mode: checkResult.mode,
            hash,
            manifestUrl: checkResult.manifestUrl,
            baseHash: checkResult.baseHash,
            patchSet: checkResult.patchSet,
            ...(checkResult.runtimeDelivery?.manifestHash
              ? { expectedManifestHash: checkResult.runtimeDelivery.manifestHash }
              : {}),
            ...(checkResult.runtimeDelivery?.jsBundleHash
              ? { expectedJsBundleHash: checkResult.runtimeDelivery.jsBundleHash }
              : {}),
          },
          projectSlug: project.slug,
          platform,
          runtimeVersionValue: serverRuntimeVersion,
          statusCb,
        });

        if (!installResult) {
          patchFallbackSelected = checkResult.mode === 'patch';
          statusCb?.('⬇️ Downloading full bundle ZIP!...');
          installResult = await installFromZip({
            downloadUrl: fullBundleZipUrl,
            hash,
            platform,
            statusCb,
            ...(checkResult.runtimeDelivery?.fullBundleHash
              ? { expectedArchiveHash: checkResult.runtimeDelivery.fullBundleHash }
              : {}),
            ...(checkResult.runtimeDelivery?.manifestHash
              ? { expectedManifestHash: checkResult.runtimeDelivery.manifestHash }
              : {}),
            ...(checkResult.runtimeDelivery?.jsBundleHash
              ? { expectedJsBundleHash: checkResult.runtimeDelivery.jsBundleHash }
              : {}),
          });
        }
        break;
      } catch (e) {
        if (
          !capabilityRefreshAttempted &&
          unresolvedCheckResult.runtimeDelivery &&
          isArtifactCapabilityRejected(e)
        ) {
          capabilityRefreshAttempted = true;
          statusCb?.('🔐 Download authorization expired; refreshing once...');
          const refreshed = await authorizeRuntimeDeliveryUpdate(unresolvedCheckResult);
          if (!isSameRuntimeDeliverySelection(unresolvedCheckResult, refreshed)) {
            throw new BundleDropError({
              message: 'Refreshed download authorization changed update identity',
              code: 'DOWNLOAD_FAILED',
              step: 'download',
              context: { channelName, platform, hash },
              cause: e,
            });
          }
          checkResult = refreshed;
          continue;
        }

        const phaseErr = isInstallPhaseError(e);
        const isDownload = phaseErr && e.phase === 'download';
        throw new BundleDropError({
          message: isDownload ? 'Failed to download update ZIP' : 'Failed to install update ZIP',
          code: isDownload ? 'DOWNLOAD_FAILED' : 'INSTALL_FAILED',
          step: isDownload ? 'download' : 'install',
          context: { channelName, platform, hash },
          cause: phaseErr ? e.originalCause : e,
        });
      }
    }

    const { bundlePath, metadataFromZip } = installResult;

    const installedHash = hash;

    statusCb?.('✅ Update downloaded. Will apply on next launch or when you call applyUpdate().');

    // Persist installed metadata for future skip logic.
    const [previousInfo, previousCurrentPointer, previousRollbackPointer] = await Promise.all([
      readBundleInfo(),
      readCurrentBundlePointer(),
      readPreviousBundlePointer(),
    ]);
    const installedInfo: BundleInfo = {
      bundleVersion: serverBundleVersion ?? metadataFromZip.bundleVersion,
      version: serverVersion ?? metadataFromZip.version,
      hash: installedHash,
      channelName,
      platform,
      installedAt: new Date().toISOString(),
      pendingApply: true,
      runtimeVersion: serverRuntimeVersion ?? metadataFromZip.runtimeVersion,
      lastInstalledReportedHash: previousInfo?.lastInstalledReportedHash,
      installedReportedHashes: previousInfo?.installedReportedHashes,
    };
    await setCurrentBundlePointer(bundlePath, installedHash);
    try {
      const resolvedBundlePath = await getDownloadedBundlePathNative();
      if (resolvedBundlePath !== bundlePath) {
        throw new BundleDropError({
          message: 'Installed bundle was not accepted by the native resolver',
          code: 'INSTALL_FAILED',
          step: 'install',
          context: { channelName, platform, hash, expectedBundlePath: bundlePath, resolvedBundlePath },
        });
      }
    } catch (nativeError) {
      await restoreCurrentPointer(previousCurrentPointer);
      await restorePreviousBundlePointer(previousRollbackPointer);
      if (nativeError instanceof BundleDropError) {
        throw nativeError;
      }
      throw new BundleDropError({
        message: 'Installed bundle was not accepted by the native resolver',
        code: 'INSTALL_FAILED',
        step: 'install',
        context: { channelName, platform, hash },
        cause: nativeError,
      });
    }
    await writeBundleInfo(installedInfo);
    await markCandidateActivated(installedHash);

    return { status: 'staged', bundlePath, hash: installedHash };
  } catch (err) {
    const wrapped =
      err instanceof BundleDropError
        ? err
        : new BundleDropError({
          message: 'OTA update failed',
          code: 'UNKNOWN',
          step: 'install',
          context: { channelName, platform },
          cause: err,
        });

    console.error('❌ OTA update failed:', wrapped);
    statusCb?.(`❌ OTA update failed (${wrapped.code}/${wrapped.step})`);
    throw wrapped;
  }
}

export const downloadUpdate = async (
  options?: DownloadOptions,
  onStatusUpdate?: (status: string) => void,
): Promise<DownloadUpdateResult> => {
  return downloadAndStageUpdate(options, onStatusUpdate);
};

export type InstallBundleOptions = {
  channelName?: string;
  onStatusUpdate?: (status: string) => void;
};

export const installBundle = async (
  hash: string,
  downloadUrl: string,
  bundleVersion?: number,
  version?: string,
  runtimeVersion?: string,
  options?: InstallBundleOptions,
): Promise<DownloadUpdateResult> => {
  return downloadAndStageUpdate(
    {
      channelName: options?.channelName,
      resolvedTarget: { hash, downloadUrl, bundleVersion, version, runtimeVersion },
    },
    options?.onStatusUpdate,
  );
};
