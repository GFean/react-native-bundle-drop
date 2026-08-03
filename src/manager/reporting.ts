import { config, platform, runtimeVersion } from '../context';
import { BundleInfo, readBundleInfo, updateBundleInfo } from '../bundleInfo';
import { reportInstalled, reportLocalRollback as postLocalRollbackReport } from '../api/clientApi';
import { getDownloadedBundlePathNative } from '../native/bundleDropNative';
import { getOrCreateInstallId } from '../fs/installId';
import { getCurrentUserProperties } from '../fs/userProperties';
import { getBundleDropRuntimeConfig } from '../runtime/initState';
import type { FailedBundleRecord } from './rollbackState';

const MAX_REPORTED_INSTALL_HASHES = 50;
const installedReportInFlightHashes = new Set<string>();

function appendReportedHash(existing: string[] | undefined, hash: string): string[] {
  const next = [...(existing || []).filter(value => value !== hash), hash];
  return next.slice(-MAX_REPORTED_INSTALL_HASHES);
}

async function getReportingState() {
  const info = await readBundleInfo();
  const path = await getDownloadedBundlePathNative();
  return {
    hasBundle: !!path,
    info,
  };
}

export async function reportInstalledIfReady(state?: { hasBundle?: boolean; info?: BundleInfo | null }) {
  const current = state ?? (await getReportingState());
  const info = state?.info ?? current.info;
  const hasBundle = state?.hasBundle ?? current.hasBundle;

  if (!info?.hash) return;
  if (info.pendingApply) return;
  if (hasBundle === false) return;
  if (info.lastInstalledReportedHash === info.hash) return;
  if (info.installedReportedHashes?.includes(info.hash)) return;
  if (installedReportInFlightHashes.has(info.hash)) return;

  const reportedHash = info.hash;
  installedReportInFlightHashes.add(reportedHash);
  try {
    const [installId, userProperties] = await Promise.all([
      getOrCreateInstallId(),
      getCurrentUserProperties(),
    ]);
    const appEnvironment = getBundleDropRuntimeConfig()?.environment ?? null;
    await reportInstalled(config.project.slug, reportedHash, {
      channelName: info.channelName,
      platform: info.platform,
      installId,
      runtimeVersion: info.runtimeVersion ?? runtimeVersion ?? null,
      environment: appEnvironment,
      userProperties: Object.keys(userProperties).length > 0 ? userProperties : undefined,
    });
    const latestInfo = await readBundleInfo();
    if (latestInfo) {
      const nextInfo: Partial<BundleInfo> = {
        installedReportedHashes: appendReportedHash(latestInfo.installedReportedHashes, reportedHash),
      };
      if (latestInfo.hash === reportedHash) {
        nextInfo.lastInstalledReportedHash = reportedHash;
      }
      await updateBundleInfo(nextInfo);
    }
  } catch (e) {
    console.warn('⚠️ Failed to report bundle install:', e?.toString?.() || e);
  } finally {
    installedReportInFlightHashes.delete(reportedHash);
  }
}

export async function reportLocalRollback(hash: string, record: FailedBundleRecord): Promise<void> {
  try {
    const [installId, userProperties] = await Promise.all([
      getOrCreateInstallId(),
      getCurrentUserProperties(),
    ]);
    const appEnvironment = getBundleDropRuntimeConfig()?.environment ?? null;

    await postLocalRollbackReport(config.project.slug, hash, {
      reason: record.reason,
      previousHash: record.previousHash ?? null,
      channelName: record.channelName ?? null,
      platform,
      installId,
      runtimeVersion: record.runtimeVersion ?? runtimeVersion ?? null,
      environment: appEnvironment,
      userProperties: Object.keys(userProperties).length > 0 ? userProperties : undefined,
      crashCount: record.crashCount ?? null,
      failedAt: record.failedAt ? new Date(record.failedAt * 1000).toISOString() : null,
    });
  } catch (e) {
    console.warn('⚠️ Failed to report local rollback:', e?.toString?.() || e);
  }
}
