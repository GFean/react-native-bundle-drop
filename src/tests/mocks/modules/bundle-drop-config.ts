const bundleDropConfig = {
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
};

export = bundleDropConfig;
