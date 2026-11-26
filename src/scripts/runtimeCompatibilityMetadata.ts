import { RETIRED_SCHEME_ONE_MESSAGE, selectRuntimeCompatibility } from '../runtime-fingerprint/selection';

/** Display metadata only. runtimeVersion remains the exact compatibility key. */
export type RuntimeCompatibilityMetadata = {
  compatibilitySource: 'manual' | 'fingerprint';
  fingerprint?: {
    schemeVersion: 2;
    hash: string;
    manualBoundary: string | null;
  };
};

export function runtimeCompatibilityMetadata(
  runtimeConfig: unknown,
  platform: 'ios' | 'android',
  runtimeVersion: string,
): RuntimeCompatibilityMetadata {
  return selectedRuntimeCompatibility(selectRuntimeCompatibility(runtimeConfig, platform), runtimeVersion);
}

export function selectedRuntimeCompatibility(
  selection: ReturnType<typeof selectRuntimeCompatibility>,
  runtimeVersion: string,
): RuntimeCompatibilityMetadata {
  if (selection.source !== 'fingerprint') return { compatibilitySource: 'manual' };
  if (runtimeVersion.startsWith('bdfp1-')) throw new Error(RETIRED_SCHEME_ONE_MESSAGE);
  return {
    compatibilitySource: 'fingerprint',
    fingerprint: {
      schemeVersion: selection.options.schemeVersion,
      hash: runtimeVersion,
      manualBoundary: selection.boundary,
    },
  };
}
