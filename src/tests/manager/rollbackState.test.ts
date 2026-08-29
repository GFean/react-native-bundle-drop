jest.mock('../../native/fs', () => require('../mocks/native/fs'));

type RollbackStateModule = typeof import('../../manager/rollbackState');

import { resetNativeFsMocks } from '../mocks/native/fs';

const ACTIVE_HASH = 'a'.repeat(64);
const FAILED_HASH = 'b'.repeat(64);
const STABLE_HASH = 'c'.repeat(64);
const CANDIDATE_HASH = 'd'.repeat(64);

const RECOVERY_STATE = {
  protocolVersion: 1 as const,
  revision: 7,
  phase: 'launching' as const,
  activeAttempt: {
    hash: ACTIVE_HASH,
    attemptId: 'attempt-7',
    status: 'launching' as const,
    unacknowledgedLaunchCount: 1,
  },
  quarantinedHashes: [FAILED_HASH],
  pendingRecoveryEvents: [
    {
      id: 'event-1',
      failedHash: FAILED_HASH,
      recoveryTarget: 'previous' as const,
      recoveredHash: STABLE_HASH,
      crashCount: 3,
      reason: 'crash_loop' as const,
      failedAt: 1_700_000_000,
    },
  ],
};

function loadRollbackState(options?: {
  attempt?: { hash: string; attemptId: string } | null;
  markHealthyResult?: boolean;
  recoveryState?: typeof RECOVERY_STATE | null;
  reportError?: unknown;
}) {
  jest.resetModules();

  const activateStartupCandidateNative = jest.fn(async (hash: string) => ({
    hash,
    bundlePath: `/bundles/${hash}/main.jsbundle`,
  }));
  const getStartupRecoveryAttemptNative = jest.fn(() =>
    options?.attempt === undefined
      ? { hash: ACTIVE_HASH, attemptId: 'attempt-7' }
      : options.attempt,
  );
  const markStartupHealthyNative = jest.fn(async () => options?.markHealthyResult ?? true);
  const getStartupRecoveryStateNative = jest.fn(async () =>
    options && 'recoveryState' in options ? options.recoveryState ?? null : RECOVERY_STATE,
  );
  const setStartupRecoveryRevokedHashesNative = jest.fn(async () => true);
  const rollbackStartupBundleNative = jest.fn(async (forceEmbedded: boolean) => ({
    rolledBack: true,
    toEmbedded: forceEmbedded,
    ...(forceEmbedded ? {} : { hash: STABLE_HASH }),
  }));
  const acknowledgeStartupRecoveryNative = jest.fn(async () => true);
  const reportLocalRollback = jest.fn(async () => {
    if (options && 'reportError' in options) throw options.reportError;
  });

  jest.doMock('../../context', () => ({
    BUNDLE_DROP_ROOT: '/mock/doc/bundle-drop',
    bundleDropConfig: {
      rollback: {
        maxCrashCount: 2,
        healthCheckMode: 'manual',
        healthyAfterSec: 9,
      },
    },
  }));
  jest.doMock('../../native/bundleDropNative', () => ({
    acknowledgeStartupRecoveryNative,
    activateStartupCandidateNative,
    getStartupRecoveryAttemptNative,
    getStartupRecoveryStateNative,
    markStartupHealthyNative,
    rollbackStartupBundleNative,
    setStartupRecoveryRevokedHashesNative,
  }));
  jest.doMock('../../manager/reporting', () => ({
    reportLocalRollback,
  }));

  return {
    module: require('../../manager/rollbackState') as RollbackStateModule,
    mocks: {
      acknowledgeStartupRecoveryNative,
      activateStartupCandidateNative,
      getStartupRecoveryStateNative,
      markStartupHealthyNative,
      reportLocalRollback,
      rollbackStartupBundleNative,
      setStartupRecoveryRevokedHashesNative,
    },
  };
}

describe('manager/rollbackState native recovery coordination', () => {
  beforeEach(resetNativeFsMocks);

  afterEach(() => {
    jest.resetModules();
    jest.unmock('../../context');
    jest.unmock('../../native/bundleDropNative');
    jest.unmock('../../manager/reporting');
    jest.restoreAllMocks();
  });

  it('activates candidates with the public rollback configuration', async () => {
    const { module, mocks } = loadRollbackState();

    await expect(module.activateStartupCandidate(CANDIDATE_HASH)).resolves.toEqual({
      hash: CANDIDATE_HASH,
      bundlePath: `/bundles/${CANDIDATE_HASH}/main.jsbundle`,
    });

    expect(mocks.activateStartupCandidateNative).toHaveBeenCalledWith(CANDIDATE_HASH, {
      maxCrashCount: 2,
      healthCheckMode: 'manual',
      healthyAfterSec: 9,
    });
  });

  it('reports health only for the launch attempt captured by native', async () => {
    const { module, mocks } = loadRollbackState({ markHealthyResult: false });

    await expect(module.reportActiveBundleHealthy()).resolves.toBe(false);
    expect(mocks.markStartupHealthyNative).toHaveBeenCalledWith({
      hash: ACTIVE_HASH,
      attemptId: 'attempt-7',
    });
  });

  it('does not report health when native did not capture an OTA launch attempt', async () => {
    const { module, mocks } = loadRollbackState({ attempt: null });

    await expect(module.reportActiveBundleHealthy()).resolves.toBe(false);
    expect(mocks.markStartupHealthyNative).not.toHaveBeenCalled();
  });

  it('uses native quarantine and native rollback/revocation commands', async () => {
    const { module, mocks } = loadRollbackState();

    await expect(module.getFailedBundleHashes()).resolves.toEqual([FAILED_HASH]);
    await expect(module.isBundleHashFailed(FAILED_HASH)).resolves.toBe(true);
    await expect(module.syncVerifiedRevokedHashes([CANDIDATE_HASH])).resolves.toBe(true);
    await expect(module.rollbackStartupBundle(true)).resolves.toEqual({
      rolledBack: true,
      toEmbedded: true,
    });

    expect(mocks.setStartupRecoveryRevokedHashesNative).toHaveBeenCalledWith([CANDIDATE_HASH]);
    expect(mocks.rollbackStartupBundleNative).toHaveBeenCalledWith(true);
  });

  it('accepts cached recovery state and handles missing hashes and snapshots', async () => {
    const { module, mocks } = loadRollbackState({ recoveryState: null });

    await expect(module.getFailedBundleHashes(RECOVERY_STATE)).resolves.toEqual([FAILED_HASH]);
    await expect(module.getFailedBundleHashes(null)).resolves.toEqual([]);
    await expect(module.isBundleHashFailed()).resolves.toBe(false);
    await expect(module.reconcileStartupRecovery()).resolves.toBeNull();

    expect(mocks.getStartupRecoveryStateNative).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a durable recovery event only after telemetry succeeds', async () => {
    const { module, mocks } = loadRollbackState();

    await module.reconcileStartupRecovery(RECOVERY_STATE, {
      hash: FAILED_HASH,
      channelName: 'General',
      runtimeVersion: '1.0.0',
    });

    expect(mocks.reportLocalRollback).toHaveBeenCalledWith(FAILED_HASH, {
      reason: 'crash_loop',
      failedAt: 1_700_000_000,
      crashCount: 3,
      channelName: 'General',
      runtimeVersion: '1.0.0',
      previousHash: STABLE_HASH,
    });
    expect(mocks.acknowledgeStartupRecoveryNative).toHaveBeenCalledWith('event-1');
  });

  it('acknowledges recovery even when no failed-bundle metadata was captured', async () => {
    const { module, mocks } = loadRollbackState();

    await module.reconcileStartupRecovery(RECOVERY_STATE);

    expect(mocks.reportLocalRollback).toHaveBeenCalledWith(FAILED_HASH, {
      reason: 'crash_loop',
      failedAt: 1_700_000_000,
      crashCount: 3,
      channelName: undefined,
      runtimeVersion: undefined,
      previousHash: STABLE_HASH,
    });
    expect(mocks.acknowledgeStartupRecoveryNative).toHaveBeenCalledWith('event-1');
  });

  it('leaves recovery telemetry pending when reporting fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { module, mocks } = loadRollbackState({ reportError: new Error('offline') });

    await expect(module.reconcileStartupRecovery(RECOVERY_STATE)).resolves.toEqual(RECOVERY_STATE);

    expect(mocks.acknowledgeStartupRecoveryNative).not.toHaveBeenCalled();
    expect(
      require('../mocks/native/fs').readMockJson(
        '/mock/doc/bundle-drop/recovery-telemetry-context.json',
      ),
    ).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '⚠️ Failed to report BundleDrop startup recovery event event-1:',
      'Error: offline',
    );
  });

  it('reuses failed-bundle context after recovery metadata replaces bundle-info', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { module, mocks } = loadRollbackState();
    mocks.reportLocalRollback.mockRejectedValueOnce(new Error('offline'));

    await module.reconcileStartupRecovery(RECOVERY_STATE, {
      hash: FAILED_HASH,
      channelName: 'Failed channel',
      runtimeVersion: 'failed-runtime',
    });
    expect(
      require('../mocks/native/fs').readMockJson(
        '/mock/doc/bundle-drop/recovery-telemetry-context.json',
      ),
    ).toEqual({
      schemaVersion: 1,
      events: {
        'event-1': {
          failedHash: FAILED_HASH,
          channelName: 'Failed channel',
          runtimeVersion: 'failed-runtime',
        },
      },
    });
    await module.reconcileStartupRecovery(RECOVERY_STATE, {
      hash: STABLE_HASH,
      channelName: 'Recovered channel',
      runtimeVersion: 'recovered-runtime',
    });

    expect(mocks.reportLocalRollback).toHaveBeenLastCalledWith(FAILED_HASH, {
      reason: 'crash_loop',
      failedAt: 1_700_000_000,
      crashCount: 3,
      channelName: 'Failed channel',
      runtimeVersion: 'failed-runtime',
      previousHash: STABLE_HASH,
    });
    expect(mocks.acknowledgeStartupRecoveryNative).toHaveBeenCalledWith('event-1');
    expect(
      require('../mocks/native/fs').readMockJson(
        '/mock/doc/bundle-drop/recovery-telemetry-context.json',
      ),
    ).toEqual({ schemaVersion: 1, events: {} });
    warnSpy.mockRestore();
  });

  it('repairs a malformed telemetry context before reporting recovery', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { module, mocks } = loadRollbackState();
    require('../mocks/native/fs').setMockFile(
      '/mock/doc/bundle-drop/recovery-telemetry-context.json',
      JSON.stringify({ schemaVersion: 2, events: {} }),
    );

    await module.reconcileStartupRecovery(RECOVERY_STATE, {
      hash: FAILED_HASH,
      channelName: 'General',
      runtimeVersion: '1.0.0',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '⚠️ Ignoring malformed BundleDrop recovery telemetry context:',
      expect.any(Error),
    );
    expect(mocks.reportLocalRollback).toHaveBeenCalledWith(
      FAILED_HASH,
      expect.objectContaining({ channelName: 'General', runtimeVersion: '1.0.0' }),
    );
  });

  it('prunes telemetry contexts whose native events were already acknowledged', async () => {
    const { module } = loadRollbackState({
      recoveryState: {
        ...RECOVERY_STATE,
        pendingRecoveryEvents: [],
      },
    });
    require('../mocks/native/fs').setMockFile(
      '/mock/doc/bundle-drop/recovery-telemetry-context.json',
      JSON.stringify({
        schemaVersion: 1,
        events: {
          stale: {
            failedHash: CANDIDATE_HASH,
            channelName: 'Old channel',
          },
        },
      }),
    );

    await module.reconcileStartupRecovery();

    expect(
      require('../mocks/native/fs').readMockJson(
        '/mock/doc/bundle-drop/recovery-telemetry-context.json',
      ),
    ).toEqual({ schemaVersion: 1, events: {} });
  });

  it('continues serializing telemetry mutations after a failed context write', async () => {
    const { module, mocks } = loadRollbackState();
    const nativeFs = require('../mocks/native/fs');
    nativeFs.mockWriteFile
      .mockRejectedValueOnce(new Error('temporary write failed'))
      .mockRejectedValueOnce(new Error('fallback write failed'));

    await expect(module.reconcileStartupRecovery(RECOVERY_STATE, {
      hash: FAILED_HASH,
      channelName: 'General',
      runtimeVersion: '1.0.0',
    })).rejects.toThrow('fallback write failed');

    await expect(module.reconcileStartupRecovery(RECOVERY_STATE, {
      hash: FAILED_HASH,
      channelName: 'General',
      runtimeVersion: '1.0.0',
    })).resolves.toEqual(RECOVERY_STATE);
    expect(mocks.acknowledgeStartupRecoveryNative).toHaveBeenCalledWith('event-1');
  });

  it('keeps telemetry pending when the failure has no printable error value', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { module, mocks } = loadRollbackState({ reportError: null });

    await expect(module.reconcileStartupRecovery()).resolves.toEqual(RECOVERY_STATE);

    expect(mocks.acknowledgeStartupRecoveryNative).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '⚠️ Failed to report BundleDrop startup recovery event event-1:',
      null,
    );
  });
});
