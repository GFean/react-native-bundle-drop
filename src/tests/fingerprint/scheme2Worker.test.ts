import { readBundleDropRuntimeSelection } from '../../expo/runtimeVersion';
import { collectNativeFingerprintV2 } from '../../fingerprintV2/collect';
import { runRuntimeFingerprintWorker } from '../../runtime-fingerprint/worker';

jest.mock('../../expo/runtimeVersion');
jest.mock('../../fingerprintV2/collect');

describe('Scheme 2 fingerprint worker', () => {
  it.each([[], ['unknown'], ['/app', 'ios'], ['ios', '/app']])('validates arguments %j', async (...args) => {
    await expect(runRuntimeFingerprintWorker(args)).rejects.toThrow('Usage: fingerprint worker');
  });

  it('requires fingerprint authority in the worker', async () => {
    jest.mocked(readBundleDropRuntimeSelection).mockReturnValue({ source: 'manual', runtimeVersion: '1.0' });
    await expect(runRuntimeFingerprintWorker(['android'])).rejects.toThrow('requires compatibilitySource: fingerprint');
  });

  it('passes the validated inputs to the collector and emits its report', async () => {
    const nativeProjectMode = { android: 'native' } as const;
    jest.mocked(readBundleDropRuntimeSelection).mockReturnValue({
      source: 'fingerprint', boundary: 'release', options: { schemeVersion: 2, nativeProjectMode },
    });
    const report = { runtimeVersion: 'bdfp2-result' } as any;
    jest.mocked(collectNativeFingerprintV2).mockResolvedValue(report);
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runRuntimeFingerprintWorker(['android']);
      expect(readBundleDropRuntimeSelection).toHaveBeenCalledWith(process.cwd(), 'android');
      expect(collectNativeFingerprintV2).toHaveBeenCalledWith(process.cwd(), 'android', {
        nativeProjectMode, extraSources: undefined,
      }, 'release');
      expect(write).toHaveBeenCalledWith(JSON.stringify(report) + '\n');
    } finally {
      write.mockRestore();
    }
  });
});
