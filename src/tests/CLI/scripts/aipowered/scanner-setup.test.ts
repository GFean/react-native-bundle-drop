import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  findCredentialLikeLiteral,
  findProjectRoot,
  isBundleDropHostedAiPlanningServer,
  isTrustedAiPlanningServer,
  scanProjectForAiSetup,
} from '../../../../CLI/scripts/aipowered/scanner';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

describe('CLI/scripts/aipowered/scanner unified setup', () => {
  let projectRoot = '';
  let fakeHome = '';
  let homedirSpy: jest.SpyInstance;

  const installEvaluatedExpoProject = (params: {
    expoVersion?: string;
    reactNativeVersion?: string;
    exp?: Record<string, unknown>;
  } = {}) => {
    const expoDirectory = path.join(projectRoot, 'node_modules', 'expo');
    const reactNativeDirectory = path.join(projectRoot, 'node_modules', 'react-native');
    const configDirectory = path.join(expoDirectory, 'node_modules', '@expo', 'config');
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.mkdirSync(reactNativeDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(expoDirectory, 'package.json'),
      JSON.stringify({ name: 'expo', version: params.expoVersion || '57.0.0' }),
    );
    fs.writeFileSync(
      path.join(reactNativeDirectory, 'package.json'),
      JSON.stringify({
        name: 'react-native',
        version: params.reactNativeVersion || '0.86.0',
      }),
    );
    fs.writeFileSync(
      path.join(configDirectory, 'package.json'),
      JSON.stringify({ name: '@expo/config', version: '1.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'evaluated-expo.json'),
      JSON.stringify(params.exp || { name: 'Fixture', slug: 'fixture' }),
    );
    fs.writeFileSync(
      path.join(configDirectory, 'index.js'),
      `const fs = require('fs');
       const path = require('path');
       exports.getConfig = root => ({
         exp: JSON.parse(fs.readFileSync(path.join(root, 'evaluated-expo.json'), 'utf8')),
         pkg: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
       });`,
    );
  };

  beforeEach(() => {
    projectRoot = createTempProjectDir();
    fakeHome = createTempProjectDir();
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.bundle-drop'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.bundle-drop', 'auth.json'),
      JSON.stringify({ token: 'setup-token' }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'bundle.drop.config.js'),
      `module.exports = {
        serverUrl: 'https://api.bundledrop.app/',
        org: { slug: 'alpha' },
        project: { slug: 'mobile' },
        runtimeVersion: { source: 'expo' },
      };`,
    );
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    removeTempDir(projectRoot);
    removeTempDir(fakeHome);
  });

  it('recognizes trusted production and local planning servers only', () => {
    expect(isTrustedAiPlanningServer('https://api.bundledrop.app')).toBe(true);
    expect(isTrustedAiPlanningServer('http://api.bundledrop.app')).toBe(false);
    expect(isTrustedAiPlanningServer('http://localhost:4000')).toBe(true);
    expect(isTrustedAiPlanningServer('https://127.0.0.1:4000')).toBe(true);
    expect(isTrustedAiPlanningServer('https://planning.example.com')).toBe(false);
    expect(isTrustedAiPlanningServer('not a url')).toBe(false);
    expect(isBundleDropHostedAiPlanningServer('https://api.bundledrop.app')).toBe(true);
    expect(isBundleDropHostedAiPlanningServer('http://api.bundledrop.app')).toBe(false);
    expect(isBundleDropHostedAiPlanningServer('not a url')).toBe(false);

    process.env.BUNDLE_DROP_ALLOW_UNTRUSTED_AI_SERVER = '1';
    try {
      expect(isTrustedAiPlanningServer('https://planning.example.com')).toBe(true);
    } finally {
      delete process.env.BUNDLE_DROP_ALLOW_UNTRUSTED_AI_SERVER;
    }
  });

  it('detects credential literals without flagging environment references', () => {
    expect(findCredentialLikeLiteral("const apiKey = 'secret-value'")).toBe(
      'credential-like property',
    );
    expect(findCredentialLikeLiteral("authorization: 'Bearer secret-value'")).toBe(
      'authorization header',
    );
    expect(findCredentialLikeLiteral('https://user:pass@example.com')).toBe(
      'credential-bearing URL',
    );
    const privateKeyMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const accessTokenMarker = ['github', 'pat', '12345678901234567890'].join('_');

    expect(findCredentialLikeLiteral(privateKeyMarker)).toBe('private key');
    expect(findCredentialLikeLiteral(accessTokenMarker)).toBe(
      'known access token format',
    );
    expect(findCredentialLikeLiteral('const apiKey = process.env.PROJECT_API_KEY')).toBeNull();
  });

  it('finds the project config from a nested directory', () => {
    const nestedDirectory = path.join(projectRoot, 'src', 'features');
    fs.mkdirSync(nestedDirectory, { recursive: true });

    expect(findProjectRoot(nestedDirectory)).toBe(projectRoot);
    expect(findProjectRoot(path.join(fakeHome, 'missing'))).toBe(path.join(fakeHome, 'missing'));

    const originalCwd = process.cwd();
    process.chdir(nestedDirectory);
    try {
      expect(fs.realpathSync(findProjectRoot())).toBe(fs.realpathSync(projectRoot));
      expect(fs.realpathSync(scanProjectForAiSetup('bare').projectRoot)).toBe(
        fs.realpathSync(projectRoot),
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('requires a readable authenticated CLI session', () => {
    const authPath = path.join(fakeHome, '.bundle-drop', 'auth.json');
    fs.unlinkSync(authPath);
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow('Not authenticated');

    fs.writeFileSync(authPath, '{}');
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'Failed to read CLI auth session',
    );

    fs.writeFileSync(authPath, '{invalid');
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'Failed to read CLI auth session',
    );
  });

  it('allows a private planning server only through the explicit override', () => {
    process.env.BUNDLE_DROP_ALLOW_UNTRUSTED_AI_SERVER = '1';
    try {
      fs.writeFileSync(
        path.join(projectRoot, 'bundle.drop.config.js'),
        `module.exports = {
          serverUrl: 'https://planning.example.com/',
          org: { slug: 'alpha' },
          project: { slug: 'mobile' },
        };`,
      );

      expect(scanProjectForAiSetup('bare', projectRoot).serverUrl).toBe(
        'https://planning.example.com',
      );
    } finally {
      delete process.env.BUNDLE_DROP_ALLOW_UNTRUSTED_AI_SERVER;
    }
  });

  it('collects Expo setup context and detects Router, engine, native directories, and active Updates', () => {
    installEvaluatedExpoProject({
      expoVersion: '57.0.7',
      reactNativeVersion: '0.86.2',
      exp: {
        name: 'Fixture',
        slug: 'fixture',
        jsEngine: 'jsc',
        plugins: ['expo-updates', '@gfean/react-native-bundle-drop'],
        updates: { url: 'https://u.expo.dev/project' },
      },
    });
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        main: 'expo-router/entry',
        packageManager: 'pnpm@10.0.0',
        dependencies: {
          expo: '^57.0.0',
          'react-native': '0.86.0',
          'expo-router': '^7.0.0',
          'expo-updates': '^0.30.0',
          'react-native-code-push': '^9.0.0',
          '@gfean/react-native-bundle-drop': '0.4.3',
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'app.json'),
      JSON.stringify({
        expo: {
          jsEngine: 'jsc',
          plugins: ['expo-updates', '@gfean/react-native-bundle-drop'],
          updates: { url: 'https://u.expo.dev/project' },
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'metro.config.js'),
      "module.exports = withBundleDropExpo(require('expo/metro-config'));",
    );
    fs.mkdirSync(path.join(projectRoot, 'ios'));

    const result = scanProjectForAiSetup('expo', projectRoot);

    expect(result).toEqual(expect.objectContaining({
      projectRoot,
      serverUrl: 'https://api.bundledrop.app',
      orgSlug: 'alpha',
      projectSlug: 'mobile',
      authToken: 'setup-token',
    }));
    expect(result.request.detected).toEqual(expect.objectContaining({
      rnVersion: '0.86.2',
      expoSdkVersion: '57.0.7',
      bundleDropStatus: 'configured',
      hasNativeDirectories: true,
      usesExpoRouter: true,
      jsEngine: 'jsc',
      expoUpdatesStatus: 'active',
      codePushDetected: true,
    }));
    expect(result.request.detected.signals).toEqual(expect.arrayContaining([
      'expoProject',
      'expoBundleDropPlugin',
      'iosDirectory',
      'expoUpdatesDependency',
      'codePushDependency',
      'expoRouter',
    ]));
    expect(result.request.files.map(file => [file.path, file.kind])).toEqual(expect.arrayContaining([
      ['package.json', 'package_manifest'],
      ['bundle.drop.config.js', 'bundle_drop_config'],
      ['app.json', 'expo_app_config'],
      ['metro.config.js', 'metro_config'],
    ]));
    expect(result.request.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    const packageFile = result.request.files.find(file => file.path === 'package.json');
    const bundleConfigFile = result.request.files.find(
      file => file.path === 'bundle.drop.config.js',
    );
    expect(packageFile?.content).toContain('BundleDrop context summary for package.json');
    expect(packageFile?.content).not.toContain('pnpm@10.0.0');
    expect(bundleConfigFile?.content).toContain(
      'BundleDrop context summary for bundle.drop.config.js',
    );
    expect(bundleConfigFile?.content).not.toContain("runtimeVersion: { source: 'expo' }");
  });

  it.each([
    {
      label: 'disabled',
      appConfig: `module.exports = { expo: { updates: { enabled: false }, jsEngine: 'hermes' } };`,
      expected: 'disabled',
      engine: 'hermes',
    },
    {
      label: 'active',
      appConfig: `module.exports = { expo: { updates: { enabled: true } } };`,
      expected: 'active',
      engine: 'hermes',
    },
  ])('detects an installed dynamic Expo Updates config as $label', ({ appConfig, expected, engine }) => {
    installEvaluatedExpoProject({
      expoVersion: '56.0.4',
      reactNativeVersion: '0.85.1',
      exp: {
        name: 'Fixture',
        slug: 'fixture',
        jsEngine: engine,
        updates: { enabled: expected === 'disabled' ? false : true },
      },
    });
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '56.0.0', 'react-native': '0.85.0', 'expo-updates': '1.0.0' } }),
    );
    fs.writeFileSync(path.join(projectRoot, 'app.config.js'), appConfig);

    const result = scanProjectForAiSetup('expo', projectRoot);

    expect(result.request.detected.expoUpdatesStatus).toBe(expected);
    expect(result.request.detected.jsEngine).toBe(engine);
    expect(result.request.detected.expoSdkVersion).toBe('56.0.4');
    expect(result.request.detected.rnVersion).toBe('0.85.1');
    expect(result.request.files.find(file => file.path === 'app.config.js')?.kind).toBe('expo_app_config');
  });

  it('fails closed before consent when a full-content setup file contains a credential literal', () => {
    installEvaluatedExpoProject();
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '57.0.0', 'react-native': '0.86.0' } }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'app.config.js'),
      `module.exports = { expo: { extra: { apiKey: 'live-project-credential' } } };`,
    );

    expect(() => scanProjectForAiSetup('expo', projectRoot)).toThrow(
      'app.config.js contains a credential-like property',
    );
  });

  it('allows environment references because no credential value is included in AI context', () => {
    installEvaluatedExpoProject();
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '57.0.0', 'react-native': '0.86.0' } }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'app.config.js'),
      `module.exports = { expo: { extra: { apiKey: process.env.PROJECT_API_KEY } } };`,
    );

    const result = scanProjectForAiSetup('expo', projectRoot);

    expect(result.request.files.find(file => file.path === 'app.config.js')?.content).toContain(
      'process.env.PROJECT_API_KEY',
    );
  });

  it('reports absent Updates and partial Bundle Drop setup in a managed project', () => {
    installEvaluatedExpoProject({
      expoVersion: '55.0.3',
      reactNativeVersion: '0.83.2',
      exp: { name: 'Fixture', slug: 'fixture' },
    });
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '55.0.0', 'react-native': '0.83.0' } }),
    );
    fs.writeFileSync(path.join(projectRoot, 'app.json'), JSON.stringify({ expo: {} }));

    const result = scanProjectForAiSetup('expo', projectRoot);

    expect(result.request.detected).toEqual(expect.objectContaining({
      bundleDropStatus: 'partial',
      hasNativeDirectories: false,
      usesExpoRouter: false,
      expoUpdatesStatus: 'absent',
      codePushDetected: false,
      jsEngine: 'hermes',
      expoSdkVersion: '55.0.3',
      rnVersion: '0.83.2',
    }));
  });

  it('collects bare native entrypoints but does not share them for Expo setup', () => {
    installEvaluatedExpoProject();
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }),
    );
    const androidFile = path.join(
      projectRoot,
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
    );
    const iosFile = path.join(projectRoot, 'ios/Demo/AppDelegate.mm');
    fs.mkdirSync(path.dirname(androidFile), { recursive: true });
    fs.mkdirSync(path.dirname(iosFile), { recursive: true });
    fs.writeFileSync(androidFile, 'class MainApplication {}');
    fs.writeFileSync(iosFile, '@implementation AppDelegate @end');

    const bare = scanProjectForAiSetup('bare', projectRoot);
    const expo = scanProjectForAiSetup('expo', projectRoot);

    expect(bare.request.files.map(file => [file.path, file.kind])).toEqual(expect.arrayContaining([
      ['android/app/src/main/kotlin/com/demo/MainApplication.kt', 'android_entrypoint'],
      ['ios/Demo/AppDelegate.mm', 'ios_entrypoint'],
    ]));
    expect(expo.request.files.map(file => file.kind)).not.toEqual(expect.arrayContaining([
      'android_entrypoint',
      'ios_entrypoint',
    ]));
    expect(bare.request.detected.signals).toEqual(expect.arrayContaining([
      'bareProject',
      'iosDirectory',
      'androidDirectory',
    ]));
  });

  it('skips generated and symlinked files during bare native discovery', () => {
    const podsDelegate = path.join(projectRoot, 'ios/Pods/Generated/AppDelegate.swift');
    const linkedDelegate = path.join(projectRoot, 'ios/Linked/AppDelegate.swift');
    const outsideDelegate = path.join(fakeHome, 'AppDelegate.swift');
    fs.mkdirSync(path.dirname(podsDelegate), { recursive: true });
    fs.mkdirSync(path.dirname(linkedDelegate), { recursive: true });
    fs.writeFileSync(podsDelegate, 'class AppDelegate {}');
    fs.writeFileSync(outsideDelegate, 'class AppDelegate {}');
    fs.symlinkSync(outsideDelegate, linkedDelegate);

    const result = scanProjectForAiSetup('bare', projectRoot);

    expect(result.request.files.map(file => file.path)).not.toEqual(expect.arrayContaining([
      'ios/Pods/Generated/AppDelegate.swift',
      'ios/Linked/AppDelegate.swift',
    ]));
  });

  it('falls back to declared versions when installed manifests have non-string versions', () => {
    installEvaluatedExpoProject();
    fs.writeFileSync(
      path.join(projectRoot, 'node_modules', 'expo', 'package.json'),
      JSON.stringify({ name: 'expo', version: 57 }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'node_modules', 'react-native', 'package.json'),
      JSON.stringify({ name: 'react-native', version: 86 }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '57.0.0', 'react-native': '0.86.0' } }),
    );

    const result = scanProjectForAiSetup('expo', projectRoot);

    expect(result.request.detected.expoSdkVersion).toBe('57.0.0');
    expect(result.request.detected.rnVersion).toBe('0.86.0');
  });

  it('handles an absent package manifest and non-string config fields', () => {
    fs.rmSync(path.join(projectRoot, 'package.json'));
    expect(scanProjectForAiSetup('bare', projectRoot).request.detected.rnVersion).toBeNull();

    fs.writeFileSync(
      path.join(projectRoot, 'bundle.drop.config.js'),
      'module.exports = { serverUrl: 42, org: { slug: 7 }, project: { slug: 9 } };',
    );
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow('Missing "serverUrl"');

    fs.writeFileSync(
      path.join(projectRoot, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://api.bundledrop.app', org: { slug: 7 }, project: { slug: 'mobile' } };",
    );
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow('Missing "serverUrl"');

    fs.writeFileSync(
      path.join(projectRoot, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://api.bundledrop.app', org: { slug: 'alpha' }, project: { slug: 9 } };",
    );
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow('Missing "serverUrl"');
  });

  it('skips symlinked and oversized setup files', () => {
    installEvaluatedExpoProject();
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ dependencies: {} }));
    fs.writeFileSync(path.join(projectRoot, 'app.json'), 'x'.repeat(81 * 1024));
    const outside = path.join(fakeHome, 'metro.config.js');
    fs.writeFileSync(outside, 'module.exports = {};');
    fs.symlinkSync(outside, path.join(projectRoot, 'metro.config.js'));

    const result = scanProjectForAiSetup('expo', projectRoot);

    expect(result.request.files.map(file => file.path)).not.toEqual(expect.arrayContaining([
      'app.json',
      'metro.config.js',
    ]));
  });

  it('enforces the total AI setup context budget across many valid native entrypoints', () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}');
    const payload = 'class MainApplication {\n' + 'x'.repeat(70 * 1024) + '\n}';
    for (let index = 0; index < 6; index += 1) {
      const file = path.join(
        projectRoot,
        `android/app/src/main/java/com/example${index}/MainApplication.kt`,
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, payload);
    }

    const result = scanProjectForAiSetup('bare', projectRoot);
    const nativeFiles = result.request.files.filter(file => file.kind === 'android_entrypoint');

    expect(nativeFiles.length).toBeGreaterThan(0);
    expect(nativeFiles.length).toBeLessThan(6);
    expect(result.request.files.reduce(
      (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
      0,
    )).toBeLessThanOrEqual(350 * 1024);
  });

  it('fails before scanning when setup server configuration is incomplete or untrusted', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://evil.example', org: { slug: '' }, project: {} };",
    );
    expect(() => scanProjectForAiSetup('expo', projectRoot)).toThrow('Missing "serverUrl"');

    fs.writeFileSync(
      path.join(projectRoot, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://evil.example', org: { slug: 'a' }, project: { slug: 'b' } };",
    );
    expect(() => scanProjectForAiSetup('expo', projectRoot)).toThrow('untrusted AI planning server');
  });

  it('requires a Bundle Drop config when no preview-only virtual config is supplied', () => {
    fs.unlinkSync(path.join(projectRoot, 'bundle.drop.config.js'));
    expect(() => scanProjectForAiSetup('expo', projectRoot)).toThrow(
      'bundle.drop.config.js not found',
    );
  });

  it('scans a preview-only virtual Bundle Drop config without writing it or reading auth', () => {
    installEvaluatedExpoProject();
    fs.unlinkSync(path.join(projectRoot, 'bundle.drop.config.js'));
    fs.rmSync(path.join(fakeHome, '.bundle-drop', 'auth.json'));
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '57.0.0', 'react-native': '0.86.0' } }),
    );
    const virtualContent = `module.exports = {
      serverUrl: 'https://api.bundledrop.app',
      org: { slug: 'virtual-org' },
      project: { slug: 'virtual-project' },
    };`;

    const result = scanProjectForAiSetup('expo', projectRoot, {
      content: virtualContent,
      serverUrl: 'https://api.bundledrop.app/',
      orgSlug: 'virtual-org',
      projectSlug: 'virtual-project',
      authToken: 'virtual-token',
    });

    expect(fs.existsSync(path.join(projectRoot, 'bundle.drop.config.js'))).toBe(false);
    expect(result.authToken).toBe('virtual-token');
    expect(result.request.files.filter(file => file.kind === 'bundle_drop_config')).toHaveLength(1);
    expect(result.request.files.find(file => file.kind === 'bundle_drop_config')?.content)
      .toContain('BundleDrop context summary for bundle.drop.config.js');
    expect(result.request.files.find(file => file.kind === 'bundle_drop_config')?.content)
      .not.toContain('virtual-project');
  });

  it('does not add a duplicate virtual config when the real config already exists', () => {
    installEvaluatedExpoProject();
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}');

    const result = scanProjectForAiSetup('expo', projectRoot, {
      content: 'module.exports = {};',
      serverUrl: 'https://api.bundledrop.app',
      orgSlug: 'virtual-org',
      projectSlug: 'virtual-project',
      authToken: 'virtual-token',
    });

    expect(result.request.files.filter(file => file.kind === 'bundle_drop_config')).toHaveLength(1);
  });

  it('uses evaluated platform engine parity and Expo Updates plugin state', () => {
    installEvaluatedExpoProject({
      exp: {
        name: 'Fixture',
        slug: 'fixture',
        plugins: [['expo-updates', { username: 'owner' }]],
        updates: { enabled: false },
        ios: { jsEngine: 'hermes' },
        android: { jsEngine: 'jsc' },
      },
    });
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '^57.0.0', 'react-native': '^0.86.0' } }),
    );

    const result = scanProjectForAiSetup('expo', projectRoot);

    expect(result.request.detected.jsEngine).toBe('unknown');
    expect(result.request.detected.expoUpdatesStatus).toBe('disabled');
  });
});
