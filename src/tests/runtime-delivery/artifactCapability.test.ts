import { InstallPhaseError } from '../../errors';
import { isArtifactCapabilityRejected } from '../../runtime-delivery/artifactCapability';

describe('runtime-delivery/artifactCapability', () => {
  it.each([
    [{ status: 401 }],
    [{ statusCode: 403 }],
    [{ httpStatus: 401 }],
    ['HTTP 403: expired'],
    [{ message: 'HTTP 401 capability rejected' }],
    [{ cause: { status: 403 } }],
    [{ error: { userInfo: { message: 'HTTP 401' } } }],
  ])('recognizes download-phase capability rejection from %p', cause => {
    expect(isArtifactCapabilityRejected(new InstallPhaseError('download', cause))).toBe(true);
  });

  it('recognizes a nested InstallPhaseError cause', () => {
    const nested = new InstallPhaseError('download', { status: 403 });
    expect(isArtifactCapabilityRejected(new InstallPhaseError('download', nested))).toBe(true);
  });

  it.each([
    null,
    403,
    'HTTP 500',
    { status: 500 },
    { message: 'permission denied' },
  ])('rejects non-capability values from %p', cause => {
    expect(isArtifactCapabilityRejected(new InstallPhaseError('download', cause))).toBe(false);
  });

  it('rejects install-phase and untagged failures', () => {
    expect(isArtifactCapabilityRejected(new InstallPhaseError('install', { status: 403 }))).toBe(false);
    expect(isArtifactCapabilityRejected({ status: 403 })).toBe(false);
  });

  it('bounds recursive inspection of malformed cyclic causes', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.cause = cyclic;
    expect(isArtifactCapabilityRejected(new InstallPhaseError('download', cyclic))).toBe(false);
  });
});
