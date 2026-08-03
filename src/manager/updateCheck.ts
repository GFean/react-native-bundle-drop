import type { AxiosResponse } from 'axios';

import { config, platform, runtimeVersion } from '../context';
import { BundleInfo, readBundleInfo } from '../bundleInfo';
import { getPublicChannels, postOtaResolve, getBundleList } from '../api/clientApi';
import type { UpdateCheckResponse, BundleListItem, BundleListResponse } from '../api/types';
import { defaultChannel } from '../context';
import { readCurrentBundlePointer } from '../fs/bundlePointer';
import { getOrCreateInstallId } from '../fs/installId';
import { getCurrentUserProperties } from '../fs/userProperties';
import { getBundleDropRuntimeConfig } from '../runtime/initState';
import { getFailedBundleHashes, isBundleHashFailed } from './rollbackState';
import { getDownloadedBundlePathNative } from '../native/bundleDropNative';
import { advertisedPatchAlgorithms } from '../patch-engine/patchOperations';

function assertInstallDecisionShape(
  decision: Extract<Awaited<ReturnType<typeof postOtaResolve>>['data'], { action: 'INSTALL' }>,
): void {
  const { target } = decision;
  if (!target?.bundleHash) {
    throw new Error('Invalid INSTALL resolve response: target.bundleHash is required');
  }
  if (!target.manifestUrl) {
    throw new Error('Invalid INSTALL resolve response: target.manifestUrl is required');
  }
  if (!target.runtimeVersion) {
    throw new Error('Invalid INSTALL resolve response: target.runtimeVersion is required');
  }

  if (decision.mode === 'full') {
    if (!target.downloadUrl) {
      throw new Error('Invalid INSTALL resolve response: target.downloadUrl is required');
    }
    return;
  }

  if (decision.mode !== 'patch') {
    throw new Error('Invalid INSTALL resolve response: mode must be full or patch');
  }
  if (!decision.baseHash) {
    throw new Error('Invalid INSTALL resolve response: baseHash is required for patch mode');
  }
  if (
    !decision.patchSet?.patchSetHash ||
    !decision.patchSet?.patchesUrl ||
    !decision.patchSet?.algorithm
  ) {
    throw new Error('Invalid INSTALL resolve response: patchSet is incomplete');
  }
  if (decision.fallback?.mode !== 'full' || !decision.fallback.downloadUrl) {
    throw new Error('Invalid INSTALL resolve response: patch mode requires full fallback');
  }
}

export async function getAvailableChannels(): Promise<string[]> {
  const { project } = config;
  if (!project?.slug) {
    throw new Error('Missing project slug in bundle.drop.config.js');
  }

  try {
    const res: AxiosResponse<string[]> = await getPublicChannels({
      projectSlug: project.slug,
    });
    if (!Array.isArray(res.data)) {
      throw new Error('Invalid channel list response');
    }
    return res.data;
  } catch (e) {
    console.warn('⚠️ Failed to fetch available channels:', e?.toString?.() || e);
    throw e;
  }
}

export async function checkForUpdate(
  channelName = defaultChannel,
  onStatusUpdate?: (status: string) => void,
): Promise<UpdateCheckResponse | null> {
  const { project } = config;

  try {
    if (!project?.slug) {
      throw new Error('Missing project slug in bundle.drop.config.js');
    }

    onStatusUpdate?.('🔍 Checking for updates...');

    const [currentPtr, nativeBundlePath, currentUserProperties, installId, rejectedHashes] = await Promise.all([
      readCurrentBundlePointer(),
      getDownloadedBundlePathNative(),
      getCurrentUserProperties(),
      getOrCreateInstallId(),
      getFailedBundleHashes(),
    ]);
    const currentHash = nativeBundlePath && currentPtr?.hash ? currentPtr.hash : null;
    const appEnvironment = getBundleDropRuntimeConfig()?.environment ?? null;
    const supportsXdelta = await import('../native/fs')
      .then(module => module.default.supportsXdelta())
      .catch(() => false);
    const res = await postOtaResolve(project.slug, {
      channelName,
      platform,
      runtimeVersion: runtimeVersion ?? null,
      environment: appEnvironment,
      currentHash,
      currentUserProperties,
      rejectedHashes,
      installId,
      transport: {
        manifestVersion: 1,
        patchAlgorithms: advertisedPatchAlgorithms(supportsXdelta),
        supportsContentAddressedAssets: true,
      },
    });

    const decision = res.data;
    if (decision.action === 'NOOP') {
      const incompatible = decision.reason === 'NO_COMPATIBLE_BUNDLE';
      if (incompatible) {
        onStatusUpdate?.('⛔️ No compatible update for this binary');
      } else {
        onStatusUpdate?.('✅ You have the latest version');
      }
      return {
        action: 'NOOP',
        upToDate: !incompatible,
        channelName,
        reason: decision.reason,
        incompatible: incompatible || undefined,
        requestedRuntimeVersion: decision.requestedRuntimeVersion,
        latestRuntimeVersionOnChannel: decision.latestRuntimeVersionOnChannel,
      };
    }
    if (decision.action === 'ROLLBACK') {
      onStatusUpdate?.('↩️ Rollback requested');
      return { action: 'ROLLBACK', channelName, reason: decision.reason };
    }

    assertInstallDecisionShape(decision);

    // INSTALL
    const targetHash = decision.target.bundleHash;
    if (await isBundleHashFailed(targetHash)) {
      onStatusUpdate?.('✅ Current bundle retained; latest update previously failed on this device');
      return {
        action: 'NOOP',
        upToDate: false,
        channelName,
        reason: 'BUNDLE_PREVIOUSLY_FAILED',
        skippedFailedBundle: true,
        skippedHash: targetHash,
      };
    }

    onStatusUpdate?.('⬇️ Update available');
    return {
      action: 'INSTALL',
      upToDate: false,
      channelName,
      hash: targetHash,
      bundleHash: targetHash,
      mode: decision.mode,
      baseHash: decision.mode === 'patch' ? decision.baseHash : undefined,
      patchSet: decision.mode === 'patch' ? decision.patchSet : undefined,
      fallback: decision.mode === 'patch' ? decision.fallback : undefined,
      downloadUrl: decision.target.downloadUrl,
      manifestUrl: decision.target.manifestUrl,
      bundleVersion: decision.target.bundleVersion,
      version: decision.target.version,
      runtimeVersion: decision.target.runtimeVersion,
    };
  } catch (e) {
    console.warn('⚠️ checkForUpdate failed:', e?.toString?.() || e);
    return null;
  }
}

export async function getInstalledBundleInfo(): Promise<BundleInfo | null> {
  return readBundleInfo();
}

/**
 * Query options for browsing downloadable bundles from a public channel.
 */
export type GetAvailableBundlesOptions = {
  /** Channel to browse. Defaults to the active runtime channel. */
  channelName?: string;
  /** Override platform when browsing bundles outside the current device platform. */
  platform?: string;
  /** Maximum number of items to return in this page. */
  limit?: number;
  /** Cursor returned by a previous page response. */
  cursor?: string;
};

/**
 * One page of public bundle-list results.
 */
export type AvailableBundlesPage = {
  /** Bundles available on the requested channel/page. */
  items: BundleListItem[];
  /** Cursor for the next page, or `null` when there is no next page. */
  nextCursor: string | null;
  /** `true` when another page can be fetched with `nextCursor`. */
  hasMore: boolean;
};

export async function getAvailableBundles(
  options?: GetAvailableBundlesOptions,
): Promise<AvailableBundlesPage> {
  const { project } = config;
  if (!project?.slug) {
    throw new Error('Missing project slug in bundle.drop.config.js');
  }

  const channelName = options?.channelName || defaultChannel;
  const res = await getBundleList(project.slug, {
    channelName,
    platform: options?.platform || platform,
    limit: options?.limit,
    cursor: options?.cursor,
  });

  return res.data;
}
