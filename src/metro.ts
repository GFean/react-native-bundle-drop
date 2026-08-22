import fs from 'fs-extra';
import path from 'path';

import { resolveExpoMetroRuntimeVersion } from './expo';
import type { ExpoMetroRuntimeVersion } from './expo';
import type { ExpoBuildIdentityReceipt } from './expo/buildReceipt';
import {
  readGeneratedRuntimeDeliveryBootstrap,
  type RuntimeDeliveryConfig,
} from './runtime-delivery/bootstrapConfig';

export type { ExpoBuildIdentityReceipt } from './expo/buildReceipt';

export type BundleDropMetroConfig = {
  resolver?: {
    extraNodeModules?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type WithBundleDropOptions = {
  projectRoot?: string;
};

export type WithBundleDropExpoOptions = WithBundleDropOptions;

type BaseBundleDropConfig = {
  serverUrl?: string;
  org?: { slug?: string };
  project?: { slug?: string };
};

const loadBaseConfig = (projectRoot: string): BaseBundleDropConfig => {
  const configPath = path.join(projectRoot, 'bundle.drop.config.js');
  if (!fs.existsSync(configPath)) {
    throw new Error('Bundle Drop Metro setup requires bundle.drop.config.js in the project root.');
  }
  delete require.cache[require.resolve(configPath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require(configPath) as BaseBundleDropConfig;
  if (!config?.serverUrl || !config.org?.slug || !config.project?.slug) {
    throw new Error(
      'bundle.drop.config.js must define serverUrl, org.slug, and project.slug before Metro setup.',
    );
  }
  return config;
};

const resolveRuntimeDelivery = (
  projectRoot: string,
  baseConfig: BaseBundleDropConfig,
): RuntimeDeliveryConfig | undefined => {
  const generated = readGeneratedRuntimeDeliveryBootstrap({
    projectRoot,
    expectedIdentity: {
      serverUrl: baseConfig.serverUrl!,
      orgSlug: baseConfig.org!.slug!,
      projectSlug: baseConfig.project!.slug!,
    },
  });
  return generated?.runtimeDelivery;
};

const writeGeneratedRuntimeConfig = (params: {
  projectRoot: string;
  runtimeDelivery?: RuntimeDeliveryConfig | Record<string, unknown>;
  runtimeVersion?: {
    ios: ExpoMetroRuntimeVersion;
    android: ExpoMetroRuntimeVersion;
  };
}): string => {
  const generatedDirectory = path.join(params.projectRoot, '.bundle-drop', 'generated');
  const generatedConfigPath = path.join(generatedDirectory, 'bundle.drop.config.js');
  fs.ensureDirSync(generatedDirectory);
  const generatedFields: string[] = [];
  if (params.runtimeVersion) {
    generatedFields.push(`  runtimeVersion: ${JSON.stringify(params.runtimeVersion)},`);
  }
  if (params.runtimeDelivery) {
    generatedFields.push(`  runtimeDelivery: ${JSON.stringify(params.runtimeDelivery)},`);
  }
  const content = [
    "'use strict';",
    '',
    "const baseConfig = require('../../bundle.drop.config.js');",
    'const resolvedConfig = { ...baseConfig };',
    'delete resolvedConfig.runtimeDelivery;',
    'module.exports = {',
    '  ...resolvedConfig,',
    ...generatedFields,
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(generatedConfigPath, content, 'utf8');
  return generatedConfigPath;
};

const mergeMetroAlias = <T extends BundleDropMetroConfig>(
  config: T,
  generatedConfigPath: string,
): T => ({
  ...config,
  resolver: {
    ...(config.resolver || {}),
    extraNodeModules: {
      ...(config.resolver?.extraNodeModules || {}),
      'bundle-drop-config': generatedConfigPath,
    },
  },
});

/**
 * Preserves a bare React Native Metro config and resolves Bundle Drop through
 * the project-owned, package-validated generated bootstrap.
 */
export function withBundleDrop<T extends BundleDropMetroConfig>(
  config: T,
  options: WithBundleDropOptions = {},
): T {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const baseConfig = loadBaseConfig(projectRoot);
  const generatedConfigPath = writeGeneratedRuntimeConfig({
    projectRoot,
    runtimeDelivery: resolveRuntimeDelivery(projectRoot, baseConfig),
  });
  return mergeMetroAlias(config, generatedConfigPath);
}

export const withBundleDropBare = withBundleDrop;

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
  const baseConfig = loadBaseConfig(projectRoot);
  const generatedConfigPath = writeGeneratedRuntimeConfig({
    projectRoot,
    runtimeDelivery: resolveRuntimeDelivery(projectRoot, baseConfig),
    runtimeVersion: { ios, android },
  });

  return mergeMetroAlias(config, generatedConfigPath);
}

export default withBundleDropExpo;
