import childProcess from 'child_process';
import path from 'path';
import { calculateRuntimeFingerprint } from '../../runtime-fingerprint/calculate';

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

describe('runtime fingerprint client', () => {
  it('starts the bounded worker in the selected project directory', () => {
    const report = { schemeVersion: 2, runtimeVersion: 'bdfp2-next' };
    jest.mocked(childProcess.spawnSync).mockReturnValue({ status: 0, stdout: JSON.stringify(report) } as any);
    const original = process.env.NODE_ENV;
    try {
      for (const mode of ['development', 'production']) {
        process.env.NODE_ENV = mode;
        expect(calculateRuntimeFingerprint('fixture', 'android')).toEqual(report);
        expect(childProcess.spawnSync).toHaveBeenLastCalledWith(process.execPath, [
          expect.stringMatching(/runtime-fingerprint[/\\]worker\.js$/), 'android',
        ], expect.objectContaining({ cwd: path.resolve('fixture'), shell: false, env: expect.objectContaining({ NODE_ENV: mode }) }));
      }
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it.each([
    [{ error: new Error('worker timed out'), status: null, stderr: '' }, 'worker timed out'],
    [{ status: 1, stderr: 'invalid source\n' }, 'invalid source'],
    [{ status: 3, stderr: '' }, 'exit 3'],
  ])('reports Scheme 2 collection failure %j', (result, message) => {
    jest.mocked(childProcess.spawnSync).mockReturnValue(result as any);
    expect(() => calculateRuntimeFingerprint('/project', 'ios')).toThrow(`Fingerprint collection failed: ${message}`);
  });
});
