import { NativeModules } from 'react-native';

const STARTUP_RECOVERY_PROTOCOL_VERSION = 1;
const SHA256_HASH_PATTERN = /^[a-f0-9]{64}$/;
const STARTUP_RECOVERY_CAPABILITY_WARNING =
  '[BundleDrop] Automatic startup recovery requires a newer BundleDrop native build. ' +
  'Recovery is disabled for this binary; rebuild the app before shipping another OTA update.';

export type StartupRecoveryHealthCheckMode = 'auto' | 'manual';

export type StartupRecoveryAttempt = {
  hash: string;
  attemptId: string;
};

export type StartupRecoverySnapshotAttempt = StartupRecoveryAttempt & {
  status: 'launching';
  unacknowledgedLaunchCount: number;
};

export type StartupRecoveryEvent = {
  id: string;
  failedHash: string;
  recoveryTarget: 'previous' | 'embedded';
  recoveredHash?: string;
  crashCount: number;
  reason: 'crash_loop';
  failedAt: number;
};

export type StartupRecoveryState = {
  protocolVersion: typeof STARTUP_RECOVERY_PROTOCOL_VERSION;
  revision: number;
  phase: 'idle' | 'armed' | 'launching' | 'stable' | 'recovered';
  candidateHash?: string;
  stableHash?: string;
  activeAttempt?: StartupRecoverySnapshotAttempt;
  policy?: {
    maxCrashCount: number;
    healthCheckMode: StartupRecoveryHealthCheckMode;
    healthyAfterSec: number;
  };
  quarantinedHashes: string[];
  pendingRecoveryEvents: StartupRecoveryEvent[];
};

export type StartupCandidateActivation = {
  hash: string;
  bundlePath: string;
};

export type StartupRollbackResult = {
  rolledBack: boolean;
  toEmbedded: boolean;
  hash?: string;
};

type BundleDropNativeModule = {
  getDownloadedBundlePath?: () => Promise<string | null>;
  restartReactNative?: () => void;
  setOtaEnabled?: (enabled: boolean) => Promise<void>;
  startupRecoveryProtocolVersion?: unknown;
  startupRecoverySelectedHash?: unknown;
  startupRecoveryAttemptHash?: unknown;
  startupRecoveryAttemptId?: unknown;
  activateStartupCandidate?: (
    hash: string,
    maxCrashCount: number,
    healthCheckMode: StartupRecoveryHealthCheckMode,
    healthyAfterSec: number,
  ) => Promise<unknown>;
  markStartupHealthy?: (hash: string, attemptId: string) => Promise<boolean>;
  getStartupRecoveryState?: () => Promise<unknown>;
  setStartupRecoveryRevokedHashes?: (hashes: string[]) => Promise<boolean>;
  acknowledgeStartupRecovery?: (eventId: string) => Promise<boolean>;
  rollbackStartupBundle?: (forceEmbedded: boolean) => Promise<unknown>;
};

type BundleDropExpoIdentityModule = {
  otaStartupEnabled?: unknown;
};

const BundleDrop = NativeModules.BundleDrop as BundleDropNativeModule | undefined;
const BundleDropExpoIdentity = NativeModules.BundleDropExpoIdentity as
  | BundleDropExpoIdentityModule
  | undefined;

// These constants describe the bundle selected by native code for this specific
// React runtime. Capture them once so later native state changes cannot rewrite
// the running identity or the attempt acknowledged by reportHealthy().
const startupRecoverySelectedHash = readStartupRecoverySelectedHash(BundleDrop);
const startupRecoveryAttempt = readStartupRecoveryAttempt(BundleDrop);
let hasWarnedAboutStartupRecoveryCapability = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function canonicalHash(value: unknown): string | null {
  return typeof value === 'string' && SHA256_HASH_PATTERN.test(value) ? value : null;
}

function readStartupRecoverySelectedHash(
  nativeModule: { startupRecoverySelectedHash?: unknown } | undefined,
): string | null | undefined {
  if (!nativeModule || !Object.prototype.hasOwnProperty.call(nativeModule, 'startupRecoverySelectedHash')) {
    return undefined;
  }
  if (nativeModule.startupRecoverySelectedHash == null) return null;
  return canonicalHash(nativeModule.startupRecoverySelectedHash);
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function readStartupRecoveryAttempt(
  nativeModule: {
    startupRecoveryAttemptHash?: unknown;
    startupRecoveryAttemptId?: unknown;
  } | undefined,
): StartupRecoveryAttempt | null {
  const hash = canonicalHash(nativeModule?.startupRecoveryAttemptHash);
  const attemptId = nonEmptyString(nativeModule?.startupRecoveryAttemptId);
  return hash && attemptId ? { hash, attemptId } : null;
}

function hasStartupRecoveryMethods(nativeModule: BundleDropNativeModule | undefined): boolean {
  return nativeModule?.startupRecoveryProtocolVersion === STARTUP_RECOVERY_PROTOCOL_VERSION &&
    typeof nativeModule.activateStartupCandidate === 'function' &&
    typeof nativeModule.markStartupHealthy === 'function' &&
    typeof nativeModule.getStartupRecoveryState === 'function' &&
    typeof nativeModule.setStartupRecoveryRevokedHashes === 'function' &&
    typeof nativeModule.acknowledgeStartupRecovery === 'function' &&
    typeof nativeModule.rollbackStartupBundle === 'function';
}

function warnAboutMissingStartupRecovery(): void {
  if (hasWarnedAboutStartupRecoveryCapability) return;
  hasWarnedAboutStartupRecoveryCapability = true;
  console.warn(STARTUP_RECOVERY_CAPABILITY_WARNING);
}

function requireStartupRecoveryCapability(): BundleDropNativeModule | null {
  if (!hasStartupRecoveryMethods(BundleDrop)) {
    warnAboutMissingStartupRecovery();
    return null;
  }
  return BundleDrop!;
}

function normalizeRecoveryEvent(value: unknown): StartupRecoveryEvent | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const failedHash = canonicalHash(value.failedHash);
  const hasRecoveredHash = value.recoveredHash != null;
  const recoveredHash = hasRecoveredHash ? canonicalHash(value.recoveredHash) : undefined;
  const crashCount = nonNegativeInteger(value.crashCount);
  const failedAt = nonNegativeInteger(value.failedAt);
  const recoveryTarget = value.recoveryTarget;
  if (
    !id ||
    !failedHash ||
    (hasRecoveredHash && !recoveredHash) ||
    crashCount === null ||
    failedAt === null ||
    value.reason !== 'crash_loop' ||
    (recoveryTarget !== 'previous' && recoveryTarget !== 'embedded')
  ) {
    return null;
  }
  if (recoveryTarget === 'previous' && !recoveredHash) return null;
  return {
    id,
    failedHash,
    recoveryTarget,
    ...(recoveredHash ? { recoveredHash } : {}),
    crashCount,
    reason: 'crash_loop',
    failedAt,
  };
}

function normalizeStartupRecoveryState(value: unknown): StartupRecoveryState | null {
  if (!isRecord(value) || value.protocolVersion !== STARTUP_RECOVERY_PROTOCOL_VERSION) {
    return null;
  }
  const revision = nonNegativeInteger(value.revision);
  if (revision === null) return null;

  const phase = value.phase;
  if (!['idle', 'armed', 'launching', 'stable', 'recovered'].includes(String(phase))) {
    return null;
  }

  const hasCandidateHash = value.candidateHash != null;
  const candidateHash = hasCandidateHash ? canonicalHash(value.candidateHash) : undefined;
  const hasStableHash = value.stableHash != null;
  const stableHash = hasStableHash ? canonicalHash(value.stableHash) : undefined;
  if ((hasCandidateHash && !candidateHash) || (hasStableHash && !stableHash)) return null;

  const baseAttempt = value.activeAttempt == null
    ? null
    : readStartupRecoveryAttempt({
        startupRecoveryAttemptHash: isRecord(value.activeAttempt)
          ? value.activeAttempt.hash
          : undefined,
        startupRecoveryAttemptId: isRecord(value.activeAttempt)
          ? value.activeAttempt.attemptId
          : undefined,
      });
  const activeAttemptCount = isRecord(value.activeAttempt)
    ? nonNegativeInteger(value.activeAttempt.unacknowledgedLaunchCount)
    : null;
  const activeAttempt = baseAttempt && isRecord(value.activeAttempt) &&
      value.activeAttempt.status === 'launching' && activeAttemptCount !== null
    ? {
        ...baseAttempt,
        status: 'launching' as const,
        unacknowledgedLaunchCount: activeAttemptCount,
      }
    : undefined;
  if (value.activeAttempt != null && !activeAttempt) return null;

  let policy: StartupRecoveryState['policy'];
  if (value.policy != null) {
    if (!isRecord(value.policy)) return null;
    const maxCrashCount = nonNegativeInteger(value.policy.maxCrashCount);
    const healthyAfterSec = typeof value.policy.healthyAfterSec === 'number' &&
      Number.isFinite(value.policy.healthyAfterSec) && value.policy.healthyAfterSec >= 0
      ? value.policy.healthyAfterSec
      : null;
    const healthCheckMode = value.policy.healthCheckMode;
    if (
      maxCrashCount === null ||
      healthyAfterSec === null ||
      (healthCheckMode !== 'auto' && healthCheckMode !== 'manual')
    ) {
      return null;
    }
    policy = { maxCrashCount, healthCheckMode, healthyAfterSec };
  }
  const quarantinedHashes = Array.isArray(value.quarantinedHashes)
    ? Array.from(new Set(value.quarantinedHashes.map(canonicalHash).filter(Boolean) as string[]))
    : null;
  const pendingRecoveryEvents = Array.isArray(value.pendingRecoveryEvents)
    ? value.pendingRecoveryEvents.map(normalizeRecoveryEvent).filter(Boolean) as StartupRecoveryEvent[]
    : null;
  if (!quarantinedHashes || !pendingRecoveryEvents) return null;

  const uniqueEvents = Array.from(
    new Map(pendingRecoveryEvents.map(event => [event.id, event])).values(),
  );
  return {
    protocolVersion: STARTUP_RECOVERY_PROTOCOL_VERSION,
    revision,
    phase: phase as StartupRecoveryState['phase'],
    ...(candidateHash ? { candidateHash } : {}),
    ...(stableHash ? { stableHash } : {}),
    ...(activeAttempt ? { activeAttempt } : {}),
    ...(policy ? { policy } : {}),
    quarantinedHashes,
    pendingRecoveryEvents: uniqueEvents,
  };
}

function normalizeCandidateActivation(value: unknown): StartupCandidateActivation | null {
  if (!isRecord(value)) return null;
  const hash = canonicalHash(value.hash);
  const bundlePath = nonEmptyString(value.bundlePath);
  return hash && bundlePath ? { hash, bundlePath } : null;
}

function normalizeRollbackResult(value: unknown): StartupRollbackResult | null {
  if (!isRecord(value) || typeof value.rolledBack !== 'boolean' || typeof value.toEmbedded !== 'boolean') {
    return null;
  }
  const hasHash = value.hash != null;
  const hash = hasHash ? canonicalHash(value.hash) : undefined;
  if (hasHash && !hash) return null;
  return {
    rolledBack: value.rolledBack,
    toEmbedded: value.toEmbedded,
    ...(hash ? { hash } : {}),
  };
}

export function isBundleDropNativeAvailable(): boolean {
  return Boolean(BundleDrop);
}

export function isExpoOtaStartupEnabledNative(): boolean {
  const nativeValue = BundleDropExpoIdentity?.otaStartupEnabled;
  return nativeValue === true || nativeValue === 1;
}

export function isStartupRecoveryAvailableNative(): boolean {
  return hasStartupRecoveryMethods(BundleDrop);
}

export function warnIfStartupRecoveryUnavailableNative(): void {
  if (!isStartupRecoveryAvailableNative()) {
    warnAboutMissingStartupRecovery();
  }
}

export function getStartupRecoveryAttemptNative(): StartupRecoveryAttempt | null {
  return startupRecoveryAttempt ? { ...startupRecoveryAttempt } : null;
}

/**
 * Hash selected for this exact React runtime. `undefined` means the installed
 * native adapter predates this constant; `null` means native selected embedded.
 */
export function getStartupRecoverySelectedHashNative(): string | null | undefined {
  return startupRecoverySelectedHash;
}

export async function activateStartupCandidateNative(
  hash: string,
  policy: {
    maxCrashCount: number;
    healthCheckMode: StartupRecoveryHealthCheckMode;
    healthyAfterSec: number;
  },
): Promise<StartupCandidateActivation | null> {
  if (
    !Number.isSafeInteger(policy.maxCrashCount) ||
    policy.maxCrashCount < 0 ||
    policy.maxCrashCount > 2_147_483_647
  ) {
    throw new Error('maxCrashCount must be a non-negative 32-bit integer');
  }
  if (!Number.isFinite(policy.healthyAfterSec) || policy.healthyAfterSec < 0) {
    throw new Error('healthyAfterSec must be a finite non-negative number');
  }
  const nativeModule = requireStartupRecoveryCapability();
  if (!nativeModule) return null;
  const result = await nativeModule.activateStartupCandidate!(
    hash,
    policy.maxCrashCount,
    policy.healthCheckMode,
    policy.healthyAfterSec,
  );
  return normalizeCandidateActivation(result);
}

export async function markStartupHealthyNative(
  attempt: StartupRecoveryAttempt,
): Promise<boolean> {
  const nativeModule = requireStartupRecoveryCapability();
  if (!nativeModule) return false;
  return nativeModule.markStartupHealthy!(attempt.hash, attempt.attemptId);
}

export async function getStartupRecoveryStateNative(): Promise<StartupRecoveryState | null> {
  const nativeModule = requireStartupRecoveryCapability();
  if (!nativeModule) return null;
  const state = normalizeStartupRecoveryState(await nativeModule.getStartupRecoveryState!());
  if (!state) {
    console.warn('[BundleDrop] Ignoring malformed native startup recovery state.');
  }
  return state;
}

export async function setStartupRecoveryRevokedHashesNative(
  hashes: string[],
): Promise<boolean> {
  const nativeModule = requireStartupRecoveryCapability();
  if (!nativeModule) return false;
  return nativeModule.setStartupRecoveryRevokedHashes!(Array.from(new Set(hashes)));
}

export async function acknowledgeStartupRecoveryNative(eventId: string): Promise<boolean> {
  const nativeModule = requireStartupRecoveryCapability();
  if (!nativeModule) return false;
  return nativeModule.acknowledgeStartupRecovery!(eventId);
}

export async function rollbackStartupBundleNative(
  forceEmbedded: boolean,
): Promise<StartupRollbackResult | null> {
  const nativeModule = requireStartupRecoveryCapability();
  if (!nativeModule) return null;
  return normalizeRollbackResult(await nativeModule.rollbackStartupBundle!(forceEmbedded));
}

export async function getDownloadedBundlePathNative(): Promise<string | null> {
  if (!BundleDrop?.getDownloadedBundlePath) {
    console.warn('BundleDrop.getDownloadedBundlePath is not defined');
    return null;
  }

  try {
    return await BundleDrop.getDownloadedBundlePath();
  } catch (e) {
    console.error('❌ Failed to get bundle path:', e);
    return null;
  }
}

export function restartReactNativeNative(): void {
  BundleDrop?.restartReactNative?.();
}

export async function setOtaEnabledNative(enabled: boolean): Promise<void> {
  if (!BundleDrop?.setOtaEnabled) return;
  try {
    await BundleDrop.setOtaEnabled(enabled);
  } catch (e) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.debug('BundleDrop.setOtaEnabled failed:', e);
    }
  }
}
