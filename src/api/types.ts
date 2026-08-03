import type { UserProperties } from '../fs/userProperties';
import type { SupportedPatchAlgorithm } from '../patchAlgorithms';

export type OtaResolveRequest = {
  channelName: string;
  platform: string;
  runtimeVersion: string | null;
  environment: string | null;
  currentHash: string | null;
  currentUserProperties: UserProperties;
  rejectedHashes: string[];
  installId: string;
  transport: {
    manifestVersion: 1;
    patchAlgorithms: string[];
    supportsContentAddressedAssets: boolean;
  };
};

export type OtaInstallTarget = {
  bundleHash: string;
  downloadUrl?: string;
  manifestUrl: string;
  bundleVersion?: number;
  version?: string;
  runtimeVersion: string;
};

export type OtaPatchSet = {
  algorithm: string;
  patchSetHash: string;
  patchesUrl: string;
  assets?: {
    missingAssetsUrl?: string | null;
    missingAssetsHash?: string | null;
  };
};

export type OtaResolveResponse =
  | {
      action: 'NOOP';
      reason?:
        | 'UP_TO_DATE'
        | 'ROLLOUT_PAUSED'
        | 'ROLLOUT_NOT_ELIGIBLE'
        | 'TARGETING_NOT_MATCHED'
        | 'NO_PUBLISHED_BUNDLE'
        | 'NO_COMPATIBLE_BUNDLE';
      requestedRuntimeVersion?: string;
      latestRuntimeVersionOnChannel?: string;
    }
  | { action: 'ROLLBACK'; reason?: string }
  | {
      action: 'INSTALL';
      mode: 'full';
      target: OtaInstallTarget & {
        downloadUrl: string;
      };
    }
  | {
      action: 'INSTALL';
      mode: 'patch';
      baseHash: string;
      target: OtaInstallTarget;
      patchSet: OtaPatchSet;
      fallback: {
        mode: 'full';
        downloadUrl: string;
      };
    };

/**
 * Simplified update-check result returned by UI-facing APIs such as `useBundleDrop().checkLatest()`.
 * Internally this is derived from the `/ota/resolve` response.
 */
export type UpdateCheckResponse = {
  /** Server decision for the current channel/runtime. */
  action: 'NOOP' | 'INSTALL' | 'ROLLBACK';
  /** `true` when the current bundle is already up to date. */
  upToDate?: boolean;
  /** Target bundle version when an install is available. */
  bundleVersion?: number;
  /** Optional semantic/app version associated with the target bundle. */
  version?: string;
  /** Target bundle hash when an install is available. */
  hash?: string;
  /** Canonical full-tree bundle hash when an install is available. */
  bundleHash?: string;
  /** Response transport selected by the server. */
  mode?: 'full' | 'patch';
  /** Base bundle hash required when mode is patch. */
  baseHash?: string;
  /** Patch-set transport metadata when mode is patch. */
  patchSet?: OtaPatchSet;
  /** Full bundle fallback for patch responses. */
  fallback?: {
    mode: 'full';
    downloadUrl: string;
  };
  /** Target manifest URL, when provided by the server. */
  manifestUrl?: string;
  /** Signed or public download URL for the target bundle. */
  downloadUrl?: string;
  /** Channel used for this resolve decision. */
  channelName?: string;
  /** Server-side reason for `NOOP` or `ROLLBACK` decisions. */
  reason?: string;
  /** True when the latest server target was skipped because this install already failed it. */
  skippedFailedBundle?: boolean;
  /** Hash skipped by local failed-bundle quarantine. */
  skippedHash?: string;
  /** `true` when no compatible bundle exists for the current runtime version. */
  incompatible?: boolean;
  /** Runtime version attached to the target bundle or current request. */
  runtimeVersion?: string;
  /** Runtime version requested by the client when an incompatibility is reported. */
  requestedRuntimeVersion?: string;
  /** Latest runtime version available on the channel when the current runtime is incompatible. */
  latestRuntimeVersionOnChannel?: string;
};

export type ReportPatchApplyFailurePayload = {
  platform: string;
  runtimeVersion: string;
  installId?: string;
  baseHash?: string;
  targetHash: string;
  algorithm?: SupportedPatchAlgorithm;
  reason?: string;
};

export type PublicChannelsParams = {
  projectSlug: string;
};

export type ReportInstalledPayload = {
  channelName?: string;
  platform?: string;
  installId?: string | null;
  runtimeVersion?: string | null;
  environment?: string | null;
  userProperties?: UserProperties;
};

export type ReportLocalRollbackPayload = {
  reason: string;
  previousHash?: string | null;
  channelName?: string | null;
  platform?: string | null;
  runtimeVersion?: string | null;
  installId?: string | null;
  environment?: string | null;
  userProperties?: UserProperties;
  crashCount?: number | null;
  failedAt?: string | null;
};

/**
 * Public metadata for a single downloadable bundle returned by the bundle list endpoint.
 */
export type BundleListItem = {
  /** Immutable bundle hash used for install and deduplication. */
  hash: string;
  /** Monotonic bundle version number assigned by BundleDrop. */
  bundleVersion: number;
  /** Optional semantic/app version attached during upload. */
  version: string;
  /** Platform the bundle was built for. */
  platform: string;
  /** Runtime version the bundle is compatible with. */
  runtimeVersion: string;
  /** Optional release notes shown in UI. */
  releaseNotes: string | null;
  /** Bundle creation timestamp in ISO format. */
  createdAt: string;
  /** Download URL if the bundle is currently installable; `null` when unavailable. */
  downloadUrl: string | null;
};

export type BundleListResponse = {
  items: BundleListItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type BundleListParams = {
  channelName: string;
  platform?: string;
  limit?: number;
  cursor?: string;
};
