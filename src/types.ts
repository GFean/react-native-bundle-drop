/**
 * Startup policy controlling what BundleDrop does after local state hydration.
 */
export type UpdatePolicy = 'manual' | 'immediate' | 'on-next-launch';

/** The current phase of the BundleDrop update flow. */
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'applying';
