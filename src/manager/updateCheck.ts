import type { AxiosResponse } from 'axios';

import { config, platform, runtimeVersion } from '../context';
import { BundleInfo, readBundleInfo } from '../bundleInfo';
import {
  getPublicChannels,
  postOtaArtifactAuthorization,
  postOtaResolve,
  getBundleList,
} from '../api/clientApi';
import type {
  UpdateCheckResponse,
  BundleListItem,
  BundleListResponse,
  OtaResolveResponse,
} from '../api/types';
import { defaultChannel } from '../context';
import { readCurrentBundlePointer } from '../fs/bundlePointer';
import { getOrCreateInstallId } from '../fs/installId';
import { getCurrentUserProperties } from '../fs/userProperties';
import { getBundleDropRuntimeConfig } from '../runtime/initState';
import { getFailedBundleHashes, isBundleHashFailed } from './rollbackState';
import { getDownloadedBundlePathNative } from '../native/bundleDropNative';
import { advertisedPatchAlgorithms } from '../patch-engine/patchOperations';
import {
  fetchRuntimeDeliveryManifest,
  reportActiveInstall,
  resolveFromRuntimeDeliveryManifest,
  shouldRollbackFromLastKnownRevocations,
  type RuntimeDeliveryResolveContext,
} from '../runtime-delivery/runtimeDelivery';
import { recordRuntimeDeliveryDiagnostic } from '../runtime-delivery/diagnostics';
import { RuntimeDeliveryManifestError } from '../runtime-delivery/manifestVerifier';
import { isRuntimeDeliveryConfigured } from '../loadConfig';

const ACTIVE_INSTALL_HEARTBEAT_VERSION = 1 as const;

type ServerResolveOptions = {
  activeInstallHeartbeatVersion?: typeof ACTIVE_INSTALL_HEARTBEAT_VERSION;
};

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

async function readResolveContext(channelName: string): Promise<RuntimeDeliveryResolveContext> {
  const [currentPtr, nativeBundlePath, userProperties, installId, rejectedHashes] = await Promise.all([
    readCurrentBundlePointer(),
    getDownloadedBundlePathNative(),
    getCurrentUserProperties(),
    getOrCreateInstallId(),
    getFailedBundleHashes(),
  ]);
  const supportsXdelta = await import('../native/fs')
    .then(module => module.default.supportsXdelta())
    .catch(() => false);
  return {
    channelName,
    currentHash: nativeBundlePath && currentPtr?.hash ? currentPtr.hash : null,
    rejectedHashes,
    installId,
    patchAlgorithms: advertisedPatchAlgorithms(supportsXdelta),
    supportsContentAddressedAssets: true,
    environment: getBundleDropRuntimeConfig()?.environment ?? null,
    userProperties,
  };
}

async function mapServerDecision(
  decision: OtaResolveResponse,
  channelName: string,
  onStatusUpdate?: (status: string) => void,
): Promise<UpdateCheckResponse> {
  if (decision.action === 'NOOP') {
    const incompatible = decision.reason === 'NO_COMPATIBLE_BUNDLE';
    onStatusUpdate?.(incompatible
      ? '⛔️ No compatible update for this binary'
      : '✅ You have the latest version');
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
}

async function resolveWithServer(
  context: RuntimeDeliveryResolveContext,
  onStatusUpdate?: (status: string) => void,
  options: ServerResolveOptions = {},
): Promise<UpdateCheckResponse> {
  const response = await postOtaResolve(config.project.slug, {
    channelName: context.channelName,
    platform,
    runtimeVersion: runtimeVersion ?? null,
    environment: context.environment,
    currentHash: context.currentHash,
    currentUserProperties: context.userProperties,
    rejectedHashes: context.rejectedHashes,
    installId: context.installId,
    transport: {
      manifestVersion: 1,
      patchAlgorithms: context.patchAlgorithms,
      supportsContentAddressedAssets: context.supportsContentAddressedAssets,
      ...(options.activeInstallHeartbeatVersion
        ? { activeInstallHeartbeatVersion: options.activeInstallHeartbeatVersion }
        : {}),
    },
  });
  return mapServerDecision(response.data, context.channelName, onStatusUpdate);
}

function emitLocalDecisionStatus(
  decision: UpdateCheckResponse,
  onStatusUpdate?: (status: string) => void,
): void {
  if (decision.action === 'INSTALL') onStatusUpdate?.('⬇️ Update available');
  else if (decision.action === 'ROLLBACK') onStatusUpdate?.('↩️ Rollback requested');
  else onStatusUpdate?.('✅ You have the latest version');
}

export async function checkForUpdate(
  channelName = defaultChannel,
  onStatusUpdate?: (status: string) => void,
): Promise<UpdateCheckResponse | null> {
  if (!config.project?.slug) {
    const error = new Error('Missing project slug in bundle.drop.config.js');
    console.warn('⚠️ checkForUpdate failed:', error.toString());
    return null;
  }
  onStatusUpdate?.('🔍 Checking for updates...');
  let context: RuntimeDeliveryResolveContext | null = null;
  try {
    context = await readResolveContext(channelName);
    if (!isRuntimeDeliveryConfigured(config.runtimeDelivery) || !runtimeVersion) {
      return await resolveWithServer(context, onStatusUpdate);
    }

    reportActiveInstall(context);
    try {
      const manifest = await fetchRuntimeDeliveryManifest(channelName);
      if (manifest.resolutionMode === 'dynamic') {
        recordRuntimeDeliveryDiagnostic('origin_fallback', {
          channelName,
          reason: `dynamic:${manifest.dynamicReason ?? 'unspecified'}`,
        });
        return await resolveWithServer(context, onStatusUpdate, {
          activeInstallHeartbeatVersion: ACTIVE_INSTALL_HEARTBEAT_VERSION,
        });
      }
      const local = await resolveFromRuntimeDeliveryManifest(manifest, context);
      emitLocalDecisionStatus(local, onStatusUpdate);
      return local;
    } catch (manifestError) {
      recordRuntimeDeliveryDiagnostic('origin_fallback', {
        channelName,
        reason: manifestError instanceof RuntimeDeliveryManifestError
          ? manifestError.code
          : 'manifest_error',
      });
      console.warn('[BundleDrop] manifest delivery unavailable; falling back to /resolve:', manifestError);
      return await resolveWithServer(context, onStatusUpdate, {
        activeInstallHeartbeatVersion: ACTIVE_INSTALL_HEARTBEAT_VERSION,
      });
    }
  } catch (error) {
    if (
      isRuntimeDeliveryConfigured(config.runtimeDelivery) &&
      context &&
      await shouldRollbackFromLastKnownRevocations(channelName, context.currentHash).catch(() => false)
    ) {
      onStatusUpdate?.('↩️ Rollback requested');
      return {
        action: 'ROLLBACK',
        channelName,
        reason: 'CURRENT_REVOKED_ORIGIN_UNAVAILABLE',
      };
    }
    console.warn('⚠️ checkForUpdate failed:', error?.toString?.() || error);
    return null;
  }
}

export async function authorizeRuntimeDeliveryUpdate(
  decision: UpdateCheckResponse,
): Promise<UpdateCheckResponse | null> {
  if (decision.action !== 'INSTALL' || !decision.runtimeDelivery || !decision.channelName) {
    return decision;
  }
  const context = await readResolveContext(decision.channelName);
  try {
    if (!runtimeVersion) throw new Error('Runtime version is required for artifact authorization');
    const response = await postOtaArtifactAuthorization(config.project.slug, {
      channelName: decision.channelName,
      platform,
      runtimeVersion,
      generation: decision.runtimeDelivery.generation,
      targetReleaseRef: decision.runtimeDelivery.targetReleaseRef,
      targetHash: decision.hash!,
      mode: decision.runtimeDelivery.selectedMode,
      patchArtifactRef: decision.runtimeDelivery.patchArtifactRef ?? null,
      currentHash: context.currentHash,
      rejectedHashes: context.rejectedHashes,
      installId: context.installId,
      transport: {
        manifestVersion: 1,
        patchAlgorithms: context.patchAlgorithms,
        supportsContentAddressedAssets: context.supportsContentAddressedAssets,
      },
    });
    const authorized = await mapServerDecision(response.data, decision.channelName);
    if (authorized.action === 'INSTALL') {
      if (authorized.hash !== decision.hash || authorized.runtimeVersion !== runtimeVersion) {
        throw new Error('Artifact authorization returned a different target identity');
      }
      const selection = decision.runtimeDelivery;
      if (authorized.mode === 'patch') {
        if (
          selection.selectedMode !== 'patch' ||
          authorized.baseHash !== selection.baseHash ||
          authorized.patchSet?.algorithm !== selection.patchAlgorithm ||
          authorized.patchSet.patchSetHash !== selection.patchSetHash ||
          (authorized.patchSet.assets?.missingAssetsHash ?? null) !==
            (selection.missingAssetsHash ?? null)
        ) {
          throw new Error('Artifact authorization returned an unsafe patch selection');
        }
      }
      return { ...authorized, runtimeDelivery: selection };
    }
    return authorized;
  } catch (error) {
    recordRuntimeDeliveryDiagnostic('origin_fallback', {
      channelName: decision.channelName,
      reason: 'artifact_authorization_failed',
    });
    console.warn('[BundleDrop] artifact authorization failed; falling back to /resolve:', error);
    try {
      return await resolveWithServer(context, undefined, {
        activeInstallHeartbeatVersion: ACTIVE_INSTALL_HEARTBEAT_VERSION,
      });
    } catch {
      if (await shouldRollbackFromLastKnownRevocations(
        decision.channelName,
        context.currentHash,
      ).catch(() => false)) {
        return {
          action: 'ROLLBACK',
          channelName: decision.channelName,
          reason: 'CURRENT_REVOKED_ORIGIN_UNAVAILABLE',
        };
      }
      return null;
    }
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
