import { BundleDropError, isBundleDropError, InstallPhaseError, isInstallPhaseError } from '../errors';

describe('errors', () => {
  it('creates a structured BundleDropError with context and cause', () => {
    const cause = new Error('root failure');
    const error = new BundleDropError({
      message: 'Apply failed',
      code: 'APPLY_FAILED',
      step: 'apply',
      context: { hash: 'hash-1' },
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('BundleDropError');
    expect(error.code).toBe('APPLY_FAILED');
    expect(error.step).toBe('apply');
    expect(error.context).toEqual({ hash: 'hash-1' });
    expect(error.cause).toBe(cause);
  });

  it('detects BundleDropError objects via the type guard', () => {
    const bundleDropError = new BundleDropError({
      message: 'Resolve failed',
      code: 'RESOLVE_FAILED',
      step: 'resolve',
    });

    expect(isBundleDropError(bundleDropError)).toBe(true);
    expect(isBundleDropError(new Error('plain error'))).toBe(false);
    expect(isBundleDropError(null)).toBe(false);
    expect(isBundleDropError({ name: 'BundleDropError' })).toBe(true);
  });

  it('creates InstallPhaseError wrapping an Error cause', () => {
    const cause = new Error('network failure');
    const err = new InstallPhaseError('download', cause);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InstallPhaseError');
    expect(err.phase).toBe('download');
    expect(err.message).toBe('network failure');
    expect(err.originalCause).toBe(cause);
  });

  it('creates InstallPhaseError wrapping a non-Error cause', () => {
    const err = new InstallPhaseError('install', 'string cause');

    expect(err.name).toBe('InstallPhaseError');
    expect(err.phase).toBe('install');
    expect(err.message).toBe('string cause');
    expect(err.originalCause).toBe('string cause');
  });

  it('detects InstallPhaseError via the type guard', () => {
    const phaseErr = new InstallPhaseError('download', new Error('net'));
    expect(isInstallPhaseError(phaseErr)).toBe(true);
    expect(isInstallPhaseError(new Error('plain'))).toBe(false);
    expect(isInstallPhaseError(null)).toBe(false);
    expect(isInstallPhaseError({ name: 'InstallPhaseError', phase: 'install' })).toBe(true);
    expect(isInstallPhaseError({ name: 'InstallPhaseError' })).toBe(false);
  });
});
