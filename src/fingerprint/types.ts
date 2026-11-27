export type FingerprintExtraSource = {
  id: string;
  type: 'file' | 'dir' | 'environment';
  value: string;
  platforms?: ('ios' | 'android')[];
  optional?: boolean;
};

export type FingerprintOptions = {
  /** Defaults to Scheme 2 when fingerprinting is enabled. */
  schemeVersion?: 2;
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
  schemeVersion: 2;
  platform: 'ios' | 'android';
  runtimeVersion: string;
  nativeHash: string;
  manualBoundary: string | null;
  sources: FingerprintSourceSummary[];
};
