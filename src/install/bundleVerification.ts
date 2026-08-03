import RNFS from '../native/fs';

import {
  BUNDLE_MANIFEST,
  BundleManifest,
  assertValidBundleManifest,
} from '../manifest/bundleManifest';

export const readJsonFile = async <T>(path: string): Promise<T> => {
  const raw = await RNFS.readFile(path, 'utf8');
  return JSON.parse(raw) as T;
};

export const bundleManifestPath = (dir: string) => `${dir}/${BUNDLE_MANIFEST}`;

export const readValidatedBundleManifestFromDir = async (
  dir: string,
  expectedHash?: string,
  expectedPlatform?: 'ios' | 'android',
): Promise<BundleManifest | null> => {
  const manifestPath = bundleManifestPath(dir);
  if (!(await RNFS.exists(manifestPath))) {
    return null;
  }
  const manifest = await readJsonFile<BundleManifest>(manifestPath);
  assertValidBundleManifest(manifest, expectedHash, expectedPlatform);
  return manifest;
};

export const verifyBundleDir = async (
  dir: string,
  expectedHash?: string,
  expectedPlatform?: 'ios' | 'android',
): Promise<BundleManifest | null> => {
  const manifest = await readValidatedBundleManifestFromDir(dir, expectedHash, expectedPlatform);
  if (!manifest) {
    return null;
  }
  await RNFS.verifyBundleFiles(dir, bundleManifestPath(dir));
  return manifest;
};
