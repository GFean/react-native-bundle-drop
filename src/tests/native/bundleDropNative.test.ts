import { readFileSync } from 'fs';
import { join } from 'path';

type NativeModule = typeof import('../../native/bundleDropNative');

const ACTIVE_HASH = 'a'.repeat(64);
const FAILED_HASH = 'b'.repeat(64);
const STABLE_HASH = 'c'.repeat(64);
const CANDIDATE_HASH = 'd'.repeat(64);
const LATER_HASH = 'e'.repeat(64);

const loadBundleDropNativeModule = (
  configure?: (deps: { NativeModules: any }) => void
) => {
  jest.resetModules();
  const reactNative = require('react-native') as typeof import('react-native');
  configure?.({ NativeModules: reactNative.NativeModules });
  return require('../../native/bundleDropNative') as NativeModule;
};

describe('native/bundleDropNative', () => {
  it('reports whether the Bundle Drop native bridge is available', () => {
    const available = loadBundleDropNativeModule();
    const reactNative = require('react-native') as typeof import('react-native');
    const nativeBundleDrop = reactNative.NativeModules.BundleDrop;
    const unavailable = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop = undefined;
    });
    reactNative.NativeModules.BundleDrop = nativeBundleDrop;

    expect(available.isBundleDropNativeAvailable()).toBe(true);
    expect(unavailable.isBundleDropNativeAvailable()).toBe(false);
  });

  it('reports whether the Expo adapter owns OTA startup in this native build', () => {
    const enabled = loadBundleDropNativeModule();
    expect(enabled.isExpoOtaStartupEnabledNative()).toBe(true);

    const enabledByIosNumericBoolean = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDropExpoIdentity.otaStartupEnabled = 1;
    });
    expect(enabledByIosNumericBoolean.isExpoOtaStartupEnabledNative()).toBe(true);

    const disabled = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDropExpoIdentity.otaStartupEnabled = false;
    });
    expect(disabled.isExpoOtaStartupEnabledNative()).toBe(false);

    const disabledByIosNumericBoolean = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDropExpoIdentity.otaStartupEnabled = 0;
    });
    expect(disabledByIosNumericBoolean.isExpoOtaStartupEnabledNative()).toBe(false);

    const invalidStringValue = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDropExpoIdentity.otaStartupEnabled = '1';
    });
    expect(invalidStringValue.isExpoOtaStartupEnabledNative()).toBe(false);

    const missingIdentity = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDropExpoIdentity = undefined;
    });
    expect(missingIdentity.isExpoOtaStartupEnabledNative()).toBe(false);

    const reactNative = require('react-native') as typeof import('react-native');
    reactNative.NativeModules.BundleDropExpoIdentity = {
      appVersion: '1.2.3',
      appBuildVersion: '45',
      otaStartupEnabled: true,
    };
  });

  it('returns null and warns when the native getter is unavailable', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.getDownloadedBundlePath = undefined;
    });

    await expect(nativeModule.getDownloadedBundlePathNative()).resolves.toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith('BundleDrop.getDownloadedBundlePath is not defined');
  });

  it('returns the native bundle path when available', async () => {
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.getDownloadedBundlePath.mockResolvedValue(
        '/mock/doc/bundle-drop/bundles/hash-1/main.jsbundle'
      );
    });

    await expect(nativeModule.getDownloadedBundlePathNative()).resolves.toBe(
      '/mock/doc/bundle-drop/bundles/hash-1/main.jsbundle'
    );
  });

  it('logs and swallows native getter failures', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.getDownloadedBundlePath.mockRejectedValue(new Error('native fail'));
    });

    await expect(nativeModule.getDownloadedBundlePathNative()).resolves.toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith('❌ Failed to get bundle path:', expect.any(Error));
  });

  it('restarts React Native when the native bridge exposes the restart method', () => {
    const nativeModule = loadBundleDropNativeModule();
    const reactNative = require('react-native') as typeof import('react-native');

    nativeModule.restartReactNativeNative();

    expect(reactNative.NativeModules.BundleDrop.restartReactNative).toHaveBeenCalledTimes(1);
  });

  it('calls native setOtaEnabled when available', async () => {
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.setOtaEnabled = jest.fn().mockResolvedValue(undefined);
    });

    await nativeModule.setOtaEnabledNative(false);

    const reactNative = require('react-native') as typeof import('react-native');
    expect(reactNative.NativeModules.BundleDrop.setOtaEnabled).toHaveBeenCalledWith(false);
  });

  it('is a no-op when native setOtaEnabled is not exposed', async () => {
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.setOtaEnabled = undefined;
    });

    await expect(nativeModule.setOtaEnabledNative(true)).resolves.toBeUndefined();
  });

  it('silently swallows native setOtaEnabled errors', async () => {
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.setOtaEnabled = jest.fn().mockRejectedValue(new Error('prefs fail'));
    });

    await expect(nativeModule.setOtaEnabledNative(false)).resolves.toBeUndefined();
  });

  it('logs debug in __DEV__ when setOtaEnabled rejects', async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    const err = new Error('prefs fail');
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.setOtaEnabled = jest.fn().mockRejectedValue(err);
    });

    await expect(nativeModule.setOtaEnabledNative(false)).resolves.toBeUndefined();

    expect(debugSpy).toHaveBeenCalledWith('BundleDrop.setOtaEnabled failed:', err);
    debugSpy.mockRestore();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
  });

  it('captures the native launch attempt once for the current JS runtime', () => {
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.startupRecoveryAttemptHash = ACTIVE_HASH;
      NativeModules.BundleDrop.startupRecoveryAttemptId = 'attempt-1';
    });
    const reactNative = require('react-native') as typeof import('react-native');

    reactNative.NativeModules.BundleDrop.startupRecoveryAttemptHash = LATER_HASH;
    reactNative.NativeModules.BundleDrop.startupRecoveryAttemptId = 'attempt-2';

    expect(nativeModule.getStartupRecoveryAttemptNative()).toEqual({
      hash: ACTIVE_HASH,
      attemptId: 'attempt-1',
    });

    reactNative.NativeModules.BundleDrop.startupRecoveryAttemptHash = null;
    reactNative.NativeModules.BundleDrop.startupRecoveryAttemptId = null;
  });

  it('captures and validates the hash selected for the current JS runtime', () => {
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.startupRecoverySelectedHash = ACTIVE_HASH;
    });
    const reactNative = require('react-native') as typeof import('react-native');

    reactNative.NativeModules.BundleDrop.startupRecoverySelectedHash = LATER_HASH;
    expect(nativeModule.getStartupRecoverySelectedHashNative()).toBe(ACTIVE_HASH);

    delete reactNative.NativeModules.BundleDrop.startupRecoverySelectedHash;
    const missing = loadBundleDropNativeModule();
    expect(missing.getStartupRecoverySelectedHashNative()).toBeUndefined();

    const embedded = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.startupRecoverySelectedHash = null;
    });
    expect(embedded.getStartupRecoverySelectedHashNative()).toBeNull();

    const malformed = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.startupRecoverySelectedHash = 'not-a-hash';
    });
    expect(malformed.getStartupRecoverySelectedHashNative()).toBeNull();

    delete reactNative.NativeModules.BundleDrop.startupRecoverySelectedHash;
  });

  it('warns once and does not fall back when the native recovery protocol is missing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.startupRecoveryProtocolVersion = 0;
    });

    expect(nativeModule.isStartupRecoveryAvailableNative()).toBe(false);
    nativeModule.warnIfStartupRecoveryUnavailableNative();
    await expect(nativeModule.activateStartupCandidateNative(CANDIDATE_HASH, {
      maxCrashCount: 3,
      healthCheckMode: 'auto',
      healthyAfterSec: 0,
    })).resolves.toBeNull();
    await expect(nativeModule.markStartupHealthyNative({
      hash: ACTIVE_HASH,
      attemptId: 'attempt',
    })).resolves.toBe(false);
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();
    await expect(nativeModule.setStartupRecoveryRevokedHashesNative([FAILED_HASH])).resolves.toBe(false);
    await expect(nativeModule.acknowledgeStartupRecoveryNative('event')).resolves.toBe(false);
    await expect(nativeModule.rollbackStartupBundleNative(false)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const reactNative = require('react-native') as typeof import('react-native');
    reactNative.NativeModules.BundleDrop.startupRecoveryProtocolVersion = 1;
  });

  it('normalizes recovery snapshots and propagates native boolean results', async () => {
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.markStartupHealthy = jest.fn(async () => false);
      NativeModules.BundleDrop.setStartupRecoveryRevokedHashes = jest.fn(async () => false);
      NativeModules.BundleDrop.acknowledgeStartupRecovery = jest.fn(async () => false);
      NativeModules.BundleDrop.getStartupRecoveryState = jest.fn(async () => ({
        protocolVersion: 1,
        revision: 4,
        phase: 'launching',
        activeAttempt: {
          hash: ACTIVE_HASH,
          attemptId: 'attempt-4',
          status: 'launching',
          unacknowledgedLaunchCount: 1,
        },
        quarantinedHashes: [FAILED_HASH, FAILED_HASH, 'invalid'],
        pendingRecoveryEvents: [
          {
            id: 'event-1',
            failedHash: FAILED_HASH,
            recoveryTarget: 'previous',
            recoveredHash: STABLE_HASH,
            crashCount: 3,
            reason: 'crash_loop',
            failedAt: 1_700_000_000,
          },
          { id: '', failedHash: 'invalid' },
        ],
      }));
    });

    await expect(nativeModule.markStartupHealthyNative({
      hash: ACTIVE_HASH,
      attemptId: 'attempt-4',
    })).resolves.toBe(false);
    nativeModule.warnIfStartupRecoveryUnavailableNative();
    await expect(
      nativeModule.setStartupRecoveryRevokedHashesNative([FAILED_HASH, FAILED_HASH]),
    ).resolves.toBe(false);
    await expect(nativeModule.acknowledgeStartupRecoveryNative('event-1')).resolves.toBe(false);
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toEqual({
      protocolVersion: 1,
      revision: 4,
      phase: 'launching',
      activeAttempt: {
        hash: ACTIVE_HASH,
        attemptId: 'attempt-4',
        status: 'launching',
        unacknowledgedLaunchCount: 1,
      },
      quarantinedHashes: [FAILED_HASH],
      pendingRecoveryEvents: [
        {
          id: 'event-1',
          failedHash: FAILED_HASH,
          recoveryTarget: 'previous',
          recoveredHash: STABLE_HASH,
          crashCount: 3,
          reason: 'crash_loop',
          failedAt: 1_700_000_000,
        },
      ],
    });
  });

  it('normalizes the shared startup recovery v1 contract fixture', async () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), 'test-fixtures/startup-recovery-contract-v1.json'), 'utf8'),
    );
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.getStartupRecoveryState = jest.fn(async () => contract);
    });

    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toEqual({
      protocolVersion: 1,
      revision: 7,
      phase: 'launching',
      candidateHash: 'a'.repeat(64),
      stableHash: 'c'.repeat(64),
      activeAttempt: {
        hash: 'a'.repeat(64),
        attemptId: 'attempt-contract-v1',
        status: 'launching',
        unacknowledgedLaunchCount: 2,
      },
      policy: {
        maxCrashCount: 3,
        healthCheckMode: 'manual',
        healthyAfterSec: 4.5,
      },
      quarantinedHashes: ['b'.repeat(64)],
      pendingRecoveryEvents: [{
        id: 'event-contract-v1',
        failedHash: 'a'.repeat(64),
        recoveryTarget: 'previous',
        recoveredHash: 'c'.repeat(64),
        crashCount: 3,
        reason: 'crash_loop',
        failedAt: 1_700_000_000,
      }],
    });
  });

  it('rejects malformed recovery snapshots and filters malformed events', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getState = jest.fn<Promise<unknown>, []>();
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.getStartupRecoveryState = getState;
    });

    getState.mockResolvedValueOnce(null);
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({ protocolVersion: 0 });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: -1,
      phase: 'idle',
      quarantinedHashes: [],
      pendingRecoveryEvents: [],
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 1,
      phase: 'unknown',
      quarantinedHashes: [],
      pendingRecoveryEvents: [],
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 1,
      phase: 'idle',
      candidateHash: 'invalid',
      quarantinedHashes: [],
      pendingRecoveryEvents: [],
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 1,
      phase: 'idle',
      policy: 'invalid',
      quarantinedHashes: [],
      pendingRecoveryEvents: [],
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 1,
      phase: 'idle',
      policy: { maxCrashCount: -1, healthCheckMode: 'auto', healthyAfterSec: 0 },
      quarantinedHashes: [],
      pendingRecoveryEvents: [],
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 1,
      phase: 'idle',
      policy: { maxCrashCount: 1, healthCheckMode: 'auto', healthyAfterSec: -1 },
      quarantinedHashes: [],
      pendingRecoveryEvents: [],
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 1,
      phase: 'idle',
      quarantinedHashes: 'invalid',
      pendingRecoveryEvents: [],
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 1,
      phase: 'idle',
      quarantinedHashes: [],
      pendingRecoveryEvents: 'invalid',
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 1,
      phase: 'armed',
      policy: {
        maxCrashCount: 1,
        healthCheckMode: 'unknown',
        healthyAfterSec: 0,
      },
      quarantinedHashes: [],
      pendingRecoveryEvents: [],
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 1,
      phase: 'idle',
      activeAttempt: 'invalid',
      quarantinedHashes: 'invalid',
      pendingRecoveryEvents: 'invalid',
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toBeNull();

    getState.mockResolvedValueOnce({
      protocolVersion: 1,
      revision: 2,
      phase: 'idle',
      activeAttempt: null,
      quarantinedHashes: [],
      pendingRecoveryEvents: [
        null,
        {
          id: 'missing-failed-hash',
          failedHash: '',
          recoveryTarget: 'embedded',
          crashCount: 1,
          reason: 'crash_loop',
          failedAt: 1,
        },
        {
          id: 'invalid-crash-count',
          failedHash: FAILED_HASH,
          recoveryTarget: 'embedded',
          crashCount: -1,
          reason: 'crash_loop',
          failedAt: 1,
        },
        {
          id: 'invalid-failed-at',
          failedHash: FAILED_HASH,
          recoveryTarget: 'embedded',
          crashCount: 1,
          reason: 'crash_loop',
          failedAt: -1,
        },
        {
          id: 'invalid-reason',
          failedHash: FAILED_HASH,
          recoveryTarget: 'embedded',
          crashCount: 1,
          reason: 'other',
          failedAt: 1,
        },
        {
          id: 'invalid-target',
          failedHash: FAILED_HASH,
          recoveryTarget: 'other',
          crashCount: 1,
          reason: 'crash_loop',
          failedAt: 1,
        },
        {
          id: 'missing-previous-target',
          failedHash: FAILED_HASH,
          recoveryTarget: 'previous',
          crashCount: 1,
          reason: 'crash_loop',
          failedAt: 1,
        },
        {
          id: 'invalid-recovered-hash',
          failedHash: FAILED_HASH,
          recoveryTarget: 'embedded',
          recoveredHash: '',
          crashCount: 1,
          reason: 'crash_loop',
          failedAt: 1,
        },
        {
          id: 'embedded-event',
          failedHash: FAILED_HASH,
          recoveryTarget: 'embedded',
          crashCount: 1,
          reason: 'crash_loop',
          failedAt: 1,
        },
      ],
    });
    await expect(nativeModule.getStartupRecoveryStateNative()).resolves.toEqual({
      protocolVersion: 1,
      revision: 2,
      phase: 'idle',
      quarantinedHashes: [],
      pendingRecoveryEvents: [{
        id: 'embedded-event',
        failedHash: FAILED_HASH,
        recoveryTarget: 'embedded',
        crashCount: 1,
        reason: 'crash_loop',
        failedAt: 1,
      }],
    });

    expect(warnSpy).toHaveBeenCalledTimes(12);
    warnSpy.mockRestore();
  });

  it('returns null for missing launch attempts and malformed transaction results', async () => {
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.startupRecoveryAttemptHash = null;
      NativeModules.BundleDrop.startupRecoveryAttemptId = null;
      NativeModules.BundleDrop.activateStartupCandidate = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ hash: CANDIDATE_HASH });
      NativeModules.BundleDrop.rollbackStartupBundle = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ rolledBack: true, toEmbedded: false })
        .mockResolvedValueOnce({ rolledBack: true, toEmbedded: false, hash: '' });
    });
    const policy = {
      maxCrashCount: 3,
      healthCheckMode: 'manual' as const,
      healthyAfterSec: 4,
    };

    expect(nativeModule.getStartupRecoveryAttemptNative()).toBeNull();
    await expect(nativeModule.activateStartupCandidateNative(CANDIDATE_HASH, policy))
      .resolves.toBeNull();
    await expect(nativeModule.activateStartupCandidateNative(CANDIDATE_HASH, policy))
      .resolves.toBeNull();
    await expect(nativeModule.rollbackStartupBundleNative(false)).resolves.toBeNull();
    await expect(nativeModule.rollbackStartupBundleNative(false)).resolves.toEqual({
      rolledBack: true,
      toEmbedded: false,
    });
    await expect(nativeModule.rollbackStartupBundleNative(false)).resolves.toBeNull();
  });

  it('normalizes activation and rollback transaction results', async () => {
    const nativeModule = loadBundleDropNativeModule(({ NativeModules }) => {
      NativeModules.BundleDrop.activateStartupCandidate = jest.fn(async () => ({
        hash: CANDIDATE_HASH,
        bundlePath: `/bundles/${CANDIDATE_HASH}/main.jsbundle`,
      }));
      NativeModules.BundleDrop.rollbackStartupBundle = jest.fn(async () => ({
        rolledBack: true,
        toEmbedded: false,
        hash: STABLE_HASH,
      }));
    });

    await expect(nativeModule.activateStartupCandidateNative(CANDIDATE_HASH, {
      maxCrashCount: 3,
      healthCheckMode: 'auto',
      healthyAfterSec: 0,
    })).resolves.toEqual({
      hash: CANDIDATE_HASH,
      bundlePath: `/bundles/${CANDIDATE_HASH}/main.jsbundle`,
    });
    await expect(nativeModule.rollbackStartupBundleNative(false)).resolves.toEqual({
      rolledBack: true,
      toEmbedded: false,
      hash: STABLE_HASH,
    });
  });

  it.each([
    [{ maxCrashCount: -1, healthCheckMode: 'auto' as const, healthyAfterSec: 0 }, 'maxCrashCount'],
    [{ maxCrashCount: 1.5, healthCheckMode: 'auto' as const, healthyAfterSec: 0 }, 'maxCrashCount'],
    [{ maxCrashCount: 2_147_483_648, healthCheckMode: 'auto' as const, healthyAfterSec: 0 }, 'maxCrashCount'],
    [{ maxCrashCount: 1, healthCheckMode: 'auto' as const, healthyAfterSec: -1 }, 'healthyAfterSec'],
    [{ maxCrashCount: 1, healthCheckMode: 'auto' as const, healthyAfterSec: Number.NaN }, 'healthyAfterSec'],
  ])('rejects invalid startup policy before calling native: %j', async (policy, field) => {
    const nativeModule = loadBundleDropNativeModule();
    await expect(nativeModule.activateStartupCandidateNative(CANDIDATE_HASH, policy))
      .rejects.toThrow(field);
    expect(require('react-native').NativeModules.BundleDrop.activateStartupCandidate)
      .not.toHaveBeenCalled();
  });
});
