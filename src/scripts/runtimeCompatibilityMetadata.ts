import { selectRuntimeVersion } from '../fingerprint/config';

/** Display metadata only. runtimeVersion remains the exact compatibility key. */
export type RuntimeCompatibilityMetadata = {
  compatibilitySource: 'manual' | 'fingerprint';
  fingerprint?: {
    schemeVersion: 1;
    hash: string;
    manualBoundary: string | null;
  };
};

export function runtimeCompatibilityMetadata(
  runtimeConfig: unknown,
  platform: 'ios' | 'android',
  runtimeVersion: string,
): RuntimeCompatibilityMetadata {
  const selection = selectRuntimeVersion(runtimeConfig, platform);
  if (selection.source !== 'fingerprint') return { compatibilitySource: 'manual' };
  return {
    compatibilitySource: 'fingerprint',
    fingerprint: { schemeVersion: 1, hash: runtimeVersion, manualBoundary: selection.boundary },
  };
}
