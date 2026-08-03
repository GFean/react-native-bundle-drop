export {};

type LoadConfigModule = typeof import('../loadConfig');

type BundleDropConfigModule = {
  serverUrl?: string;
  org?: { slug?: string };
  project?: { name?: string; slug?: string; apiKey?: string };
  runtimeVersion?: {
    ios: string | { source: 'appVersion' | 'nativeVersion' };
    android: string | { source: 'appVersion' | 'nativeVersion' };
  } | { source: 'expo' };
  defaultChannel?: string;
};

const loadConfigModule = (
  configure?: (deps: {
    Platform: { OS: 'ios' | 'android' };
    bundleDropConfig: BundleDropConfigModule;
  }) => void
) => {
  jest.resetModules();
  const reactNative = require('react-native') as { Platform: { OS: 'ios' | 'android' } };
  const bundleDropConfig = require('bundle-drop-config') as BundleDropConfigModule;
  configure?.({ Platform: reactNative.Platform, bundleDropConfig });
  return require('../loadConfig') as LoadConfigModule;
};

describe('loadConfig', () => {
  it('returns the configured values when the config is valid', () => {
    const { loadConfig } = loadConfigModule(({ bundleDropConfig }) => {
      Object.assign(bundleDropConfig, {
        serverUrl: 'https://bundledrop.app',
        org: { slug: 'alpha-org' },
        project: {
          name: 'Bundle Drop',
          slug: 'dashboard',
          apiKey: 'download-key',
        },
        defaultChannel: 'Beta',
      });
    });

    expect(loadConfig()).toEqual(
      expect.objectContaining({
        serverUrl: 'https://bundledrop.app',
        org: { slug: 'alpha-org' },
        project: {
          name: 'Bundle Drop',
          slug: 'dashboard',
          apiKey: 'download-key',
        },
        defaultChannel: 'Beta',
      })
    );
  });

  it('throws in production when required config fields are missing', () => {
    const { loadConfig } = loadConfigModule(({ bundleDropConfig }) => {
      delete bundleDropConfig.serverUrl;
    });

    expect(() => loadConfig()).toThrow('bundle.drop.config.js could not be loaded');
  });

  it('fails closed when Expo source was not replaced by the Metro wrapper', () => {
    const { loadConfig } = loadConfigModule(({ bundleDropConfig }) => {
      Object.assign(bundleDropConfig, {
        serverUrl: 'https://bundledrop.app',
        org: { slug: 'alpha-org' },
        project: { name: 'Bundle Drop', slug: 'dashboard' },
        runtimeVersion: { source: 'expo' },
      });
    });

    expect(() => loadConfig()).toThrow('bundle.drop.config.js could not be loaded');
  });

  it('falls back to production API defaults when __DEV__ is true and config fails', () => {
    (globalThis as any).__DEV__ = true;
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const { loadConfig } = loadConfigModule(({ bundleDropConfig }) => {
        delete bundleDropConfig.serverUrl;
      });

      expect(loadConfig()).toEqual({
        serverUrl: 'https://api.bundledrop.app',
        org: { slug: 'default-org' },
        project: { name: 'BundleDrop', slug: 'default' },
      });
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      delete (globalThis as any).__DEV__;
      consoleSpy.mockRestore();
    }
  });
});
