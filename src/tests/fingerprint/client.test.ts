import childProcess from 'child_process';
import { calculateFingerprintSync } from '../../fingerprint/client';

describe('bounded fingerprint process adapter', () => {
  afterEach(() => jest.restoreAllMocks());
  it('returns the independently collected report', () => {
    const spawn = jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0, stdout: '{"runtimeVersion":"bdfp1-example"}' } as any);
    expect(calculateFingerprintSync('/fixture', 'android')).toEqual({ runtimeVersion: 'bdfp1-example' });
    expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: 120_000, shell: false });
  });
  it.each([
    { error: new Error('timed out'), status: null },
    { status: 1, stderr: 'required input failed' },
    { status: 2, stderr: '' },
  ])('fails instead of inventing or retaining an identity: %j', result => {
    jest.spyOn(childProcess, 'spawnSync').mockReturnValue(result as any);
    expect(() => calculateFingerprintSync('/fixture', 'ios')).toThrow('Fingerprint collection failed');
  });
  it('rejects malformed process output', () => {
    jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0, stdout: 'invalid' } as any);
    expect(() => calculateFingerprintSync('/fixture', 'android')).toThrow();
  });
  it('preserves an explicitly selected development environment', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const spawn = jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0, stdout: '{}' } as any);
      calculateFingerprintSync('/fixture', 'ios');
      expect(spawn.mock.calls[0][2]?.env?.NODE_ENV).toBe('development');
    } finally { process.env.NODE_ENV = before; }
  });
});
