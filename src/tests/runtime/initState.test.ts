jest.mock('../../context', () => ({
  defaultChannel: 'General',
}));

import {
  assertBundleDropInitialized,
  BUNDLE_DROP_DISABLED_MESSAGE,
  BUNDLE_DROP_NOT_INITIALIZED_MESSAGE,
  getBundleDropRuntimeConfig,
  getBundleDropRuntimeConfigOrWarn,
  hasBundleDropBeenInitialized,
  initializeBundleDropRuntime,
  resetBundleDropRuntimeForTests,
  resolveBundleDropRuntimeConfig,
  setBundleDropChannel,
} from '../../runtime/initState';

describe('runtime/initState', () => {
  beforeEach(() => {
    resetBundleDropRuntimeForTests();
  });

  it('requires initialization before runtime config can be read', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(hasBundleDropBeenInitialized()).toBe(false);
    expect(getBundleDropRuntimeConfig()).toBeNull();
    expect(getBundleDropRuntimeConfigOrWarn()).toBeNull();
    expect(getBundleDropRuntimeConfigOrWarn()).toBeNull();
    expect(() => assertBundleDropInitialized()).toThrow(
      'BundleDrop has not been initialized',
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(BUNDLE_DROP_NOT_INITIALIZED_MESSAGE);
    warnSpy.mockRestore();
  });

  it('normalizes init config, trims strings, and defaults channel/policy/checkOnly', () => {
    expect(
      resolveBundleDropRuntimeConfig({
        environment: '  production  ',
      }),
    ).toEqual({
      environment: 'production',
      enabled: true,
      channelName: 'General',
      policy: 'manual',
      onStatusUpdate: undefined,
      checkOnly: false,
    });

    const onStatusUpdate = jest.fn();
    const initialized = initializeBundleDropRuntime({
      environment: 'staging',
      channelName: '  Beta ',
      policy: 'immediate',
      onStatusUpdate,
      checkOnly: true,
    });

    expect(initialized).toEqual({
      alreadyInitialized: false,
      config: {
        environment: 'staging',
        enabled: true,
        channelName: 'Beta',
        policy: 'immediate',
        onStatusUpdate,
        checkOnly: true,
      },
    });
    expect(hasBundleDropBeenInitialized()).toBe(true);
    expect(getBundleDropRuntimeConfig()).toEqual(initialized.config);
    expect(assertBundleDropInitialized()).toEqual(initialized.config);
  });

  it('rejects invalid environments and different re-init config while allowing callback refresh on same config', () => {
    expect(() =>
      initializeBundleDropRuntime({
        environment: 123 as unknown as string,
      }),
    ).toThrow('requires a string environment');
    expect(() =>
      initializeBundleDropRuntime({
        environment: '   ',
      }),
    ).toThrow('requires a non-empty environment');

    const firstStatusHandler = jest.fn();
    initializeBundleDropRuntime({
      environment: 'production',
      channelName: 'General',
      onStatusUpdate: firstStatusHandler,
    });

    const secondStatusHandler = jest.fn();
    const reinitialized = initializeBundleDropRuntime({
      environment: 'production',
      channelName: 'General',
      onStatusUpdate: secondStatusHandler,
    });

    expect(reinitialized.alreadyInitialized).toBe(true);
    expect(reinitialized.config.onStatusUpdate).toBe(secondStatusHandler);

    expect(setBundleDropChannel('  Beta ')).toEqual({
      environment: 'production',
      enabled: true,
      channelName: 'Beta',
      policy: 'manual',
      onStatusUpdate: secondStatusHandler,
      checkOnly: false,
    });
    expect(getBundleDropRuntimeConfig()).toEqual({
      environment: 'production',
      enabled: true,
      channelName: 'Beta',
      policy: 'manual',
      onStatusUpdate: secondStatusHandler,
      checkOnly: false,
    });

    const afterChannelSwitch = initializeBundleDropRuntime({
      environment: 'production',
      channelName: 'General',
    });
    expect(afterChannelSwitch.alreadyInitialized).toBe(true);
    expect(afterChannelSwitch.config.channelName).toBe('Beta');

    expect(() =>
      initializeBundleDropRuntime({
        environment: 'production',
        channelName: 'Beta',
      }),
    ).toThrow('different runtime config');

    expect(() => setBundleDropChannel('   ')).toThrow('requires a non-empty channelName');

    resetBundleDropRuntimeForTests();
    expect(hasBundleDropBeenInitialized()).toBe(false);
  });

  it('supports a disabled runtime config and warns once when read', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const initialized = initializeBundleDropRuntime({
      environment: 'development',
      enabled: false,
      channelName: 'Dev',
    });

    expect(initialized.config).toEqual({
      environment: 'development',
      enabled: false,
      channelName: 'Dev',
      policy: 'manual',
      onStatusUpdate: undefined,
      checkOnly: false,
    });
    expect(getBundleDropRuntimeConfigOrWarn()).toEqual(initialized.config);
    expect(getBundleDropRuntimeConfigOrWarn()).toEqual(initialized.config);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(BUNDLE_DROP_DISABLED_MESSAGE);

    warnSpy.mockRestore();
  });
});
