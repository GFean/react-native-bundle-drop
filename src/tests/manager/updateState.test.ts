type UpdateStateModule = typeof import('../../manager/updateState');

const loadUpdateStateModule = (overrides?: {
  bundlePath?: string | null;
  bundleInfo?: Record<string, unknown> | null;
  readBundleInfoError?: Error;
  updateBundleInfoError?: Error;
  reportError?: Error;
  failedHash?: string;
  recoveredManifest?: Record<string, unknown> | null;
  recoveredMetadata?: Record<string, unknown> | null;
  platform?: 'ios' | 'android';
}) => {
  jest.resetModules();

  const readBundleInfo = jest.fn(async () => {
    if (overrides?.readBundleInfoError) {
      throw overrides.readBundleInfoError;
    }
    return overrides?.bundleInfo ?? null;
  });
  const updateBundleInfo = jest.fn(async (_partial: Record<string, unknown>) => {
    if (overrides?.updateBundleInfoError) {
      throw overrides.updateBundleInfoError;
    }
  });
  const writeBundleInfoDurably = jest.fn(async (_info: Record<string, unknown>) => undefined);
  const deleteBundleInfo = jest.fn(async () => undefined);
  const reportInstalledIfReady = jest.fn(async (_state?: unknown) => {
    if (overrides?.reportError) {
      throw overrides.reportError;
    }
  });
  const getDownloadedBundlePathNative = jest.fn(async () =>
    overrides?.bundlePath !== undefined ? overrides.bundlePath : null
  );
  const restartReactNativeNative = jest.fn();
  const isBundleHashFailed = jest.fn(async (hash?: string | null) => !!hash && hash === overrides?.failedHash);
  const verifyBundleDir = jest.fn(async () => overrides?.recoveredManifest ?? null);
  const readJsonFile = jest.fn(async () => overrides?.recoveredMetadata ?? {});
  const fsExists = jest.fn(async () => overrides?.recoveredMetadata != null);

  jest.doMock('../../bundleInfo', () => ({
    readBundleInfo,
    updateBundleInfo,
    writeBundleInfoDurably,
    deleteBundleInfo,
  }));
  jest.doMock('../../manager/reporting', () => ({
    reportInstalledIfReady,
  }));
  jest.doMock('../../native/bundleDropNative', () => ({
    getDownloadedBundlePathNative,
    restartReactNativeNative,
  }));
  jest.doMock('../../manager/rollbackState', () => ({
    isBundleHashFailed,
  }));
  jest.doMock('../../install/bundleVerification', () => ({
    verifyBundleDir,
    readJsonFile,
  }));
  jest.doMock('../../native/fs', () => ({
    __esModule: true,
    default: { exists: fsExists },
  }));
  jest.doMock('../../context', () => ({
    platform: overrides?.platform ?? 'android',
  }));

  const module = require('../../manager/updateState') as UpdateStateModule;
  return {
    module,
    mocks: {
      readBundleInfo,
      updateBundleInfo,
      writeBundleInfoDurably,
      deleteBundleInfo,
      reportInstalledIfReady,
      getDownloadedBundlePathNative,
      restartReactNativeNative,
      isBundleHashFailed,
      verifyBundleDir,
      readJsonFile,
    },
  };
};

describe('manager/updateState', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('../../bundleInfo');
    jest.unmock('../../manager/reporting');
    jest.unmock('../../native/bundleDropNative');
    jest.unmock('../../manager/rollbackState');
    jest.unmock('../../install/bundleVerification');
    jest.unmock('../../native/fs');
    jest.unmock('../../context');
  });

  it('returns cached update state without re-reading dependencies', async () => {
    const { module, mocks } = loadUpdateStateModule();

    await expect(
      module.getUpdateState({
        bundleInfo: { hash: 'cached-hash', pendingApply: true } as never,
        bundlePath: '/bundles/cached/main.jsbundle',
      })
    ).resolves.toEqual({
      hasBundle: true,
      info: { hash: 'cached-hash', pendingApply: true },
      pendingApply: true,
    });

    expect(mocks.readBundleInfo).not.toHaveBeenCalled();
    expect(mocks.getDownloadedBundlePathNative).not.toHaveBeenCalled();
  });

  it('reads update state from dependencies and defaults pendingApply to false', async () => {
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: '/bundles/hash-0/main.jsbundle',
      bundleInfo: null,
    });

    await expect(module.getUpdateState()).resolves.toEqual({
      hasBundle: true,
      info: null,
      pendingApply: false,
    });

    expect(mocks.readBundleInfo).toHaveBeenCalledTimes(1);
    expect(mocks.getDownloadedBundlePathNative).toHaveBeenCalledTimes(1);
  });

  it('reconciles pending applied bundles on launch and reports in the background', async () => {
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: '/bundles/hash-1/main.jsbundle',
      bundleInfo: {
        hash: 'hash-1',
        pendingApply: true,
        channelName: 'General',
      },
    });

    await module.reconcileAppliedBundleOnLaunch();

    expect(mocks.updateBundleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingApply: false,
        installedAt: expect.any(String),
      })
    );
    expect(mocks.reportInstalledIfReady).toHaveBeenCalledWith({
      hasBundle: true,
      info: expect.objectContaining({
        hash: 'hash-1',
        pendingApply: false,
        channelName: 'General',
      }),
    });
  });

  it('skips reconciliation when there is no downloaded bundle and retries unreported installs', async () => {
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: null,
      bundleInfo: {
        hash: 'hash-1',
        pendingApply: true,
      },
    });

    await module.reconcileAppliedBundleOnLaunch();

    expect(mocks.updateBundleInfo).not.toHaveBeenCalled();
    expect(mocks.reportInstalledIfReady).not.toHaveBeenCalled();
    expect(mocks.deleteBundleInfo).toHaveBeenCalledTimes(1);

    const noPending = loadUpdateStateModule({
      bundlePath: '/bundles/hash-1/main.jsbundle',
      bundleInfo: {
        hash: 'hash-1',
        pendingApply: false,
      },
    });

    await noPending.module.reconcileAppliedBundleOnLaunch();

    expect(noPending.mocks.updateBundleInfo).not.toHaveBeenCalled();
    expect(noPending.mocks.reportInstalledIfReady).toHaveBeenCalledWith({
      hasBundle: true,
      info: {
        hash: 'hash-1',
        pendingApply: false,
      },
      pendingApply: false,
    });

    const noPendingReportFailure = loadUpdateStateModule({
      bundlePath: '/bundles/hash-2/main.jsbundle',
      bundleInfo: {
        hash: 'hash-2',
        pendingApply: false,
      },
      reportError: new Error('report failed'),
    });

    await expect(noPendingReportFailure.module.reconcileAppliedBundleOnLaunch()).resolves.toEqual({
      hash: 'hash-2',
      pendingApply: false,
    });
    await Promise.resolve();
    expect(noPendingReportFailure.mocks.updateBundleInfo).not.toHaveBeenCalled();
    expect(noPendingReportFailure.mocks.reportInstalledIfReady).toHaveBeenCalledTimes(1);
  });

  it('does not block launch reconciliation when install reporting fails', async () => {
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: '/bundles/hash-4/main.jsbundle',
      bundleInfo: {
        hash: 'hash-4',
        pendingApply: true,
        channelName: 'General',
      },
      reportError: new Error('report failed'),
    });

    await expect(module.reconcileAppliedBundleOnLaunch()).resolves.toMatchObject({
      hash: 'hash-4',
      pendingApply: false,
    });
    await Promise.resolve();

    expect(mocks.updateBundleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingApply: false,
      })
    );
    expect(mocks.reportInstalledIfReady).toHaveBeenCalledTimes(1);
  });

  it('reconstructs recovered metadata from the executing verified bundle', async () => {
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: '/bundles/stable-hash/main.jsbundle',
      bundleInfo: {
        hash: 'failed-hash',
        channelName: 'Failed candidate channel',
        runtimeVersion: 'failed-runtime',
        version: 'failed-version',
        bundleVersion: 99,
        pendingApply: true,
        installedReportedHashes: ['stable-hash'],
      },
      recoveredManifest: {
        bundleHash: 'stable-hash',
        runtimeVersion: 'stable-runtime',
        version: '2.1.0',
      },
      recoveredMetadata: {
        bundleVersion: 21,
        runtimeVersion: 'metadata-runtime',
        version: 'metadata-version',
      },
    });

    await expect(module.reconcileAppliedBundleOnLaunch({
      bundleInfo: {
        hash: 'failed-hash',
        channelName: 'Failed candidate channel',
        runtimeVersion: 'failed-runtime',
        pendingApply: true,
        installedReportedHashes: ['stable-hash'],
      },
      bundlePath: '/bundles/stable-hash/main.jsbundle',
      currentHash: 'stable-hash',
    })).resolves.toEqual({
      hash: 'stable-hash',
      bundleVersion: 21,
      version: '2.1.0',
      runtimeVersion: 'stable-runtime',
      platform: 'android',
      installedAt: expect.any(String),
      pendingApply: false,
      lastInstalledReportedHash: 'stable-hash',
      installedReportedHashes: ['stable-hash'],
    });

    expect(mocks.verifyBundleDir).toHaveBeenCalledWith(
      '/bundles/stable-hash',
      'stable-hash',
      'android',
    );
    expect(mocks.writeBundleInfoDurably).toHaveBeenCalledWith(
      expect.not.objectContaining({ channelName: 'Failed candidate channel' }),
    );
  });

  it('reconstructs an iOS recovery without optional metadata and ignores report failures', async () => {
    const { module, mocks } = loadUpdateStateModule({
      platform: 'ios',
      bundlePath: '/bundles/stable-hash/main.jsbundle',
      bundleInfo: {
        hash: 'failed-hash',
        pendingApply: true,
      },
      recoveredManifest: {
        bundleHash: 'stable-hash',
        runtimeVersion: 'stable-runtime',
        version: '2.2.0',
      },
      recoveredMetadata: null,
      reportError: new Error('offline'),
    });

    await expect(module.reconcileAppliedBundleOnLaunch({
      bundleInfo: { hash: 'failed-hash', pendingApply: true },
      bundlePath: '/bundles/stable-hash/main.jsbundle',
      currentHash: 'stable-hash',
    })).resolves.toEqual({
      hash: 'stable-hash',
      bundleVersion: undefined,
      version: '2.2.0',
      runtimeVersion: 'stable-runtime',
      platform: 'ios',
      installedAt: expect.any(String),
      pendingApply: false,
      lastInstalledReportedHash: undefined,
      installedReportedHashes: undefined,
    });
    await Promise.resolve();

    expect(mocks.readJsonFile).not.toHaveBeenCalled();
    expect(mocks.reportInstalledIfReady).toHaveBeenCalledTimes(1);
  });

  it('returns null metadata when a downloaded bundle has no stored bundle info', async () => {
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: '/bundles/untracked/main.jsbundle',
      bundleInfo: null,
    });

    await expect(module.reconcileAppliedBundleOnLaunch()).resolves.toBeNull();
    expect(mocks.reportInstalledIfReady).toHaveBeenCalledWith({
      hasBundle: true,
      info: null,
      pendingApply: false,
    });
  });

  it('returns noBundle and alreadyApplied when apply preconditions fail', async () => {
    const noBundle = loadUpdateStateModule({
      bundlePath: null,
      bundleInfo: { pendingApply: true },
    });
    const noBundleStatus = jest.fn();

    await expect(noBundle.module.applyUpdate(noBundleStatus)).resolves.toEqual({
      status: 'noBundle',
    });
    expect(noBundleStatus).toHaveBeenCalledWith('⚠️ No downloaded bundle to apply');
    expect(noBundle.mocks.restartReactNativeNative).not.toHaveBeenCalled();

    const alreadyApplied = loadUpdateStateModule({
      bundlePath: '/bundles/hash-1/main.jsbundle',
      bundleInfo: { hash: 'hash-1', pendingApply: false },
    });
    const alreadyAppliedStatus = jest.fn();

    await expect(alreadyApplied.module.applyUpdate(alreadyAppliedStatus)).resolves.toEqual({
      status: 'alreadyApplied',
    });
    expect(alreadyAppliedStatus).toHaveBeenCalledWith('ℹ️ Bundle already applied');
    expect(alreadyApplied.mocks.restartReactNativeNative).not.toHaveBeenCalled();
  });

  it('applies the downloaded bundle and defers install reporting until restart', async () => {
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: '/bundles/hash-2/main.jsbundle',
      bundleInfo: {
        hash: 'hash-2',
        pendingApply: true,
        channelName: 'General',
        platform: 'android',
      },
    });
    const statusSpy = jest.fn();
    const beforeRestartSpy = jest.fn();

    await expect(module.applyUpdate(statusSpy, beforeRestartSpy)).resolves.toEqual({
      status: 'applied',
    });

    expect(statusSpy).toHaveBeenCalledWith('♻️ Applying downloaded bundle...');
    expect(mocks.updateBundleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingApply: false,
        installedAt: expect.any(String),
      })
    );
    expect(mocks.reportInstalledIfReady).not.toHaveBeenCalled();
    expect(beforeRestartSpy).toHaveBeenCalledTimes(1);
    expect(beforeRestartSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.restartReactNativeNative.mock.invocationCallOrder[0],
    );
    expect(mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);
  });

  it('applies when bundle info is missing without reporting during apply', async () => {
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: '/bundles/hash-null/main.jsbundle',
      bundleInfo: null,
    });

    await expect(module.applyUpdate()).resolves.toEqual({
      status: 'applied',
    });

    expect(mocks.reportInstalledIfReady).not.toHaveBeenCalled();
    expect(mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);
  });

  it('does not report installed during apply because restart reconciliation owns it', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: '/bundles/hash-3/main.jsbundle',
      bundleInfo: {
        hash: 'hash-3',
        pendingApply: true,
      },
      reportError: new Error('telemetry failed'),
    });

    await expect(module.applyUpdate()).resolves.toEqual({
      status: 'applied',
    });

    expect(mocks.updateBundleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingApply: false,
      })
    );
    expect(mocks.restartReactNativeNative).toHaveBeenCalledTimes(1);
    expect(mocks.reportInstalledIfReady).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('blocks applying a bundle that previously failed on this device', async () => {
    const { module, mocks } = loadUpdateStateModule({
      bundlePath: '/bundles/hash-failed/main.jsbundle',
      bundleInfo: {
        hash: 'hash-failed',
        pendingApply: true,
      },
      failedHash: 'hash-failed',
    });
    const statusSpy = jest.fn();

    await expect(module.applyUpdate(statusSpy)).resolves.toEqual({
      status: 'blocked',
      reason: 'BUNDLE_PREVIOUSLY_FAILED',
      skippedHash: 'hash-failed',
    });
    expect(statusSpy).toHaveBeenCalledWith('⚠️ Update previously failed on this device');
    expect(mocks.restartReactNativeNative).not.toHaveBeenCalled();
    expect(mocks.reportInstalledIfReady).not.toHaveBeenCalled();
  });

  it('wraps apply failures in a BundleDropError', async () => {
    const { module } = loadUpdateStateModule({
      bundlePath: '/bundles/hash-4/main.jsbundle',
      bundleInfo: {
        hash: 'hash-4',
        pendingApply: true,
      },
      updateBundleInfoError: new Error('disk full'),
    });

    await expect(module.applyUpdate()).rejects.toEqual(
      expect.objectContaining({
        name: 'BundleDropError',
        code: 'APPLY_FAILED',
        step: 'apply',
      })
    );
  });
});
