import path from 'path';

import { ExpoIntegrationError } from './errors';
import type { MobilePlatform } from './types';
import { selectRuntimeVersion } from '../fingerprint/config';
import { calculateFingerprintSync } from '../fingerprint/client';

export type BundleDropRuntimeVersionAuthority =
  | {
      source: 'bundle-drop';
      runtimeVersion: string;
    }
  | {
      source: 'expo';
    };

const loadBundleDropConfig = (projectRoot: string): Record<string, any> => {
  const configPath = path.join(path.resolve(projectRoot), 'bundle.drop.config.js');
  try {
    const resolvedConfigPath = require.resolve(configPath);
    delete require.cache[resolvedConfigPath];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require(resolvedConfigPath);
    if (!config || typeof config !== 'object') {
      throw new Error('the module did not export an object');
    }
    return config;
  } catch (error) {
    throw new ExpoIntegrationError(
      `Could not load Bundle Drop runtime configuration from ${configPath}.`,
      { cause: error },
    );
  }
};

/**
 * Bundle Drop literals are the default runtime authority for every project
 * type. Expo runtime policies remain available only through an explicit
 * `runtimeVersion: { source: 'expo' }` opt-in.
 */
export function readBundleDropRuntimeSelection(projectRoot: string, platform: MobilePlatform) {
  return selectRuntimeVersion(loadBundleDropConfig(projectRoot).runtimeVersion, platform);
}

export function resolveBundleDropRuntimeVersionAuthority(
  projectRoot: string,
  platform: MobilePlatform,
): BundleDropRuntimeVersionAuthority {
  const selection = readBundleDropRuntimeSelection(projectRoot, platform);
  if (selection.source === 'expo') {
    return { source: 'expo' };
  }
  return {
    source: 'bundle-drop',
    runtimeVersion: selection.source === 'fingerprint'
      ? calculateFingerprintSync(projectRoot, platform).runtimeVersion
      : selection.runtimeVersion,
  };
}
