import { runtimeVersion } from '../context';
import { getOrCreateInstallId } from '../fs/installId';
import { reportPatchApplyFailure } from '../api/clientApi';
import type { OtaPatchSet } from '../api/types';
import type { InstallResult } from '../install/bundleInstallShared';
import { installFromPatchSet } from './installFromPatchSet';
import { isSupportedPatchAlgorithm, type SupportedPatchAlgorithm } from './patchOperations';

export type PatchTransportTarget = {
  mode?: 'full' | 'patch';
  hash: string;
  manifestUrl?: string;
  baseHash?: string;
  patchSet?: OtaPatchSet;
};

type TryInstallPatchTransportParams = {
  target: PatchTransportTarget;
  projectSlug: string;
  platform: 'ios' | 'android';
  runtimeVersionValue?: string;
  statusCb?: (status: string) => void;
};

const PATCH_FAILURE_REPORT_TIMEOUT_MS = 1500;

const reportPatchInstallFailure = async ({
  projectSlug,
  platform,
  runtimeVersionValue,
  baseHash,
  targetHash,
  algorithm,
  error,
}: {
  projectSlug: string;
  platform: string;
  runtimeVersionValue: string;
  baseHash?: string;
  targetHash: string;
  algorithm: SupportedPatchAlgorithm;
  error: unknown;
}) => {
  try {
    const installId = await getOrCreateInstallId();
    await reportPatchApplyFailure(projectSlug, {
      platform,
      runtimeVersion: runtimeVersionValue,
      installId,
      baseHash,
      targetHash,
      algorithm,
      reason: error instanceof Error ? error.message : 'patch_install_failed',
    });
  } catch {
    // Telemetry must never block the full-bundle fallback path.
  }
};

const reportPatchInstallFailureBeforeFallback = async (
  params: Parameters<typeof reportPatchInstallFailure>[0],
) => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<void>(resolve => {
    timeout = setTimeout(resolve, PATCH_FAILURE_REPORT_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      reportPatchInstallFailure(params),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const tryInstallPatchTransport = async ({
  target,
  projectSlug,
  platform,
  runtimeVersionValue,
  statusCb,
}: TryInstallPatchTransportParams): Promise<InstallResult | null> => {
  if (
    target.mode !== 'patch' ||
    !target.baseHash ||
    !isSupportedPatchAlgorithm(target.patchSet?.algorithm) ||
    !target.patchSet?.patchesUrl ||
    !target.patchSet.patchSetHash
  ) {
    return null;
  }

  try {
    statusCb?.('🧩 Downloading patch set...');
    return await installFromPatchSet({
      patchesUrl: target.patchSet.patchesUrl,
      patchSetHash: target.patchSet.patchSetHash,
      manifestUrl: target.manifestUrl,
      missingAssetsUrl: target.patchSet.assets?.missingAssetsUrl,
      missingAssetsHash: target.patchSet.assets?.missingAssetsHash,
      baseHash: target.baseHash,
      targetHash: target.hash,
      algorithm: target.patchSet.algorithm,
      platform,
      statusCb,
    });
  } catch (e) {
    await reportPatchInstallFailureBeforeFallback({
      projectSlug,
      platform,
      runtimeVersionValue: runtimeVersionValue ?? runtimeVersion ?? '',
      baseHash: target.baseHash,
      targetHash: target.hash,
      algorithm: target.patchSet.algorithm,
      error: e,
    });
    statusCb?.('↩️ Patch install failed; falling back to full bundle ZIP');
    console.warn('⚠️ Patch install failed; falling back to full bundle ZIP:', e?.toString?.() || e);
    return null;
  }
};
