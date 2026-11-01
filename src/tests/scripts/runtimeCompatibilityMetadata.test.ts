import { runtimeCompatibilityMetadata } from '../../scripts/runtimeCompatibilityMetadata';

describe('runtime compatibility display metadata', () => {
  const runtime = `bdfp1-${'a'.repeat(64)}`;
  it('keeps old config and explicit literals manual without inspecting the string', () => {
    expect(runtimeCompatibilityMetadata({ ios: runtime }, 'ios', runtime)).toEqual({ compatibilitySource: 'manual' });
    expect(runtimeCompatibilityMetadata({ source: 'expo' }, 'ios', 'expo-runtime')).toEqual({ compatibilitySource: 'manual' });
  });
  it('emits identical scheme 1 metadata with or without a public scheme option', () => {
    const config = { compatibilitySource: 'fingerprint', ios: ' 4.0.27 ' };
    const expected = { compatibilitySource: 'fingerprint', fingerprint: { schemeVersion: 1, hash: runtime, manualBoundary: '4.0.27' } };
    expect(runtimeCompatibilityMetadata(config, 'ios', runtime)).toEqual(expected);
    expect(runtimeCompatibilityMetadata({ ...config, fingerprint: { schemeVersion: 1 } }, 'ios', runtime)).toEqual(expected);
    expect(runtimeCompatibilityMetadata(config, 'android', runtime).fingerprint?.manualBoundary).toBeNull();
  });
});
