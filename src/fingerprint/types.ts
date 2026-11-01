export type FingerprintExtraSource = {
  id: string;
  type: 'file' | 'dir' | 'environment';
  value: string;
  platforms?: ('ios' | 'android')[];
  optional?: boolean;
};

export type FingerprintOptions = {
  /** Frozen scheme 1. Calculation changes require a new scheme version. */
  schemeVersion?: 1;
  nativeProjectMode?: Partial<Record<'ios' | 'android', 'native' | 'cng'>>;
  extraSources?: FingerprintExtraSource[];
};

export type FingerprintSourceSummary = {
  type: string;
  id: string;
  hash: string | null;
  reasons: string[];
  debugInfo?: unknown;
};

export type NativeFingerprint = {
  status: 'stable';
  schemeVersion: 1;
  platform: 'ios' | 'android';
  runtimeVersion: string;
  nativeHash: string;
  manualBoundary: string | null;
  sources: FingerprintSourceSummary[];
};
