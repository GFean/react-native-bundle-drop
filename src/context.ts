import { Platform } from 'react-native';
import RNFS from './native/fs';

import { loadConfig } from './loadConfig';
import { resolveExpoNativeRuntimeVersion } from './expo/nativeIdentity';
import { isBundleDropNativeAvailable } from './native/bundleDropNative';

export const config = loadConfig();

export const platform = Platform.OS === 'ios' ? 'ios' : 'android';
export const isIOS = platform === 'ios';

const configuredRuntimeVersion = config.runtimeVersion;
const platformRuntimeVersion =
  configuredRuntimeVersion && !('source' in configuredRuntimeVersion)
    ? configuredRuntimeVersion[platform]
    : undefined;

const isExpoDevelopmentWithoutNativeAdapter =
  config.projectType === 'expo' &&
  typeof __DEV__ !== 'undefined' &&
  __DEV__ &&
  !isBundleDropNativeAvailable();

export const runtimeVersion =
  typeof platformRuntimeVersion === 'string'
    ? platformRuntimeVersion
    : platformRuntimeVersion?.source === 'appVersion' ||
        platformRuntimeVersion?.source === 'nativeVersion'
      ? isExpoDevelopmentWithoutNativeAdapter
        ? undefined
        : resolveExpoNativeRuntimeVersion(platformRuntimeVersion.source)
      : undefined;

export const defaultChannel = config.defaultChannel || 'develop';

const configuredMaxCrashCount = config.rollback?.maxCrashCount ?? 3;
if (
  !Number.isSafeInteger(configuredMaxCrashCount) ||
  configuredMaxCrashCount < 0 ||
  configuredMaxCrashCount > 2_147_483_647
) {
  throw new Error('[BundleDrop] rollback.maxCrashCount must be a non-negative 32-bit integer.');
}

const configuredHealthyAfterSec = config.rollback?.healthyAfterSec ?? 0;
if (!Number.isFinite(configuredHealthyAfterSec) || configuredHealthyAfterSec < 0) {
  throw new Error('[BundleDrop] rollback.healthyAfterSec must be a finite non-negative number.');
}

export const BUNDLE_DROP_ROOT = isIOS
  ? `${RNFS.LibraryDirectoryPath}/bundle-drop`
  : `${RNFS.DocumentDirectoryPath}/bundle-drop`;

/**
 * Resolved static BundleDrop configuration for the current platform.
 */
export type BundleDropConfig = {
  /** BundleDrop backend base URL. */
  serverUrl: string;
  /** Current React Native platform. */
  platform: 'ios' | 'android';
  /** Runtime version configured for the current platform, if present. */
  runtimeVersion: string | undefined;
  /** Default channel used before runtime code sets another channel. */
  defaultChannel: string;
  /** Organization identity used by BundleDrop APIs. */
  org: { slug: string };
  /** Project identity used by BundleDrop APIs. */
  project: { name: string; slug: string };
  /** Effective rollback/crash recovery policy with defaults applied. */
  rollback: {
    /** Crash count required before rollback. */
    maxCrashCount: number;
    /** How Bundle Drop marks a newly launched OTA bundle healthy. */
    healthCheckMode: 'auto' | 'manual';
    /** Seconds to wait before automatically marking a candidate healthy in auto mode. */
    healthyAfterSec: number;
  };
};

/**
 * Resolved BundleDrop config for the current platform, derived from `bundle.drop.config.js`.
 */
export const bundleDropConfig: BundleDropConfig = {
  serverUrl: config.serverUrl,
  platform,
  runtimeVersion,
  defaultChannel,
  org: { slug: config.org.slug },
  project: { name: config.project.name, slug: config.project.slug },
  rollback: {
    maxCrashCount: configuredMaxCrashCount,
    healthCheckMode: config.rollback?.healthCheckMode === 'manual' ? 'manual' : 'auto',
    healthyAfterSec: configuredHealthyAfterSec,
  },
};
