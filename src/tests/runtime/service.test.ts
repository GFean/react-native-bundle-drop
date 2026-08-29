type RuntimeServiceModule = typeof import('../../runtime/service');

const INIT_ERROR =
  'BundleDrop has not been initialized. Call BundleDrop.init({ environment, ... }) before using OTA APIs or useBundleDrop().';
const DISABLED_STATUS = 'BundleDrop is disabled';

const createBundleListItem = (hash = 'hash-12', bundleVersion = 12) => ({
  hash,
  bundleVersion,
  version: `1.0.${bundleVersion}`,
  platform: 'android' as const,
  runtimeVersion: '1.0.0',
  releaseNotes: null,
  createdAt: '2026-03-29T00:00:00.000Z',
  downloadUrl: `https://cdn.example.com/${hash}.zip`,
});

const loadRuntimeServiceModule = (overrides?: {
  rollbackResult?: { rolledBack: boolean; reason?: string };
  pendingState?: { hasBundle: boolean; info?: unknown; pendingApply: boolean };
  decision?: any;
  applyResult?: { status: 'applied' | 'noBundle' | 'disabled' | 'alreadyApplied' | 'blocked'; reason?: 'BUNDLE_PREVIOUSLY_FAILED'; skippedHash?: string };
  downloadResult?: { status: 'staged' | 'upToDate' | 'disabled' | 'incompatible' | 'rollback'; reason?: string; skippedFailedBundle?: boolean; skippedHash?: string };
  invokeCheckCallback?: boolean;
  invokeApplyCallback?: boolean;
  invokeDownloadCallback?: boolean;
  invokeInstallCallback?: boolean;
  onCheckStarted?: () => void;
  checkError?: Error;
  readBundleInfoError?: Error;
  channelsResult?: string[];
  channelsError?: Error;
  bundlesResult?: {
    items: unknown[];
    nextCursor: string | null;
    hasMore: boolean;
  };
  bundlesError?: Error;
  installResult?: { status: 'staged' | 'upToDate' | 'disabled' | 'incompatible' | 'rollback'; reason?: string };
  waitForCheck?: Promise<void>;
  waitForRecoveryTelemetry?: Promise<void>;
  recoveryTelemetryError?: Error;
  reportHealthyError?: Error;
  setOtaEnabledPromise?: Promise<void>;
  nativeModuleAvailable?: boolean;
  expoOtaStartupEnabled?: boolean;
  runtimeDeliveryMode?: 'v1' | 'shadow' | 'v2';
}) => {
  jest.resetModules();

  const downloadUpdate = jest.fn(async (_payload, onStatusUpdate?: (status: string) => void) => {
    if (overrides?.invokeDownloadCallback) {
      onStatusUpdate?.('download progress');
    }
    return overrides?.downloadResult ?? { status: 'staged' };
  });
  const installBundle = jest.fn(
    async (
      _hash?: string,
      _downloadUrl?: string,
      _bundleVersion?: number,
      _version?: string,
      _runtimeVersion?: string,
      options?: { onStatusUpdate?: (status: string) => void },
    ) => {
      if (overrides?.invokeInstallCallback) {
        options?.onStatusUpdate?.('install progress');
      }
      return overrides?.installResult ?? { status: 'staged' };
    },
  );
  const checkForUpdate = jest.fn(async (_channelName?: string, onStatusUpdate?: (status: string) => void) => {
    overrides?.onCheckStarted?.();
    if (overrides?.checkError) {
      throw overrides.checkError;
    }
    if (overrides?.invokeCheckCallback) {
      onStatusUpdate?.('check progress');
    }
    await overrides?.waitForCheck;
    return overrides?.decision ?? null;
  });
  const getAvailableChannels = jest.fn(async () => {
    if (overrides?.channelsError) {
      throw overrides.channelsError;
    }
    return overrides?.channelsResult ?? ['General', 'Beta'];
  });
  const getAvailableBundles = jest.fn(async () => {
    if (overrides?.bundlesError) {
      throw overrides.bundlesError;
    }
    return (
      overrides?.bundlesResult ?? {
        items: [{ hash: 'hash-1', bundleVersion: 1, version: '1.0.0' }],
        nextCursor: null,
        hasMore: false,
      }
    );
  });
  const applyUpdate = jest.fn(async (
    onStatusUpdate?: (status: string) => void,
    onBeforeRestart?: () => void,
  ) => {
    if (overrides?.invokeApplyCallback) {
      onStatusUpdate?.('apply progress');
    }
    const result = overrides?.applyResult ?? { status: 'applied' as const };
    if (result.status === 'applied') {
      onBeforeRestart?.();
    }
    return result;
  });
  const getUpdateState = jest.fn(async () =>
    overrides?.pendingState ?? { hasBundle: false, info: null, pendingApply: false }
  );
  const reconcileAppliedBundleOnLaunch = jest.fn<Promise<any>, [any?]>(
    async () => ({ hash: 'hash-1', pendingApply: false }),
  );
  const reportActiveBundleHealthy = jest.fn(async () => {
    if (overrides?.reportHealthyError) {
      throw overrides.reportHealthyError;
    }
    return true;
  });
  const readStartupRecoveryState = jest.fn(async () => ({
    protocolVersion: 1,
    revision: 0,
    phase: 'idle' as const,
    quarantinedHashes: [],
    pendingRecoveryEvents: [],
  }));
  const reconcileStartupRecovery = jest.fn(async (state: unknown) => {
    if (overrides?.recoveryTelemetryError) {
      throw overrides.recoveryTelemetryError;
    }
    await overrides?.waitForRecoveryTelemetry;
    return state;
  });
  const rollbackStartupBundle = jest.fn(async (forceEmbedded: boolean) => ({
    rolledBack: overrides?.rollbackResult?.rolledBack ?? true,
    toEmbedded: forceEmbedded,
    ...(forceEmbedded ? {} : { hash: 'c'.repeat(64) }),
  }));
  const readBundleInfo = jest.fn(async () => {
    if (overrides?.readBundleInfoError) {
      throw overrides.readBundleInfoError;
    }
    return { hash: 'hash-1', pendingApply: true };
  });
  const readCurrentBundleHash = jest.fn(async () => 'hash-1');
  const getDownloadedBundlePathNative = jest.fn(async () => '/bundles/hash-1/main.jsbundle');
  const restartReactNativeNative = jest.fn();
  const setOtaEnabledNative = jest.fn(async () => {
    await overrides?.setOtaEnabledPromise;
  });
  const warnIfStartupRecoveryUnavailableNative = jest.fn();

  jest.doMock('../../manager/downloadAndInstall', () => ({
    downloadUpdate,
    installBundle,
  }));
  jest.doMock('../../manager/updateCheck', () => ({
    checkForUpdate,
    getAvailableChannels,
    getAvailableBundles,
  }));
  jest.doMock('../../manager/updateState', () => ({
    applyUpdate,
    getUpdateState,
    reconcileAppliedBundleOnLaunch,
  }));
  jest.doMock('../../manager/rollbackState', () => ({
    readStartupRecoveryState,
    reconcileStartupRecovery,
    reportActiveBundleHealthy,
    rollbackStartupBundle,
  }));
  jest.doMock('../../bundleInfo', () => ({
    readBundleInfo,
  }));
  jest.doMock('../../context', () => ({
    config: {
      projectType: 'expo',
      runtimeDelivery: overrides?.runtimeDeliveryMode
        ? overrides.runtimeDeliveryMode === 'v2'
          ? {
              mode: 'v2',
              manifestBaseUrl: 'https://manifests.example.com',
              manifestAccessId: 'access-id',
              publicKeys: { key: {} },
            }
          : { mode: overrides.runtimeDeliveryMode }
        : undefined,
    },
    defaultChannel: 'General',
  }));
  jest.doMock('../../fs/bundlePointer', () => ({
    readCurrentBundleHash,
  }));
  jest.doMock('../../native/bundleDropNative', () => ({
    getDownloadedBundlePathNative,
    isBundleDropNativeAvailable: () => overrides?.nativeModuleAvailable ?? true,
    isExpoOtaStartupEnabledNative: () => overrides?.expoOtaStartupEnabled ?? true,
    restartReactNativeNative,
    setOtaEnabledNative,
    warnIfStartupRecoveryUnavailableNative,
  }));

  const service = require('../../runtime/service') as RuntimeServiceModule & {
    waitForBundleDropStartupForTests: () => Promise<void>;
  };

  return {
    service,
    mocks: {
      downloadUpdate,
      installBundle,
      checkForUpdate,
      getAvailableChannels,
      getAvailableBundles,
      applyUpdate,
      getUpdateState,
      reconcileAppliedBundleOnLaunch,
      reportActiveBundleHealthy,
      readStartupRecoveryState,
      reconcileStartupRecovery,
      rollbackStartupBundle,
      readBundleInfo,
      readCurrentBundleHash,
      getDownloadedBundlePathNative,
      restartReactNativeNative,
      setOtaEnabledNative,
      warnIfStartupRecoveryUnavailableNative,
    },
  };
};

describe('runtime/service', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('../../manager/downloadAndInstall');
    jest.unmock('../../manager/updateCheck');
    jest.unmock('../../manager/updateState');
    jest.unmock('../../manager/rollbackState');
    jest.unmock('../../bundleInfo');
    jest.unmock('../../context');
    jest.unmock('../../fs/bundlePointer');
    jest.unmock('../../native/bundleDropNative');
  });

  it('requires initialization before runtime actions can be used', async () => {
    const { service } = loadRuntimeServiceModule();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      service.setChannel('Beta');
      expect(service.getBundleDropSnapshot().channelName).toBe('General');
      await expect(service.checkLatest()).resolves.toEqual({
        response: null,
        status: DISABLED_STATUS,
      });
      await expect(service.fetchAvailableChannels()).resolves.toEqual([]);
      expect(service.getChannelName()).toBe('General');
      expect(warnSpy).toHaveBeenCalledWith(INIT_ERROR);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps Expo development runtimes usable when the native adapter is unavailable', async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const { service, mocks } = loadRuntimeServiceModule({ nativeModuleAvailable: false });

      service.initBundleDrop({ environment: 'development' });
      await service.waitForBundleDropStartupForTests();

      expect(service.getBundleDropSnapshot()).toMatchObject({
        status: DISABLED_STATUS,
        isEnabled: false,
        isBusy: false,
      });
      expect(mocks.setOtaEnabledNative).toHaveBeenCalledWith(false);
      expect(mocks.reconcileAppliedBundleOnLaunch).not.toHaveBeenCalled();
      await expect(service.checkLatest()).resolves.toEqual({
        response: null,
        status: DISABLED_STATUS,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[BundleDrop] OTA startup is unavailable in this Expo runtime. ' +
          'Expo Go and standard Debug/development-client builds keep Metro priority, so OTA features are disabled. ' +
          'Use a non-Debug/Release native build to test Bundle Drop updates.',
      );
    } finally {
      warnSpy.mockRestore();
      delete (globalThis as { __DEV__?: boolean }).__DEV__;
    }
  });

  it('disables OTA APIs when an Expo development client keeps Metro startup priority', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, mocks } = loadRuntimeServiceModule({
      nativeModuleAvailable: true,
      expoOtaStartupEnabled: false,
    });

    try {
      service.initBundleDrop({ environment: 'development' });
      await service.waitForBundleDropStartupForTests();

      expect(service.getBundleDropSnapshot()).toMatchObject({
        status: DISABLED_STATUS,
        isEnabled: false,
      });
      expect(mocks.setOtaEnabledNative).toHaveBeenCalledWith(false);
      expect(mocks.reconcileAppliedBundleOnLaunch).not.toHaveBeenCalled();
      await expect(service.checkLatest()).resolves.toEqual({
        response: null,
        status: DISABLED_STATUS,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('supports an explicit disabled init mode without starting OTA work', async () => {
    const { service, mocks } = loadRuntimeServiceModule();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      service.initBundleDrop({
        environment: 'development',
        enabled: false,
        channelName: 'Dev',
      });

      expect(mocks.reconcileAppliedBundleOnLaunch).not.toHaveBeenCalled();
      expect(mocks.reportActiveBundleHealthy).not.toHaveBeenCalled();
      expect(service.getBundleDropSnapshot()).toEqual({
        status: DISABLED_STATUS,
        isBusy: false,
        isEnabled: false,
        channelName: 'Dev',
        installedInfo: null,
        pendingApply: false,
        hasBundle: false,
        availableChannels: [],
      });

      service.setChannel('Beta');
      expect(service.getChannelName()).toBe('Beta');
      expect(service.getBundleDropSnapshot().channelName).toBe('Beta');

      await expect(service.checkLatest()).resolves.toEqual({
        response: null,
        status: DISABLED_STATUS,
      });
      await expect(service.downloadAndStage()).resolves.toEqual({
        result: { status: 'disabled' },
        status: DISABLED_STATUS,
      });
      await expect(service.applyDownloadedUpdate()).resolves.toEqual({
        result: { status: 'disabled' },
        status: DISABLED_STATUS,
      });
      await expect(service.reportHealthy()).resolves.toBeUndefined();
      await expect(service.fetchAvailableChannels()).resolves.toEqual([]);
      await expect(service.fetchAvailableBundles()).resolves.toEqual({
        items: [],
        nextCursor: null,
        hasMore: false,
      });
      await expect(service.installBundle('hash', 'https://cdn.example.com/hash.zip')).resolves.toEqual({
        status: 'disabled',
      });
      await expect(service.installBundleFromListItem({
        hash: 'hash',
        bundleVersion: 1,
        version: '1.0.0',
        platform: 'android',
        runtimeVersion: '1.0.0',
        releaseNotes: null,
        createdAt: '2026-03-29T00:00:00.000Z',
        downloadUrl: 'https://cdn.example.com/hash.zip',
      })).resolves.toEqual({
        result: { status: 'disabled' },
        status: DISABLED_STATUS,
      });
      await expect(service.getInstalledBundleInfo()).resolves.toBeNull();
      await expect(service.getRuntimeUpdateState()).resolves.toEqual({
        hasBundle: false,
        info: null,
        pendingApply: false,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'BundleDrop is disabled. OTA APIs are running in no-op mode because BundleDrop.init({ enabled: false, ... }) was used.',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('initializes once, runs local bootstrap in manual mode, and rejects different re-init config', async () => {
    const { service, mocks } = loadRuntimeServiceModule();

    service.initBundleDrop({
      environment: 'production',
      onStatusUpdate: jest.fn(),
    });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.reconcileAppliedBundleOnLaunch).toHaveBeenCalledTimes(1);
    expect(mocks.reportActiveBundleHealthy).not.toHaveBeenCalled();
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
    expect(service.getBundleDropSnapshot()).toMatchObject({
      isEnabled: true,
      channelName: 'General',
      isBusy: false,
      pendingApply: false,
      hasBundle: false,
    });

    service.setChannel('Beta');
    expect(service.getChannelName()).toBe('Beta');
    expect(service.getBundleDropSnapshot()).toMatchObject({
      isEnabled: true,
      channelName: 'Beta',
      status: 'Click the button to check for updates',
    });

    service.initBundleDrop({
      environment: 'production',
    });
    expect(mocks.reconcileAppliedBundleOnLaunch).toHaveBeenCalledTimes(1);
    expect(service.getChannelName()).toBe('Beta');
    expect(() =>
      service.initBundleDrop({
      environment: 'staging',
      }),
    ).toThrow('different runtime config');
  });

  it('preserves explicit reportHealthy while native owns automatic health timing', async () => {
    const { service, mocks } = loadRuntimeServiceModule();

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();
    expect(mocks.reportActiveBundleHealthy).not.toHaveBeenCalled();

    await service.reportHealthy();
    expect(mocks.reportActiveBundleHealthy).toHaveBeenCalledWith();
  });

  it('reports healthy without waiting for startup network work to finish', async () => {
    const unresolvedCheck = new Promise<void>(() => undefined);
    const { service, mocks } = loadRuntimeServiceModule({
      waitForCheck: unresolvedCheck,
    });

    service.initBundleDrop({ environment: 'production', policy: 'immediate' });
    await service.reportHealthy();

    expect(mocks.reportActiveBundleHealthy).toHaveBeenCalledWith();
  });

  it('does not block local startup on pending recovery telemetry delivery', async () => {
    const pendingTelemetry = new Promise<void>(() => undefined);
    const { service, mocks } = loadRuntimeServiceModule({
      waitForRecoveryTelemetry: pendingTelemetry,
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.reconcileStartupRecovery).toHaveBeenCalledTimes(1);
    expect(service.getBundleDropSnapshot().isBusy).toBe(false);
  });

  it('warns without failing startup when recovery telemetry reconciliation rejects', async () => {
    const telemetryError = new Error('telemetry unavailable');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service } = loadRuntimeServiceModule({
      recoveryTelemetryError: telemetryError,
    });

    try {
      service.initBundleDrop({ environment: 'production' });
      await service.waitForBundleDropStartupForTests();
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledWith(
        '⚠️ Failed to reconcile BundleDrop startup recovery telemetry:',
        telemetryError,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not report a candidate healthy after apply has requested a restart', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(service.applyDownloadedUpdate()).resolves.toEqual({
      result: { status: 'applied' },
      status: '✅ Update applied, reloading...',
    });
    await service.reportHealthy();

    expect(mocks.applyUpdate).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
    expect(mocks.reportActiveBundleHealthy).not.toHaveBeenCalled();
  });

  it('does not clear a pending restart guard on duplicate init', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();
    await service.applyDownloadedUpdate();

    service.initBundleDrop({ environment: 'production' });
    await service.reportHealthy();

    expect(mocks.reportActiveBundleHealthy).not.toHaveBeenCalled();
  });

  it('keeps a single active flow, exposes subscribers, and resets test state helpers', async () => {
    const { service } = loadRuntimeServiceModule();
    const listener = jest.fn();
    const unsubscribe = service.subscribeBundleDropState(listener);

    service.initBundleDrop({ environment: 'production' });
    expect(service.isUpdateFlowActive()).toBe(true);
    const pendingCheck = service.checkLatest();
    await expect(service.fetchAvailableChannels()).resolves.toEqual(['General', 'Beta']);
    await expect(service.fetchAvailableBundles()).resolves.toEqual({
      items: [{ hash: 'hash-1', bundleVersion: 1, version: '1.0.0' }],
      nextCursor: null,
      hasMore: false,
    });
    expect(() => service.setChannel('Beta')).toThrow('Another update flow is already in progress');
    await expect(pendingCheck).resolves.toEqual({
      response: null,
      status: '⚠️ Unable to check for updates. Try again.',
    });
    expect(listener).toHaveBeenCalled();
    expect(service.isUpdateFlowActive()).toBe(false);

    unsubscribe();
    service.resetBundleDropRuntimeServiceForTests();
    expect(service.getBundleDropSnapshot()).toEqual({
      status: 'BundleDrop is disabled',
      isBusy: false,
      isEnabled: false,
      channelName: 'General',
      installedInfo: null,
      pendingApply: false,
      hasBundle: false,
      availableChannels: [],
    });
  });

  it('rejects overlapping runtime update actions after startup has finished', async () => {
    let releaseCheck!: () => void;
    const waitForCheck = new Promise<void>(resolve => {
      releaseCheck = resolve;
    });
    const { service } = loadRuntimeServiceModule({
      waitForCheck,
      decision: { action: 'NOOP' },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    const pendingCheck = service.checkLatest();
    await expect(service.downloadAndStage()).rejects.toThrow('Another update flow is already in progress');

    releaseCheck();

    await expect(pendingCheck).resolves.toEqual({
      response: { action: 'NOOP' },
      status: '✅ You have the latest version',
    });
  });

  it('reconciles native startup recovery without making a JS rollback decision', async () => {
    const { service, mocks } = loadRuntimeServiceModule();

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.readStartupRecoveryState).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileStartupRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.rollbackStartupBundle).not.toHaveBeenCalled();
    expect(mocks.restartReactNativeNative).not.toHaveBeenCalled();
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });

  it('captures startup failures without leaking the lock', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { service } = loadRuntimeServiceModule({
      readBundleInfoError: new Error('prefetch failed'),
    });

    try {
      service.initBundleDrop({ environment: 'production' });
      await service.waitForBundleDropStartupForTests();
      expect(service.isUpdateFlowActive()).toBe(false);
      expect(service.getBundleDropSnapshot().status).toBe('⚠️ Failed to initialize BundleDrop');
      expect(consoleSpy).toHaveBeenCalledWith(
        '❌ BundleDrop startup failed:',
        expect.any(Error),
      );
      await expect(service.getObservabilityContext()).resolves.toMatchObject({
        source: 'embedded',
        dist: 'embedded',
        context: null,
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('applies a previously downloaded update immediately when policy is immediate', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: true,
        info: { hash: 'hash-1', pendingApply: true },
        pendingApply: true,
      },
      applyResult: { status: 'applied' },
    });
    const statusSpy = jest.fn();

    service.initBundleDrop({
      environment: 'production',
      policy: 'immediate',
      onStatusUpdate: statusSpy,
    });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.reconcileAppliedBundleOnLaunch).toHaveBeenCalled();
    expect(mocks.reportActiveBundleHealthy).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith('♻️ Applying previously downloaded update...');
    expect(mocks.applyUpdate).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });

  it('defers a pending update until the next launch when requested', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: true,
        info: { hash: 'hash-1', pendingApply: true },
        pendingApply: true,
      },
    });
    const statusSpy = jest.fn();

    service.initBundleDrop({
      environment: 'production',
      policy: 'on-next-launch',
      onStatusUpdate: statusSpy,
    });
    await service.waitForBundleDropStartupForTests();

    expect(statusSpy).toHaveBeenCalledWith('✅ Update downloaded; will apply on next launch.');
    expect(mocks.checkForUpdate).not.toHaveBeenCalled();
  });

  it('handles startup check-only failures, server rollback, and noop/incompatible responses', async () => {
    const failedCheck = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: null,
    });
    const failedStatus = jest.fn();

    failedCheck.service.initBundleDrop({
      environment: 'production',
      checkOnly: true,
      onStatusUpdate: failedStatus,
    });
    await failedCheck.service.waitForBundleDropStartupForTests();
    expect(failedStatus).toHaveBeenCalledWith('⚠️ Unable to check for updates. Try again.');

    const rollback = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: {
        action: 'ROLLBACK',
        reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
      },
    });
    const rollbackStatus = jest.fn();

    rollback.service.initBundleDrop({
      environment: 'production',
      checkOnly: true,
      onStatusUpdate: rollbackStatus,
    });
    await rollback.service.waitForBundleDropStartupForTests();
    expect(rollbackStatus).toHaveBeenCalledWith('↩️ Server requested rollback...');
    expect(rollback.mocks.rollbackStartupBundle).toHaveBeenCalledTimes(1);
    expect(rollback.mocks.rollbackStartupBundle).toHaveBeenCalledWith(true);
    expect(rollback.mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);

    const incompatible = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: {
        action: 'NOOP',
        incompatible: true,
      },
    });
    const incompatibleStatus = jest.fn();

    incompatible.service.initBundleDrop({
      environment: 'production',
      checkOnly: true,
      onStatusUpdate: incompatibleStatus,
    });
    await incompatible.service.waitForBundleDropStartupForTests();
    expect(incompatibleStatus).toHaveBeenCalledWith('⛔️ No compatible update for this binary');

    const upToDate = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: {
        action: 'NOOP',
        incompatible: false,
      },
    });
    const upToDateStatus = jest.fn();

    upToDate.service.initBundleDrop({
      environment: 'production',
      checkOnly: true,
      onStatusUpdate: upToDateStatus,
    });
    await upToDate.service.waitForBundleDropStartupForTests();
    expect(upToDateStatus).toHaveBeenCalledWith('✅ You have the latest version');
  });

  it.each([
    'CURRENT_REVOKED_NO_COMPATIBLE_TARGET',
    'CURRENT_REVOKED_NO_SAFE_TARGET',
    'CURRENT_REVOKED_ORIGIN_UNAVAILABLE',
  ])('forces native rollback for %s', async reason => {
    const { service, mocks } = loadRuntimeServiceModule({
      decision: { action: 'ROLLBACK', reason },
    });

    service.initBundleDrop({ environment: 'production', checkOnly: true });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.rollbackStartupBundle).toHaveBeenCalledWith(true);
  });

  it('preserves previous-or-native behavior for non-revocation rollback reasons', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      decision: { action: 'ROLLBACK', reason: 'SERVER_REQUESTED_ROLLBACK' },
    });

    service.initBundleDrop({ environment: 'production', checkOnly: true });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.rollbackStartupBundle).toHaveBeenCalledWith(false);
  });

  it.each(['immediate', 'on-next-launch'] as const)(
    'applies an authorization rollback during %s startup',
    async policy => {
      const { service, mocks } = loadRuntimeServiceModule({
        decision: {
          action: 'INSTALL',
          hash: 'new-hash',
          mode: 'full',
          runtimeDelivery: {
            generation: 7,
            targetReleaseRef: 'release-7',
            selectedMode: 'full',
          },
        },
        downloadResult: {
          status: 'rollback',
          reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
        },
      });

      service.initBundleDrop({ environment: 'production', policy });
      await service.waitForBundleDropStartupForTests();

      expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);
      expect(mocks.rollbackStartupBundle).toHaveBeenCalledWith(true);
      expect(mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);
      expect(mocks.applyUpdate).not.toHaveBeenCalled();
    },
  );

  it('preserves previous-or-native behavior for a non-revocation authorization rollback', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      decision: {
        action: 'INSTALL',
        hash: 'new-hash',
        downloadUrl: 'https://cdn.example/new.zip',
      },
      downloadResult: {
        status: 'rollback',
        reason: 'SERVER_REQUESTED_ROLLBACK',
      },
    });

    service.initBundleDrop({ environment: 'production', policy: 'immediate' });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.rollbackStartupBundle).toHaveBeenCalledWith(false);
    expect(mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);
    expect(mocks.applyUpdate).not.toHaveBeenCalled();
  });

  it('guards missing resolved targets and handles staged, up-to-date, and incompatible startup downloads', async () => {
    const missingTarget = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: {
        action: 'INSTALL',
        hash: 'hash-3',
      },
    });
    const missingStatus = jest.fn();

    missingTarget.service.initBundleDrop({
      environment: 'production',
      policy: 'on-next-launch',
      onStatusUpdate: missingStatus,
    });
    await missingTarget.service.waitForBundleDropStartupForTests();
    expect(missingStatus).toHaveBeenCalledWith('⚠️ Update available but missing download URL');
    expect(missingTarget.mocks.downloadUpdate).not.toHaveBeenCalled();

    const nextLaunch = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: {
        action: 'INSTALL',
        hash: 'hash-4',
        downloadUrl: 'https://cdn.example.com/hash-4.zip',
        manifestUrl: 'https://cdn.example.com/hash-4-manifest.json',
        bundleVersion: 4,
        version: '1.0.4',
        runtimeVersion: '1.0.0',
      },
      downloadResult: {
        status: 'staged',
      },
    });
    const nextLaunchStatus = jest.fn();

    nextLaunch.service.initBundleDrop({
      environment: 'production',
      policy: 'on-next-launch',
      channelName: 'Beta',
      onStatusUpdate: nextLaunchStatus,
    });
    await nextLaunch.service.waitForBundleDropStartupForTests();

    expect(nextLaunch.mocks.downloadUpdate).toHaveBeenCalledWith(
      {
        channelName: 'Beta',
        resolvedTarget: {
          hash: 'hash-4',
          downloadUrl: 'https://cdn.example.com/hash-4.zip',
          manifestUrl: 'https://cdn.example.com/hash-4-manifest.json',
          bundleVersion: 4,
          version: '1.0.4',
          runtimeVersion: '1.0.0',
        },
      },
      expect.any(Function),
    );
    expect(nextLaunchStatus).toHaveBeenCalledWith('✅ Update downloaded for next launch');

    const patchDecision = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: {
        action: 'INSTALL',
        hash: 'hash-patch-target',
        mode: 'patch',
        manifestUrl: 'https://cdn.example.com/hash-patch-target-manifest.json',
        baseHash: 'hash-patch-base',
        patchSet: {
          algorithm: 'xdelta3-vcdiff',
          patchSetHash: 'patch-set-hash',
          patchesUrl: 'https://cdn.example.com/patch-set.zip',
        },
        fallback: {
          mode: 'full',
          downloadUrl: 'https://cdn.example.com/hash-patch-target.zip',
        },
      },
      downloadResult: {
        status: 'staged',
      },
    });

    patchDecision.service.initBundleDrop({
      environment: 'production',
      policy: 'on-next-launch',
    });
    await patchDecision.service.waitForBundleDropStartupForTests();

    expect(patchDecision.mocks.downloadUpdate).toHaveBeenCalledWith(
      {
        channelName: 'General',
        resolvedTarget: {
          hash: 'hash-patch-target',
          downloadUrl: 'https://cdn.example.com/hash-patch-target.zip',
          manifestUrl: 'https://cdn.example.com/hash-patch-target-manifest.json',
          bundleVersion: undefined,
          version: undefined,
          runtimeVersion: undefined,
          mode: 'patch',
          baseHash: 'hash-patch-base',
          patchSet: {
            algorithm: 'xdelta3-vcdiff',
            patchSetHash: 'patch-set-hash',
            patchesUrl: 'https://cdn.example.com/patch-set.zip',
          },
          fallback: {
            mode: 'full',
            downloadUrl: 'https://cdn.example.com/hash-patch-target.zip',
          },
        },
      },
      expect.any(Function),
    );

    const immediate = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: {
        action: 'INSTALL',
        hash: 'hash-5',
        downloadUrl: 'https://cdn.example.com/hash-5.zip',
      },
      downloadResult: {
        status: 'staged',
      },
      applyResult: {
        status: 'applied',
      },
    });

    immediate.service.initBundleDrop({
      environment: 'production',
      policy: 'immediate',
    });
    await immediate.service.waitForBundleDropStartupForTests();

    expect(immediate.mocks.downloadUpdate).toHaveBeenCalled();
    expect(immediate.mocks.applyUpdate).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));

    const upToDate = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: {
        action: 'INSTALL',
        hash: 'hash-6',
        downloadUrl: 'https://cdn.example.com/hash-6.zip',
      },
      invokeDownloadCallback: true,
      downloadResult: {
        status: 'upToDate',
      },
    });

    upToDate.service.initBundleDrop({
      environment: 'production',
      policy: 'on-next-launch',
    });
    await upToDate.service.waitForBundleDropStartupForTests();
    expect(upToDate.mocks.downloadUpdate).toHaveBeenCalled();

    const incompatible = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
      decision: {
        action: 'INSTALL',
        hash: 'hash-7',
        downloadUrl: 'https://cdn.example.com/hash-7.zip',
      },
      downloadResult: {
        status: 'incompatible',
      },
    });
    const incompatibleStatus = jest.fn();

    incompatible.service.initBundleDrop({
      environment: 'production',
      policy: 'immediate',
      onStatusUpdate: incompatibleStatus,
    });
    await incompatible.service.waitForBundleDropStartupForTests();
    expect(incompatibleStatus).toHaveBeenCalledWith('⛔️ No compatible update for this binary');
    expect(incompatible.mocks.applyUpdate).not.toHaveBeenCalled();
  });

  it('preserves v2 authorization context through manual, next-launch, immediate, and check-only startup policies', async () => {
    const v2Decision = {
      action: 'INSTALL',
      hash: 'hash-v2',
      bundleVersion: 7,
      runtimeVersion: '1.0.0',
      mode: 'full',
      runtimeDelivery: {
        generation: 7,
        targetReleaseRef: 'release-v2',
        selectedMode: 'full',
      },
    };

    const manual = loadRuntimeServiceModule({
      pendingState: { hasBundle: false, info: null, pendingApply: false },
      decision: v2Decision,
    });
    manual.service.initBundleDrop({ environment: 'production', policy: 'manual' });
    await manual.service.waitForBundleDropStartupForTests();
    expect(manual.mocks.downloadUpdate).not.toHaveBeenCalled();

    const nextLaunch = loadRuntimeServiceModule({
      pendingState: { hasBundle: false, info: null, pendingApply: false },
      decision: v2Decision,
    });
    nextLaunch.service.initBundleDrop({ environment: 'production', policy: 'on-next-launch' });
    await nextLaunch.service.waitForBundleDropStartupForTests();
    expect(nextLaunch.mocks.downloadUpdate).toHaveBeenCalledWith({
      channelName: 'General',
      resolvedTarget: expect.objectContaining({
        hash: 'hash-v2',
        downloadUrl: undefined,
        runtimeDelivery: v2Decision.runtimeDelivery,
      }),
    }, expect.any(Function));

    const immediate = loadRuntimeServiceModule({
      pendingState: { hasBundle: false, info: null, pendingApply: false },
      decision: v2Decision,
    });
    immediate.service.initBundleDrop({ environment: 'production', policy: 'immediate' });
    await immediate.service.waitForBundleDropStartupForTests();
    expect(immediate.mocks.downloadUpdate).toHaveBeenCalled();
    expect(immediate.mocks.applyUpdate).toHaveBeenCalled();

    const checkOnly = loadRuntimeServiceModule({
      pendingState: { hasBundle: false, info: null, pendingApply: false },
      decision: v2Decision,
    });
    checkOnly.service.initBundleDrop({
      environment: 'production',
      policy: 'immediate',
      checkOnly: true,
    });
    await checkOnly.service.waitForBundleDropStartupForTests();
    expect(checkOnly.mocks.downloadUpdate).not.toHaveBeenCalled();
  });

  it('exposes runtime actions, fetch fallbacks, and install helpers through the singleton service', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      decision: {
        action: 'INSTALL',
        hash: 'hash-9',
        downloadUrl: 'https://cdn.example.com/hash-9.zip',
        bundleVersion: 9,
      },
      downloadResult: { status: 'staged' },
      invokeCheckCallback: true,
      invokeApplyCallback: true,
      invokeDownloadCallback: true,
      pendingState: {
        hasBundle: true,
        info: { hash: 'hash-9', pendingApply: true },
        pendingApply: true,
      },
      channelsResult: ['General', 'Beta'],
      bundlesResult: {
        items: [{ hash: 'hash-9', bundleVersion: 9, version: '1.0.9' }],
        nextCursor: 'cursor-2',
        hasMore: true,
      },
      installResult: { status: 'staged' },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    const checkStatusSpy = jest.fn();
    await expect(service.checkLatest(checkStatusSpy)).resolves.toEqual({
      response: {
        action: 'INSTALL',
        hash: 'hash-9',
        downloadUrl: 'https://cdn.example.com/hash-9.zip',
        bundleVersion: 9,
      },
      status: '⬇️ Update available (v9)',
    });
    expect(checkStatusSpy).toHaveBeenCalledWith('check progress');

    const downloadStatusSpy = jest.fn();
    await expect(service.downloadAndStage(downloadStatusSpy)).resolves.toEqual({
      result: { status: 'staged' },
      status: '✅ Update downloaded. Will apply on next launch or when you call applyUpdate.',
    });
    expect(downloadStatusSpy).toHaveBeenCalled();

    const applyStatusSpy = jest.fn();
    await expect(service.applyDownloadedUpdate(applyStatusSpy)).resolves.toEqual({
      result: { status: 'applied' },
      status: '✅ Update applied, reloading...',
    });
    expect(applyStatusSpy).toHaveBeenCalledWith('apply progress');

    await expect(service.fetchAvailableChannels()).resolves.toEqual(['General', 'Beta']);
    await expect(service.fetchAvailableBundles({ limit: 20 })).resolves.toEqual({
      items: [{ hash: 'hash-9', bundleVersion: 9, version: '1.0.9' }],
      nextCursor: 'cursor-2',
      hasMore: true,
    });

    await expect(
      service.installBundleFromListItem({
        hash: 'hash-9',
        bundleVersion: 9,
        version: '1.0.9',
        platform: 'android',
        runtimeVersion: '1.0.0',
        releaseNotes: null,
        createdAt: '2026-03-29T00:00:00.000Z',
        downloadUrl: 'https://cdn.example.com/hash-9.zip',
      }),
    ).resolves.toEqual({
      result: { status: 'staged' },
      status: '✅ v9 downloaded. Will apply on next launch or when you call applyUpdate.',
    });

    await expect(service.getInstalledBundleInfo()).resolves.toEqual({ hash: 'hash-9', pendingApply: true });
    await expect(service.getRuntimeUpdateState()).resolves.toEqual({
      hasBundle: true,
      info: { hash: 'hash-9', pendingApply: true },
      pendingApply: true,
    });

    await expect(service.checkForUpdate()).resolves.toEqual({
      action: 'INSTALL',
      hash: 'hash-9',
      downloadUrl: 'https://cdn.example.com/hash-9.zip',
      bundleVersion: 9,
    });
    await expect(service.downloadUpdate()).resolves.toEqual({ status: 'staged' });
    await expect(service.applyUpdate()).resolves.toEqual({ status: 'applied' });
    await expect(service.getAvailableChannels()).resolves.toEqual(['General', 'Beta']);
    await expect(service.getAvailableBundles()).resolves.toEqual({
      items: [{ hash: 'hash-9', bundleVersion: 9, version: '1.0.9' }],
      nextCursor: 'cursor-2',
      hasMore: true,
    });
    await expect(
      service.installBundle('hash-9', 'https://cdn.example.com/hash-9.zip', 9, '1.0.9', '1.0.0'),
    ).resolves.toEqual({ status: 'staged' });

    expect(mocks.installBundle).toHaveBeenCalled();
    expect(service.getBundleDropSnapshot()).toMatchObject({
      availableChannels: ['General', 'Beta'],
      status: '✅ Update downloaded. Will apply on next launch or when you call applyUpdate.',
    });
  });

  it('maps rollback and no-bundle/already-applied statuses for direct runtime actions', async () => {
    const rollbackDownload = loadRuntimeServiceModule({
      decision: {
        action: 'ROLLBACK',
        reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
      },
      downloadResult: { status: 'rollback', reason: 'CURRENT_REVOKED_NO_SAFE_TARGET' },
    });

    rollbackDownload.service.initBundleDrop({ environment: 'production' });
    await rollbackDownload.service.waitForBundleDropStartupForTests();
    await expect(rollbackDownload.service.checkLatest()).resolves.toEqual({
      response: {
        action: 'ROLLBACK',
        reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
      },
      status: '↩️ Rollback requested: CURRENT_REVOKED_NO_SAFE_TARGET',
    });
    expect(rollbackDownload.mocks.rollbackStartupBundle).not.toHaveBeenCalled();
    expect(rollbackDownload.mocks.restartReactNativeNative).not.toHaveBeenCalled();

    await expect(rollbackDownload.service.downloadAndStage()).resolves.toEqual({
      result: { status: 'rollback', reason: 'CURRENT_REVOKED_NO_SAFE_TARGET' },
      status: '↩️ Rollback requested: CURRENT_REVOKED_NO_SAFE_TARGET',
    });
    expect(rollbackDownload.mocks.rollbackStartupBundle).toHaveBeenCalledWith(true);
    expect(rollbackDownload.mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);

    const noBundleApply = loadRuntimeServiceModule({
      applyResult: { status: 'noBundle' },
    });

    noBundleApply.service.initBundleDrop({ environment: 'production' });
    await noBundleApply.service.waitForBundleDropStartupForTests();
    await expect(noBundleApply.service.applyDownloadedUpdate()).resolves.toEqual({
      result: { status: 'noBundle' },
      status: '⚠️ No downloaded bundle to apply',
    });

    const alreadyApplied = loadRuntimeServiceModule({
      applyResult: { status: 'alreadyApplied' },
    });

    alreadyApplied.service.initBundleDrop({ environment: 'production' });
    await alreadyApplied.service.waitForBundleDropStartupForTests();
    await expect(alreadyApplied.service.applyDownloadedUpdate()).resolves.toEqual({
      result: { status: 'alreadyApplied' },
      status: 'ℹ️ Bundle already applied',
    });

    const blockedApply = loadRuntimeServiceModule({
      applyResult: { status: 'blocked', reason: 'BUNDLE_PREVIOUSLY_FAILED', skippedHash: 'hash-bad' },
    });

    blockedApply.service.initBundleDrop({ environment: 'production' });
    await blockedApply.service.waitForBundleDropStartupForTests();
    await expect(blockedApply.service.applyDownloadedUpdate()).resolves.toEqual({
      result: { status: 'blocked', reason: 'BUNDLE_PREVIOUSLY_FAILED', skippedHash: 'hash-bad' },
      status: '⚠️ Update previously failed on this device',
    });
  });

  it('maps local quarantine no-op statuses for checks and downloads', async () => {
    const { service } = loadRuntimeServiceModule({
      decision: {
        action: 'NOOP',
        upToDate: false,
        reason: 'BUNDLE_PREVIOUSLY_FAILED',
        skippedFailedBundle: true,
        skippedHash: 'hash-bad',
      },
      downloadResult: {
        status: 'upToDate',
        reason: 'BUNDLE_PREVIOUSLY_FAILED',
        skippedFailedBundle: true,
        skippedHash: 'hash-bad',
      },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(service.checkLatest()).resolves.toEqual({
      response: {
        action: 'NOOP',
        upToDate: false,
        reason: 'BUNDLE_PREVIOUSLY_FAILED',
        skippedFailedBundle: true,
        skippedHash: 'hash-bad',
      },
      status: '✅ Current bundle retained; requested update previously failed on this device',
    });
    await expect(service.downloadAndStage()).resolves.toEqual({
      result: {
        status: 'upToDate',
        reason: 'BUNDLE_PREVIOUSLY_FAILED',
        skippedFailedBundle: true,
        skippedHash: 'hash-bad',
      },
      status: '✅ Current bundle retained; requested update previously failed on this device',
    });
  });

  it('executes previous-or-native rollback for manual downloads without an explicit reason', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      decision: {
        action: 'ROLLBACK',
      },
      downloadResult: { status: 'rollback' },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(service.checkLatest()).resolves.toEqual({
      response: { action: 'ROLLBACK' },
      status: '↩️ Rollback requested',
    });
    expect(mocks.rollbackStartupBundle).not.toHaveBeenCalled();
    expect(mocks.restartReactNativeNative).not.toHaveBeenCalled();

    await expect(service.downloadAndStage()).resolves.toEqual({
      result: { status: 'rollback' },
      status: '↩️ Rollback requested',
    });
    expect(mocks.rollbackStartupBundle).toHaveBeenCalledWith(false);
    expect(mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);
  });

  it('returns empty fetch fallbacks and guards bundle list items without download urls', async () => {
    const { service } = loadRuntimeServiceModule({
      channelsError: new Error('channels failed'),
      bundlesError: new Error('bundles failed'),
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(service.fetchAvailableChannels()).resolves.toEqual([]);
    await expect(service.fetchAvailableBundles()).resolves.toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    await expect(
      service.installBundleFromListItem({
        hash: 'hash-10',
        bundleVersion: 10,
        version: '1.0.10',
        platform: 'android',
        runtimeVersion: '1.0.0',
        releaseNotes: null,
        createdAt: '2026-03-29T00:00:00.000Z',
        downloadUrl: null,
      }),
    ).resolves.toEqual({
      result: { status: 'incompatible' },
      status: '⚠️ Bundle is not downloadable (expired or unavailable)',
    });
  });

  it('uses resolved patch transport when an authoritative v2 target matches the selected bundle', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      runtimeDeliveryMode: 'v2',
      decision: {
        action: 'INSTALL',
        hash: 'hash-12',
        bundleHash: 'hash-12',
        mode: 'patch',
        baseHash: 'hash-11',
        manifestUrl: 'https://cdn.example.com/hash-12.manifest.json',
        patchSet: {
          algorithm: 'xdelta3-vcdiff',
          patchSetHash: 'patch-set-hash',
          patchesUrl: 'https://cdn.example.com/hash-11-to-hash-12.patch.zip',
        },
        fallback: {
          mode: 'full',
          downloadUrl: 'https://cdn.example.com/hash-12-full.zip',
        },
        bundleVersion: 12,
        version: '1.0.12',
        runtimeVersion: '1.0.0',
      },
      downloadResult: { status: 'staged' },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(
      service.installBundleFromListItem(createBundleListItem()),
    ).resolves.toEqual({
      result: { status: 'staged' },
      status: '✅ v12 downloaded. Will apply on next launch or when you call applyUpdate.',
    });

    expect(mocks.downloadUpdate).toHaveBeenCalledWith(
      {
        channelName: 'General',
        resolvedTarget: expect.objectContaining({
          hash: 'hash-12',
          downloadUrl: 'https://cdn.example.com/hash-12-full.zip',
          mode: 'patch',
          baseHash: 'hash-11',
          manifestUrl: 'https://cdn.example.com/hash-12.manifest.json',
          patchSet: expect.objectContaining({
            patchSetHash: 'patch-set-hash',
          }),
        }),
      },
      expect.any(Function),
    );
    expect(mocks.installBundle).not.toHaveBeenCalled();
  });

  it('applies an authoritative rollback instead of installing a selected v2 bundle', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      runtimeDeliveryMode: 'v2',
      decision: {
        action: 'ROLLBACK',
        reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
      },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(
      service.installBundleFromListItem(createBundleListItem()),
    ).resolves.toEqual({
      result: { status: 'rollback', reason: 'CURRENT_REVOKED_NO_SAFE_TARGET' },
      status: '↩️ Rollback requested: CURRENT_REVOKED_NO_SAFE_TARGET',
    });

    expect(mocks.rollbackStartupBundle).toHaveBeenCalledWith(true);
    expect(mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.installBundle).not.toHaveBeenCalled();
  });

  it('applies a rollback returned by v2 list-item artifact authorization', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      runtimeDeliveryMode: 'v2',
      decision: {
        action: 'INSTALL',
        hash: 'hash-12',
        runtimeDelivery: {
          generation: 12,
          targetReleaseRef: 'release-12',
          selectedMode: 'full',
        },
      },
      downloadResult: {
        status: 'rollback',
        reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
      },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(
      service.installBundleFromListItem(createBundleListItem()),
    ).resolves.toEqual({
      result: { status: 'rollback', reason: 'CURRENT_REVOKED_NO_SAFE_TARGET' },
      status: '↩️ Rollback requested: CURRENT_REVOKED_NO_SAFE_TARGET',
    });

    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.rollbackStartupBundle).toHaveBeenCalledWith(true);
    expect(mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);
    expect(mocks.installBundle).not.toHaveBeenCalled();
  });

  it.each([
    ['a different INSTALL target', { action: 'INSTALL', hash: 'other-hash' }, undefined],
    ['a NOOP decision', { action: 'NOOP', reason: 'UP_TO_DATE' }, undefined],
    ['an empty decision', null, undefined],
    ['a resolve failure', null, new Error('resolve unavailable')],
  ])('fails closed for managed list installs after %s', async (_case, decision, checkError) => {
    const { service, mocks } = loadRuntimeServiceModule({
      runtimeDeliveryMode: 'v2',
      decision,
      checkError,
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(
      service.installBundleFromListItem(createBundleListItem()),
    ).resolves.toEqual({
      result: { status: 'incompatible' },
      status: '⚠️ Selected bundle is not authorized by the current runtime delivery decision',
    });

    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.installBundle).not.toHaveBeenCalled();
  });

  it.each(['v1', 'shadow'] as const)(
    'preserves direct list-item fallback for the deprecated %s config when resolve fails',
    async runtimeDeliveryMode => {
      const { service, mocks } = loadRuntimeServiceModule({
        runtimeDeliveryMode,
        checkError: new Error('resolve unavailable'),
        installResult: { status: 'staged' },
      });

      service.initBundleDrop({ environment: 'production' });
      await service.waitForBundleDropStartupForTests();

      await expect(
        service.installBundleFromListItem(createBundleListItem('hash-13', 13)),
      ).resolves.toEqual({
        result: { status: 'staged' },
        status: '✅ v13 downloaded. Will apply on next launch or when you call applyUpdate.',
      });

      expect(mocks.installBundle).toHaveBeenCalledWith(
        'hash-13',
        'https://cdn.example.com/hash-13.zip',
        13,
        '1.0.13',
        '1.0.0',
        expect.objectContaining({
          channelName: 'General',
        }),
      );
    },
  );

  it('blocks direct URL installs with managed runtime delivery', async () => {
    const { service, mocks } = loadRuntimeServiceModule({ runtimeDeliveryMode: 'v2' });
    const statusSpy = jest.fn();

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(
      service.installBundle(
        'hash-12',
        'https://cdn.example.com/hash-12.zip',
        12,
        '1.0.12',
        '1.0.0',
        statusSpy,
      ),
    ).resolves.toEqual({ status: 'incompatible' });

    expect(statusSpy).toHaveBeenCalledWith(
      '⚠️ Direct URL installs are unavailable with managed runtime delivery; use downloadUpdate or a bundle-list item',
    );
    expect(mocks.installBundle).not.toHaveBeenCalled();
  });

  it.each(['v1', 'shadow'] as const)(
    'preserves direct URL installs for the deprecated %s config',
    async runtimeDeliveryMode => {
      const { service, mocks } = loadRuntimeServiceModule({
        runtimeDeliveryMode,
        installResult: { status: 'staged' },
      });

      service.initBundleDrop({ environment: 'production' });
      await service.waitForBundleDropStartupForTests();

      await expect(
        service.installBundle(
          'hash-12',
          'https://cdn.example.com/hash-12.zip',
          12,
          '1.0.12',
          '1.0.0',
        ),
      ).resolves.toEqual({ status: 'staged' });

      expect(mocks.installBundle).toHaveBeenCalledTimes(1);
    },
  );

  it('uses the active runtime channel for singleton actions while still allowing bundle list overrides', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      decision: {
        action: 'INSTALL',
        hash: 'hash-12',
        downloadUrl: 'https://cdn.example.com/hash-12.zip',
      },
      bundlesResult: {
        items: [{ hash: 'hash-12', bundleVersion: 12, version: '1.0.12' }],
        nextCursor: null,
        hasMore: false,
      },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    service.setChannel('Beta');

    await service.checkLatest();
    await service.downloadAndStage();
    await service.fetchAvailableBundles();
    await service.fetchAvailableBundles({ channelName: 'Gamma', limit: 10 });

    expect(mocks.checkForUpdate).toHaveBeenNthCalledWith(1, 'Beta', expect.any(Function));
    expect(mocks.downloadUpdate).toHaveBeenCalledWith(
      { channelName: 'Beta' },
      expect.any(Function),
    );
    expect(mocks.getAvailableBundles).toHaveBeenNthCalledWith(1, {
      channelName: 'Beta',
    });
    expect(mocks.getAvailableBundles).toHaveBeenNthCalledWith(2, {
      channelName: 'Gamma',
      limit: 10,
    });
  });

  it('returns null installed info when local metadata is empty', async () => {
    const { service } = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: false,
        info: null,
        pendingApply: false,
      },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    await expect(service.getInstalledBundleInfo()).resolves.toBeNull();
  });

  it('returns undefined status for non-staged bundle installs and relays explicit install progress callbacks', async () => {
    const { service, mocks } = loadRuntimeServiceModule({
      installResult: { status: 'incompatible' },
      invokeInstallCallback: true,
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    const installProgressSpy = jest.fn();
    await expect(
      service.installBundle(
        'hash-11',
        'https://cdn.example.com/hash-11.zip',
        11,
        '1.0.11',
        '1.0.0',
        installProgressSpy,
      ),
    ).resolves.toEqual({ status: 'incompatible' });
    expect(installProgressSpy).toHaveBeenCalledWith('install progress');

    await expect(
      service.installBundleFromListItem({
        hash: 'hash-11',
        bundleVersion: 11,
        version: '1.0.11',
        platform: 'android',
        runtimeVersion: '1.0.0',
        releaseNotes: null,
        createdAt: '2026-03-29T00:00:00.000Z',
        downloadUrl: 'https://cdn.example.com/hash-11.zip',
      }),
    ).resolves.toEqual({
      result: { status: 'incompatible' },
      status: '⛔️ No compatible update for this binary',
    });
    expect(mocks.installBundle).toHaveBeenCalledTimes(2);
  });

  it('returns embedded observability context when no OTA bundle is installed', async () => {
    const { service } = loadRuntimeServiceModule({
      pendingState: { hasBundle: false, info: null, pendingApply: false },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    const ctx = await service.getObservabilityContext();
    expect(ctx).toEqual({
      source: 'embedded',
      dist: 'embedded',
      tags: {
        bundle_drop_hash: null,
        bundle_drop_channel: null,
        bundle_drop_version: null,
        bundle_drop_runtime_version: null,
        bundle_drop_platform: null,
      },
      context: null,
    });
  });

  it('returns embedded observability context when the bundle is pending apply', async () => {
    const { service } = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: true,
        info: { hash: 'pending-hash', channelName: 'General', bundleVersion: 5, pendingApply: true, platform: 'android', runtimeVersion: '2.0.0' },
        pendingApply: true,
      },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    const ctx = await service.getObservabilityContext();
    expect(ctx.source).toBe('embedded');
    expect(ctx.dist).toBe('embedded');
    expect(ctx.context).toBeNull();
  });

  it('returns ota observability context with tags when an active bundle is installed', async () => {
    const info = {
      hash: 'abc123',
      channelName: 'General',
      bundleVersion: 12,
      platform: 'android' as const,
      runtimeVersion: '3.0.0',
      pendingApply: false,
      installedAt: '2026-05-08T10:00:00.000Z',
    };
    const { service } = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: true,
        info,
        pendingApply: false,
      },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    const ctx = await service.getObservabilityContext();
    expect(ctx).toEqual({
      source: 'ota',
      dist: 'abc123',
      tags: {
        bundle_drop_hash: 'abc123',
        bundle_drop_channel: 'General',
        bundle_drop_version: '12',
        bundle_drop_runtime_version: '3.0.0',
        bundle_drop_platform: 'android',
      },
      context: info,
    });
  });

  it('returns embedded observability context for sparse bundle info without hash', async () => {
    const info = {
      pendingApply: false,
      installedAt: '2026-05-08T10:00:00.000Z',
    };
    const { service } = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: true,
        info,
        pendingApply: false,
      },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    const ctx = await service.getObservabilityContext();
    expect(ctx).toEqual({
      source: 'embedded',
      dist: 'embedded',
      tags: {
        bundle_drop_hash: null,
        bundle_drop_channel: null,
        bundle_drop_version: null,
        bundle_drop_runtime_version: null,
        bundle_drop_platform: null,
      },
      context: null,
    });
  });

  it('returns ota observability context with null fallbacks for partial bundle info', async () => {
    const info = {
      hash: 'partial-hash',
      pendingApply: false,
    };
    const { service } = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: true,
        info,
        pendingApply: false,
      },
    });

    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    const ctx = await service.getObservabilityContext();
    expect(ctx).toEqual({
      source: 'ota',
      dist: 'partial-hash',
      tags: {
        bundle_drop_hash: 'partial-hash',
        bundle_drop_channel: null,
        bundle_drop_version: null,
        bundle_drop_runtime_version: null,
        bundle_drop_platform: null,
      },
      context: info,
    });
  });

  it('returns embedded observability context when BundleDrop is disabled', async () => {
    const { service } = loadRuntimeServiceModule();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.initBundleDrop({ environment: 'production', enabled: false });
    await service.waitForBundleDropStartupForTests();

    const ctx = await service.getObservabilityContext();
    expect(ctx.source).toBe('embedded');
    expect(ctx.dist).toBe('embedded');
    warnSpy.mockRestore();
  });

  it('calls setOtaEnabledNative(true) when init is called with enabled: true', async () => {
    const { service, mocks } = loadRuntimeServiceModule();
    service.initBundleDrop({ environment: 'production', enabled: true });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.setOtaEnabledNative).toHaveBeenCalledWith(true);
  });

  it('calls setOtaEnabledNative(false) when init is called with enabled: false', async () => {
    const { service, mocks } = loadRuntimeServiceModule();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.initBundleDrop({ environment: 'production', enabled: false });

    expect(mocks.setOtaEnabledNative).toHaveBeenCalledWith(false);
    warnSpy.mockRestore();
  });

  it('calls setOtaEnabledNative(true) by default when enabled is omitted', async () => {
    const { service, mocks } = loadRuntimeServiceModule();
    service.initBundleDrop({ environment: 'production' });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.setOtaEnabledNative).toHaveBeenCalledWith(true);
  });

  it('waits for native OTA enablement before reading the Android bundle path', async () => {
    let resolveNativeEnable!: () => void;
    const nativeEnablePromise = new Promise<void>(resolve => {
      resolveNativeEnable = resolve;
    });
    const { service, mocks } = loadRuntimeServiceModule({
      setOtaEnabledPromise: nativeEnablePromise,
    });

    service.initBundleDrop({ environment: 'production' });
    const startup = service.waitForBundleDropStartupForTests();
    await Promise.resolve();

    expect(mocks.setOtaEnabledNative).toHaveBeenCalledWith(true);
    expect(mocks.getDownloadedBundlePathNative).not.toHaveBeenCalled();

    resolveNativeEnable();
    await startup;

    expect(mocks.getDownloadedBundlePathNative).toHaveBeenCalled();
  });

  it('getObservabilityContext waits for local startup before reading state', async () => {
    let resolveReconcile!: () => void;
    const reconcilePromise = new Promise<void>(resolve => {
      resolveReconcile = resolve;
    });

    const { service, mocks } = loadRuntimeServiceModule({
      pendingState: {
        hasBundle: true,
        info: { hash: 'startup-hash', channelName: 'General', bundleVersion: 1, pendingApply: false, platform: 'android', runtimeVersion: '1.0.0' },
        pendingApply: false,
      },
    });

    mocks.reconcileAppliedBundleOnLaunch.mockImplementation(async () => {
      await reconcilePromise;
    });

    service.initBundleDrop({ environment: 'production' });

    let contextResolved = false;
    const contextPromise = service.getObservabilityContext().then(ctx => {
      contextResolved = true;
      return ctx;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(contextResolved).toBe(false);

    resolveReconcile();
    const ctx = await contextPromise;
    expect(contextResolved).toBe(true);
    expect(ctx.source).toBe('ota');
    expect(ctx.dist).toBe('startup-hash');
  });

  it('getObservabilityContext does not wait for startup network checks', async () => {
    let resolveCheck!: () => void;
    const waitForCheck = new Promise<void>(resolve => {
      resolveCheck = resolve;
    });
    let resolveCheckStarted!: () => void;
    const checkStarted = new Promise<void>(resolve => {
      resolveCheckStarted = resolve;
    });

    const { service, mocks } = loadRuntimeServiceModule({
      decision: { action: 'NOOP' },
      waitForCheck,
      onCheckStarted: resolveCheckStarted,
      pendingState: {
        hasBundle: true,
        info: {
          hash: 'local-ready-hash',
          channelName: 'General',
          bundleVersion: 6,
          pendingApply: false,
          platform: 'android',
          runtimeVersion: '1.0.0',
        },
        pendingApply: false,
      },
    });

    service.initBundleDrop({ environment: 'production', checkOnly: true });

    let fullStartupResolved = false;
    const fullStartupPromise = service.waitForBundleDropStartupForTests().then(() => {
      fullStartupResolved = true;
    });

    await checkStarted;

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(() => service.setChannel('Beta')).toThrow('Another update flow is already in progress');

    await expect(service.getObservabilityContext()).resolves.toMatchObject({
      source: 'ota',
      dist: 'local-ready-hash',
    });
    expect(fullStartupResolved).toBe(false);

    resolveCheck();
    await fullStartupPromise;

    expect(fullStartupResolved).toBe(true);
  });

  it('runtime update APIs wait for full startup before entering manager calls', async () => {
    let resolveStartupCheck!: () => void;
    const waitForCheck = new Promise<void>(resolve => {
      resolveStartupCheck = resolve;
    });
    let resolveCheckStarted!: () => void;
    const checkStarted = new Promise<void>(resolve => {
      resolveCheckStarted = resolve;
    });

    const { service, mocks } = loadRuntimeServiceModule({
      decision: { action: 'NOOP' },
      waitForCheck,
      onCheckStarted: resolveCheckStarted,
    });

    service.initBundleDrop({ environment: 'production', checkOnly: true });
    await checkStarted;

    const checkLatestPromise = service.checkLatest();

    await Promise.resolve();
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);

    resolveStartupCheck();

    await expect(checkLatestPromise).resolves.toEqual({
      response: { action: 'NOOP' },
      status: '✅ You have the latest version',
    });
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('keeps observability tied to the launched bundle when server rollback changes stored metadata', async () => {
    const runningInfo = {
      hash: 'running-hash',
      channelName: 'General',
      bundleVersion: 10,
      pendingApply: false,
      platform: 'android' as const,
      runtimeVersion: '1.0.0',
    };
    const rolledBackInfo = {
      hash: 'rolled-back-hash',
      channelName: 'General',
      bundleVersion: 9,
      pendingApply: false,
      platform: 'android' as const,
      runtimeVersion: '1.0.0',
    };

    const { service, mocks } = loadRuntimeServiceModule({
      decision: {
        action: 'ROLLBACK',
        reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
      },
    });

    mocks.getUpdateState
      .mockResolvedValueOnce({
        hasBundle: true,
        info: runningInfo,
        pendingApply: false,
      })
      .mockResolvedValueOnce({
        hasBundle: true,
        info: runningInfo,
        pendingApply: false,
      })
      .mockResolvedValue({
        hasBundle: true,
        info: rolledBackInfo,
        pendingApply: false,
      });

    service.initBundleDrop({ environment: 'production', checkOnly: true });
    await service.waitForBundleDropStartupForTests();

    expect(mocks.rollbackStartupBundle).toHaveBeenCalledTimes(1);

    await expect(service.getObservabilityContext()).resolves.toEqual({
      source: 'ota',
      dist: 'running-hash',
      tags: {
        bundle_drop_hash: 'running-hash',
        bundle_drop_channel: 'General',
        bundle_drop_version: '10',
        bundle_drop_runtime_version: '1.0.0',
        bundle_drop_platform: 'android',
      },
      context: runningInfo,
    });
  });

  it('returns embedded observability context when getObservabilityContext runs before init', async () => {
    const { service } = loadRuntimeServiceModule();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ctx = await service.getObservabilityContext();
      expect(ctx).toEqual({
        source: 'embedded',
        dist: 'embedded',
        tags: {
          bundle_drop_hash: null,
          bundle_drop_channel: null,
          bundle_drop_version: null,
          bundle_drop_runtime_version: null,
          bundle_drop_platform: null,
        },
        context: null,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
