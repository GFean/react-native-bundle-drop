import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const mockResolveOfficialEasBuildIdentity = jest.fn(
  async ({ receiptIdentity }: { receiptIdentity: ExpoBuildIdentity }) => receiptIdentity,
);

jest.mock('../../../CLI/scripts/expo/eas-build-proof', () => ({
  resolveOfficialEasBuildIdentity: (params: unknown) =>
    mockResolveOfficialEasBuildIdentity(params as { receiptIdentity: ExpoBuildIdentity }),
}));

import type { ExpoBuildIdentity } from '../../../expo';
import { resolveExpoBuildIdentity } from '../../../expo';
import { inspectProject, runDoctor } from '../../../CLI/scripts/doctor';
import type { ExpoBuildIdentityReceipt } from '../../../metro';
import { resolveExpoIntegrationGeneration } from '../../../expo/buildReceipt';
import { createExpoFixture, removeFixture } from '../../expo/fixture';
import {
  MODERN_KOTLIN_MAIN_APPLICATION,
  RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
  RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION,
  RN71_KOTLIN_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
  RN71_KOTLIN_MAIN_APPLICATION,
  RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION,
  RN71_OBJC_APP_DELEGATE,
  RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION,
  RN85_SWIFT_APP_DELEGATE,
} from '../../fixtures/rn85SwiftAppDelegate';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

const PACKAGE_NAME = '@gfean/react-native-bundle-drop';

const rehashIdentity = (
  identity: ExpoBuildIdentity,
  overrides: Partial<Omit<ExpoBuildIdentity, 'identityHash'>>,
): ExpoBuildIdentity => {
  const { identityHash: _identityHash, ...withoutHash } = { ...identity, ...overrides };
  return {
    ...withoutHash,
    identityHash: crypto.createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex'),
  };
};

describe('CLI/scripts/doctor', () => {
  const projects: Array<{ root: string; expo: boolean }> = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const project of projects.splice(0)) {
      if (project.expo) removeFixture(project.root);
      else removeTempDir(project.root);
    }
  });

  const createExpoProject = (
    config: Record<string, unknown>,
    runtimeVersion: { source: 'expo' } | { ios: string; android: string } = { source: 'expo' },
  ) => {
    const projectRoot = createExpoFixture({
      config,
      bundleDropRuntimeVersion: runtimeVersion,
    });
    projects.push({ root: projectRoot, expo: true });
    const bundleConfigPath = path.join(projectRoot, 'bundle.drop.config.js');
    const bundleConfig = JSON.parse(
      fs.readFileSync(bundleConfigPath, 'utf8').match(/module\.exports = (.*);/)![1],
    );
    fs.writeFileSync(
      bundleConfigPath,
      `module.exports = ${JSON.stringify({
        ...bundleConfig,
        serverUrl: 'https://api.example.com',
        org: { slug: 'org' },
        project: { name: 'Fixture', slug: 'fixture' },
      })};\n`,
    );
    fs.writeFileSync(
      path.join(projectRoot, 'metro.config.js'),
      "const { getDefaultConfig } = require('expo/metro-config');\n" +
        "const { withBundleDropExpo } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDropExpo(getDefaultConfig(__dirname));\n',
    );
    return projectRoot;
  };

  const updatePackageJson = (projectRoot: string, dependencies: Record<string, string>) => {
    const packagePath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    pkg.dependencies = dependencies;
    fs.writeFileSync(packagePath, JSON.stringify(pkg));
  };

  const installBundleDropMetadata = (
    projectRoot: string,
    moduleConfig: Record<string, unknown> = {
      apple: { podspecPath: 'BundleDropExpo.podspec' },
      android: { path: 'expo/android' },
    },
    includeReactNativeConfig = true,
  ) => {
    const packageRoot = path.join(projectRoot, 'node_modules', '@gfean', 'react-native-bundle-drop');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: PACKAGE_NAME, version: '0.4.3' }),
    );
    fs.writeFileSync(
      path.join(packageRoot, 'expo-module.config.json'),
      JSON.stringify(moduleConfig),
    );
    if (includeReactNativeConfig) {
      fs.writeFileSync(path.join(packageRoot, 'react-native.config.js'), 'module.exports = {};');
    }
  };

  const createBareProject = () => {
    const projectRoot = createTempProjectDir();
    projects.push({ root: projectRoot, expo: false });
    fs.mkdirSync(path.join(projectRoot, 'node_modules', 'react-native'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'node_modules', 'react-native', 'package.json'),
      JSON.stringify({ name: 'react-native', version: '0.86.0' }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'bundle.drop.config.js'),
      "module.exports = { projectType: 'bare', serverUrl: 'https://api.example.com', org: { slug: 'org' }, project: { name: 'Fixture', slug: 'fixture' }, runtimeVersion: { ios: 'ios-runtime', android: 'android-runtime' } };",
    );
    fs.writeFileSync(
      path.join(projectRoot, 'metro.config.cjs'),
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro'); module.exports = withBundleDrop({});",
    );

    const packageRoot = path.join(projectRoot, 'node_modules', '@gfean', 'react-native-bundle-drop');
    fs.mkdirSync(path.join(packageRoot, 'android'), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: PACKAGE_NAME, version: '0.4.3' }),
    );
    fs.writeFileSync(path.join(packageRoot, 'BundleDrop.podspec'), 'Pod::Spec.new do |s|\nend\n');
    fs.writeFileSync(
      path.join(packageRoot, 'react-native.config.js'),
      "module.exports = { dependency: { platforms: { ios: { podspecPath: 'BundleDrop.podspec' }, android: { packageInstance: 'new BundleDropPackage()' } } } };",
    );

    const androidEntrypoint = path.join(
      projectRoot,
      'android/app/src/main/java/com/fixture/MainApplication.kt',
    );
    fs.mkdirSync(path.dirname(androidEntrypoint), { recursive: true });
    fs.writeFileSync(
      androidEntrypoint,
      RN71_KOTLIN_MAIN_APPLICATION,
    );
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
      '<manifest package="com.demo"><application android:name=".MainApplication" /></manifest>',
    );
    const androidAutolinking = path.join(
      projectRoot,
      'android/build/generated/autolinking/autolinking.json',
    );
    fs.mkdirSync(path.dirname(androidAutolinking), { recursive: true });
    fs.writeFileSync(
      androidAutolinking,
      JSON.stringify({ dependencies: { [PACKAGE_NAME]: { name: PACKAGE_NAME } } }),
    );

    const iosEntrypoint = path.join(projectRoot, 'ios/Fixture/AppDelegate.swift');
    fs.mkdirSync(path.dirname(iosEntrypoint), { recursive: true });
    fs.writeFileSync(
      iosEntrypoint,
      [
        'import BundleDrop',
        '@main class AppDelegate: RCTAppDelegate {',
        '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(projectRoot, 'ios/Podfile.lock'), 'PODS:\n  - BundleDrop (0.4.3)\n');
    return projectRoot;
  };

  const writeDoctorNativeProbe = (
    projectRoot: string,
    relativePath: string,
    source: string,
  ) => {
    let authoritativeSource = source;
    if (relativePath.includes('/MainApplication.')) {
      if (!/(?:^|\n)\s*package\s+/.test(authoritativeSource)) {
        authoritativeSource = relativePath.endsWith('.java')
          ? `package com.demo;\n${authoritativeSource}`
          : `package com.demo\n${authoritativeSource}`;
      }
      if (relativePath.endsWith('.java')) {
        fs.rmSync(
          path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.kt'),
          { force: true },
        );
      }
    } else if (relativePath.endsWith('AppDelegate.swift')) {
      if (!/@(?:main|UIApplicationMain)\b/.test(authoritativeSource)) {
        authoritativeSource = authoritativeSource.replace(
          /\bclass\s+AppDelegate\b/,
          '@main class AppDelegate',
        );
      }
    } else if (/AppDelegate\.m{1,2}$/.test(relativePath)) {
      fs.rmSync(path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'), { force: true });
      fs.writeFileSync(
        path.join(projectRoot, 'ios/Fixture/main.m'),
        'int main(int argc, char **argv) { return UIApplicationMain(argc, argv, nil, @"AppDelegate"); }',
      );
    }
    const entrypoint = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, authoritativeSource);
  };

  const modernDoctorProbe = (resolver: string, lazyPrefix = '') => [
    'package com.demo',
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

  const writeReceipt = (projectRoot: string, receipt: ExpoBuildIdentityReceipt) => {
    const receiptPath = path.join(projectRoot, '.bundle-drop', 'build-identity.json');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  };

  it('passes evaluated plugin, isolated autolinking, Metro, identity, and absent Updates checks', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.2.3',
      runtimeVersion: 'runtime-1',
      plugins: [PACKAGE_NAME],
      ios: { buildNumber: '7' },
      android: { versionCode: 8 },
    });
    updatePackageJson(projectRoot, { expo: '57.0.0', 'react-native': '0.86.0' });
    installBundleDropMetadata(projectRoot);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });

    expect(result.projectType).toBe('expo');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Expo config plugin', status: 'pass' }),
      expect.objectContaining({ name: 'Expo/native autolinking metadata', status: 'pass' }),
      expect.objectContaining({ name: 'Expo Updates ownership', status: 'pass' }),
      expect.objectContaining({ name: 'Expo Metro wrapper', status: 'pass' }),
      expect.objectContaining({ name: 'ios build identity', status: 'pass' }),
      expect.objectContaining({ name: 'Native build receipt', status: 'warning' }),
      expect.objectContaining({ name: 'Expo Go', status: 'warning' }),
    ]));
    expect(result.checks.some(check => check.name.startsWith('android'))).toBe(false);
  });

  it('does not require a native receipt for default Bundle Drop literal runtimes', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.2.3',
      plugins: [PACKAGE_NAME],
      ios: { buildNumber: '7' },
      android: { versionCode: 8 },
    }, {
      ios: 'ios-runtime',
      android: 'android-runtime',
    });
    updatePackageJson(projectRoot, { expo: '57.0.0', 'react-native': '0.86.0' });
    installBundleDropMetadata(projectRoot);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });

    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime authority',
      status: 'pass',
      message: expect.stringContaining('do not require or compare Expo build receipts'),
    }));
    expect(result.checks.some(check => check.name === 'Native build receipt')).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'ios build identity',
      status: 'pass',
      message: expect.stringContaining('Bundle Drop literal resolved to ios-runtime'),
    }));
  });

  it('requires the Bundle Drop plugin exactly once, including tuple registrations', async () => {
    for (const plugins of [[], [PACKAGE_NAME, [PACKAGE_NAME, { enabled: true }]]]) {
      const projectRoot = createExpoProject({
        name: 'Fixture',
        slug: 'fixture',
        version: '1.0.0',
        runtimeVersion: 'runtime-1',
        plugins,
      });
      installBundleDropMetadata(projectRoot);
      const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });
      const check = result.checks.find(item => item.name === 'Expo config plugin');
      expect(check).toEqual(expect.objectContaining({ status: 'error' }));
      expect(check?.message).toContain(`found ${plugins.length}`);
    }
  });

  it('ignores invalid evaluated plugin entries when counting Bundle Drop registration', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.0.0',
      runtimeVersion: 'runtime-1',
      plugins: [null, {}, [42], PACKAGE_NAME],
    });
    installBundleDropMetadata(projectRoot);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Expo config plugin',
      status: 'pass',
    }));
  });

  it.each([
    [{ apple: { podspecPath: 'wrong.podspec' }, android: { path: 'expo/android' } }, true],
    [{ apple: { podspecPath: 'BundleDropExpo.podspec' }, android: { path: 'wrong' } }, true],
    [{ apple: { podspecPath: 'BundleDropExpo.podspec' }, android: { path: 'expo/android' } }, false],
  ])('fails incomplete packed autolinking metadata %#', async (moduleConfig, includeReactNativeConfig) => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.0.0',
      runtimeVersion: 'runtime-1',
      plugins: [PACKAGE_NAME],
    });
    installBundleDropMetadata(projectRoot, moduleConfig, includeReactNativeConfig);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Expo/native autolinking metadata',
      status: 'error',
      message: 'Packed Bundle Drop autolinking metadata is incomplete.',
    }));
  });

  it('reports an installed package resolution or malformed metadata failure', async () => {
    const missingPackageRoot = createExpoProject({
      name: 'Fixture', slug: 'fixture', version: '1.0.0', runtimeVersion: 'r', plugins: [PACKAGE_NAME],
    });
    let result = await inspectProject({ cwd: missingPackageRoot, projectType: 'expo', platform: 'ios' });
    expect(result.checks.find(check => check.name === 'Expo/native autolinking metadata'))
      .toEqual(expect.objectContaining({ status: 'error', message: expect.stringContaining('Could not validate') }));

    const malformedRoot = createExpoProject({
      name: 'Fixture', slug: 'fixture', version: '1.0.0', runtimeVersion: 'r', plugins: [PACKAGE_NAME],
    });
    installBundleDropMetadata(malformedRoot);
    fs.writeFileSync(
      path.join(malformedRoot, 'node_modules', '@gfean', 'react-native-bundle-drop', 'expo-module.config.json'),
      '{invalid',
    );
    result = await inspectProject({ cwd: malformedRoot, projectType: 'expo', platform: 'ios' });
    expect(result.checks.find(check => check.name === 'Expo/native autolinking metadata'))
      .toEqual(expect.objectContaining({ status: 'error', message: expect.stringContaining('Could not validate') }));
  });

  it('blocks active Expo Updates from dependency, plugin, URL, or enabled config', async () => {
    const variants = [
      { dependencies: { 'expo-updates': '1.0.0' }, updates: undefined, plugins: undefined },
      { dependencies: {}, updates: undefined, plugins: [PACKAGE_NAME, 'expo-updates'] },
      { dependencies: {}, updates: { url: 'https://u.expo.dev/project' }, plugins: [PACKAGE_NAME] },
      { dependencies: {}, updates: { enabled: true }, plugins: [PACKAGE_NAME] },
    ];
    for (const variant of variants) {
      const projectRoot = createExpoProject({
        name: 'Fixture',
        slug: 'fixture',
        version: '1.0.0',
        runtimeVersion: 'runtime-1',
        ...(variant.plugins ? { plugins: variant.plugins } : {}),
        ...(variant.updates ? { updates: variant.updates } : {}),
      });
      updatePackageJson(projectRoot, variant.dependencies);
      installBundleDropMetadata(projectRoot);

      const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });
      expect(result.checks).toContainEqual(expect.objectContaining({
        name: 'Expo Updates ownership',
        status: 'error',
      }));
    }
  });

  it('warns for explicitly disabled Expo Updates and accepts exact build receipt parity', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.2.3',
      runtimeVersion: 'runtime-1',
      plugins: [[PACKAGE_NAME, {}], 'expo-updates'],
      updates: { enabled: false },
      ios: { buildNumber: '7' },
    });
    updatePackageJson(projectRoot, { 'expo-updates': '1.0.0' });
    installBundleDropMetadata(projectRoot);
    const identity = await resolveExpoBuildIdentity(projectRoot, 'ios');
    writeReceipt(projectRoot, {
      schemaVersion: 3,
      identities: { ios: identity },
      proofs: {
        ios: {
          createdAt: '2026-08-01T00:00:00.000Z',
          evidence: 'eas-official-metadata',
          integrationGeneration: resolveExpoIntegrationGeneration(),
          easBuildId: '33333333-3333-4333-8333-333333333333',
        },
      },
    });
    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });

    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Expo Updates ownership',
      status: 'warning',
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'ios build/upload parity',
      status: 'pass',
    }));
  });

  it('reports missing Metro wrapper and mismatched receipt identity as blocking errors', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.2.3',
      runtimeVersion: 'runtime-1',
      plugins: [PACKAGE_NAME],
      ios: { buildNumber: '7' },
    });
    installBundleDropMetadata(projectRoot);
    fs.unlinkSync(path.join(projectRoot, 'metro.config.js'));
    const identity = await resolveExpoBuildIdentity(projectRoot, 'ios');
    writeReceipt(projectRoot, {
      schemaVersion: 3,
      identities: { ios: rehashIdentity(identity, { runtimeVersion: 'old-runtime' }) },
      proofs: {
        ios: {
          createdAt: '2026-08-01T00:00:00.000Z',
          evidence: 'eas-official-metadata',
          integrationGeneration: resolveExpoIntegrationGeneration(),
          easBuildId: '33333333-3333-4333-8333-333333333333',
        },
      },
    });
    mockResolveOfficialEasBuildIdentity.mockRejectedValueOnce(
      new Error('official EAS identity mismatch'),
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Expo Metro wrapper', status: 'error' }),
      expect.objectContaining({
        name: 'ios build/upload parity',
        status: 'error',
        message: 'Could not verify the exact EAS build receipt: official EAS identity mismatch',
      }),
    ]));
    expect(mockResolveOfficialEasBuildIdentity).toHaveBeenCalledTimes(1);
  });

  it('warns when the strict receipt does not contain the selected platform', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.2.3',
      runtimeVersion: 'runtime-1',
      plugins: [PACKAGE_NAME],
      android: { versionCode: 8 },
    });
    installBundleDropMetadata(projectRoot);
    const androidIdentity = await resolveExpoBuildIdentity(projectRoot, 'android');
    writeReceipt(projectRoot, {
      schemaVersion: 3,
      identities: { android: androidIdentity },
      proofs: {
        android: {
          createdAt: '2026-08-01T00:00:00.000Z',
          evidence: 'eas-official-metadata',
          integrationGeneration: resolveExpoIntegrationGeneration(),
          easBuildId: '33333333-3333-4333-8333-333333333333',
        },
      },
    });

    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });

    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'ios build/upload parity',
      status: 'warning',
      message: 'No ios identity exists in the current native build receipt.',
    }));
  });

  it('propagates identity failures that are not the remote nativeVersion pre-build case', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.0.0',
      runtimeVersion: 'runtime-1',
      jsEngine: 'unsupported',
      plugins: [PACKAGE_NAME],
    });
    installBundleDropMetadata(projectRoot);

    await expect(inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' }))
      .rejects.toThrow('Unsupported Expo JavaScript engine');
  });

  it('checks both platforms by default', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.0.0',
      runtimeVersion: 'runtime-1',
      plugins: [PACKAGE_NAME],
    });
    installBundleDropMetadata(projectRoot);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ios build identity' }),
      expect.objectContaining({ name: 'android build identity' }),
    ]));
  });

  it('allows setup to await a binary-backed remote nativeVersion receipt', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.0.0',
      runtimeVersion: { policy: 'nativeVersion' },
      plugins: [PACKAGE_NAME],
    });
    installBundleDropMetadata(projectRoot);
    fs.writeFileSync(
      path.join(projectRoot, 'eas.json'),
      JSON.stringify({ cli: { appVersionSource: 'remote' } }),
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo', platform: 'ios' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'ios build identity',
      status: 'warning',
      message: expect.stringContaining('binary-backed'),
    }));
    expect(result.checks.filter(check => check.status === 'error')).toEqual([]);
  });

  it('blocks stale committed native markers and accepts generated startup integration', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.0.0',
      runtimeVersion: 'runtime-1',
      plugins: [PACKAGE_NAME],
    });
    installBundleDropMetadata(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'android'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'ios'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'ios', 'Pods'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'ios', 'build'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'ios', 'Pods', 'Ignored.plist'), '<true/>');
    fs.writeFileSync(
      path.join(projectRoot, 'ios', 'build', 'project.pbxproj'),
      'name = "Bundle Drop: Write iOS build identity";',
    );

    let result = await inspectProject({ cwd: projectRoot, projectType: 'expo' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android generated native integration', status: 'error' }),
      expect.objectContaining({ name: 'ios generated native integration', status: 'error' }),
    ]));

    const manifestPath = path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      '<manifest><application><meta-data android:value="true" android:name="com.bundledrop.EXPO_ENABLED" /></application></manifest>',
    );
    const plistPath = path.join(projectRoot, 'ios/Fixture/Info.plist');
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, '<plist><dict><key>BundleDropExpoEnabled</key><true/></dict></plist>');
    const projectPath = path.join(projectRoot, 'ios/Fixture.xcodeproj/project.pbxproj');
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, 'name = "Bundle Drop: Write iOS build identity";');

    result = await inspectProject({ cwd: projectRoot, projectType: 'expo' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android generated native integration', status: 'pass' }),
      expect.objectContaining({ name: 'ios generated native integration', status: 'pass' }),
    ]));
  });

  it('inspects healthy and incomplete bare projects without applying Expo checks', async () => {
    const healthyRoot = createBareProject();
    let result = await inspectProject({ cwd: healthyRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Bundle Drop config', status: 'pass' }),
      expect.objectContaining({ name: 'Bare Metro alias', status: 'pass' }),
      expect.objectContaining({ name: 'Bare/native autolinking metadata', status: 'pass' }),
      expect.objectContaining({ name: 'ios runtime identity', status: 'pass' }),
      expect.objectContaining({ name: 'android runtime identity', status: 'pass' }),
      expect.objectContaining({ name: 'ios OTA startup ownership', status: 'pass' }),
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'pass' }),
      expect.objectContaining({ name: 'ios native autolinking', status: 'pass' }),
      expect.objectContaining({ name: 'android native autolinking', status: 'pass' }),
    ]));
    expect(result.checks.some(check => check.name.startsWith('Expo'))).toBe(false);

    fs.unlinkSync(path.join(healthyRoot, 'bundle.drop.config.js'));
    fs.unlinkSync(path.join(healthyRoot, 'metro.config.cjs'));
    const nested = path.join(healthyRoot, 'nested');
    fs.mkdirSync(nested);
    result = await inspectProject({ cwd: healthyRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Bundle Drop config', status: 'error' }),
      expect.objectContaining({ name: 'Bare Metro alias', status: 'error' }),
      expect.objectContaining({ name: 'ios runtime identity', status: 'error' }),
      expect.objectContaining({ name: 'android runtime identity', status: 'error' }),
    ]));
  });

  it('rejects dead or competing Metro wrapper authority for bare and Expo projects', async () => {
    const bareRoot = createBareProject();
    fs.writeFileSync(
      path.join(bareRoot, 'metro.config.cjs'),
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const ignored = withBundleDrop(config);\nmodule.exports = config;\n',
    );
    let result = await inspectProject({ cwd: bareRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Bare Metro alias', status: 'error' }),
    ]));

    fs.writeFileSync(path.join(bareRoot, 'metro.config.js'), 'module.exports = {};\n');
    result = await inspectProject({ cwd: bareRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Bare Metro alias',
        status: 'error',
        message: expect.stringContaining('Multiple Metro config files'),
      }),
    ]));

    const expoRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      plugins: [PACKAGE_NAME],
    }, { ios: 'ios-runtime', android: 'android-runtime' });
    fs.writeFileSync(
      path.join(expoRoot, 'metro.config.js'),
      "const { getDefaultConfig } = require('expo/metro-config');\n" +
        "const { withBundleDropExpo } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const ignored = withBundleDropExpo(getDefaultConfig(__dirname));\n' +
        'module.exports = getDefaultConfig(__dirname);\n',
    );
    const expoResult = await inspectProject({ cwd: expoRoot, projectType: 'expo' });
    expect(expoResult.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Expo Metro wrapper', status: 'error' }),
    ]));
  });

  it.each([
    [
      'aliased package export',
      "const { withBundleDrop: other } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = {};\nmodule.exports = withBundleDrop(config);\n',
    ],
    [
      'renamed unrelated package export',
      "const { other: withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = {};\nmodule.exports = withBundleDrop(config);\n',
    ],
    [
      'nested dead export',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = {};\nfunction dead() { module.exports = withBundleDrop(config); }\n' +
        'module.exports = config;\n',
    ],
    [
      'zero-argument wrapper',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop();\n',
    ],
    [
      'unsupported base value',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = undefined;\nmodule.exports = withBundleDrop(config);\n',
    ],
  ])('rejects a bare Metro %s', async (_label, content) => {
    const projectRoot = createBareProject();
    fs.writeFileSync(path.join(projectRoot, 'metro.config.cjs'), content);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Bare Metro alias',
      status: 'error',
    }));
  });

  it.each([
    [
      'aliased package export',
      "const { withBundleDropExpo: other } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = {};\nmodule.exports = withBundleDropExpo(config);\n',
    ],
    [
      'nested dead export',
      "const { withBundleDropExpo } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = {};\nfunction dead() { module.exports = withBundleDropExpo(config); }\n' +
        'module.exports = config;\n',
    ],
    [
      'zero-argument wrapper',
      "const { withBundleDropExpo } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDropExpo();\n',
    ],
    [
      'unsupported base value',
      "const { withBundleDropExpo } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = undefined;\nmodule.exports = withBundleDropExpo(config);\n',
    ],
  ])('rejects an Expo Metro %s', async (_label, content) => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      plugins: [PACKAGE_NAME],
    }, { ios: 'ios-runtime', android: 'android-runtime' });
    fs.writeFileSync(path.join(projectRoot, 'metro.config.js'), content);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'expo' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Expo Metro wrapper',
      status: 'error',
    }));
  });

  it('reports generated v2 bootstrap and ignored inline migration states', async () => {
    const projectRoot = createBareProject();
    fs.mkdirSync(path.join(projectRoot, '.bundle-drop'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.bundle-drop/runtime-delivery.lock.json'),
      JSON.stringify({
        schemaVersion: 1,
        project: {
          serverUrl: 'https://api.example.com',
          orgSlug: 'org',
          projectSlug: 'fixture',
          projectId: 'project-id-1',
          orgId: 'org-id-1',
        },
        runtimeDelivery: {
          manifestBaseUrl: 'https://manifests.example.com',
          manifestAccessId: `mft_${'A'.repeat(43)}`,
          publicKeys: {
            key: {
              kty: 'EC',
              crv: 'P-256',
              x: 'd-g4y_28QdARnFF6HO0T00laLEfHhVFXTmuWHqBWmfM',
              y: '_Z_xWbhjDp3IVMtLA_rN3guVyprP34OvBikPWpVQfUI',
            },
          },
        },
      }),
    );

    let result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime delivery bootstrap',
      status: 'pass',
    }));

    const lockPath = path.join(projectRoot, '.bundle-drop/runtime-delivery.lock.json');
    const legacyPath = path.join(projectRoot, '.bundle-drop/runtime-delivery.generated.json');
    const validBootstrap = fs.readFileSync(lockPath, 'utf8');
    fs.renameSync(lockPath, legacyPath);
    result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime delivery bootstrap',
      status: 'warning',
      message: expect.stringContaining('legacy runtime-delivery.generated.json'),
    }));

    fs.writeFileSync(lockPath, validBootstrap);
    result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime delivery bootstrap',
      status: 'warning',
      message: expect.stringContaining('matches the legacy bootstrap'),
    }));

    const conflictingLegacy = JSON.parse(validBootstrap);
    conflictingLegacy.runtimeDelivery.manifestBaseUrl = 'https://other.example.com';
    fs.writeFileSync(legacyPath, JSON.stringify(conflictingLegacy));
    result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime delivery bootstrap',
      status: 'error',
      message: expect.stringContaining('lockfile and legacy bootstrap differ'),
    }));
    fs.rmSync(legacyPath);

    const malformedBootstrapPath = path.join(
      projectRoot,
      '.bundle-drop/runtime-delivery.lock.json',
    );
    const malformedBootstrap = JSON.parse(fs.readFileSync(malformedBootstrapPath, 'utf8'));
    delete malformedBootstrap.project.orgId;
    fs.writeFileSync(malformedBootstrapPath, JSON.stringify(malformedBootstrap));
    result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime delivery bootstrap',
      status: 'error',
      message: expect.stringContaining('invalid stable project identity'),
    }));

    const legacyRoot = createBareProject();
    fs.writeFileSync(
      path.join(legacyRoot, 'bundle.drop.config.js'),
      "module.exports = { projectType: 'bare', serverUrl: 'https://api.example.com', org: { slug: 'org' }, project: { name: 'Fixture', slug: 'fixture' }, runtimeVersion: { ios: 'ios-runtime', android: 'android-runtime' }, runtimeDelivery: { mode: 'v1' } };",
    );
    result = await inspectProject({ cwd: legacyRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime delivery bootstrap',
      status: 'warning',
      message: expect.stringContaining('Stale inline runtime delivery config is ignored'),
    }));
  });

  it('rejects ignored bootstraps and warns until a valid bootstrap is committed', async () => {
    const projectRoot = createBareProject();
    const bootstrapPath = path.join(projectRoot, '.bundle-drop/runtime-delivery.lock.json');
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(
      bootstrapPath,
      JSON.stringify({
        schemaVersion: 1,
        project: {
          serverUrl: 'https://api.example.com',
          orgSlug: 'org',
          projectSlug: 'fixture',
        },
        runtimeDelivery: {
          manifestBaseUrl: 'https://manifests.example.com',
          manifestAccessId: `mft_${'A'.repeat(43)}`,
          publicKeys: {
            key: {
              kty: 'EC',
              crv: 'P-256',
              x: 'd-g4y_28QdARnFF6HO0T00laLEfHhVFXTmuWHqBWmfM',
              y: '_Z_xWbhjDp3IVMtLA_rN3guVyprP34OvBikPWpVQfUI',
            },
          },
        },
      }),
    );
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });
    fs.writeFileSync(
      path.join(projectRoot, '.gitignore'),
      '# !.bundle-drop/runtime-delivery.lock.json\n' +
        '!.bundle-drop/runtime-delivery.lock.json\n' +
        '.bundle-drop/\n',
    );

    let result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime delivery bootstrap',
      status: 'error',
      message: expect.stringContaining('ignored by Git'),
    }));

    fs.writeFileSync(
      path.join(projectRoot, '.gitignore'),
      '.bundle-drop/*\n!.bundle-drop/runtime-delivery.lock.json\n',
    );
    result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime delivery bootstrap',
      status: 'warning',
      message: expect.stringContaining('not committed yet'),
    }));

    execFileSync('git', ['add', '.gitignore', '.bundle-drop/runtime-delivery.lock.json'], {
      cwd: projectRoot,
    });
    result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'Runtime delivery bootstrap',
      status: 'pass',
    }));
  });

  it('reports bare runtime authority, startup wiring, package metadata, and stale native linking', async () => {
    const projectRoot = createBareProject();
    const packageRoot = path.join(projectRoot, 'node_modules', '@gfean', 'react-native-bundle-drop');
    fs.writeFileSync(
      path.join(projectRoot, 'bundle.drop.config.js'),
      "module.exports = { projectType: 'bare', runtimeVersion: { source: 'expo' } };",
    );
    fs.writeFileSync(path.join(packageRoot, 'react-native.config.js'), 'module.exports = {};');
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.kt'),
      'class MainApplication {}',
    );
    fs.writeFileSync(
      path.join(projectRoot, 'android/build/generated/autolinking/autolinking.json'),
      JSON.stringify({ dependencies: {} }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'),
      'class AppDelegate {}',
    );
    fs.writeFileSync(path.join(projectRoot, 'ios/Podfile.lock'), 'PODS:\n  - React-Core\n');

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Bare/native autolinking metadata', status: 'error' }),
      expect.objectContaining({ name: 'ios runtime identity', status: 'error' }),
      expect.objectContaining({ name: 'android runtime identity', status: 'error' }),
      expect.objectContaining({ name: 'ios OTA startup ownership', status: 'error' }),
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'error' }),
      expect.objectContaining({ name: 'ios native autolinking', status: 'error' }),
      expect.objectContaining({ name: 'android native autolinking', status: 'error' }),
    ]));
  });

  it('warns when bare native linking has not been generated and supports modern startup entrypoints', async () => {
    const projectRoot = createBareProject();
    fs.rmSync(path.join(projectRoot, 'android/build'), { recursive: true });
    fs.unlinkSync(path.join(projectRoot, 'ios/Podfile.lock'));
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.kt'),
      MODERN_KOTLIN_MAIN_APPLICATION,
    );
    fs.unlinkSync(path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'));
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/AppDelegate.mm'),
      '#import <BundleDrop/BundleDropLocator.h>\n@implementation AppDelegate\n- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }\n@end',
    );
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/main.m'),
      'int main(int argc, char **argv) { return UIApplicationMain(argc, argv, nil, @"AppDelegate"); }',
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'pass' }),
      expect.objectContaining({ name: 'ios OTA startup ownership', status: 'pass' }),
      expect.objectContaining({ name: 'android native autolinking', status: 'warning' }),
      expect.objectContaining({ name: 'ios native autolinking', status: 'warning' }),
    ]));
  });

  it('accepts the archived RN85 NativePaths host and connected Swift factory delegate', async () => {
    const projectRoot = createBareProject();
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.kt'),
      RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION,
    );
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
      '<manifest package="app.bundledrop.harness.rn85"><application android:name=".MainApplication" /></manifest>',
    );
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'),
      RN85_SWIFT_APP_DELEGATE,
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'pass' }),
      expect.objectContaining({ name: 'ios OTA startup ownership', status: 'pass' }),
    ]));

    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.kt'),
      RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION,
    );
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
      '<manifest package="com.demo"><application android:name=".MainApplication" /></manifest>',
    );
    const overrideResult = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(overrideResult.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'pass' }),
    ]));
  });

  it('accepts RN71 Objective-C delegation with DEBUG Metro and Release embedded fallbacks', async () => {
    const projectRoot = createBareProject();
    fs.unlinkSync(path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'));
    fs.writeFileSync(path.join(projectRoot, 'ios/Fixture/AppDelegate.m'), RN71_OBJC_APP_DELEGATE);
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/main.m'),
      'int main(int argc, char **argv) { return UIApplicationMain(argc, argv, nil, @"AppDelegate"); }',
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'ios OTA startup ownership',
      status: 'pass',
    }));
  });

  it('accepts the documented RN71 Java multiline local fallback', async () => {
    const projectRoot = createBareProject();
    const kotlinEntrypoint = path.join(
      projectRoot,
      'android/app/src/main/java/com/fixture/MainApplication.kt',
    );
    fs.unlinkSync(kotlinEntrypoint);
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.java'),
      RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION,
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'android OTA startup ownership',
      status: 'pass',
    }));
  });

  it('accepts the preserved RN71 Kotlin conditional local fallback', async () => {
    const projectRoot = createBareProject();
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.kt'),
      RN71_KOTLIN_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'android OTA startup ownership',
      status: 'pass',
    }));
  });

  it('accepts the preserved RN71 Java conditional local fallback', async () => {
    const projectRoot = createBareProject();
    const kotlinEntrypoint = path.join(
      projectRoot,
      'android/app/src/main/java/com/fixture/MainApplication.kt',
    );
    fs.unlinkSync(kotlinEntrypoint);
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.java'),
      RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'android OTA startup ownership',
      status: 'pass',
    }));
  });

  it.each([
    {
      label: 'Android',
      file: 'android/app/src/main/java/com/duplicate/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
        '}',
      ].join('\n'),
      check: 'android OTA startup ownership',
    },
    {
      label: 'iOS',
      file: 'ios/Duplicate/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
      check: 'ios OTA startup ownership',
    },
  ])('rejects duplicate integrated $label entrypoints', async ({ file, content, check }) => {
    const projectRoot = createBareProject();
    const duplicatePath = path.join(projectRoot, file);
    fs.mkdirSync(path.dirname(duplicatePath), { recursive: true });
    fs.writeFileSync(duplicatePath, content);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: check,
        status: 'error',
        message: expect.stringContaining('Multiple'),
      }),
    ]));
  });

  it('rejects bare startup calls that import nonexistent native modules', async () => {
    const projectRoot = createBareProject();
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.kt'),
      'import com.gfean.reactnativebundledrop.BundleDropModule\nclass MainApplication { fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null) }',
    );
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'),
      'import ReactNativeBundleDrop\nclass AppDelegate { func bundleURL() -> URL? { BundleDropLocator.bundleURL() } }',
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'error' }),
      expect.objectContaining({ name: 'ios OTA startup ownership', status: 'error' }),
    ]));
  });

  it('rejects native entrypoints not selected by the platform principal', async () => {
    const projectRoot = createBareProject();
    const manifestPath = path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      '<manifest><application android:name="com.example.CustomApplication" /></manifest>',
    );
    fs.unlinkSync(path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'));
    fs.writeFileSync(path.join(projectRoot, 'ios/Fixture/AppDelegate.m'), [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
      '@end',
    ].join('\n'));
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/main.m'),
      'int main(int argc, char **argv) { return UIApplicationMain(argc, argv, nil, @"OtherDelegate"); }',
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'error' }),
      expect.objectContaining({ name: 'ios OTA startup ownership', status: 'error' }),
    ]));
  });

  it('rejects a Swift principal decoy in a string beside the real app principal', async () => {
    const projectRoot = createBareProject();
    fs.writeFileSync(path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'), [
      'import BundleDrop',
      'let documentation = "@main class AppDelegate"',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '}',
    ].join('\n'));
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/RealApp.swift'),
      '@main struct RealApp { static func main() {} }',
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'ios OTA startup ownership',
      status: 'error',
      message: expect.stringContaining('principal annotation'),
    }));
  });

  it('rejects resolver calls in dead Android and iOS helper methods', async () => {
    const projectRoot = createBareProject();
    const androidEntrypoint = path.join(
      projectRoot,
      'android/app/src/main/java/com/fixture/MainApplication.kt',
    );
    fs.writeFileSync(androidEntrypoint, [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override fun getJSBundleFile(): String? = null',
      '  fun getJSBundleFileForTests() = BundleDropModule.resolveJSBundleFile(this, null)',
      '}',
    ].join('\n'));

    let result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'error' }),
    ]));

    fs.writeFileSync(androidEntrypoint, [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
      '}',
    ].join('\n'));
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'),
      [
        'import BundleDrop',
        'class AppDelegate { func bundleURL() -> URL? { nil } }',
        'class Helper { func bundleURL() -> URL? { BundleDropLocator.bundleURL() } }',
      ].join('\n'),
    );

    result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ios OTA startup ownership', status: 'error' }),
    ]));
  });

  it.each([
    {
      label: 'dead modern Android host connection',
      file: 'android/app/src/main/java/com/fixture/MainApplication.kt',
      content: MODERN_KOTLIN_MAIN_APPLICATION
        .replace('jsBundleFilePath = getJSBundleFile(),', 'isHermesEnabled = true,')
        .replace(
          '\n}',
          '\n  fun deadHost() = getDefaultReactHost(jsBundleFilePath = getJSBundleFile())\n}',
        ),
      check: 'android OTA startup ownership',
    },
    {
      label: 'unused legacy Android host',
      file: 'android/app/src/main/java/com/fixture/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION.replace(
        'override val reactNativeHost',
        'val unusedHost',
      ),
      check: 'android OTA startup ownership',
    },
    {
      label: 'nested legacy Android authority getter',
      file: 'android/app/src/main/java/com/fixture/MainApplication.kt',
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
      check: 'android OTA startup ownership',
    },
    {
      label: 'anonymous legacy Android authority getter',
      file: 'android/app/src/main/java/com/fixture/MainApplication.kt',
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
      check: 'android OTA startup ownership',
    },
    {
      label: 'dead Swift AppDelegate beside the real principal',
      file: 'ios/Fixture/AppDelegate.swift',
      content: [
        'import BundleDrop',
        '@main class RealAppDelegate: UIResponder, UIApplicationDelegate {}',
        'class AppDelegate: RCTAppDelegate {',
        '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
      check: 'ios OTA startup ownership',
    },
    {
      label: 'DEBUG-only Swift resolver',
      file: 'ios/Fixture/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate {',
        '  func bundleURL() -> URL? {',
        '#if DEBUG',
        '    return BundleDropLocator.bundleURL()',
        '#else',
        '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        '#endif',
        '  }',
        '}',
      ].join('\n'),
      check: 'ios OTA startup ownership',
    },
    {
      label: 'ignored Objective-C resolver result',
      file: 'ios/Fixture/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)bundleURL { [BundleDropLocator bundleURL]; return nil; }',
        '@end',
      ].join('\n'),
      check: 'ios OTA startup ownership',
    },
  ])('rejects $label', async ({ file, content, check }) => {
    const projectRoot = createBareProject();
    writeDoctorNativeProbe(projectRoot, file, content);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: check,
      status: 'error',
    }));
  });

  it.each([
    ['nested Kotlin comment resolver', 'android/app/src/main/java/com/fixture/MainApplication.kt', [
      'package com.demo',
      'class MainApplication {',
      '  /* outer /* nested */',
      '    import com.bundledrop.BundleDropModule',
      '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
      '  */',
      '}',
    ].join('\n')],
    ['Kotlin raw multiline string resolver and host decoy', 'android/app/src/main/java/com/fixture/MainApplication.kt', [
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
    ].join('\n')],
    ['nested Swift comment resolver', 'ios/Fixture/AppDelegate.swift', [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  /* outer /* nested */',
      '    override func bundleURL() -> URL? { return BundleDropLocator.bundleURL() }',
      '  */',
      '}',
    ].join('\n')],
    ['Swift multiline string resolver decoy', 'ios/Fixture/AppDelegate.swift', [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  let documentation = """ "',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '  " """',
      '}',
    ].join('\n')],
    ['conditional Android Release bypass', 'android/app/src/main/java/com/fixture/MainApplication.kt', modernDoctorProbe(
      'private fun getJSBundleFile(): String? { return if (useOta) BundleDropModule.resolveJSBundleFile(this, null) else "/android_asset/index.android.bundle" }',
    )],
    ['near-match Android resolver', 'android/app/src/main/java/com/fixture/MainApplication.kt', modernDoctorProbe(
      'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFileForTests(this, null)',
    )],
    ['wrong Android resolver context', 'android/app/src/main/java/com/fixture/MainApplication.kt', modernDoctorProbe(
      'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(42, null)',
    )],
    ['transformed Java resolver return', 'android/app/src/main/java/com/fixture/MainApplication.java',
      RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace(
        '      );',
        '      ).trim();',
      )],
    ['Java fallback ternary with a statement branch', 'android/app/src/main/java/com/fixture/MainApplication.java',
      RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION.replace(
        '? selectEnterpriseBundle()',
        '? return selectEnterpriseBundle()',
      )],
    ['Java resolver with Kotlin non-null suffix', 'android/app/src/main/java/com/fixture/MainApplication.java',
      RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace('      );', '      )!!;')],
    ['Java anonymous host with wrong this receiver', 'android/app/src/main/java/com/fixture/MainApplication.java',
      RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace('getApplicationContext(),', 'this,')],
    ['Kotlin anonymous host with Java receiver syntax', 'android/app/src/main/java/com/fixture/MainApplication.kt',
      RN71_KOTLIN_MAIN_APPLICATION.replace('this@MainApplication,', 'MainApplication.this,')],
    ['non-null Kotlin resolver without unwrap', 'android/app/src/main/java/com/fixture/MainApplication.kt',
      RN71_KOTLIN_MAIN_APPLICATION.replace('          )!!', '          )')],
    ['mismatched Android import alias', 'android/app/src/main/java/com/fixture/MainApplication.kt', modernDoctorProbe(
      'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
    ).replace('import com.bundledrop.BundleDropModule', 'import com.bundledrop.BundleDropModule as BDM')],
    ['early modern Android host bypass', 'android/app/src/main/java/com/fixture/MainApplication.kt', modernDoctorProbe(
      'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
      'if (useCustom) return@lazy customReactHost',
    )],
    ['conditional Swift Release bypass', 'ios/Fixture/AppDelegate.swift', [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? {',
      '    return useOta ? BundleDropLocator.bundleURL() : Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '  }',
      '}',
    ].join('\n')],
    ['RN85 sourceURL bypass', 'ios/Fixture/AppDelegate.swift', RN85_SWIFT_APP_DELEGATE.replace(
      '    self.bundleURL()',
      '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
    )],
    ['direct Swift sourceURL bypass', 'ios/Fixture/AppDelegate.swift', [
      'import BundleDrop',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { return BundleDropLocator.bundleURL() }',
      '  override func sourceURL(for bridge: RCTBridge) -> URL? {',
      '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      '  }',
      '}',
    ].join('\n')],
    ['ignored Objective-C delegation', 'ios/Fixture/AppDelegate.mm', [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
      '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {',
      '  [self bundleURL];',
      '  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];',
      '}',
      '@end',
    ].join('\n')],
  ])('rejects reviewer probe: %s', async (_label, file, content) => {
    const projectRoot = createBareProject();
    writeDoctorNativeProbe(projectRoot, file, content);

    const platform = file.startsWith('android/') ? 'android' : 'ios';
    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: `${platform} OTA startup ownership`,
      status: 'error',
    }));
  });

  it('rejects a parameterized Android onCreate overload as the startup lifecycle', async () => {
    const projectRoot = createBareProject();
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.kt'),
      [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
        '  fun onCreate(test: Boolean) { super.onCreate(); loadReactNative(this) }',
        '}',
      ].join('\n'),
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'error' }),
    ]));
  });

  it('rejects Bundle Drop and CodePush native co-authority', async () => {
    const projectRoot = createBareProject();
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/java/com/fixture/MainApplication.kt'),
      [
        'import com.bundledrop.BundleDropModule',
        'import com.microsoft.codepush.react.CodePush as LegacyCodePush',
        'class MainApplication {',
        '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(',
        '    this, LegacyCodePush.getJSBundleFile(),',
        '  )',
        '}',
      ].join('\n'),
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'error' }),
    ]));
  });

  it.each([
    {
      label: 'parameterized Kotlin resolver',
      file: 'android/app/src/main/java/com/fixture/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  override fun getJSBundleFile(test: Boolean) =',
        '    BundleDropModule.resolveJSBundleFile(this, null)',
        '}',
      ].join('\n'),
      check: 'android OTA startup ownership',
    },
    {
      label: 'parameterized Java resolver',
      file: 'android/app/src/main/java/com/fixture/MainApplication.java',
      content: [
        'import com.bundledrop.BundleDropModule;',
        'public class MainApplication {',
        '  public String getJSBundleFile(boolean test) {',
        '    return BundleDropModule.resolveJSBundleFile(this, null);',
        '  }',
        '}',
      ].join('\n'),
      check: 'android OTA startup ownership',
    },
    {
      label: 'parameterized Swift resolver',
      file: 'ios/Fixture/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate {',
        '  func bundleURL(test: Bool) -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
      check: 'ios OTA startup ownership',
    },
    {
      label: 'unconnected Swift factory delegate',
      file: 'ios/Fixture/AppDelegate.swift',
      content: RN85_SWIFT_APP_DELEGATE.replace(
        'RCTReactNativeFactory(delegate: delegate)',
        'RCTReactNativeFactory(delegate: ReactNativeDelegate())',
      ),
      check: 'ios OTA startup ownership',
    },
    {
      label: 'Objective-C AppDelegate category',
      file: 'ios/Fixture/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate (BundleDrop)',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '@end',
      ].join('\n'),
      check: 'ios OTA startup ownership',
    },
    {
      label: 'duplicate Objective-C AppDelegate implementation',
      file: 'ios/Fixture/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '@end',
        '@implementation AppDelegate',
        '@end',
      ].join('\n'),
      check: 'ios OTA startup ownership',
    },
  ])('rejects a $label decoy', async ({ file, content, check }) => {
    const projectRoot = createBareProject();
    writeDoctorNativeProbe(projectRoot, file, content);

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: check, status: 'error' }),
    ]));
  });

  it('reports a missing installed package and malformed bare runtime config', async () => {
    const projectRoot = createBareProject();
    fs.rmSync(
      path.join(projectRoot, 'node_modules', '@gfean', 'react-native-bundle-drop'),
      { recursive: true },
    );
    fs.writeFileSync(path.join(projectRoot, 'bundle.drop.config.js'), 'module.exports = null;');

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare', platform: 'ios' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Bare/native autolinking metadata',
        status: 'error',
        message: expect.stringContaining('Could not validate'),
      }),
      expect.objectContaining({ name: 'ios runtime identity', status: 'error' }),
    ]));
    expect(result.checks.some(check => check.name.startsWith('android'))).toBe(false);
  });

  it('prints all checks and throws only when blocking doctor errors exist', async () => {
    const projectRoot = createBareProject();
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runDoctor({ cwd: projectRoot, projectType: 'bare' })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Bundle Drop doctor: bare project'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('✅'));

    fs.writeFileSync(path.join(projectRoot, 'metro.config.cjs'), 'module.exports = {};');
    await expect(runDoctor({ cwd: projectRoot, projectType: 'bare' })).rejects.toThrow(
      'found 1 blocking issue',
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('❌'));
  });

  it('supports default cwd/options and prints warning checks', async () => {
    const projectRoot = createExpoProject({
      name: 'Fixture',
      slug: 'fixture',
      version: '1.0.0',
      runtimeVersion: 'runtime-1',
      plugins: [PACKAGE_NAME],
    });
    installBundleDropMetadata(projectRoot);
    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await inspectProject();
      expect(result.projectType).toBe('expo');
      await expect(runDoctor()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('⚠️'));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
