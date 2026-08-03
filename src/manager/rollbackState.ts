import RNFS from '../native/fs';

import { BUNDLE_DROP_ROOT, bundleDropConfig, platform } from '../context';
import { atomicWriteJson, ensureDir } from '../fs/fsUtils';
import {
  deleteCurrentBundlePointer,
  deletePreviousBundlePointer,
  readCurrentBundlePointer,
  readPreviousBundlePointer,
  writeCurrentBundlePointer,
  type BundlePointer,
} from '../fs/bundlePointer';
import { readBundleInfo, updateBundleInfo } from '../bundleInfo';
import { reportLocalRollback } from './reporting';
import { BUNDLE_MANIFEST, type BundleManifest } from '../manifest/bundleManifest';

export type RollbackPolicy = {
  maxCrashCount?: number;
  healthCheckMode?: 'auto' | 'manual';
  healthyAfterSec?: number;
};

export type FailedBundleReason = 'crash_loop';

export type FailedBundleRecord = {
  reason: FailedBundleReason;
  failedAt: number;
  crashCount?: number;
  channelName?: string;
  runtimeVersion?: string;
  previousHash?: string;
};

export type RollbackState = {
  activeHash?: string;
  lastGoodHash?: string;
  candidateHash?: string;
  candidateActivatedAt?: number;
  candidateCommitted?: boolean;
  crashCount?: number;
  lastLaunchAt?: number;
  failedBundles?: Record<string, FailedBundleRecord>;
};

type RollbackDecision =
  | { shouldRollback: false }
  | { shouldRollback: true; reason: FailedBundleReason };

const STATE_PATH = `${BUNDLE_DROP_ROOT}/state.json`;
const MAX_FAILED_BUNDLES = 20;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function readState(): Promise<RollbackState | null> {
  try {
    if (!(await RNFS.exists(STATE_PATH))) return null;
    const raw = await RNFS.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw) as RollbackState;
  } catch {
    return null;
  }
}

export { readState as readRollbackState };

async function writeState(state: RollbackState): Promise<void> {
  await ensureDir(BUNDLE_DROP_ROOT);
  await atomicWriteJson(STATE_PATH, state);
}

async function updateState(partial: Partial<RollbackState>): Promise<RollbackState> {
  const existing = (await readState()) || {};
  const next = { ...existing, ...partial };
  await writeState(next);
  return next;
}

function pruneFailedBundles(
  failedBundles: Record<string, FailedBundleRecord>,
): Record<string, FailedBundleRecord> {
  return Object.fromEntries(
    Object.entries(failedBundles)
      .sort(([, left], [, right]) => right.failedAt - left.failedAt)
      .slice(0, MAX_FAILED_BUNDLES),
  );
}

export async function markCandidateActivated(hash: string): Promise<void> {
  const previous = await readPreviousBundlePointer();
  const previousHash = previous?.hash;
  const now = nowSec();
  await updateState({
    activeHash: hash,
    candidateHash: hash,
    candidateActivatedAt: now,
    candidateCommitted: false,
    crashCount: 0,
    lastLaunchAt: now,
    lastGoodHash: previousHash ?? undefined,
  });
}

export async function reportActiveBundleHealthy(
  cached?: { currentPointer?: BundlePointer | null },
  expectedHash?: string,
): Promise<boolean> {
  const current = cached?.currentPointer !== undefined ? cached.currentPointer : await readCurrentBundlePointer();
  const hash = current?.hash;
  if (!hash) return false;
  if (expectedHash && hash !== expectedHash) return false;

  const state = (await readState()) || {};
  const isCandidate = state.candidateHash === hash && state.candidateCommitted !== true;
  if (!isCandidate) return false;

  await updateState({
    activeHash: hash,
    candidateHash: hash,
    candidateCommitted: true,
    crashCount: 0,
    lastGoodHash: hash,
  });
  return true;
}

export async function commitActiveBundle(
  cached?: { currentPointer?: BundlePointer | null },
): Promise<void> {
  await reportActiveBundleHealthy(cached);
}

export async function isBundleHashFailed(hash?: string | null): Promise<boolean> {
  if (!hash) return false;
  const state = await readState();
  return !!state?.failedBundles?.[hash];
}

export async function getFailedBundleHashes(): Promise<string[]> {
  const state = await readState();
  return Object.entries(state?.failedBundles || {})
    .sort(([, left], [, right]) => right.failedAt - left.failedAt)
    .slice(0, MAX_FAILED_BUNDLES)
    .map(([hash]) => hash);
}

async function buildFailedBundleRecord(
  hash: string,
  reason: FailedBundleReason,
  state: RollbackState,
): Promise<FailedBundleRecord> {
  const [bundleInfo, previous] = await Promise.all([
    readBundleInfo(),
    readPreviousBundlePointer(),
  ]);
  const record: FailedBundleRecord = {
    reason,
    failedAt: nowSec(),
    crashCount: state.crashCount,
    channelName: bundleInfo?.channelName,
    runtimeVersion: bundleInfo?.runtimeVersion,
    previousHash: previous?.hash,
  };
  return record;
}

async function recordFailedBundle(
  hash: string,
  record: FailedBundleRecord,
): Promise<void> {
  const state = (await readState()) || {};
  const failedBundles = pruneFailedBundles({
    ...(state.failedBundles || {}),
    [hash]: record,
  });
  await updateState({ failedBundles });
}

export async function evaluateRollbackOnLaunch(
  policy: Required<RollbackPolicy>,
  cached?: { currentPointer?: BundlePointer | null; rollbackState?: RollbackState | null },
): Promise<RollbackDecision> {
  const current = cached?.currentPointer !== undefined ? cached.currentPointer : await readCurrentBundlePointer();
  const activeHash = current?.hash;
  if (!activeHash) return { shouldRollback: false };

  const now = nowSec();
  const persistedState = (await readState()) || {};
  const state =
    cached?.rollbackState !== undefined
      ? {
          ...persistedState,
          ...cached.rollbackState,
          failedBundles: persistedState.failedBundles ?? cached.rollbackState?.failedBundles,
        }
      : persistedState;
  const next: RollbackState = {
    ...state,
    activeHash,
    lastLaunchAt: now,
  };

  const isCandidate = state.candidateHash === activeHash && state.candidateCommitted !== true;
  if (isCandidate) {
    const crashCount = (state.crashCount ?? 0) + 1;
    next.crashCount = crashCount;

    if (
      policy.maxCrashCount > 0 &&
      crashCount >= policy.maxCrashCount
    ) {
      await writeState(next);
      return { shouldRollback: true, reason: 'crash_loop' };
    }

  }

  await writeState(next);
  return { shouldRollback: false };
}

export async function rollbackToPreviousIfNeeded(
  policy: Required<RollbackPolicy>,
  cached?: { currentPointer?: BundlePointer | null; rollbackState?: RollbackState | null },
): Promise<{ rolledBack: boolean; reason?: FailedBundleReason }> {
  const decision = await evaluateRollbackOnLaunch(policy, cached);
  if (!decision.shouldRollback) return { rolledBack: false };

  const current = cached?.currentPointer !== undefined ? cached.currentPointer : await readCurrentBundlePointer();
  const failedHash = current?.hash;
  const state = (await readState()) || {};
  if (!failedHash) return { rolledBack: false };

  const failedRecord = await buildFailedBundleRecord(failedHash, decision.reason, state);
  await rollbackToPreviousOrNative();
  await recordFailedBundle(failedHash, failedRecord);
  await reportLocalRollback(failedHash, failedRecord).catch(() => undefined);
  return { rolledBack: true, reason: decision.reason };
}

export function getRollbackPolicy(): Required<RollbackPolicy> {
  return bundleDropConfig.rollback;
}

export async function rollbackToPreviousOrNative(): Promise<{ rolledBack: boolean; toNative?: boolean }> {
  const [current, previous, state] = await Promise.all([
    readCurrentBundlePointer(),
    readPreviousBundlePointer(),
    readState(),
  ]);
  const previousIsFailed = previous ? !!state?.failedBundles?.[previous.hash] : false;

  if (previous && previous.hash !== current?.hash && !previousIsFailed) {
    await writeCurrentBundlePointer({ ...previous, updatedAt: new Date().toISOString() });
    const metadata = await readBundleMetadata(previous.bundlePath);
    await updateBundleInfo({
      hash: previous.hash,
      bundleVersion: metadata?.bundleVersion,
      version: metadata?.version,
      runtimeVersion: metadata?.runtimeVersion,
      pendingApply: false,
      installedAt: new Date().toISOString(),
      lastInstalledReportedHash: previous.hash,
    });

    await updateState({
      activeHash: previous.hash,
      candidateHash: previous.hash,
      candidateCommitted: true,
      crashCount: 0,
      lastGoodHash: previous.hash,
    });

    return { rolledBack: true };
  }

  // No previous OTA bundle exists; fall back to native bundle by clearing the active pointer.
  await deleteCurrentBundlePointer();
  await deletePreviousBundlePointer();
  await updateBundleInfo({
    hash: undefined,
    bundleVersion: undefined,
    version: undefined,
    runtimeVersion: undefined,
    pendingApply: false,
    installedAt: new Date().toISOString(),
  });
  await updateState({
    activeHash: undefined,
    candidateHash: undefined,
    candidateCommitted: true,
    crashCount: 0,
  });

  return { rolledBack: true, toNative: true };
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    if (!(await RNFS.exists(path))) return null;
    const raw = await RNFS.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readBundleMetadata(bundlePath: string): Promise<{
  bundleVersion?: number;
  version?: string;
  runtimeVersion?: string;
} | null> {
  const dir = bundlePath.substring(0, bundlePath.lastIndexOf('/'));
  const manifest = await readJsonIfExists<BundleManifest>(`${dir}/${BUNDLE_MANIFEST}`);
  const metadataFile = platform === 'android' ? 'metadata-android.json' : 'metadata-ios.json';
  const parsed = await readJsonIfExists<Record<string, unknown>>(`${dir}/${metadataFile}`);

  if (!manifest && !parsed) {
    return null;
  }
  return {
    bundleVersion: parsed?.bundleVersion as number | undefined,
    version: manifest?.version ?? parsed?.version as string | undefined,
    runtimeVersion: manifest?.runtimeVersion ?? parsed?.runtimeVersion as string | undefined,
  };
}
