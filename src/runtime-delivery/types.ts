export const RUNTIME_DELIVERY_ROLLOUT_ALGORITHM =
  'sha256-install-id-uint32be-mod100-v1' as const;
export const RUNTIME_DELIVERY_MANIFEST_JWS_TYPE = 'bundledrop-manifest+jws' as const;
export const RUNTIME_DELIVERY_AUTHORITY_LEASE_JWS_TYPE =
  'bundledrop-authority-lease+jws' as const;

export type RuntimeDeliveryPublicKey = {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
};

export type RuntimeDeliveryRelease = {
  releaseRef: string;
  bundleHash: string;
  bundleVersion: number;
  version?: string;
  runtimeVersion: string;
  manifestHash: string;
  jsBundleHash: string;
  fullBundleHash: string;
  fullBundleSizeBytes: number;
  available: boolean;
  expiresAt?: string | null;
};

export type RuntimeDeliveryPublishedRollout = {
  releaseRef: string;
  rolloutPercentage: number;
  status: 'active' | 'completed';
};

export type RuntimeDeliveryPatchEdge = {
  baseHash: string;
  targetHash: string;
  algorithm: string;
  patchSetHash: string;
  patchArtifactRef: string;
  patchSizeBytes: number;
  fullBundleSizeBytes: number;
  missingAssetsHash?: string | null;
  expiresAt?: string | null;
};

export type RuntimeDeliveryLaneManifest = {
  schemaVersion: 3;
  type: 'lane';
  projectSlug: string;
  channelName: string;
  platform: string;
  runtimeVersion: string;
  generation: number;
  generatedAt: string;
  resolutionMode: 'local' | 'dynamic';
  dynamicReason?: string;
  publishingMode: 'automatic' | 'managed';
  rolloutAlgorithm: typeof RUNTIME_DELIVERY_ROLLOUT_ALGORITHM;
  revokedHashes: string[];
  releases: RuntimeDeliveryRelease[];
  publishedRollouts: RuntimeDeliveryPublishedRollout[];
  patchPolicy: {
    enabled: boolean;
    maxPatchToFullRatio: number;
  };
  patchEdges: RuntimeDeliveryPatchEdge[];
  candidateSetComplete: boolean;
};

export type RuntimeDeliveryJws = {
  protected: string;
  payload: string;
  signature: string;
};

export type RuntimeDeliveryAuthorityLeaseV1 = {
  schemaVersion: 1;
  type: 'publisher-lease';
  manifestOrigin: string;
  generatedAt: string;
  expiresAt: string;
};

export type RuntimeDeliveryAuthorityLease = {
  schemaVersion: 2;
  type: 'publisher-lease';
  manifestOrigin: string;
  generatedAt: string;
  expiresAt: string;
  clientAuthority: 'enabled' | 'disabled';
};

export type RuntimeDeliveryLaneIdentity = {
  projectSlug: string;
  channelName: string;
  platform: string;
  runtimeVersion: string;
};
