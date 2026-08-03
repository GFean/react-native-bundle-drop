import fs from 'fs';
import path from 'path';
import {
  resolveExpoBuildIdentity,
  resolveExpoMetroRuntimeVersion,
} from '../../expo';
import { createExpoFixture, removeFixture } from './fixture';

describe('resolveExpoBuildIdentity', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      removeFixture(root);
    }
  });

  const fixture = (...args: Parameters<typeof createExpoFixture>): string => {
    const root = createExpoFixture(...args);
    roots.push(root);
    return root;
  };

  it.each(['54.0.36', '55.0.0', '56.1.2', '57.0.0-canary-1'])(
    'resolves literal identities for supported expo@%s',
    async expoVersion => {
      const root = fixture({
        expoVersion,
        config: {
          version: '2.3.4',
          runtimeVersion: 'shared-runtime',
          jsEngine: 'hermes',
          ios: {
            version: '2.3.5',
            buildNumber: '17',
            runtimeVersion: 'ios-runtime',
            jsEngine: 'jsc',
          },
          android: { versionCode: 18 },
        },
      });
      const identity = await resolveExpoBuildIdentity(root, 'ios');
      expect(identity).toEqual(
        expect.objectContaining({
          platform: 'ios',
          runtimeVersion: 'ios-runtime',
          runtimeVersionPolicy: 'literal',
          expoSdkVersion: expoVersion,
          reactNativeVersion: '0.83.0',
          javaScriptEngine: 'jsc',
          appVersion: '2.3.5',
          nativeVersion: '2.3.5(17)',
        }),
      );
      expect(identity.identityHash).toMatch(/^[a-f0-9]{64}$/);
      expect(await resolveExpoBuildIdentity(root, 'ios')).toEqual(identity);
    },
  );

  it('uses Bundle Drop literals without requiring an Expo runtimeVersion or fingerprint API', async () => {
    const root = fixture({
      expoVersion: '57.0.0',
      config: {
        name: 'Fixture',
        slug: 'fixture',
        version: '3.0.0',
        ios: { buildNumber: '9' },
        android: { versionCode: 10 },
      },
      bundleDropRuntimeVersion: {
        ios: 'bundle-ios-runtime',
        android: 'bundle-android-runtime',
      },
    });
    fs.writeFileSync(
      path.join(
        root,
        'node_modules/expo/node_modules/@expo/config-plugins/build/utils/Updates.js',
      ),
      `exports.getAppVersion = config => config.version;
       exports.getNativeVersion = (config, platform) => platform === 'ios'
         ? config.version + '(' + config.ios.buildNumber + ')'
         : config.version + '(' + config.android.versionCode + ')';`,
    );
    fs.writeFileSync(
      path.join(root, 'node_modules/expo/node_modules/@expo/fingerprint/index.js'),
      'throw new Error("fingerprint must not load");',
    );

    await expect(resolveExpoBuildIdentity(root, 'ios')).resolves.toEqual(
      expect.objectContaining({
        runtimeVersion: 'bundle-ios-runtime',
        runtimeVersionPolicy: 'literal',
        appVersion: '3.0.0',
        nativeVersion: '3.0.0(9)',
      }),
    );
    await expect(resolveExpoMetroRuntimeVersion(root, 'android')).resolves.toBe(
      'bundle-android-runtime',
    );
  });

  it.each([
    ['appVersion', '4.5.6', 'appVersion'],
    ['nativeVersion', '4.5.6(22)', 'nativeVersion'],
    ['sdkVersion', 'exposdk:56.0.0', 'sdkVersion'],
    ['fingerprint', 'fingerprint-android', 'fingerprint'],
  ] as const)('uses the official %s policy resolver', async (policy, expected, expectedPolicy) => {
    const root = fixture({
      expoVersion: '56.0.0',
      reactNativeVersion: '0.85.0',
      config: {
        version: '4.5.6',
        sdkVersion: '56.0.0',
        runtimeVersion: { policy },
        android: { versionCode: 22 },
      },
    });
    const identity = await resolveExpoBuildIdentity(root, 'android');
    expect(identity.runtimeVersion).toBe(expected);
    expect(identity.runtimeVersionPolicy).toBe(expectedPolicy);
    expect(identity.javaScriptEngine).toBe('hermes');
    expect(identity.nativeVersion).toBe('4.5.6(22)');
  });

  it('uses platform runtime policy overrides', async () => {
    const root = fixture({
      config: {
        version: '1.2.3',
        runtimeVersion: { policy: 'nativeVersion' },
        ios: { buildNumber: '4', runtimeVersion: { policy: 'appVersion' } },
      },
    });
    expect((await resolveExpoBuildIdentity(root, 'ios')).runtimeVersion).toBe('1.2.3');
  });

  it('rejects remote EAS native versioning and malformed eas.json without guessing', async () => {
    const root = fixture({
      config: {
        version: '1.0.0',
        runtimeVersion: { policy: 'nativeVersion' },
        ios: { buildNumber: '1' },
      },
    });
    fs.writeFileSync(path.join(root, 'eas.json'), JSON.stringify({ cli: { appVersionSource: 'remote' } }));
    await expect(resolveExpoBuildIdentity(root, 'ios')).rejects.toThrow('exact build receipt');
    await expect(resolveExpoMetroRuntimeVersion(root, 'ios')).resolves.toEqual({
      source: 'nativeVersion',
    });
    await expect(resolveExpoBuildIdentity(root, 'ios', {
      officialNativeBuildVersion: '42',
    })).resolves.toEqual(expect.objectContaining({
      runtimeVersion: '1.0.0(42)',
      nativeVersion: '1.0.0(42)',
    }));

    fs.writeFileSync(path.join(root, 'eas.json'), '{bad');
    await expect(resolveExpoBuildIdentity(root, 'ios')).rejects.toThrow('eas.json could not be parsed');
    await expect(resolveExpoMetroRuntimeVersion(root, 'ios')).resolves.toEqual({
      source: 'nativeVersion',
    });
  });

  it('validates official Android EAS version codes', async () => {
    const root = fixture({
      config: {
        version: '1.0.0',
        runtimeVersion: { policy: 'nativeVersion' },
      },
    });
    fs.writeFileSync(path.join(root, 'eas.json'), JSON.stringify({ cli: { appVersionSource: 'remote' } }));
    await expect(resolveExpoBuildIdentity(root, 'android', {
      officialNativeBuildVersion: 'not-a-version-code',
    })).rejects.toThrow('not a version code');
    await expect(resolveExpoBuildIdentity(root, 'android', {
      officialAppVersion: '',
      officialNativeBuildVersion: '42',
    })).rejects.toThrow('official app version is empty');
    await expect(resolveExpoBuildIdentity(root, 'android', {
      officialAppVersion: '1.0.0',
      officialNativeBuildVersion: '',
    })).rejects.toThrow('official EAS app build version is empty');
    await expect(resolveExpoBuildIdentity(root, 'android', {
      officialAppVersion: '2.0.0',
      officialNativeBuildVersion: '42',
    })).resolves.toEqual(expect.objectContaining({
      appVersion: '2.0.0',
      nativeVersion: '2.0.0(42)',
      runtimeVersion: '2.0.0(42)',
    }));
  });

  it('ignores remote EAS versioning for policies that do not depend on it', async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'eas.json'), JSON.stringify({ cli: { appVersionSource: 'remote' } }));
    await expect(resolveExpoBuildIdentity(root, 'android')).resolves.toEqual(
      expect.objectContaining({ runtimeVersion: 'runtime-literal' }),
    );
  });

  it('uses binary-backed Metro sentinels for app-derived policies', async () => {
    const appRoot = fixture({
      config: { version: '2.0.0', runtimeVersion: { policy: 'appVersion' } },
    });
    await expect(resolveExpoMetroRuntimeVersion(appRoot, 'android')).resolves.toEqual({
      source: 'appVersion',
    });

    const literalRoot = fixture();
    await expect(resolveExpoMetroRuntimeVersion(literalRoot, 'ios')).resolves.toBe(
      'runtime-literal',
    );
  });

  it.each([
    ['53.0.0', 'outside Bundle Drop'],
    ['58.0.0', 'outside Bundle Drop'],
    ['canary', 'Could not determine the Expo SDK'],
  ])('rejects unsupported or malformed Expo versions', async (expoVersion, message) => {
    const root = fixture({ expoVersion });
    await expect(resolveExpoBuildIdentity(root, 'ios')).rejects.toThrow(message);
  });

  it('rejects malformed package versions', async () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'node_modules', 'react-native', 'package.json'),
      JSON.stringify({ name: 'react-native', main: 'index.js', version: null }),
    );
    await expect(resolveExpoBuildIdentity(root, 'ios')).rejects.toThrow(
      'react-native/package.json does not contain a valid version',
    );
  });

  it.each([
    [{}, 'runtimeVersion must be'],
    [{ runtimeVersion: {} }, 'runtimeVersion must be'],
    [{ runtimeVersion: { policy: 'custom' } }, 'runtimeVersion must be'],
    [{ runtimeVersion: '' }, 'runtimeVersion must be'],
    [{ runtimeVersion: 'ok', jsEngine: 'v8' }, 'Unsupported Expo JavaScript engine'],
  ])('fails closed for an invalid identity input %#', async (config, message) => {
    const root = fixture({ config });
    await expect(resolveExpoBuildIdentity(root, 'ios')).rejects.toThrow(message);
  });

  it('rejects a policy that the official Expo utility cannot resolve concretely', async () => {
    const root = fixture({
      config: { version: '1.0.0', runtimeVersion: { policy: 'sdkVersion' } },
    });
    await expect(resolveExpoBuildIdentity(root, 'android')).rejects.toThrow(
      'did not resolve a concrete runtime version',
    );
  });

  it('rejects an unsupported platform at runtime', async () => {
    const root = fixture();
    await expect(resolveExpoBuildIdentity(root, 'windows' as 'ios')).rejects.toThrow(
      'Unsupported mobile platform',
    );
  });

  it('rejects incompatible runtime and fingerprint utility APIs', async () => {
    const baseUtilitiesRoot = fixture();
    fs.writeFileSync(
      path.join(
        baseUtilitiesRoot,
        'node_modules/expo/node_modules/@expo/config-plugins/build/utils/Updates.js',
      ),
      'exports.getRuntimeVersionAsync = async () => "ok";',
    );
    await expect(resolveExpoBuildIdentity(baseUtilitiesRoot, 'ios')).rejects.toThrow(
      'runtime-version utilities are incomplete',
    );

    const runtimeRoot = fixture();
    fs.writeFileSync(
      path.join(
        runtimeRoot,
        'node_modules/expo/node_modules/@expo/config-plugins/build/utils/Updates.js',
      ),
      `exports.getAppVersion = config => config.version;
       exports.getNativeVersion = config => config.version;`,
    );
    await expect(resolveExpoBuildIdentity(runtimeRoot, 'ios')).rejects.toThrow(
      'runtime-version utilities are incomplete',
    );

    const fingerprintRoot = fixture({ config: { runtimeVersion: { policy: 'fingerprint' } } });
    fs.writeFileSync(
      path.join(fingerprintRoot, 'node_modules/expo/node_modules/@expo/fingerprint/index.js'),
      'exports.createFingerprintAsync = null;',
    );
    await expect(resolveExpoBuildIdentity(fingerprintRoot, 'ios')).rejects.toThrow(
      'does not export createFingerprintAsync',
    );

    const emptyFingerprintRoot = fixture({
      config: { runtimeVersion: { policy: 'fingerprint' } },
    });
    fs.writeFileSync(
      path.join(emptyFingerprintRoot, 'node_modules/expo/node_modules/@expo/fingerprint/index.js'),
      'exports.createFingerprintAsync = async () => ({ hash: null });',
    );
    await expect(resolveExpoBuildIdentity(emptyFingerprintRoot, 'ios')).rejects.toThrow(
      'did not return a concrete hash',
    );
  });

  it('fails clearly for missing, non-object, and incomplete Bundle Drop runtime configs', async () => {
    const missingRoot = fixture();
    fs.unlinkSync(path.join(missingRoot, 'bundle.drop.config.js'));
    await expect(resolveExpoBuildIdentity(missingRoot, 'ios')).rejects.toThrow(
      'Could not load Bundle Drop runtime configuration',
    );

    const nonObjectRoot = fixture();
    fs.writeFileSync(path.join(nonObjectRoot, 'bundle.drop.config.js'), 'module.exports = null;');
    await expect(resolveExpoBuildIdentity(nonObjectRoot, 'ios')).rejects.toThrow(
      'Could not load Bundle Drop runtime configuration',
    );

    const incompleteRoot = fixture();
    fs.writeFileSync(
      path.join(incompleteRoot, 'bundle.drop.config.js'),
      "module.exports = { runtimeVersion: { ios: '   ' } };",
    );
    await expect(resolveExpoBuildIdentity(incompleteRoot, 'ios')).rejects.toThrow(
      'must define a non-empty runtimeVersion.ios literal',
    );
  });
});
