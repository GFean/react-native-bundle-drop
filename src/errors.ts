export type BundleDropErrorCode =
  | 'CHECK_FAILED'
  | 'RESOLVE_FAILED'
  | 'INCOMPATIBLE_BINARY'
  | 'NO_UPDATE'
  | 'DOWNLOAD_URL_MISSING'
  | 'DOWNLOAD_FAILED'
  | 'INSTALL_FAILED'
  | 'HASH_MISSING'
  | 'APPLY_NO_BUNDLE'
  | 'APPLY_ALREADY_APPLIED'
  | 'APPLY_FAILED'
  | 'UNKNOWN';

export type BundleDropErrorStep =
  | 'check'
  | 'resolve'
  | 'resolveDownloadUrl'
  | 'download'
  | 'install'
  | 'persist'
  | 'apply';

/**
 * Structured error thrown by BundleDrop runtime flows.
 */
export class BundleDropError extends Error {
  /** Stable machine-readable error code. */
  code: BundleDropErrorCode;
  /** Runtime step where the error occurred. */
  step: BundleDropErrorStep;
  /** Optional diagnostic context for logs or support tooling. */
  context?: Record<string, any>;
  /** Original error or value that caused this error, when available. */
  cause?: unknown;

  /**
   * Create a structured BundleDrop runtime error.
   */
  constructor(args: {
    /** Human-readable error message. */
    message: string;
    /** Stable machine-readable error code. */
    code: BundleDropErrorCode;
    /** Runtime step where the error occurred. */
    step: BundleDropErrorStep;
    /** Optional diagnostic context for logs or support tooling. */
    context?: Record<string, any>;
    /** Original error or value that caused this error, when available. */
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'BundleDropError';
    this.code = args.code;
    this.step = args.step;
    this.context = args.context;
    this.cause = args.cause;
  }
}

/**
 * Type guard for `BundleDropError`.
 */
export function isBundleDropError(e: unknown): e is BundleDropError {
  return !!e && typeof e === 'object' && (e as any).name === 'BundleDropError';
}

export type InstallPhase = 'download' | 'install';

export class InstallPhaseError extends Error {
  phase: InstallPhase;
  originalCause: unknown;
  constructor(phase: InstallPhase, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(msg);
    this.name = 'InstallPhaseError';
    this.phase = phase;
    this.originalCause = cause;
  }
}

export function isInstallPhaseError(e: unknown): e is InstallPhaseError {
  return !!e && typeof e === 'object' &&
    (e as any).name === 'InstallPhaseError' &&
    typeof (e as any).phase === 'string';
}
