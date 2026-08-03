import fs from 'fs-extra';
import path from 'path';

import { resolveExpoMetroRuntimeVersion } from './expo';
import type { ExpoMetroRuntimeVersion } from './expo';
import type { ExpoBuildIdentityReceipt } from './expo/buildReceipt';

export type { ExpoBuildIdentityReceipt } from './expo/buildReceipt';

export type BundleDropMetroConfig = {
  resolver?: {
    extraNodeModules?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type WithBundleDropExpoOptions = {
  projectRoot?: string;
};

const writeGeneratedRuntimeConfig = (params: {
  projectRoot: string;
  ios: ExpoMetroRuntimeVersion;
  android: ExpoMetroRuntimeVersion;
}): string => {
  const generatedDirectory = path.join(params.projectRoot, '.bundle-drop', 'generated');
  const generatedConfigPath = path.join(generatedDirectory, 'bundle.drop.config.js');
  fs.ensureDirSync(generatedDirectory);
  const baseConfigPath = path.join(params.projectRoot, 'bundle.drop.config.js');
  if (!fs.existsSync(baseConfigPath)) {
    throw new Error('Bundle Drop Expo Metro setup requires bundle.drop.config.js in the project root.');
  }
  const content = [
    "'use strict';",
    '',
    "const baseConfig = require('../../bundle.drop.config.js');",
    'module.exports = {',
    '  ...baseConfig,',
    `  runtimeVersion: ${JSON.stringify({
      ios: params.ios,
      android: params.android,
    })},`,
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(generatedConfigPath, content, 'utf8');
  return generatedConfigPath;
};

/**
 * Preserves the caller's Expo Metro config and only adds Bundle Drop's config
 * alias after resolving the same concrete identity used by build and upload.
 */
export async function withBundleDropExpo<T extends BundleDropMetroConfig>(
  configOrPromise: T | Promise<T>,
  options: WithBundleDropExpoOptions = {},
): Promise<T> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const [config, ios, android] = await Promise.all([
    Promise.resolve(configOrPromise),
    resolveExpoMetroRuntimeVersion(projectRoot, 'ios'),
    resolveExpoMetroRuntimeVersion(projectRoot, 'android'),
  ]);
  const generatedConfigPath = writeGeneratedRuntimeConfig({ projectRoot, ios, android });

  return {
    ...config,
    resolver: {
      ...(config.resolver || {}),
      extraNodeModules: {
        ...(config.resolver?.extraNodeModules || {}),
        'bundle-drop-config': generatedConfigPath,
      },
    },
  };
}

export default withBundleDropExpo;
