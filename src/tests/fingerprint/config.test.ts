import { selectRuntimeVersion } from '../../fingerprint/config';

describe('runtime compatibility selection', () => {
  it('retains manual defaults and explicit Expo delegation', () => {
    expect(selectRuntimeVersion({ android: ' 1.0 ' }, 'android')).toEqual({ source: 'manual', runtimeVersion: '1.0' });
    expect(selectRuntimeVersion({ source: 'expo' }, 'ios')).toEqual({ source: 'expo' });
    expect(selectRuntimeVersion({ compatibilitySource: 'manual', ios: 'one' }, 'ios')).toEqual({ source: 'manual', runtimeVersion: 'one' });
  });

  it('supports optional boundaries and the permanently implicit scheme 1', () => {
    expect(selectRuntimeVersion({ compatibilitySource: 'fingerprint' }, 'android')).toEqual({ source: 'fingerprint', boundary: null, options: {} });
    expect(selectRuntimeVersion({ compatibilitySource: 'fingerprint', ios: ' one ', fingerprint: { schemeVersion: 1 } }, 'ios'))
      .toEqual({ source: 'fingerprint', boundary: 'one', options: { schemeVersion: 1 } });
  });

  it.each([
    null, [], {}, { source: 'other' }, { compatibilitySource: 'other' },
    { source: 'expo', ios: '1' }, { source: 'expo', compatibilitySource: 'fingerprint' },
    { source: 'expo', fingerprint: {} }, { ios: '1', fingerprint: {} },
    { compatibilitySource: 'fingerprint', android: '' },
    { compatibilitySource: 'fingerprint', ios: {} },
    { compatibilitySource: 'fingerprint', fingerprint: [] },
    { compatibilitySource: 'fingerprint', fingerprint: { schemeVersion: 2 } },
    { compatibilitySource: 'fingerprint', fingerprint: { extraSources: 'no' } },
    { compatibilitySource: 'fingerprint', fingerprint: { nativeProjectMode: [] } },
    { compatibilitySource: 'fingerprint', fingerprint: { nativeProjectMode: { ios: 'other' } } },
    { compatibilitySource: 'fingerprint', fingerprint: { mystery: true } },
  ])('rejects invalid or conflicting configuration: %j', value => {
    expect(() => selectRuntimeVersion(value, 'ios')).toThrow();
  });
});
