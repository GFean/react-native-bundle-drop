import type { ReactTestRenderer } from 'react-test-renderer';

type UseBundleDropModule = typeof import('../useBundleDrop');
const DISABLED_STATUS = 'BundleDrop is disabled';

const loadUseBundleDropModule = (overrides?: {
  runtimeConfig?: {
    environment: string;
    enabled: boolean;
    channelName: string;
    policy: 'manual' | 'immediate' | 'on-next-launch';
    checkOnly: boolean;
  } | null;
  snapshot?: {
    status: string;
    isEnabled: boolean;
    isBusy: boolean;
    channelName: string;
    installedInfo: unknown;
    pendingApply: boolean;
    hasBundle: boolean;
    availableChannels: string[];
  };
}) => {
  jest.resetModules();

  let currentListener: (() => void) | null = null;
  let snapshot =
    overrides?.snapshot ?? {
      status: 'Ready',
      isEnabled: true,
      isBusy: false,
      channelName: 'General',
      installedInfo: { hash: 'hash-1', pendingApply: true },
      pendingApply: true,
      hasBundle: true,
      availableChannels: ['General', 'Beta'],
    };

  const getBundleDropRuntimeConfigOrWarn = jest.fn(() =>
    overrides?.runtimeConfig === undefined
      ? {
          environment: 'production',
          enabled: true,
          channelName: 'General',
          policy: 'manual',
          checkOnly: false,
        }
      : overrides.runtimeConfig
  );
  const checkLatest = jest.fn(async () => ({ response: null, status: 'Checked' }));
  const downloadAndStage = jest.fn(async () => ({ result: { status: 'staged' }, status: 'Downloaded' }));
  const applyDownloadedUpdate = jest.fn(async () => ({ result: { status: 'applied' }, status: 'Applied' }));
  const reportHealthy = jest.fn(async () => undefined);
  const fetchAvailableChannels = jest.fn(async () => ['General', 'Beta']);
  const fetchAvailableBundles = jest.fn(async () => ({ items: [], nextCursor: null, hasMore: false }));
  const installBundleFromListItem = jest.fn(async () => ({ result: { status: 'staged' }, status: 'Installed' }));
  const setChannel = jest.fn();
  const subscribeBundleDropState = jest.fn((listener: () => void) => {
    currentListener = listener;
    return () => {
      currentListener = null;
    };
  });
  const getBundleDropSnapshot = jest.fn(() => snapshot);

  jest.doMock('../runtime/initState', () => ({
    getBundleDropRuntimeConfigOrWarn,
  }));
  jest.doMock('../runtime/service', () => ({
    applyDownloadedUpdate,
    reportHealthy,
    checkLatest,
    downloadAndStage,
    fetchAvailableBundles,
    fetchAvailableChannels,
    getBundleDropSnapshot,
    installBundleFromListItem,
    setChannel,
    subscribeBundleDropState,
  }));

  const React = require('react') as typeof import('react');
  const TestRenderer = require('react-test-renderer') as typeof import('react-test-renderer');
  const module = require('../useBundleDrop') as UseBundleDropModule;

  let latest: ReturnType<UseBundleDropModule['useBundleDrop']> | null = null;
  const HookHost = () => {
    latest = module.useBundleDrop();
    return null;
  };

  let renderer!: ReactTestRenderer;

  const mount = async () => {
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(React.createElement(HookHost));
    });
  };

  const emit = async (nextSnapshot: typeof snapshot) => {
    snapshot = nextSnapshot;
    await TestRenderer.act(async () => {
      currentListener?.();
    });
  };

  return {
    mount,
    emit,
    getLatest: () => latest!,
    unmount: () => renderer.unmount(),
    mocks: {
      getBundleDropRuntimeConfigOrWarn,
      checkLatest,
      downloadAndStage,
      applyDownloadedUpdate,
      reportHealthy,
      fetchAvailableChannels,
      fetchAvailableBundles,
      installBundleFromListItem,
      setChannel,
      subscribeBundleDropState,
    },
  };
};

describe('useBundleDrop', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('../runtime/initState');
    jest.unmock('../runtime/service');
  });

  it('does not throw when BundleDrop.init has not run and exposes the disabled snapshot', async () => {
    const harness = loadUseBundleDropModule({
      runtimeConfig: null,
      snapshot: {
        status: DISABLED_STATUS,
        isEnabled: false,
        isBusy: false,
        channelName: 'General',
        installedInfo: null,
        pendingApply: false,
        hasBundle: false,
        availableChannels: [],
      },
    });

    await harness.mount();
    expect(harness.mocks.getBundleDropRuntimeConfigOrWarn).toHaveBeenCalledTimes(1);
    expect(harness.getLatest()).toMatchObject({
      status: DISABLED_STATUS,
      isEnabled: false,
      isBusy: false,
      channelName: 'General',
      installedInfo: null,
      pendingApply: false,
      hasBundle: false,
      availableChannels: [],
    });
  });

  it('subscribes to the singleton runtime snapshot and exposes singleton actions', async () => {
    const harness = loadUseBundleDropModule();

    await harness.mount();
    expect(harness.mocks.getBundleDropRuntimeConfigOrWarn).toHaveBeenCalledTimes(1);
    expect(harness.mocks.subscribeBundleDropState).toHaveBeenCalledTimes(1);
    expect(harness.getLatest()).toMatchObject({
      status: 'Ready',
      isEnabled: true,
      isBusy: false,
      channelName: 'General',
      installedInfo: { hash: 'hash-1', pendingApply: true },
      pendingApply: true,
      hasBundle: true,
      availableChannels: ['General', 'Beta'],
    });

    expect(harness.getLatest().checkLatest).toBe(harness.mocks.checkLatest);
    expect(harness.getLatest().downloadUpdate).toBe(harness.mocks.downloadAndStage);
    expect(harness.getLatest().applyUpdate).toBe(harness.mocks.applyDownloadedUpdate);
    expect(harness.getLatest().reportHealthy).toBe(harness.mocks.reportHealthy);
    expect(harness.getLatest().fetchAvailableChannels).toBe(harness.mocks.fetchAvailableChannels);
    expect(harness.getLatest().fetchBundles).toBe(harness.mocks.fetchAvailableBundles);
    expect(harness.getLatest().installBundle).toBe(harness.mocks.installBundleFromListItem);
    expect(harness.getLatest().setChannel).toBe(harness.mocks.setChannel);

    await harness.emit({
      status: 'Updated',
      isEnabled: true,
      isBusy: true,
      channelName: 'Beta',
      installedInfo: { hash: 'hash-2', pendingApply: false },
      pendingApply: false,
      hasBundle: true,
      availableChannels: ['Stable'],
    });

    expect(harness.getLatest()).toMatchObject({
      status: 'Updated',
      isEnabled: true,
      isBusy: true,
      channelName: 'Beta',
      installedInfo: { hash: 'hash-2', pendingApply: false },
      pendingApply: false,
      hasBundle: true,
      availableChannels: ['Stable'],
    });
  });
});
