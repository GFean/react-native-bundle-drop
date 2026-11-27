import { selectRuntimeCompatibility } from '../../runtime-fingerprint/selection';

describe('runtime compatibility selection', () => {
  it('retains manual defaults and explicit Expo delegation', () => {
    expect(selectRuntimeCompatibility({ android: ' 1.0 ' }, 'android')).toEqual({ source: 'manual', runtimeVersion: '1.0' });
    expect(selectRuntimeCompatibility({ source: 'expo' }, 'ios')).toEqual({ source: 'expo' });
    expect(selectRuntimeCompatibility({ compatibilitySource: 'manual', ios: 'one' }, 'ios')).toEqual({ source: 'manual', runtimeVersion: 'one' });
  });

  it('supports optional boundaries and the default Scheme 2', () => {
    expect(selectRuntimeCompatibility({ compatibilitySource: 'fingerprint' }, 'android')).toEqual({ source: 'fingerprint', boundary: null, options: { schemeVersion: 2 } });
    expect(selectRuntimeCompatibility({ compatibilitySource: 'fingerprint', ios: ' one ', fingerprint: { schemeVersion: 2 } }, 'ios'))
      .toEqual({ source: 'fingerprint', boundary: 'one', options: { schemeVersion: 2 } });
  });

  it('rejects the retired Scheme 1 pin with migration guidance', () => {
    expect(() => selectRuntimeCompatibility({
      compatibilitySource: 'fingerprint', fingerprint: { schemeVersion: 1 },
    }, 'ios')).toThrow(/Scheme 1 is retired.*0\.13\.1.*rebuild for Scheme 2/);
  });

  it('retains valid native project mode and explicit sources', () => {
    const options = {
      nativeProjectMode: { ios: 'native', android: 'cng' },
      extraSources: [{ id: 'layout', type: 'file', value: 'native.json' }],
    };
    expect(selectRuntimeCompatibility({ compatibilitySource: 'fingerprint', fingerprint: options }, 'ios'))
      .toEqual({ source: 'fingerprint', boundary: null, options: { ...options, schemeVersion: 2 } });
  });

  it.each([
    null, [], {}, { source: 'other' }, { compatibilitySource: 'other' },
    { source: 'expo', ios: '1' }, { source: 'expo', compatibilitySource: 'fingerprint' },
    { source: 'expo', fingerprint: {} }, { ios: '1', fingerprint: {} },
    { compatibilitySource: 'fingerprint', android: '' },
    { compatibilitySource: 'fingerprint', ios: {} },
    { compatibilitySource: 'fingerprint', fingerprint: [] },
    { compatibilitySource: 'fingerprint', fingerprint: { schemeVersion: 3 } },
    { compatibilitySource: 'fingerprint', fingerprint: { schemeVersion: null } },
    { compatibilitySource: 'fingerprint', fingerprint: '' },
    { compatibilitySource: 'fingerprint', fingerprint: { extraSources: 'no' } },
    { compatibilitySource: 'fingerprint', fingerprint: { nativeProjectMode: [] } },
    { compatibilitySource: 'fingerprint', fingerprint: { nativeProjectMode: { ios: 'other' } } },
    { compatibilitySource: 'fingerprint', fingerprint: { mystery: true } },
  ])('rejects invalid or conflicting configuration: %j', value => {
    expect(() => selectRuntimeCompatibility(value, 'ios')).toThrow();
  });
});
