import { NativeModules } from 'react-native';

const { BundleDrop, BundleDropExpoIdentity } = NativeModules;

export function isBundleDropNativeAvailable(): boolean {
  return Boolean(BundleDrop);
}

export function isExpoOtaStartupEnabledNative(): boolean {
  const nativeValue = BundleDropExpoIdentity?.otaStartupEnabled;
  return nativeValue === true || nativeValue === 1;
}

export async function getDownloadedBundlePathNative(): Promise<string | null> {
  if (!BundleDrop?.getDownloadedBundlePath) {
    console.warn('BundleDrop.getDownloadedBundlePath is not defined');
    return null;
  }

  try {
    return await BundleDrop.getDownloadedBundlePath();
  } catch (e) {
    console.error('❌ Failed to get bundle path:', e);
    return null;
  }
}

export function restartReactNativeNative() {
  BundleDrop?.restartReactNative?.();
}

export async function setOtaEnabledNative(enabled: boolean): Promise<void> {
  if (!BundleDrop?.setOtaEnabled) return;
  try {
    await BundleDrop.setOtaEnabled(enabled);
  } catch (e) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.debug('BundleDrop.setOtaEnabled failed:', e);
    }
  }
}
