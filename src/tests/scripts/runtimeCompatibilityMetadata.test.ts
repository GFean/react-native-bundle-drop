import { runtimeCompatibilityMetadata } from '../../scripts/runtimeCompatibilityMetadata';

describe('runtime compatibility display metadata', () => {
  const runtime = `bdfp1-${'a'.repeat(64)}`;
  it('keeps old config and explicit literals manual without inspecting the string', () => {
    expect(runtimeCompatibilityMetadata({ ios: runtime }, 'ios', runtime)).toEqual({ compatibilitySource: 'manual' });
    expect(runtimeCompatibilityMetadata({ source: 'expo' }, 'ios', 'expo-runtime')).toEqual({ compatibilitySource: 'manual' });
  });
  it('emits Scheme 2 metadata by default or when explicitly selected', () => {
    const config = { compatibilitySource: 'fingerprint', ios: ' 4.0.27 ' };
    const defaultRuntime = `bdfp2-${'b'.repeat(64)}`;
    expect(runtimeCompatibilityMetadata(config, 'ios', defaultRuntime)).toEqual({
      compatibilitySource: 'fingerprint',
      fingerprint: { schemeVersion: 2, hash: defaultRuntime, manualBoundary: '4.0.27' },
    });
    expect(runtimeCompatibilityMetadata({ ...config, fingerprint: { schemeVersion: 2 } }, 'ios', defaultRuntime)).toEqual({
      compatibilitySource: 'fingerprint',
      fingerprint: { schemeVersion: 2, hash: defaultRuntime, manualBoundary: '4.0.27' },
    });
    expect(runtimeCompatibilityMetadata(config, 'android', defaultRuntime).fingerprint?.manualBoundary).toBeNull();
  });
  it('rejects retired fingerprints passed as a build identity under fingerprint authority', () => {
    expect(() => runtimeCompatibilityMetadata({ compatibilitySource: 'fingerprint' }, 'ios', runtime))
      .toThrow(/Scheme 1 is retired.*0\.13\.1/);
  });
});
