const mockGetBundleDropRuntimeConfig = jest.fn();

jest.mock('../../runtime/initState', () => ({
  getBundleDropRuntimeConfig: () => mockGetBundleDropRuntimeConfig(),
}));

import {
  getRuntimeDeliveryDiagnosticCounters,
  recordRuntimeDeliveryDiagnostic,
  resetRuntimeDeliveryDiagnosticsForTests,
} from '../../runtime-delivery/diagnostics';

describe('runtime-delivery diagnostics', () => {
  beforeEach(() => {
    resetRuntimeDeliveryDiagnosticsForTests();
    mockGetBundleDropRuntimeConfig.mockReset().mockReturnValue(null);
  });

  it('keeps independent process counters and returns defensive snapshots', () => {
    recordRuntimeDeliveryDiagnostic('manifest_hit', { channelName: 'General' });
    recordRuntimeDeliveryDiagnostic('manifest_hit');
    recordRuntimeDeliveryDiagnostic('origin_fallback', { reason: 'timeout' });

    const snapshot = getRuntimeDeliveryDiagnosticCounters();
    expect(snapshot).toEqual(expect.objectContaining({
      manifest_hit: 2,
      origin_fallback: 1,
      invalid_signature: 0,
    }));
    snapshot.manifest_hit = 99;
    expect(getRuntimeDeliveryDiagnosticCounters().manifest_hit).toBe(2);
  });

  it('emits structured increments to the app listener without allowing it to break checks', () => {
    const listener = jest.fn();
    mockGetBundleDropRuntimeConfig.mockReturnValue({ onRuntimeDeliveryDiagnostic: listener });
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-08-17T00:00:00.000Z');

    recordRuntimeDeliveryDiagnostic('unknown_key', {
      channelName: 'General',
      reason: 'unknown_key',
    });
    expect(listener).toHaveBeenCalledWith({
      name: 'unknown_key',
      count: 1,
      timestamp: '2026-08-17T00:00:00.000Z',
      details: { channelName: 'General', reason: 'unknown_key' },
    });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    listener.mockImplementationOnce(() => {
      throw new Error('sink offline');
    });
    expect(() => recordRuntimeDeliveryDiagnostic('unknown_key')).not.toThrow();
    expect(getRuntimeDeliveryDiagnosticCounters().unknown_key).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      '[BundleDrop] runtime-delivery diagnostic listener failed:',
      expect.any(Error),
    );
  });
});
