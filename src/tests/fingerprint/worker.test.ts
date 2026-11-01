import { collectNativeFingerprint } from '../../fingerprint/collect';
import { runFingerprintWorker } from '../../fingerprint/worker';

jest.mock('../../fingerprint/collect', () => ({ collectNativeFingerprint: jest.fn() }));

describe('fingerprint worker protocol', () => {
  const originalExitCode = process.exitCode;
  beforeEach(() => {
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.exitCode = undefined;
  });
  afterEach(() => { jest.restoreAllMocks(); process.exitCode = originalExitCode; });
  it.each([[], ['/fixture', 'windows']])('rejects invalid arguments %j', async (...args) => {
    await runFingerprintWorker(args);
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });
  it('writes one JSON result', async () => {
    (collectNativeFingerprint as jest.Mock).mockResolvedValue({ runtimeVersion: 'test' });
    await runFingerprintWorker(['/fixture', 'android']);
    expect(process.stdout.write).toHaveBeenCalledWith('{"runtimeVersion":"test"}\n');
    expect(process.exitCode).toBeUndefined();
  });
  it('fails with the collector error', async () => {
    (collectNativeFingerprint as jest.Mock).mockRejectedValue(new Error('missing required input'));
    await runFingerprintWorker(['/fixture', 'ios']);
    expect(process.stderr.write).toHaveBeenCalledWith('missing required input\n');
    expect(process.exitCode).toBe(1);
  });
});
