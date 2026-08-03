/**
 * Shape of `bundle.drop.config.js` after it is loaded through Metro.
 */
export type BundleDropProjectConfig = {
  /** Persisted project shape used to keep Expo and bare runtime behavior distinct. */
  projectType?: 'expo' | 'bare';
  /** BundleDrop backend base URL. */
  serverUrl: string;
  /** Organization identity used for public API calls. */
  org: {
    /** Organization slug. */
    slug: string;
  };
  /** Project identity and public access configuration. */
  project: {
    /** Human-readable project name. */
    name: string;
    /** Project slug used by public API calls. */
    slug: string;
    /** Optional public API key used by CLI/runtime integrations. */
    apiKey?: string;
  };
  /**
   * Runtime compatibility source. Concrete platform values are the default for
   * both bare and Expo projects. Expo projects may explicitly delegate runtime
   * resolution to the Expo app config; the Expo Metro wrapper then replaces that
   * declaration with the concrete values embedded in the build.
   */
  runtimeVersion?:
    | {
        /** iOS runtime version. */
        ios?: string | { source: 'appVersion' | 'nativeVersion' };
        /** Android runtime version. */
        android?: string | { source: 'appVersion' | 'nativeVersion' };
      }
    | {
        /** Explicitly resolve concrete values from the evaluated Expo app config. */
        source: 'expo';
      };
  /** Default OTA channel used before runtime code sets another channel. */
  defaultChannel?: string;
  /** Rollback/crash recovery tuning. */
  rollback?: {
    /** Crash count required before rollback. */
    maxCrashCount?: number;
    /** How Bundle Drop marks a newly launched OTA bundle healthy. */
    healthCheckMode?: 'auto' | 'manual';
    /** Seconds to wait before automatically marking a candidate healthy in auto mode. */
    healthyAfterSec?: number;
  };
};

export function loadConfig(): BundleDropProjectConfig {
  try {
    // ✅ Resolved via Metro alias in the host app (extraNodeModules)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cfg = require('bundle-drop-config');

    if (!cfg?.serverUrl || !cfg?.project?.slug || !cfg?.org?.slug) {
      throw new Error('bundle.drop.config.js missing serverUrl, org.slug or project.slug');
    }
    if (cfg.runtimeVersion?.source === 'expo') {
      throw new Error(
        'Expo runtime identity was not embedded. Configure Metro with withBundleDropExpo().',
      );
    }

    return cfg;
  } catch (e) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[BundleDrop] loadConfig failed, using dev defaults:', e);
      return {
        serverUrl: 'https://api.bundledrop.app',
        org: { slug: 'default-org' },
        project: { name: 'BundleDrop', slug: 'default' },
      };
    }
    throw new Error(
      '[BundleDrop] bundle.drop.config.js could not be loaded. ' +
      'Ensure the config file exists and Metro is configured with the bundle-drop-config alias.',
    );
  }
}
