import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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
    fs.writeFileSync(
      path.join(projectRoot, 'metro.config.js'),
      "const { getDefaultConfig } = require('expo/metro-config');\nmodule.exports = withBundleDropExpo(getDefaultConfig(__dirname));\n",
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
      "module.exports = { projectType: 'bare', runtimeVersion: { ios: 'ios-runtime', android: 'android-runtime' } };",
    );
    fs.writeFileSync(
      path.join(projectRoot, 'metro.config.cjs'),
      "module.exports = { resolver: { extraNodeModules: { 'bundle-drop-config': 'config' } } };",
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
      'import com.bundledrop.BundleDropModule\nclass MainApplication { fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null) }',
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
      'import BundleDrop\nclass AppDelegate { func bundleURL() -> URL? { BundleDropLocator.bundleURL() } }',
    );
    fs.writeFileSync(path.join(projectRoot, 'ios/Podfile.lock'), 'PODS:\n  - BundleDrop (0.4.3)\n');
    return projectRoot;
  };

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
      'import com.bundledrop.BundleDropNativePaths\nclass MainApplication { val path = BundleDropNativePaths.getDownloadedBundlePath(this) }',
    );
    fs.unlinkSync(path.join(projectRoot, 'ios/Fixture/AppDelegate.swift'));
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Fixture/AppDelegate.mm'),
      '#import <BundleDrop/BundleDropLocator.h>\n@implementation AppDelegate\n- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }\n@end',
    );

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare' });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'android OTA startup ownership', status: 'pass' }),
      expect.objectContaining({ name: 'ios OTA startup ownership', status: 'pass' }),
      expect.objectContaining({ name: 'android native autolinking', status: 'warning' }),
      expect.objectContaining({ name: 'ios native autolinking', status: 'warning' }),
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
