type RuntimeVersionConfig = {
  ios: string;
  android: string;
};

type RollbackConfig = {
  maxCrashCount?: number;
  healthCheckMode?: 'auto' | 'manual';
  healthyAfterSec?: number;
};

type MockConfig = {
  serverUrl: string;
  org: { slug: string };
  project: { name: string; slug: string; apiKey?: string };
  runtimeVersion?: RuntimeVersionConfig;
  defaultChannel?: string;
  rollback?: RollbackConfig;
};

type MockBundleDropContext = {
  serverUrl: string;
  platform: 'ios' | 'android';
  runtimeVersion?: string;
  defaultChannel: string;
  org: { slug: string };
  project: { name: string; slug: string };
  rollback: {
    maxCrashCount: number;
    healthCheckMode: 'auto' | 'manual';
    healthyAfterSec: number;
  };
};

const createConfig = (): MockConfig => ({
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: {
    name: 'Bundle Drop',
    slug: 'bundle-drop-app',
    apiKey: 'test-api-key',
  },
  runtimeVersion: {
    ios: '1.0.0',
    android: '1.0.0',
  },
  defaultChannel: 'General',
  rollback: {
    maxCrashCount: 2,
    healthCheckMode: 'auto',
    healthyAfterSec: 0,
  },
});

const normalizeConfig = (partial: Partial<MockConfig>): MockConfig => ({
  ...config,
  ...partial,
  org: {
    ...config.org,
    ...(partial.org || {}),
  },
  project: {
    ...config.project,
    ...(partial.project || {}),
  },
  runtimeVersion: partial.runtimeVersion
    ? {
        ...(config.runtimeVersion || { ios: '1.0.0', android: '1.0.0' }),
        ...partial.runtimeVersion,
      }
    : config.runtimeVersion,
  rollback: partial.rollback
    ? {
        ...(config.rollback || {}),
        ...partial.rollback,
      }
    : config.rollback,
});

const syncDerivedValues = () => {
  isIOS = platform === 'ios';
  runtimeVersion = config.runtimeVersion?.[platform];
  defaultChannel = config.defaultChannel || 'develop';
  BUNDLE_DROP_ROOT = isIOS ? '/mock/lib/bundle-drop' : '/mock/doc/bundle-drop';
  bundleDropConfig = {
    serverUrl: config.serverUrl,
    platform,
    runtimeVersion,
    defaultChannel,
    org: { slug: config.org.slug },
    project: { name: config.project.name, slug: config.project.slug },
    rollback: {
      maxCrashCount: config.rollback?.maxCrashCount ?? 3,
      healthCheckMode: config.rollback?.healthCheckMode === 'manual' ? 'manual' : 'auto',
      healthyAfterSec: config.rollback?.healthyAfterSec ?? 0,
    },
  };
};

export let config = createConfig();
export let platform: 'ios' | 'android' = 'android';
export let isIOS = false;
export let runtimeVersion = config.runtimeVersion?.android;
export let defaultChannel = config.defaultChannel || 'develop';
export let BUNDLE_DROP_ROOT = '/mock/doc/bundle-drop';

export let bundleDropConfig: MockBundleDropContext = {
  serverUrl: config.serverUrl,
  platform,
  runtimeVersion,
  defaultChannel,
  org: { slug: config.org.slug },
  project: { name: config.project.name, slug: config.project.slug },
  rollback: {
    maxCrashCount: config.rollback?.maxCrashCount ?? 3,
    healthCheckMode: config.rollback?.healthCheckMode === 'manual' ? 'manual' : 'auto',
    healthyAfterSec: config.rollback?.healthyAfterSec ?? 0,
  },
};

export const setMockConfig = (partial: Partial<MockConfig>) => {
  config = normalizeConfig(partial);
  syncDerivedValues();
};

export const setMockPlatform = (nextPlatform: 'ios' | 'android') => {
  platform = nextPlatform;
  syncDerivedValues();
};

export const resetContextMocks = () => {
  config = createConfig();
  platform = 'android';
  syncDerivedValues();
};

resetContextMocks();
