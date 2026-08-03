export {};

type ContextModule = typeof import('../context');

type BundleDropConfigModule = {
  projectType?: 'expo' | 'bare';
  serverUrl?: string;
  org?: { slug?: string };
  project?: { name?: string; slug?: string; apiKey?: string };
  runtimeVersion?: {
    ios: string | { source: 'appVersion' | 'nativeVersion' };
    android: string | { source: 'appVersion' | 'nativeVersion' };
  } | { source: 'expo' };
  defaultChannel?: string;
  rollback?: {
    maxCrashCount?: number;
    healthCheckMode?: 'auto' | 'manual';
    healthyAfterSec?: number;
  };
};

const loadContextModule = (
  configure?: (deps: {
    Platform: { OS: 'ios' | 'android' };
    bundleDropConfig: BundleDropConfigModule;
    NativeModules: any;
  }) => void
) => {
  jest.resetModules();
  const reactNative = require('react-native') as typeof import('react-native');
  const bundleDropConfig = require('bundle-drop-config') as BundleDropConfigModule;
  configure?.({
    Platform: reactNative.Platform as { OS: 'ios' | 'android' },
    bundleDropConfig,
    NativeModules: reactNative.NativeModules,
  });
  return require('../context') as ContextModule;
};

describe('context', () => {
  it('derives Android values from config and the document directory', () => {
    const context = loadContextModule(({ Platform, bundleDropConfig, NativeModules }) => {
      Platform.OS = 'android';
      NativeModules.BundleDrop.DocumentDirectoryPath = '/android-docs';
      Object.assign(bundleDropConfig, {
        serverUrl: 'https://bundledrop.app',
        org: { slug: 'alpha-org' },
        project: { name: 'Bundle Drop', slug: 'app', apiKey: 'key' },
        runtimeVersion: { ios: '1.0.0', android: '2.0.0' },
        defaultChannel: 'Beta',
        rollback: {
          maxCrashCount: 4,
          healthCheckMode: 'manual',
          healthyAfterSec: 45,
        },
      });
    });

    expect(context.platform).toBe('android');
    expect(context.isIOS).toBe(false);
    expect(context.runtimeVersion).toBe('2.0.0');
    expect(context.defaultChannel).toBe('Beta');
    expect(context.BUNDLE_DROP_ROOT).toBe('/android-docs/bundle-drop');
    expect(context.bundleDropConfig).toEqual({
      serverUrl: 'https://bundledrop.app',
      platform: 'android',
      runtimeVersion: '2.0.0',
      defaultChannel: 'Beta',
      org: { slug: 'alpha-org' },
      project: { name: 'Bundle Drop', slug: 'app' },
      rollback: {
        maxCrashCount: 4,
        healthCheckMode: 'manual',
        healthyAfterSec: 45,
      },
    });
  });

  it('derives iOS values and fallback defaults when optional config is omitted', () => {
    const context = loadContextModule(({ Platform, bundleDropConfig, NativeModules }) => {
      Platform.OS = 'ios';
      NativeModules.BundleDrop.LibraryDirectoryPath = '/ios-library';
      Object.assign(bundleDropConfig, {
        serverUrl: 'https://bundledrop.app',
        org: { slug: 'alpha-org' },
        project: { name: 'Bundle Drop', slug: 'app' },
        runtimeVersion: { ios: '3.0.0', android: '2.0.0' },
      });
      delete bundleDropConfig.defaultChannel;
      delete bundleDropConfig.rollback;
    });

    expect(context.platform).toBe('ios');
    expect(context.isIOS).toBe(true);
    expect(context.runtimeVersion).toBe('3.0.0');
    expect(context.defaultChannel).toBe('develop');
    expect(context.BUNDLE_DROP_ROOT).toBe('/ios-library/bundle-drop');
    expect(context.bundleDropConfig.rollback).toEqual({
      maxCrashCount: 3,
      healthCheckMode: 'auto',
      healthyAfterSec: 0,
    });
  });

  it('leaves an omitted runtime identity unresolved', () => {
    const context = loadContextModule(({ Platform, bundleDropConfig }) => {
      Platform.OS = 'android';
      Object.assign(bundleDropConfig, {
        serverUrl: 'https://bundledrop.app',
        org: { slug: 'alpha-org' },
        project: { name: 'Bundle Drop', slug: 'app' },
      });
      delete bundleDropConfig.runtimeVersion;
    });

    expect(context.runtimeVersion).toBeUndefined();
    expect(context.bundleDropConfig.runtimeVersion).toBeUndefined();
  });

  it('derives a remote nativeVersion policy from the installed Expo binary', () => {
    const context = loadContextModule(({ Platform, bundleDropConfig, NativeModules }) => {
      Platform.OS = 'android';
      NativeModules.BundleDropExpoIdentity = {
        appVersion: '4.5.6',
        appBuildVersion: '123',
      };
      Object.assign(bundleDropConfig, {
        serverUrl: 'https://bundledrop.app',
        org: { slug: 'alpha-org' },
        project: { name: 'Bundle Drop', slug: 'app' },
        runtimeVersion: {
          ios: 'ios-runtime',
          android: { source: 'nativeVersion' },
        },
      });
    });

    expect(context.runtimeVersion).toBe('4.5.6(123)');
    expect(context.bundleDropConfig.runtimeVersion).toBe('4.5.6(123)');
  });

  it('derives an appVersion policy from the installed Expo binary', () => {
    const context = loadContextModule(({ Platform, bundleDropConfig, NativeModules }) => {
      Platform.OS = 'ios';
      NativeModules.BundleDropExpoIdentity = {
        appVersion: '7.8.9',
        appBuildVersion: '321',
      };
      Object.assign(bundleDropConfig, {
        serverUrl: 'https://bundledrop.app',
        org: { slug: 'alpha-org' },
        project: { name: 'Bundle Drop', slug: 'app' },
        runtimeVersion: {
          ios: { source: 'appVersion' },
          android: 'android-runtime',
        },
      });
    });

    expect(context.runtimeVersion).toBe('7.8.9');
  });

  it('fails closed when an app-derived policy has no Expo native identity', () => {
    expect(() => loadContextModule(({ Platform, bundleDropConfig, NativeModules }) => {
      Platform.OS = 'ios';
      delete NativeModules.BundleDropExpoIdentity;
      Object.assign(bundleDropConfig, {
        serverUrl: 'https://bundledrop.app',
        org: { slug: 'alpha-org' },
        project: { name: 'Bundle Drop', slug: 'app' },
        runtimeVersion: {
          ios: { source: 'nativeVersion' },
          android: 'android-runtime',
        },
      });
    })).toThrow('could not read the Expo native build version');
  });

  it('leaves native-derived identity unresolved in an Expo development runtime without the adapter', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const reactNative = require('react-native') as typeof import('react-native');
    const nativeBundleDrop = reactNative.NativeModules.BundleDrop;

    try {
      const context = loadContextModule(({ Platform, bundleDropConfig, NativeModules }) => {
        Platform.OS = 'ios';
        NativeModules.BundleDrop = undefined;
        delete NativeModules.BundleDropExpoIdentity;
        Object.assign(bundleDropConfig, {
          projectType: 'expo',
          serverUrl: 'https://bundledrop.app',
          org: { slug: 'alpha-org' },
          project: { name: 'Bundle Drop', slug: 'app' },
          runtimeVersion: {
            ios: { source: 'nativeVersion' },
            android: 'android-runtime',
          },
        });
      });

      expect(context.runtimeVersion).toBeUndefined();
      expect(context.bundleDropConfig.runtimeVersion).toBeUndefined();
    } finally {
      reactNative.NativeModules.BundleDrop = nativeBundleDrop;
      delete (globalThis as { __DEV__?: boolean }).__DEV__;
    }
  });
});
