import type { BundleInfo } from '../bundleInfo';
import { BUNDLE_DROP_ROOT, bundleDropConfig } from '../context';
import { atomicWriteJson, ensureDir } from '../fs/fsUtils';
import RNFS from '../native/fs';
import {
  acknowledgeStartupRecoveryNative,
  activateStartupCandidateNative,
  getStartupRecoveryAttemptNative,
  getStartupRecoveryStateNative,
  markStartupHealthyNative,
  rollbackStartupBundleNative,
  setStartupRecoveryRevokedHashesNative,
  type StartupRecoveryEvent,
  type StartupRecoveryState,
  type StartupCandidateActivation,
  type StartupRollbackResult,
} from '../native/bundleDropNative';
import { reportLocalRollback, type FailedBundleRecord } from './reporting';

export type RollbackPolicy = {
  maxCrashCount?: number;
  healthCheckMode?: 'auto' | 'manual';
  healthyAfterSec?: number;
};

export type { FailedBundleRecord } from './reporting';
export type { StartupRecoveryState } from '../native/bundleDropNative';

type RecoveryTelemetryContext = {
  failedHash: string;
  channelName?: string;
  runtimeVersion?: string;
};

type RecoveryTelemetryContextState = {
  schemaVersion: 1;
  events: Record<string, RecoveryTelemetryContext>;
};

export const STARTUP_RECOVERY_TELEMETRY_CONTEXT_PATH =
  `${BUNDLE_DROP_ROOT}/recovery-telemetry-context.json`;

let telemetryContextMutation: Promise<void> = Promise.resolve();

async function readRecoveryTelemetryContexts(): Promise<RecoveryTelemetryContextState> {
  try {
    if (!await RNFS.exists(STARTUP_RECOVERY_TELEMETRY_CONTEXT_PATH)) {
      return { schemaVersion: 1, events: {} };
    }
    const parsed = JSON.parse(
      await RNFS.readFile(STARTUP_RECOVERY_TELEMETRY_CONTEXT_PATH, 'utf8'),
    ) as RecoveryTelemetryContextState;
    if (parsed?.schemaVersion !== 1 || !parsed.events || typeof parsed.events !== 'object') {
      throw new Error('unsupported recovery telemetry context');
    }
    return parsed;
  } catch (error) {
    console.warn('⚠️ Ignoring malformed BundleDrop recovery telemetry context:', error);
    return { schemaVersion: 1, events: {} };
  }
}

async function mutateRecoveryTelemetryContexts(
  mutate: (state: RecoveryTelemetryContextState) => boolean,
): Promise<RecoveryTelemetryContextState> {
  let result: RecoveryTelemetryContextState = { schemaVersion: 1, events: {} };
  const mutation = telemetryContextMutation.then(async () => {
    result = await readRecoveryTelemetryContexts();
    if (!mutate(result)) return;
    await ensureDir(BUNDLE_DROP_ROOT);
    await atomicWriteJson(STARTUP_RECOVERY_TELEMETRY_CONTEXT_PATH, result);
  });
  telemetryContextMutation = mutation.then(() => undefined, () => undefined);
  await mutation;
  return result;
}

async function prepareRecoveryTelemetryContexts(
  events: StartupRecoveryEvent[],
  failedBundleInfo?: BundleInfo | null,
): Promise<RecoveryTelemetryContextState> {
  const pendingEventIds = new Set(events.map(event => event.id));
  return mutateRecoveryTelemetryContexts(state => {
    let changed = false;
    for (const eventId of Object.keys(state.events)) {
      if (!pendingEventIds.has(eventId)) {
        delete state.events[eventId];
        changed = true;
      }
    }
    for (const event of events) {
      if (
        !state.events[event.id] &&
        failedBundleInfo?.hash === event.failedHash
      ) {
        state.events[event.id] = {
          failedHash: event.failedHash,
          channelName: failedBundleInfo.channelName,
          runtimeVersion: failedBundleInfo.runtimeVersion,
        };
        changed = true;
      }
    }
    return changed;
  });
}

async function removeRecoveryTelemetryContext(eventId: string): Promise<void> {
  await mutateRecoveryTelemetryContexts(state => {
    if (!state.events[eventId]) return false;
    delete state.events[eventId];
    return true;
  });
}

export function getRollbackPolicy(): Required<RollbackPolicy> {
  return bundleDropConfig.rollback;
}

export async function activateStartupCandidate(
  hash: string,
): Promise<StartupCandidateActivation | null> {
  return activateStartupCandidateNative(hash, getRollbackPolicy());
}

export async function reportActiveBundleHealthy(): Promise<boolean> {
  const attempt = getStartupRecoveryAttemptNative();
  if (!attempt) return false;
  return markStartupHealthyNative(attempt);
}

export async function readStartupRecoveryState(): Promise<StartupRecoveryState | null> {
  return getStartupRecoveryStateNative();
}

export async function getFailedBundleHashes(
  cachedState?: StartupRecoveryState | null,
): Promise<string[]> {
  const state = cachedState === undefined ? await readStartupRecoveryState() : cachedState;
  return [...(state?.quarantinedHashes || [])];
}

export async function isBundleHashFailed(hash?: string | null): Promise<boolean> {
  if (!hash) return false;
  return (await getFailedBundleHashes()).includes(hash);
}

export async function syncVerifiedRevokedHashes(hashes: string[]): Promise<boolean> {
  return setStartupRecoveryRevokedHashesNative(hashes);
}

export async function rollbackStartupBundle(
  forceEmbedded: boolean,
): Promise<StartupRollbackResult | null> {
  return rollbackStartupBundleNative(forceEmbedded);
}

function recoveryRecord(
  event: StartupRecoveryEvent,
  context?: RecoveryTelemetryContext,
): FailedBundleRecord {
  return {
    reason: event.reason,
    failedAt: event.failedAt,
    crashCount: event.crashCount,
    channelName: context?.channelName,
    runtimeVersion: context?.runtimeVersion,
    previousHash: event.recoveredHash,
  };
}

/**
 * Flush native recovery events without making JS part of the recovery decision.
 * Native keeps each event durable until its backend report succeeds and JS
 * acknowledges that exact event id.
 */
export async function reconcileStartupRecovery(
  cachedState?: StartupRecoveryState | null,
  failedBundleInfo?: BundleInfo | null,
): Promise<StartupRecoveryState | null> {
  const state = cachedState === undefined ? await readStartupRecoveryState() : cachedState;
  if (!state) return null;
  const telemetryContexts = await prepareRecoveryTelemetryContexts(
    state.pendingRecoveryEvents,
    failedBundleInfo,
  );

  for (const event of state.pendingRecoveryEvents) {
    try {
      const telemetryContext = telemetryContexts.events[event.id];
      await reportLocalRollback(
        event.failedHash,
        recoveryRecord(
          event,
          telemetryContext?.failedHash === event.failedHash ? telemetryContext : undefined,
        ),
      );
      if (await acknowledgeStartupRecoveryNative(event.id)) {
        await removeRecoveryTelemetryContext(event.id);
      }
    } catch (error) {
      console.warn(
        `⚠️ Failed to report BundleDrop startup recovery event ${event.id}:`,
        error?.toString?.() || error,
      );
    }
  }

  return state;
}
