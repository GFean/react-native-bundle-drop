export const XDELTA_PATCH_ALGORITHM = 'xdelta3-vcdiff';
export const ASSET_ONLY_PATCH_ALGORITHM = 'asset-only-v1';

export const SUPPORTED_PATCH_ALGORITHMS = [
  XDELTA_PATCH_ALGORITHM,
  ASSET_ONLY_PATCH_ALGORITHM,
] as const;

export type SupportedPatchAlgorithm = (typeof SUPPORTED_PATCH_ALGORITHMS)[number];
