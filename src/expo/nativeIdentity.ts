import { NativeModules } from 'react-native';

type ExpoNativeIdentityConstants = {
  appVersion?: unknown;
  appBuildVersion?: unknown;
};

export function resolveExpoNativeRuntimeVersion(
  source: 'appVersion' | 'nativeVersion',
): string {
  const identity = NativeModules.BundleDropExpoIdentity as
    | ExpoNativeIdentityConstants
    | undefined;
  const appVersion = identity?.appVersion;
  const appBuildVersion = identity?.appBuildVersion;
  if (
    typeof appVersion !== 'string' || !appVersion.trim() ||
    typeof appBuildVersion !== 'string' || !appBuildVersion.trim()
  ) {
    throw new Error(
      'Bundle Drop could not read the Expo native build version. ' +
        'Create a new native binary with the Bundle Drop Expo adapter.',
    );
  }
  return source === 'appVersion'
    ? appVersion
    : `${appVersion}(${appBuildVersion})`;
}
