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
import { findCodePushResiduePaths } from '../../../../CLI/scripts/aipowered/code-push-residue';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';
import {
  MODERN_KOTLIN_MAIN_APPLICATION,
  RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
  RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION,
  RN71_JAVA_MAIN_APPLICATION,
  RN71_KOTLIN_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
  RN71_KOTLIN_MAIN_APPLICATION,
  RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION,
  RN71_OBJC_APP_DELEGATE,
  RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION,
  RN85_SWIFT_APP_DELEGATE,
} from '../../../fixtures/rn85SwiftAppDelegate';

describe('CLI/scripts/aipowered/scanner unified setup', () => {
  let projectRoot = '';
  let fakeHome = '';
  let homedirSpy: jest.SpyInstance;

  const modernAndroidReviewerProbe = (resolver: string, lazyPrefix = '') => [
    'import com.bundledrop.BundleDropModule',
    'class MainApplication: Application(), ReactApplication {',
    `  ${resolver}`,
    '  override val reactHost: ReactHost by lazy {',
    `    ${lazyPrefix}`,
    '    getDefaultReactHost(',
    '      context = applicationContext,',
    '      packages = PackageList(this).packages,',
    '      jsBundleFilePath = getJSBundleFile(),',
    '    )',
    '  }',
    '}',
  ].join('\n');

  const writeNativeFixture = (relativePath: string, source: string) => {
    let authoritativeSource = source;
    if (
      relativePath.endsWith('AppDelegate.swift') &&
      !/@(?:main|UIApplicationMain)\b/.test(source)
    ) {
      authoritativeSource = source.replace(/\bclass\s+AppDelegate\b/, '@main class AppDelegate');
    }
    const nativeFile = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
    fs.writeFileSync(nativeFile, authoritativeSource);

    if (relativePath.includes('/MainApplication.')) {
      const packageName = authoritativeSource.match(
        /(?:^|\n)\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/,
      )?.[1] || relativePath.match(/\/(?:java|kotlin)\/(.+)\/MainApplication\./)?.[1]
        ?.replace(/\//g, '.');
      const manifest = path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml');
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(
        manifest,
        `<manifest package="${packageName}"><application android:name=".MainApplication" /></manifest>`,
      );
    } else if (/AppDelegate\.m{1,2}$/.test(relativePath)) {
      const mainFile = path.join(path.dirname(nativeFile), 'main.m');
      fs.writeFileSync(
        mainFile,
        'int main(int argc, char **argv) { return UIApplicationMain(argc, argv, nil, @"AppDelegate"); }',
      );
    }
    return authoritativeSource;
  };

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
         dynamicConfigPath: fs.existsSync(path.join(root, 'app.config.js'))
           ? path.join(root, 'app.config.js')
           : null,
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
    expect(findCredentialLikeLiteral(
      'const value = "bdp_proj_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"',
    )).toBe('Bundle Drop project key');
    expect(findCredentialLikeLiteral(
      'export default "bdp_pat_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"',
    )).toBe('Bundle Drop personal access token');
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
    const appJsonFile = result.request.files.find(file => file.path === 'app.json');
    const metroFile = result.request.files.find(file => file.path === 'metro.config.js');
    expect(packageFile?.content).toContain('BundleDrop context summary for package.json');
    expect(packageFile?.content).not.toContain('pnpm@10.0.0');
    expect(bundleConfigFile?.content).toContain(
      'BundleDrop context summary for bundle.drop.config.js',
    );
    expect(bundleConfigFile?.content).toContain('runtimeVersionAuthority: expo_source');
    expect(bundleConfigFile?.content).not.toContain("runtimeVersion: { source: 'expo' }");
    expect(appJsonFile?.content).toContain('BundleDrop context summary for app.json');
    expect(metroFile?.content).toContain('BundleDrop context summary for metro.config.js');
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

  it.each([
    ['bidirectional override', '\u202E'],
    ['JavaScript line separator', '\u2028'],
    ['JavaScript paragraph separator', '\u2029'],
  ])('rejects a %s in local source before provider consent', (_label, unsafeCharacter) => {
    installEvaluatedExpoProject();
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '57.0.0', 'react-native': '0.86.0' } }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'app.config.js'),
      `module.exports = { expo: { name: "Demo${unsafeCharacter}" } };\n`,
    );

    expect(() => scanProjectForAiSetup('expo', projectRoot)).toThrow(
      'contains unsafe terminal or bidirectional control characters',
    );
  });

  it('shares only Expo evaluated authoritative dynamic config when stale configs coexist', () => {
    installEvaluatedExpoProject();
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '57.0.0', 'react-native': '0.86.0' } }),
    );
    fs.writeFileSync(path.join(projectRoot, 'app.config.js'), 'module.exports = { expo: {} };');
    fs.writeFileSync(path.join(projectRoot, 'app.config.ts'), 'export default { stale: true };');

    const paths = scanProjectForAiSetup('expo', projectRoot).request.files.map(file => file.path);

    expect(paths).toContain('app.config.js');
    expect(paths).not.toContain('app.config.ts');
    expect(paths).not.toContain('app.json');
  });

  it('fails closed when AndroidManifest starts a different application class', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.71.0' } }),
    );
    const applicationFile = path.join(
      projectRoot,
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
    );
    fs.mkdirSync(path.dirname(applicationFile), { recursive: true });
    fs.writeFileSync(applicationFile, RN71_KOTLIN_MAIN_APPLICATION);
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
      '<manifest package="com.demo"><application android:name=".CustomApplication" /></manifest>',
    );

    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'AndroidManifest.xml starts com.demo.CustomApplication, not com.demo.MainApplication',
    );
  });

  it('fails closed when Objective-C UIApplicationMain names a different delegate', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.71.0' } }),
    );
    const delegateFile = path.join(projectRoot, 'ios/Demo/AppDelegate.m');
    fs.mkdirSync(path.dirname(delegateFile), { recursive: true });
    fs.writeFileSync(delegateFile, [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
      '@end',
    ].join('\n'));
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Demo/main.m'),
      'int main(int argc, char **argv) { return UIApplicationMain(argc, argv, nil, @"OtherDelegate"); }',
    );

    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'UIApplicationMain argument 4 does not select AppDelegate',
    );
  });

  it('binds Android authority across manifests without accepting spoofed attributes', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }),
    );
    writeNativeFixture(
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      RN71_KOTLIN_MAIN_APPLICATION,
    );
    const mainManifest = path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml');
    fs.writeFileSync(
      mainManifest,
      '<manifest package="com.demo"><application tools:name=".MainApplication" android:name=".OtherApplication" /></manifest>',
    );
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'starts com.demo.OtherApplication, not com.demo.MainApplication',
    );

    fs.writeFileSync(
      mainManifest,
      '<manifest package="com.demo"><application android:name=".MainApplication" /></manifest>',
    );
    const releaseManifest = path.join(projectRoot, 'android/app/src/release/AndroidManifest.xml');
    fs.mkdirSync(path.dirname(releaseManifest), { recursive: true });
    fs.writeFileSync(
      releaseManifest,
      '<manifest package="com.demo"><application android:name=".ReleaseApplication" /></manifest>',
    );
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'release/AndroidManifest.xml starts com.demo.ReleaseApplication',
    );

    fs.rmSync(path.dirname(releaseManifest), { recursive: true });
    const testManifest = path.join(projectRoot, 'android/app/src/androidTest/AndroidManifest.xml');
    fs.mkdirSync(path.dirname(testManifest), { recursive: true });
    fs.writeFileSync(
      testManifest,
      '<manifest package="com.demo"><application android:name=".TestApplication" /></manifest>',
    );
    expect(() => scanProjectForAiSetup('bare', projectRoot)).not.toThrow();
  });

  it('resolves a relative Android application through Gradle namespace, not source decoys', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }),
    );
    const applicationFile = path.join(
      projectRoot,
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
    );
    fs.mkdirSync(path.dirname(applicationFile), { recursive: true });
    fs.writeFileSync(applicationFile, RN71_KOTLIN_MAIN_APPLICATION);
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
      '<manifest><application android:name=".MainApplication" /></manifest>',
    );
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/build.gradle.kts'),
      'android {\n  namespace = "com.demo"\n}',
    );
    expect(() => scanProjectForAiSetup('bare', projectRoot)).not.toThrow();

    fs.writeFileSync(
      applicationFile,
      RN71_KOTLIN_MAIN_APPLICATION.replace('package com.demo', 'package dead.demo'),
    );
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'starts com.demo.MainApplication, not dead.demo.MainApplication',
    );
  });

  it('requires explicit native principal sources before sharing setup context', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }),
    );
    const androidFile = path.join(
      projectRoot,
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
    );
    fs.mkdirSync(path.dirname(androidFile), { recursive: true });
    fs.writeFileSync(androidFile, RN71_KOTLIN_MAIN_APPLICATION);
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'main AndroidManifest.xml is missing',
    );

    fs.rmSync(path.join(projectRoot, 'android'), { recursive: true });
    const swiftFile = path.join(projectRoot, 'ios/Demo/AppDelegate.swift');
    fs.mkdirSync(path.dirname(swiftFile), { recursive: true });
    fs.writeFileSync(swiftFile, [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '}',
    ].join('\n'));
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'Swift @main/UIApplicationMain principal is missing',
    );

    fs.rmSync(path.join(projectRoot, 'ios'), { recursive: true });
    const objcFile = path.join(projectRoot, 'ios/Demo/AppDelegate.m');
    fs.mkdirSync(path.dirname(objcFile), { recursive: true });
    fs.writeFileSync(objcFile, [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
      '@end',
    ].join('\n'));
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Demo/main.m'),
      'int main(void) { return CustomUIApplicationMain(0, nil, nil, @"AppDelegate"); }',
    );
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'Exactly one UIApplicationMain call is required',
    );
  });

  it('does not accept Swift principal annotations hidden in strings or nested comments', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }),
    );
    const appDelegate = path.join(projectRoot, 'ios/Demo/AppDelegate.swift');
    fs.mkdirSync(path.dirname(appDelegate), { recursive: true });
    fs.writeFileSync(appDelegate, [
      'import BundleDrop',
      'let documentation = "@main class AppDelegate"',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '}',
    ].join('\n'));
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Demo/RealApp.swift'),
      '@main struct RealApp { static func main() {} }',
    );

    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'Swift principal annotation does not uniquely select AppDelegate',
    );

    fs.rmSync(path.join(projectRoot, 'ios/Demo/RealApp.swift'));
    fs.writeFileSync(appDelegate, [
      'import BundleDrop',
      '/* outer /* nested */ @main class AppDelegate */',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '}',
    ].join('\n'));
    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'Swift @main/UIApplicationMain principal is missing',
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
    fs.writeFileSync(
      path.join(projectRoot, 'app.json'),
      JSON.stringify({ name: 'BareDemo', displayName: 'Bare Demo' }),
    );
    writeNativeFixture(
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      'package com.demo\nclass MainApplication {}',
    );
    writeNativeFixture('ios/Demo/AppDelegate.mm', '@implementation AppDelegate @end');

    const bare = scanProjectForAiSetup('bare', projectRoot);
    const expo = scanProjectForAiSetup('expo', projectRoot);

    expect(bare.request.files.map(file => [file.path, file.kind])).toEqual(expect.arrayContaining([
      ['android/app/src/main/kotlin/com/demo/MainApplication.kt', 'android_entrypoint'],
      ['ios/Demo/AppDelegate.mm', 'ios_entrypoint'],
    ]));
    expect(bare.request.files.map(file => file.path)).not.toContain('app.json');
    expect(expo.request.files.map(file => [file.path, file.kind])).toContainEqual([
      'app.json',
      'expo_app_config',
    ]);
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

  it('does not detect CodePush after its dependency and native startup hook are migrated', () => {
    const packagePath = path.join(projectRoot, 'package.json');
    const androidFile = path.join(
      projectRoot,
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
    );
    fs.mkdirSync(path.dirname(androidFile), { recursive: true });
    fs.writeFileSync(
      packagePath,
      JSON.stringify({
        dependencies: {
          '@gfean/react-native-bundle-drop': '0.4.3',
          'react-native': '0.86.0',
          'react-native-code-push': '9.0.0',
        },
      }),
    );
    fs.writeFileSync(
      androidFile,
      'class MainApplication { fun getJSBundleFile() = CodePush.getJSBundleFile() }',
    );
    writeNativeFixture(
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      'class MainApplication { fun getJSBundleFile() = CodePush.getJSBundleFile() }',
    );

    expect(scanProjectForAiSetup('bare', projectRoot).request.detected.codePushDetected).toBe(true);

    fs.writeFileSync(
      packagePath,
      JSON.stringify({
        dependencies: {
          '@gfean/react-native-bundle-drop': '0.4.3',
          'react-native': '0.86.0',
        },
      }),
    );
    writeNativeFixture('android/app/src/main/kotlin/com/demo/MainApplication.kt', RN71_KOTLIN_MAIN_APPLICATION);

    const migrated = scanProjectForAiSetup('bare', projectRoot).request.detected;
    expect(findCodePushResiduePaths(projectRoot)).toEqual([]);
    expect(migrated.codePushDetected).toBe(false);
    expect(migrated.signals).not.toContain('codePushDependency');
    expect(migrated.bundleDropStatus).toBe('configured');
  });

  it.each([
    {
      label: 'legacy Kotlin override',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION,
    },
    {
      label: 'legacy Java override',
      file: 'android/app/src/main/java/com/demo/MainApplication.java',
      content: RN71_JAVA_MAIN_APPLICATION,
    },
    {
      label: 'legacy Java multiline local fallback',
      file: 'android/app/src/main/java/com/demo/MainApplication.java',
      content: RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION,
    },
    {
      label: 'legacy Java conditional local fallback',
      file: 'android/app/src/main/java/com/demo/MainApplication.java',
      content: RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
    },
    {
      label: 'legacy Kotlin conditional local fallback',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: RN71_KOTLIN_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
    },
    {
      label: 'modern Kotlin ReactHost connection',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: MODERN_KOTLIN_MAIN_APPLICATION,
    },
    {
      label: 'archived RN85 Kotlin NativePaths host connection',
      file: 'android/app/src/main/kotlin/app/bundledrop/harness/rn85/MainApplication.kt',
      content: RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION,
    },
    {
      label: 'fully-qualified NativePaths host override',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION,
    },
    {
      label: 'Swift AppDelegate resolver',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  @objc override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
    },
    {
      label: 'RN85 Swift factory delegate resolver',
      file: 'ios/BundleDropDemo/AppDelegate.swift',
      content: RN85_SWIFT_APP_DELEGATE,
    },
    {
      label: 'Objective-C AppDelegate resolver',
      file: 'ios/Demo/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {',
        '  return self.bundleURL;',
        '}',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '@end',
      ].join('\n'),
    },
    {
      label: 'RN71 Objective-C delegated source URL with DEBUG Metro fallback',
      file: 'ios/Demo/AppDelegate.m',
      content: RN71_OBJC_APP_DELEGATE,
    },
  ])('reports configured for a strict $label', ({ file, content }) => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@gfean/react-native-bundle-drop': '0.4.3',
          'react-native': '0.86.0',
        },
      }),
    );
    writeNativeFixture(file, content);

    expect(scanProjectForAiSetup('bare', projectRoot).request.detected.bundleDropStatus)
      .toBe('configured');
  });

  it.each([
    {
      label: 'nested Kotlin comment resolver',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: [
        'package com.demo',
        'class MainApplication {',
        '  /* outer /* nested */',
        '    import com.bundledrop.BundleDropModule',
        '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
        '  */',
        '}',
      ].join('\n'),
    },
    {
      label: 'Kotlin raw multiline string resolver and host decoy',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: [
        'package com.demo',
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  val documentation = """ "',
        '  private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
        '  override val reactHost: ReactHost by lazy {',
        '    getDefaultReactHost(jsBundleFilePath = getJSBundleFile())',
        '  }',
        '  " """',
        '}',
      ].join('\n'),
    },
    {
      label: 'nested Swift comment resolver',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  /* outer /* nested */',
        '    override func bundleURL() -> URL? { return BundleDropLocator.bundleURL() }',
        '  */',
        '}',
      ].join('\n'),
    },
    {
      label: 'Swift multiline string resolver decoy',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  let documentation = """ "',
        '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '  " """',
        '}',
      ].join('\n'),
    },
    {
      label: 'conditional Android Release bypass',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: modernAndroidReviewerProbe(
        'private fun getJSBundleFile(): String? { return if (useOta) BundleDropModule.resolveJSBundleFile(this, null) else "/android_asset/index.android.bundle" }',
      ),
    },
    {
      label: 'wrong Android resolver symbol',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: modernAndroidReviewerProbe(
        'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFileForTests(this, null)',
      ),
    },
    {
      label: 'wrong Android resolver context',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: modernAndroidReviewerProbe(
        'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(42, null)',
      ),
    },
    {
      label: 'transformed Java resolver return',
      file: 'android/app/src/main/java/com/demo/MainApplication.java',
      content: RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace(
        '      );',
        '      ).trim();',
      ),
    },
    {
      label: 'Java fallback ternary with a statement branch',
      file: 'android/app/src/main/java/com/demo/MainApplication.java',
      content: RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION.replace(
        '? selectEnterpriseBundle()',
        '? return selectEnterpriseBundle()',
      ),
    },
    {
      label: 'Java resolver with Kotlin non-null suffix',
      file: 'android/app/src/main/java/com/demo/MainApplication.java',
      content: RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace(
        '      );',
        '      )!!;',
      ),
    },
    {
      label: 'Java anonymous host with the wrong this receiver',
      file: 'android/app/src/main/java/com/demo/MainApplication.java',
      content: RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace(
        'getApplicationContext(),',
        'this,',
      ),
    },
    {
      label: 'Kotlin anonymous host with Java receiver syntax',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION.replace(
        'this@MainApplication,',
        'MainApplication.this,',
      ),
    },
    {
      label: 'non-null Kotlin resolver without an unwrap or fallback',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION.replace('          )!!', '          )'),
    },
    {
      label: 'mismatched Android import alias',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: modernAndroidReviewerProbe(
        'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
      ).replace('import com.bundledrop.BundleDropModule', 'import com.bundledrop.BundleDropModule as BDM'),
    },
    {
      label: 'early modern Android host bypass',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: modernAndroidReviewerProbe(
        'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
        'if (useCustom) return@lazy customReactHost',
      ),
    },
    {
      label: 'conditional Swift Release bypass',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  override func bundleURL() -> URL? {',
        '    return useOta ? BundleDropLocator.bundleURL() : Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      label: 'RN85 sourceURL bypassing a dead bundleURL',
      file: 'ios/BundleDropDemo/AppDelegate.swift',
      content: RN85_SWIFT_APP_DELEGATE.replace(
        '    self.bundleURL()',
        '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      ),
    },
    {
      label: 'direct Swift sourceURL bypassing bundleURL',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  override func bundleURL() -> URL? { return BundleDropLocator.bundleURL() }',
        '  override func sourceURL(for bridge: RCTBridge) -> URL? {',
        '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      label: 'ignored Objective-C bundleURL delegation',
      file: 'ios/Demo/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {',
        '  [self bundleURL];',
        '  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];',
        '}',
        '@end',
      ].join('\n'),
    },
    {
      label: 'near-match Android method',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  override fun getJSBundleFile(): String? = null',
        '  fun getJSBundleFileForTests() = BundleDropModule.resolveJSBundleFile(this, null)',
        '}',
      ].join('\n'),
    },
    {
      label: 'nested Android helper owner',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  class Helper {',
        '    fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      label: 'renamed Android lifecycle decoy',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
        '  override fun onCreate() {}',
        '  fun onCreateForTests() { super.onCreate(); loadReactNative(this) }',
        '}',
      ].join('\n'),
    },
    {
      label: 'parameterized Android onCreate overload',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
        '  fun onCreate(test: Boolean) { super.onCreate(); loadReactNative(this) }',
        '}',
      ].join('\n'),
    },
    {
      label: 'parameterized Kotlin resolver decoy',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  override fun getJSBundleFile(test: Boolean) =',
        '    BundleDropModule.resolveJSBundleFile(this, null)',
        '}',
      ].join('\n'),
    },
    {
      label: 'parameterized Java resolver decoy',
      file: 'android/app/src/main/java/com/demo/MainApplication.java',
      content: [
        'import com.bundledrop.BundleDropModule;',
        'public class MainApplication {',
        '  public String getJSBundleFile(boolean test) {',
        '    return BundleDropModule.resolveJSBundleFile(this, null);',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      label: 'dead Swift helper owner',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate { func bundleURL() -> URL? { nil } }',
        'class Helper { func bundleURL() -> URL? { BundleDropLocator.bundleURL() } }',
      ].join('\n'),
    },
    {
      label: 'parameterized Swift resolver decoy',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  func bundleURL(test: Bool) -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
    },
    {
      label: 'unconnected Swift factory delegate',
      file: 'ios/Demo/AppDelegate.swift',
      content: RN85_SWIFT_APP_DELEGATE.replace(
        'RCTReactNativeFactory(delegate: delegate)',
        'RCTReactNativeFactory(delegate: ReactNativeDelegate())',
      ),
    },
    {
      label: 'Objective-C AppDelegate category decoy',
      file: 'ios/Demo/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate (BundleDrop)',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '@end',
      ].join('\n'),
    },
    {
      label: 'duplicate Objective-C AppDelegate implementation',
      file: 'ios/Demo/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '@end',
        '@implementation AppDelegate',
        '@end',
      ].join('\n'),
    },
    {
      label: 'dead modern Kotlin host connection',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: MODERN_KOTLIN_MAIN_APPLICATION
        .replace('jsBundleFilePath = getJSBundleFile(),', 'isHermesEnabled = true,')
        .replace(
          '\n}',
          '\n  fun deadHost() = getDefaultReactHost(jsBundleFilePath = getJSBundleFile())\n}',
        ),
    },
    {
      label: 'unused legacy Kotlin native host',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION.replace(
        'override val reactNativeHost',
        'val unusedHost',
      ),
    },
    {
      label: 'nested legacy Kotlin authority getter',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  val deadHost: ReactNativeHost = object : DefaultReactNativeHost(this) {',
        '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this@MainApplication, null)',
        '  }',
        '  val actualHost: ReactNativeHost = object : DefaultReactNativeHost(this) {}',
        '  override val reactNativeHost: ReactNativeHost get() = actualHost',
        '  class Helper {',
        '    override val reactNativeHost: ReactNativeHost get() = deadHost',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      label: 'anonymous legacy Kotlin authority getter',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: [
        'package com.demo',
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  val deadHost: ReactNativeHost = object : DefaultReactNativeHost(this) {',
        '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this@MainApplication, null)',
        '  }',
        '  val deadApplication = object : ReactApplication {',
        '    override val reactNativeHost: ReactNativeHost get() = deadHost',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      label: 'DEBUG-only Kotlin resolver',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION
        .replace(
          '"/data/local/tmp/dev.jsbundle"',
          'BundleDropModule.resolveJSBundleFile(this@MainApplication, null)!!',
        )
        .replace(
          /BundleDropModule\.resolveJSBundleFile\(\n            this@MainApplication,\n            "\/android_asset\/index\.android\.bundle",\n          \)!!/,
          '"/android_asset/index.android.bundle"',
        ),
    },
    {
      label: 'ignored Swift resolver result',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate {',
        '  func bundleURL() -> URL? { BundleDropLocator.bundleURL(); return nil }',
        '}',
      ].join('\n'),
    },
    {
      label: 'cross-statement Kotlin resolver result',
      file: 'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION.replace(
        /override fun getJSBundleFile\(\): String =[\s\S]*?\n    }\n}/,
        `override fun getJSBundleFile(): String? {
          val embeddedPath: String? = null
          return embeddedPath
          BundleDropModule.resolveJSBundleFile(this@MainApplication, null)
        }
      }
  }`,
      ),
    },
    {
      label: 'DEBUG-only mixed Swift preprocessor branch',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate {',
        '  func bundleURL() -> URL? {',
        '#if FEATURE_PREVIEW',
        '    return Bundle.main.url(forResource: "preview", withExtension: "jsbundle")',
        '#elseif DEBUG',
        '    return BundleDropLocator.bundleURL()',
        '#else',
        '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        '#endif',
        '  }',
        '}',
      ].join('\n'),
    },
  ])('does not report configured for a $label', ({ file, content }) => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@gfean/react-native-bundle-drop': '0.4.3',
          'react-native': '0.86.0',
        },
      }),
    );
    writeNativeFixture(file, content);

    expect(scanProjectForAiSetup('bare', projectRoot).request.detected.bundleDropStatus)
      .toBe('partial');
  });

  it('fails closed when a dead Swift AppDelegate is not the application principal', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }),
    );
    writeNativeFixture('ios/Demo/AppDelegate.swift', [
      'import BundleDrop',
      '@main class RealAppDelegate: UIResponder, UIApplicationDelegate {}',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '}',
    ].join('\n'));

    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'Swift principal annotation does not uniquely select AppDelegate',
    );
  });

  it('does not report configured when a present native platform has no entrypoint', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@gfean/react-native-bundle-drop': '0.4.3',
          'react-native': '0.86.0',
        },
      }),
    );
    writeNativeFixture(
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      RN71_KOTLIN_MAIN_APPLICATION,
    );
    fs.mkdirSync(path.join(projectRoot, 'ios/Demo'), { recursive: true });

    expect(scanProjectForAiSetup('bare', projectRoot).request.detected.bundleDropStatus)
      .toBe('partial');
  });

  it.each([
    {
      label: 'Android',
      files: [
        'android/app/src/main/kotlin/com/first/MainApplication.kt',
        'android/app/src/main/kotlin/com/second/MainApplication.kt',
      ],
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
        '}',
      ].join('\n'),
    },
    {
      label: 'iOS',
      files: [
        'ios/First/AppDelegate.swift',
        'ios/Second/AppDelegate.swift',
      ],
      content: [
        'import BundleDrop',
        'class AppDelegate {',
        '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
    },
  ])('does not report configured with duplicate integrated $label entrypoints', ({ files, content }) => {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@gfean/react-native-bundle-drop': '0.4.3',
          'react-native': '0.86.0',
        },
      }),
    );
    for (const file of files) {
      const nativeFile = path.join(projectRoot, file);
      fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
      fs.writeFileSync(nativeFile, content);
    }

    expect(scanProjectForAiSetup('bare', projectRoot).request.detected.bundleDropStatus)
      .toBe('partial');
  });

  it('skips generated files but fails closed on symlinked native source', () => {
    const podsDelegate = path.join(projectRoot, 'ios/Pods/Generated/AppDelegate.swift');
    const linkedDelegate = path.join(projectRoot, 'ios/Linked/AppDelegate.swift');
    const outsideDelegate = path.join(fakeHome, 'AppDelegate.swift');
    fs.mkdirSync(path.dirname(podsDelegate), { recursive: true });
    fs.mkdirSync(path.dirname(linkedDelegate), { recursive: true });
    fs.writeFileSync(podsDelegate, 'class AppDelegate {}');
    fs.writeFileSync(outsideDelegate, 'class AppDelegate {}');
    fs.symlinkSync(outsideDelegate, linkedDelegate);

    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'symbolic-link source path Linked/AppDelegate.swift',
    );
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

  it('fails closed when an Expo setup file is oversized or symlinked', () => {
    installEvaluatedExpoProject();
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ dependencies: {} }));
    fs.writeFileSync(path.join(projectRoot, 'app.config.js'), 'x'.repeat(81 * 1024));

    expect(() => scanProjectForAiSetup('expo', projectRoot)).toThrow(
      'app.config.js: it exceeds the 81920-byte per-file limit',
    );

    fs.unlinkSync(path.join(projectRoot, 'app.config.js'));
    const outside = path.join(fakeHome, 'metro.config.js');
    fs.writeFileSync(outside, 'module.exports = {};');
    fs.symlinkSync(outside, path.join(projectRoot, 'metro.config.js'));

    expect(() => scanProjectForAiSetup('expo', projectRoot)).toThrow(
      'metro.config.js: the path is not a regular project file',
    );
  });

  it.each([
    'android/app/src/main/java/com/example/MainApplication.kt',
    'ios/Fixture/AppDelegate.swift',
  ])('fails closed when required native entrypoint %s exceeds the file limit', relativePath => {
    const entrypoint = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, 'x'.repeat(81 * 1024));

    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      `${relativePath}: it exceeds the 81920-byte per-file limit`,
    );
  });

  it('fails closed instead of omitting an entrypoint at the total context limit', () => {
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

    expect(() => scanProjectForAiSetup('bare', projectRoot)).toThrow(
      'including it would exceed the 131072-byte total context limit',
    );
  });

  it('summarizes oversized CLI-owned app.json and Metro files within a bounded read limit', () => {
    installEvaluatedExpoProject();
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ dependencies: { expo: '57.0.0', 'react-native': '0.86.0' } }),
    );
    fs.writeFileSync(path.join(projectRoot, 'app.json'), `{"expo":{"padding":"${'x'.repeat(90 * 1024)}"}}`);
    fs.writeFileSync(
      path.join(projectRoot, 'metro.config.js'),
      `module.exports = { padding: '${'y'.repeat(90 * 1024)}' };`,
    );

    const files = scanProjectForAiSetup('expo', projectRoot).request.files;

    expect(files.find(file => file.path === 'app.json')?.content.length).toBeLessThan(2000);
    expect(files.find(file => file.path === 'metro.config.js')?.content.length).toBeLessThan(2000);
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
