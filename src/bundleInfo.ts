import RNFS from './native/fs';

/**
 * Metadata persisted for the currently downloaded or applied OTA bundle.
 */
export type BundleInfo = {
  /** Monotonic bundle version assigned by BundleDrop. */
  bundleVersion?: number;
  /** Optional semantic/app version attached during upload. */
  version?: string;
  /** Immutable bundle hash used for install, reporting, and deduplication. */
  hash?: string;
  /** ISO timestamp for when this bundle metadata was written locally. */
  installedAt?: string;
  /** Channel used when the bundle was downloaded or installed. */
  channelName?: string;
  /** Platform this local metadata belongs to. */
  platform?: 'ios' | 'android';
  /** `true` when the bundle has downloaded but has not yet been applied. */
  pendingApply?: boolean;
  /** Last bundle hash successfully reported to the backend as installed. */
  lastInstalledReportedHash?: string;
  /** Bundle hashes already reported as installed for this app install. */
  installedReportedHashes?: string[];
  /** Runtime version the bundle is compatible with. */
  runtimeVersion?: string;
};

const BUNDLE_INFO_PATH = `${RNFS.DocumentDirectoryPath}/bundle-info.json`;

export async function readBundleInfo(): Promise<BundleInfo | null> {
  try {
    if (!(await RNFS.exists(BUNDLE_INFO_PATH))) return null;
    const raw = await RNFS.readFile(BUNDLE_INFO_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('⚠️ Failed to read bundle-info.json', e);
    return null;
  }
}

export async function writeBundleInfoDurably(info: BundleInfo): Promise<void> {
  await RNFS.writeFile(BUNDLE_INFO_PATH, JSON.stringify(info, null, 2), 'utf8');
}

export async function writeBundleInfo(info: BundleInfo): Promise<void> {
  try {
    await writeBundleInfoDurably(info);
  } catch (e) {
    console.warn('⚠️ Failed to write bundle-info.json', e);
  }
}

export async function updateBundleInfo(partial: Partial<BundleInfo>): Promise<void> {
  const existing = (await readBundleInfo()) || {};
  await writeBundleInfo({ ...existing, ...partial });
}

export async function deleteBundleInfo(): Promise<void> {
  try {
    if (await RNFS.exists(BUNDLE_INFO_PATH)) {
      await RNFS.unlink(BUNDLE_INFO_PATH);
    }
  } catch (e) {
    console.warn('⚠️ Failed to delete bundle-info.json', e);
  }
}
