type NativeModule = typeof import('../../native/bundleDropNative');

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
});
