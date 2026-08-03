import { Image, Platform, NativeModules } from 'react-native';

import RNFS from './native/fs';

let hasPatched = false;
const { BundleDrop } = NativeModules;

const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));
const hasFileExtension = (value: string) => /\/?[^/.]+\.[^/.]+$/.test(value);
const ANDROID_BASE_DENSITY = 160;
const ANDROID_SCALE_SUFFIXES: Record<string, string> = {
  '0.75': 'ldpi',
  '1': 'mdpi',
  '1.5': 'hdpi',
  '2': 'xhdpi',
  '3': 'xxhdpi',
  '4': 'xxxhdpi',
};
const ANDROID_DRAWABLE_FILE_TYPES = new Set([
  'gif',
  'heic',
  'heif',
  'jpeg',
  'jpg',
  'ktx',
  'png',
  'svg',
  'webp',
  'xml',
]);
// React Native has moved these between drawable-* and raw output across versions.
const ANDROID_RESOURCE_LOCATION_DRIFT_FILE_TYPES = new Set(['heic', 'heif', 'svg']);

type PackagerAsset = {
  __packager_asset?: boolean;
  httpServerLocation?: string;
  name?: string;
  scales?: number[];
  type?: string;
};

function getPackagerAsset(source: any): PackagerAsset | undefined {
  if (typeof source === 'number') {
    try {
      const registry = require('react-native/Libraries/Image/AssetRegistry') as {
        getAssetByID?: (assetId: number) => PackagerAsset | undefined;
      };
      return registry.getAssetByID?.(source);
    } catch {
      return undefined;
    }
  }

  return source?.__packager_asset ? source : undefined;
}

function getAssetBasePath(asset: PackagerAsset): string | undefined {
  const basePath = asset.httpServerLocation;
  if (!basePath) return undefined;
  return basePath.replace(/^\//, '');
}

function getAndroidResourceIdentifier(asset: PackagerAsset): string | undefined {
  const basePath = getAssetBasePath(asset);
  if (!basePath || !asset.name) return undefined;

  return `${basePath}/${asset.name}`
    .toLowerCase()
    .replace(/\//g, '_')
    .replace(/([^a-z0-9_])/g, '')
    .replace(/^(?:assets|assetsunstable_path)_/, '');
}

function getAndroidScaleSuffix(scale: number): string {
  const knownSuffix = ANDROID_SCALE_SUFFIXES[scale.toString()];
  if (knownSuffix) return knownSuffix;
  return `${Math.round(scale * ANDROID_BASE_DENSITY)}dpi`;
}

function getAssetScaleCandidates(asset: PackagerAsset, preferredScale?: number): number[] {
  const scales = Array.isArray(asset.scales)
    ? asset.scales.filter(scale => Number.isFinite(scale) && scale > 0)
    : [];
  const canUsePreferredScale = typeof preferredScale === 'number'
    && Number.isFinite(preferredScale)
    && preferredScale > 0
    && (scales.length === 0 || scales.includes(preferredScale));
  const preferredScales = canUsePreferredScale
    ? [preferredScale]
    : [];
  const candidates = [...preferredScales, ...scales];
  return Array.from(new Set(candidates.length > 0 ? candidates : [1]));
}

function getAndroidRawPathCandidates(resourceIdentifier: string, extension: string): string[] {
  return [
    `raw/${resourceIdentifier}${extension}`,
    `res/raw/${resourceIdentifier}${extension}`,
  ];
}

function getAndroidDrawablePathCandidates(
  asset: PackagerAsset,
  resourceIdentifier: string,
  extension: string,
  preferredScale?: number,
): string[] {
  return getAssetScaleCandidates(asset, preferredScale).flatMap(scale => {
    const suffix = getAndroidScaleSuffix(scale);
    const drawablePath = `drawable-${suffix}/${resourceIdentifier}${extension}`;
    return [drawablePath, `res/${drawablePath}`];
  });
}

function getAndroidResourcePathCandidates(
  asset: PackagerAsset,
  resourceIdentifier: string | undefined,
  extension: string,
  preferredScale?: number,
): string[] {
  if (!resourceIdentifier) return [];

  const assetType = asset.type?.toLowerCase();
  if (!assetType) return [];

  const hasLocationDrift = ANDROID_RESOURCE_LOCATION_DRIFT_FILE_TYPES.has(assetType);
  const shouldTryDrawable = ANDROID_DRAWABLE_FILE_TYPES.has(assetType) || hasLocationDrift;
  const shouldTryRaw = !ANDROID_DRAWABLE_FILE_TYPES.has(assetType) || hasLocationDrift;

  return [
    ...(shouldTryDrawable
      ? getAndroidDrawablePathCandidates(asset, resourceIdentifier, extension, preferredScale)
      : []),
    ...(shouldTryRaw ? getAndroidRawPathCandidates(resourceIdentifier, extension) : []),
  ];
}

function getAssetMetadataCandidates(asset?: PackagerAsset, preferredScale?: number): string[] {
  if (!asset?.name || !asset.type) return [];

  const extension = `.${asset.type.toLowerCase()}`;
  const basePath = getAssetBasePath(asset);
  const resourceIdentifier = getAndroidResourceIdentifier(asset);
  const pathWithExtension = basePath ? `${basePath}/${asset.name}${extension}` : undefined;
  const pathWithoutAssetsPrefix = pathWithExtension?.replace(/^assets\//, '');

  return unique([
    pathWithExtension ?? '',
    pathWithoutAssetsPrefix ?? '',
    ...getAndroidResourcePathCandidates(asset, resourceIdentifier, extension, preferredScale),
  ]);
}

export function patchImageResolverWithManifest(manifest: Record<string, string>) {
  if (!manifest || Object.keys(manifest).length === 0) {
    console.warn('🧩 Cannot patch image resolver — empty manifest');
    return;
  }

  const originalResolve = (Image as any).resolveAssetSource;

  (Image as any).resolveAssetSource = (source: any) => {
    const resolved = originalResolve(source);
    const packagerAsset = getPackagerAsset(source);

    if (typeof source !== 'number' && !source?.__packager_asset) {
      return resolved;
    }

    const uri = resolved?.uri;
    if (!uri) return resolved;

    if (/^(https?|data|content):/.test(uri)) {
      return resolved;
    }

    let cleanedKeyWithExtension = uri;
    if (uri.startsWith('file://')) {
      const parts = uri.split('/files/')[1];
      cleanedKeyWithExtension = parts ?? uri;
    } else {
      cleanedKeyWithExtension = uri
        .replace(/^asset:\/\//, '')
        .replace(/^asset:\//, '')
        .replace(/^assets\//, '')
        .replace(/^res\//, '');
    }

    const withExtensionWithoutAndroidPrefix = cleanedKeyWithExtension.replace(/^android\//, '');

    const pathCandidates = [
      cleanedKeyWithExtension,
      `res/${cleanedKeyWithExtension}`,
      withExtensionWithoutAndroidPrefix,
    ];
    const candidates = unique([
      ...getAssetMetadataCandidates(packagerAsset, resolved?.scale),
      ...pathCandidates,
    ]).filter(hasFileExtension);

    const finalPath = candidates.reduce<string | undefined>(
      (match, candidate) => match ?? manifest[candidate],
      undefined,
    );

    if (finalPath) {
      const fullPath = `file://${RNFS.DocumentDirectoryPath}/${finalPath}`;
      return { ...resolved, uri: fullPath };
    }

    return resolved;
  };
}

export function injectBundleDropImageResolver(manifestOverride?: Record<string, string>) {
  if (Platform.OS !== 'android') return;
  if (hasPatched && !manifestOverride) return;

  try {
    let manifest: Record<string, string>;

    if (manifestOverride) {
      manifest = manifestOverride;
    } else {
      const raw = BundleDrop.getImageManifestSync?.();
      if (!raw) return;
      manifest = JSON.parse(raw) as Record<string, string>;
    }

    patchImageResolverWithManifest(manifest);
    hasPatched = true;
  } catch {
    // Silently ignore – async path will retry
  }
}

export async function injectBundleDropImageResolverAsync() {
  if (Platform.OS !== 'android') return;
  if (hasPatched) return;

  try {
    const raw: string | null = await BundleDrop.getImageManifest?.();
    if (!raw) return;
    const manifest: Record<string, string> = JSON.parse(raw);
    patchImageResolverWithManifest(manifest);
    hasPatched = true;
  } catch {
    // Non-critical: images fall back to default resolution
  }
}
