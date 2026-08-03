import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { evaluateExpoConfig } from './config';
import { ExpoIntegrationError } from './errors';
import { loadExpoDependency, loadProjectModule } from './localModules';
import { resolveBundleDropRuntimeVersionAuthority } from './runtimeVersion';
import type {
  ExpoBuildIdentity,
  ExpoRuntimeVersionPolicy,
  JavaScriptEngine,
  MobilePlatform,
} from './types';

type PackageManifest = { version?: unknown };

type ExpoUpdatesUtilities = {
  FINGERPRINT_RUNTIME_VERSION_SENTINEL?: string;
  getAppVersion: (config: Record<string, any>, platform: MobilePlatform) => string;
  getNativeVersion: (config: Record<string, any>, platform: MobilePlatform) => string;
  getRuntimeVersionAsync: (
    projectRoot: string,
    config: Record<string, any>,
    platform: MobilePlatform,
  ) => Promise<string | null>;
};

type ExpoFingerprintModule = {
  createFingerprintAsync: (
    projectRoot: string,
    options: { platforms: MobilePlatform[] },
  ) => Promise<{ hash?: unknown }>;
};

const MIN_SUPPORTED_EXPO_SDK = 54;
const MAX_SUPPORTED_EXPO_SDK = 57;

function requirePackageVersion(projectRoot: string, moduleId: string): string {
  const manifest = loadProjectModule<PackageManifest>(projectRoot, moduleId);
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new ExpoIntegrationError(`${moduleId} does not contain a valid version.`);
  }
  return manifest.version;
}

function getExpoSdkMajor(expoVersion: string): number {
  const match = /^(\d+)\./.exec(expoVersion);
  if (!match) {
    throw new ExpoIntegrationError(`Could not determine the Expo SDK from expo@${expoVersion}.`);
  }
  return Number(match[1]);
}

function assertSupportedExpoSdk(expoVersion: string): void {
  const sdkMajor = getExpoSdkMajor(expoVersion);
  if (sdkMajor < MIN_SUPPORTED_EXPO_SDK || sdkMajor > MAX_SUPPORTED_EXPO_SDK) {
    throw new ExpoIntegrationError(
      `Expo SDK ${sdkMajor} is outside Bundle Drop's supported SDK ` +
        `${MIN_SUPPORTED_EXPO_SDK}-${MAX_SUPPORTED_EXPO_SDK} range.`,
    );
  }
}

function getSelectedRuntimeVersion(
  config: Record<string, any>,
  platform: MobilePlatform,
): unknown {
  return config[platform]?.runtimeVersion ?? config.runtimeVersion;
}

function getRuntimeVersionPolicy(selectedRuntimeVersion: unknown): ExpoRuntimeVersionPolicy {
  if (typeof selectedRuntimeVersion === 'string' && selectedRuntimeVersion.trim() !== '') {
    return 'literal';
  }
  if (
    selectedRuntimeVersion &&
    typeof selectedRuntimeVersion === 'object' &&
    'policy' in selectedRuntimeVersion
  ) {
    const policy = (selectedRuntimeVersion as { policy?: unknown }).policy;
    if (
      policy === 'appVersion' ||
      policy === 'nativeVersion' ||
      policy === 'sdkVersion' ||
      policy === 'fingerprint'
    ) {
      return policy;
    }
  }
  throw new ExpoIntegrationError(
    'Expo runtimeVersion must be a non-empty literal or a supported Expo runtime-version policy.',
  );
}

function getJavaScriptEngine(
  config: Record<string, any>,
  platform: MobilePlatform,
): JavaScriptEngine {
  const engine = config[platform]?.jsEngine ?? config.jsEngine ?? 'hermes';
  if (engine !== 'hermes' && engine !== 'jsc') {
    throw new ExpoIntegrationError(`Unsupported Expo JavaScript engine: ${String(engine)}.`);
  }
  return engine;
}

function assertLocalNativeVersionPolicy(
  projectRoot: string,
  runtimeVersionPolicy: ExpoRuntimeVersionPolicy,
  hasOfficialNativeBuildVersion: boolean,
): void {
  if (runtimeVersionPolicy !== 'nativeVersion' || hasOfficialNativeBuildVersion) {
    return;
  }
  const easConfigPath = path.join(projectRoot, 'eas.json');
  if (!fs.existsSync(easConfigPath)) {
    return;
  }
  let easConfig: Record<string, any>;
  try {
    easConfig = JSON.parse(fs.readFileSync(easConfigPath, 'utf8')) as Record<string, any>;
  } catch (error) {
    throw new ExpoIntegrationError('eas.json could not be parsed while checking native versioning.', {
      cause: error,
    });
  }
  if (easConfig.cli?.appVersionSource === 'remote') {
    throw new ExpoIntegrationError(
      'The nativeVersion runtime policy uses remote EAS app versions. ' +
        'An exact build receipt or an officially resolved EAS value is required; Bundle Drop will not guess it.',
    );
  }
}

function applyOfficialBuildVersions(
  config: Record<string, any>,
  platform: MobilePlatform,
  versions: { appVersion?: string; appBuildVersion?: string },
): Record<string, any> {
  const { appVersion, appBuildVersion } = versions;
  if (appVersion !== undefined && !appVersion.trim()) {
    throw new ExpoIntegrationError('The official app version is empty.');
  }
  if (appBuildVersion !== undefined && !appBuildVersion.trim()) {
    throw new ExpoIntegrationError('The official EAS app build version is empty.');
  }
  const platformConfig = { ...(config[platform] || {}) };
  if (appVersion !== undefined) platformConfig.version = appVersion;
  if (platform === 'ios' && appBuildVersion !== undefined) {
    platformConfig.buildNumber = appBuildVersion;
  } else if (platform === 'android' && appBuildVersion !== undefined) {
    if (!/^\d+$/.test(appBuildVersion)) {
      throw new ExpoIntegrationError('The official Android EAS app build version is not a version code.');
    }
    platformConfig.versionCode = Number(appBuildVersion);
  }
  return { ...config, [platform]: platformConfig };
}

export async function resolveExpoProjectFingerprint(
  projectRoot: string,
  platform: MobilePlatform,
): Promise<string> {
  const fingerprintModule = loadExpoDependency<ExpoFingerprintModule>(
    projectRoot,
    '@expo/fingerprint',
  );
  if (typeof fingerprintModule.createFingerprintAsync !== 'function') {
    throw new ExpoIntegrationError(
      'The project-local @expo/fingerprint package does not export createFingerprintAsync().',
    );
  }
  const fingerprint = await fingerprintModule.createFingerprintAsync(projectRoot, {
    platforms: [platform],
  });
  if (typeof fingerprint.hash !== 'string' || fingerprint.hash.trim() === '') {
    throw new ExpoIntegrationError('Expo fingerprint resolution did not return a concrete hash.');
  }
  return fingerprint.hash;
}

function hashIdentity(identity: Omit<ExpoBuildIdentity, 'identityHash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export async function resolveExpoBuildIdentity(
  projectRoot: string,
  platform: MobilePlatform,
  options: {
    officialAppVersion?: string;
    officialNativeBuildVersion?: string;
  } = {},
): Promise<ExpoBuildIdentity> {
  if (platform !== 'ios' && platform !== 'android') {
    throw new ExpoIntegrationError(`Unsupported mobile platform: ${String(platform)}.`);
  }

  const absoluteProjectRoot = path.resolve(projectRoot);
  const evaluated = evaluateExpoConfig(absoluteProjectRoot).exp;
  const expoSdkVersion = requirePackageVersion(absoluteProjectRoot, 'expo/package.json');
  const reactNativeVersion = requirePackageVersion(
    absoluteProjectRoot,
    'react-native/package.json',
  );
  assertSupportedExpoSdk(expoSdkVersion);

  const selectedRuntimeVersion = getSelectedRuntimeVersion(evaluated, platform);
  const runtimeAuthority = resolveBundleDropRuntimeVersionAuthority(
    absoluteProjectRoot,
    platform,
  );
  const runtimeVersionPolicy = runtimeAuthority.source === 'bundle-drop'
    ? 'literal'
    : getRuntimeVersionPolicy(selectedRuntimeVersion);
  const officialNativeBuildVersion = options.officialNativeBuildVersion;
  assertLocalNativeVersionPolicy(
    absoluteProjectRoot,
    runtimeVersionPolicy,
    officialNativeBuildVersion !== undefined,
  );
  const exp = options.officialAppVersion !== undefined || officialNativeBuildVersion !== undefined
    ? applyOfficialBuildVersions(evaluated, platform, {
        appVersion: options.officialAppVersion,
        appBuildVersion: officialNativeBuildVersion,
      })
    : evaluated;

  const updatesUtilities = loadExpoDependency<ExpoUpdatesUtilities>(
    absoluteProjectRoot,
    '@expo/config-plugins/build/utils/Updates',
  );
  if (
    typeof updatesUtilities.getAppVersion !== 'function' ||
    typeof updatesUtilities.getNativeVersion !== 'function'
  ) {
    throw new ExpoIntegrationError(
      'The project-local Expo runtime-version utilities are incomplete or incompatible.',
    );
  }

  let runtimeVersion: string | null = runtimeAuthority.source === 'bundle-drop'
    ? runtimeAuthority.runtimeVersion
    : null;
  if (runtimeAuthority.source === 'expo') {
    if (typeof updatesUtilities.getRuntimeVersionAsync !== 'function') {
      throw new ExpoIntegrationError(
        'The project-local Expo runtime-version utilities are incomplete or incompatible.',
      );
    }
    runtimeVersion = await updatesUtilities.getRuntimeVersionAsync(
      absoluteProjectRoot,
      exp,
      platform,
    );
    const fingerprintSentinel =
      updatesUtilities.FINGERPRINT_RUNTIME_VERSION_SENTINEL ?? 'file:fingerprint';
    if (runtimeVersionPolicy === 'fingerprint' || runtimeVersion === fingerprintSentinel) {
      runtimeVersion = await resolveExpoProjectFingerprint(absoluteProjectRoot, platform);
    }
  }
  if (typeof runtimeVersion !== 'string' || runtimeVersion.trim() === '') {
    throw new ExpoIntegrationError(
      'Expo did not resolve a concrete runtime version for this build.',
    );
  }

  const identityWithoutHash: Omit<ExpoBuildIdentity, 'identityHash'> = {
    platform,
    runtimeVersion,
    runtimeVersionPolicy,
    expoSdkVersion,
    reactNativeVersion,
    javaScriptEngine: getJavaScriptEngine(exp, platform),
    appVersion: updatesUtilities.getAppVersion(exp, platform),
    nativeVersion: updatesUtilities.getNativeVersion(exp, platform),
  };

  return {
    ...identityWithoutHash,
    identityHash: hashIdentity(identityWithoutHash),
  };
}

export type ExpoMetroRuntimeVersion = string | {
  source: 'appVersion' | 'nativeVersion';
};

/**
 * App-derived policies read the signed binary at runtime. This remains exact
 * for remote EAS versions and for committed native projects whose generated
 * version fields have not yet been reconciled with app config.
 */
export async function resolveExpoMetroRuntimeVersion(
  projectRoot: string,
  platform: MobilePlatform,
): Promise<ExpoMetroRuntimeVersion> {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const runtimeAuthority = resolveBundleDropRuntimeVersionAuthority(
    absoluteProjectRoot,
    platform,
  );
  if (runtimeAuthority.source === 'bundle-drop') {
    return runtimeAuthority.runtimeVersion;
  }
  const exp = evaluateExpoConfig(absoluteProjectRoot).exp;
  const policy = getRuntimeVersionPolicy(getSelectedRuntimeVersion(exp, platform));
  if (policy === 'appVersion' || policy === 'nativeVersion') {
    return { source: policy };
  }
  return (await resolveExpoBuildIdentity(absoluteProjectRoot, platform)).runtimeVersion;
}
