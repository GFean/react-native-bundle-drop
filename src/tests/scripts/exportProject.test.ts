import fs from 'fs-extra';
import path from 'path';

import { createTempProjectDir, removeTempDir } from '../utils/tempDir';

const mockDetectProjectType = jest.fn();
const mockEvaluateExpoConfig = jest.fn();
const mockExportExpoProject = jest.fn();
const mockResolveExpoUploadIdentity = jest.fn();
const mockBuildCanonicalArtifact = jest.fn();
const mockRunBundleScript = jest.fn();

jest.mock('../../expo', () => ({
  detectProjectType: (...args: unknown[]) => mockDetectProjectType(...args),
  evaluateExpoConfig: (...args: unknown[]) => mockEvaluateExpoConfig(...args),
  exportExpoProject: (...args: unknown[]) => mockExportExpoProject(...args),
  assertExpoUpdatesDoesNotOwnStartup: (...args: unknown[]) =>
    jest.requireActual('../../expo/expoUpdatesOwnership').assertExpoUpdatesDoesNotOwnStartup(...args),
}));
jest.mock('../../CLI/scripts/expo/build-receipt', () => ({
  resolveExpoUploadIdentity: (...args: unknown[]) => mockResolveExpoUploadIdentity(...args),
}));
jest.mock('../../scripts/canonicalArtifact', () => ({
  buildCanonicalArtifact: (...args: unknown[]) => mockBuildCanonicalArtifact(...args),
}));
jest.mock('../../scripts/bundle', () => ({
  runBundleScript: (...args: unknown[]) => mockRunBundleScript(...args),
}));

import { exportProjectArtifact } from '../../scripts/exportProject';
import type { ExpoBuildIdentity } from '../../expo';

const iosIdentity: ExpoBuildIdentity = {
  platform: 'ios',
  runtimeVersion: 'ios-runtime',
  runtimeVersionPolicy: 'literal',
  expoSdkVersion: '57.0.0',
  reactNativeVersion: '0.86.0',
  javaScriptEngine: 'hermes',
  appVersion: '2.0.0',
  nativeVersion: '2.0.0(12)',
  identityHash: 'ios-hash',
};

const androidIdentity: ExpoBuildIdentity = {
  ...iosIdentity,
  platform: 'android',
  runtimeVersion: 'android-runtime',
  identityHash: 'android-hash',
};

describe('exportProjectArtifact', () => {
  const roots: string[] = [];
  const originalPackageRoot = process.env.BUNDLE_DROP_PACKAGE_ROOT_OVERRIDE;

  const fixture = (packageJson: Record<string, unknown> = {}) => {
    const root = createTempProjectDir();
    roots.push(root);
    fs.writeJsonSync(path.join(root, 'package.json'), packageJson);
    process.env.BUNDLE_DROP_PACKAGE_ROOT_OVERRIDE = root;
    return root;
  };

  beforeEach(() => {
    mockDetectProjectType.mockReturnValue('expo');
    mockEvaluateExpoConfig.mockReturnValue({ exp: { plugins: [], updates: { enabled: false } } });
    mockResolveExpoUploadIdentity.mockResolvedValue(iosIdentity);
    mockBuildCanonicalArtifact.mockImplementation(({ outputDir }) => ({
      outputDir,
      bundlePath: '/artifact/main.jsbundle',
      zipPath: '/artifact/bundle.zip',
      manifestPath: '/artifact/bundle-manifest.json',
    }));
    mockRunBundleScript.mockReturnValue({ bundlePath: '/bare/main.jsbundle' });
    mockExportExpoProject.mockImplementation(async ({ outputDirectory }: { outputDirectory: string }) => {
      const bundlePath = path.join(outputDirectory, 'embed.jsbundle');
      const sourceMapPath = path.join(outputDirectory, 'embed.jsbundle.map');
      const assetsDirectory = path.join(outputDirectory, 'assets');
      fs.ensureDirSync(assetsDirectory);
      fs.writeFileSync(bundlePath, 'opaque-hermes-bytecode');
      fs.writeFileSync(sourceMapPath, '{"debug_id":"source-map-debug-id"}');
      fs.writeFileSync(path.join(assetsDirectory, 'icon.png'), 'asset');
      return {
        bundlePath,
        sourceMapPath,
        assetsDirectory,
        sourceMapDebugId: 'source-map-debug-id',
      };
    });
  });

  afterEach(() => {
    if (originalPackageRoot === undefined) delete process.env.BUNDLE_DROP_PACKAGE_ROOT_OVERRIDE;
    else process.env.BUNDLE_DROP_PACKAGE_ROOT_OVERRIDE = originalPackageRoot;
    for (const root of roots.splice(0)) removeTempDir(root);
  });

  it('keeps bare React Native publishing delegated to the unchanged bundle script', async () => {
    const root = fixture();
    mockDetectProjectType.mockReturnValue('bare');

    const result = await exportProjectArtifact({
      projectRoot: root,
      projectType: 'bare',
      platform: 'android',
      appVersion: '1.4.0',
      generateSourceMap: true,
    });

    expect(mockDetectProjectType).toHaveBeenCalledWith({
      projectRoot: root,
      explicitType: 'bare',
    });
    expect(mockRunBundleScript).toHaveBeenCalledWith({
      platform: 'android',
      cwd: root,
      sourcemap: true,
    });
    expect(result).toEqual({
      projectType: 'bare',
      buildIdentity: undefined,
      bundlePath: '/bare/main.jsbundle',
    });
    expect(mockExportExpoProject).not.toHaveBeenCalled();
    expect(mockBuildCanonicalArtifact).not.toHaveBeenCalled();
  });

  it('normalizes Expo export:embed output through the canonical artifact builder', async () => {
    const root = fixture({ dependencies: { expo: '57.0.0' } });

    const result = await exportProjectArtifact({
      projectRoot: root,
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: true,
      buildReceipt: 'receipts/eas.json',
    });

    expect(mockResolveExpoUploadIdentity).toHaveBeenCalledWith({
      projectRoot: root,
      platform: 'ios',
      receiptFile: 'receipts/eas.json',
    });
    expect(mockExportExpoProject).toHaveBeenCalledWith({
      projectRoot: root,
      platform: 'ios',
      outputDirectory: path.join(root, '.bundle-drop/artifacts/expo-export-ios'),
      resetCache: true,
      buildIdentity: iosIdentity,
    });
    expect(fs.readFileSync(
      path.join(root, '.bundle-drop/artifacts/expo-artifacts-ios/main.jsbundle'),
      'utf8',
    )).toBe(
      'opaque-hermes-bytecode',
    );
    expect(mockBuildCanonicalArtifact).toHaveBeenCalledWith({
      platform: 'ios',
      appVersion: '2.0.0',
      runtimeVersion: 'ios-runtime',
      bundlePath: path.join(root, '.bundle-drop/artifacts/expo-artifacts-ios/main.jsbundle'),
      assetsDir: path.join(root, '.bundle-drop/artifacts/expo-export-ios/assets'),
      outputDir: path.join(root, '.bundle-drop/artifacts/expo-artifacts-ios'),
      sourceMapPath: path.join(
        root,
        '.bundle-drop/artifacts/expo-artifacts-ios/main.jsbundle.map',
      ),
    });
    expect(mockRunBundleScript).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      projectType: 'expo',
      projectRoot: root,
      buildIdentity: iosIdentity,
      sourceMapDebugId: 'source-map-debug-id',
      zipPath: '/artifact/bundle.zip',
    }));
  });

  it('uses a supplied identity without resolving a receipt', async () => {
    const root = fixture();

    await exportProjectArtifact({
      projectRoot: root,
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
      buildIdentity: iosIdentity,
    });

    expect(mockResolveExpoUploadIdentity).not.toHaveBeenCalled();
    expect(mockExportExpoProject).toHaveBeenCalledWith(expect.objectContaining({
      buildIdentity: iosIdentity,
    }));
  });

  it('keeps Expo upload artifacts out of the installed native package', async () => {
    const root = fixture();
    const packageRoot = createTempProjectDir();
    roots.push(packageRoot);
    process.env.BUNDLE_DROP_PACKAGE_ROOT_OVERRIDE = packageRoot;

    const artifact = await exportProjectArtifact({
      projectRoot: root,
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
      buildIdentity: iosIdentity,
    });

    expect(artifact).toEqual(expect.objectContaining({
      outputDir: path.join(root, '.bundle-drop/artifacts/expo-artifacts-ios'),
    }));
    expect(fs.existsSync(path.join(packageRoot, 'dist'))).toBe(false);
  });

  it('rejects active expo-updates from dependencies or evaluated configuration', async () => {
    const installedRoot = fixture({ dependencies: { 'expo-updates': '0.30.0' } });
    mockEvaluateExpoConfig.mockReturnValue({ exp: { plugins: [] } });
    await expect(exportProjectArtifact({
      projectRoot: installedRoot,
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
    })).rejects.toThrow('Active expo-updates blocks Bundle Drop');

    const configuredRoot = fixture();
    mockEvaluateExpoConfig.mockReturnValue({ exp: { plugins: [['expo-updates', {}]] } });
    await expect(exportProjectArtifact({
      projectRoot: configuredRoot,
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
    })).rejects.toThrow('Active expo-updates blocks Bundle Drop');

    expect(mockExportExpoProject).not.toHaveBeenCalled();
  });

  it.each(['optionalDependencies', 'peerDependencies'] as const)(
    'rejects expo-updates declared in %s',
    async dependencyGroup => {
      const root = fixture({ [dependencyGroup]: { 'expo-updates': '0.30.0' } });
      mockEvaluateExpoConfig.mockReturnValue({ exp: {} });

      await expect(exportProjectArtifact({
        projectRoot: root,
        platform: 'ios',
        appVersion: '2.0.0',
        generateSourceMap: false,
      })).rejects.toThrow('Active expo-updates blocks Bundle Drop');
    },
  );

  it.each([
    { plugins: [null, ['not-expo-updates'], { name: 'ignored' }], updates: { url: 'https://updates.example.com' } },
    { plugins: [], updates: { enabled: true } },
  ])('rejects each evaluated active expo-updates signal', async exp => {
    const root = fixture();
    mockEvaluateExpoConfig.mockReturnValue({ exp });

    await expect(exportProjectArtifact({
      projectRoot: root,
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
    })).rejects.toThrow('Active expo-updates blocks Bundle Drop');
  });

  it('allows installed expo-updates only when evaluated configuration explicitly disables it', async () => {
    const root = fixture({ devDependencies: { 'expo-updates': '0.30.0' } });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: ['expo-updates'], updates: { enabled: false, url: 'https://updates.example.com' } },
    });

    await expect(exportProjectArtifact({
      projectRoot: root,
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
    })).resolves.toEqual(expect.objectContaining({ projectType: 'expo' }));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('expo-updates is installed but explicitly disabled'));
    warning.mockRestore();
  });

  it('passes a caller-provided project type through strict explicit validation', async () => {
    const root = fixture({ dependencies: { expo: '57.0.0' }, main: 'expo-router/entry' });
    mockDetectProjectType.mockImplementationOnce(() => {
      throw new Error('The explicit bare project type requires React Native.');
    });

    await expect(exportProjectArtifact({
      projectRoot: root,
      projectType: 'bare',
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
    })).rejects.toThrow('explicit bare project type requires React Native');

    expect(mockDetectProjectType).toHaveBeenCalledWith({
      projectRoot: root,
      explicitType: 'bare',
    });

    expect(mockRunBundleScript).not.toHaveBeenCalled();
    expect(mockExportExpoProject).not.toHaveBeenCalled();
  });

  it('fails closed when receipt platform or app version differs from the upload target', async () => {
    const root = fixture();
    mockResolveExpoUploadIdentity.mockResolvedValueOnce({ ...iosIdentity, platform: 'android' });
    await expect(exportProjectArtifact({
      projectRoot: root,
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
    })).rejects.toThrow('identity is for android, not ios');

    mockResolveExpoUploadIdentity.mockResolvedValueOnce(iosIdentity);
    await expect(exportProjectArtifact({
      projectRoot: root,
      platform: 'ios',
      appVersion: '2.0.1',
      generateSourceMap: false,
    })).rejects.toThrow('Expo app version mismatch');

    expect(mockExportExpoProject).not.toHaveBeenCalled();
  });

  it('isolates concurrent iOS and Android Expo exports and canonical artifacts', async () => {
    const root = fixture();
    const pendingExports = new Map<string, () => void>();
    mockResolveExpoUploadIdentity.mockImplementation(
      async ({ platform }: { platform: 'ios' | 'android' }) =>
        platform === 'ios' ? iosIdentity : androidIdentity,
    );
    mockExportExpoProject.mockImplementation(({
      outputDirectory,
      platform,
    }: {
      outputDirectory: string;
      platform: 'ios' | 'android';
    }) => new Promise(resolve => {
      const bundlePath = path.join(outputDirectory, 'embed.jsbundle');
      const sourceMapPath = path.join(outputDirectory, 'embed.jsbundle.map');
      const assetsDirectory = path.join(outputDirectory, 'assets');
      fs.ensureDirSync(assetsDirectory);
      fs.writeFileSync(bundlePath, `${platform}-bundle`);
      fs.writeFileSync(sourceMapPath, `${platform}-source-map`);
      fs.writeFileSync(path.join(assetsDirectory, `${platform}.png`), `${platform}-asset`);

      pendingExports.set(platform, () => resolve({
        bundlePath,
        sourceMapPath,
        assetsDirectory,
        sourceMapDebugId: `${platform}-debug-id`,
      }));
      if (pendingExports.size === 2) {
        for (const finishExport of pendingExports.values()) finishExport();
      }
    }));
    mockBuildCanonicalArtifact.mockImplementation((options) => ({
      outputDir: options.outputDir,
      bundlePath: options.bundlePath,
      sourceMapPath: options.sourceMapPath,
      metadataPath: path.join(options.outputDir, `metadata-${options.platform}.json`),
      manifestPath: path.join(options.outputDir, 'bundle-manifest.json'),
      zipPath: path.join(options.outputDir, `bundle-${options.platform}.zip`),
      runtimeVersion: options.runtimeVersion,
      hash: `${options.platform}-hash`,
      bundleHash: `${options.platform}-hash`,
      jsBundleHash: `${options.platform}-js-hash`,
    }));

    const [iosArtifact, androidArtifact] = await Promise.all([
      exportProjectArtifact({
        projectRoot: root,
        platform: 'ios',
        appVersion: '2.0.0',
        generateSourceMap: true,
      }),
      exportProjectArtifact({
        projectRoot: root,
        platform: 'android',
        appVersion: '2.0.0',
        generateSourceMap: true,
      }),
    ]);

    expect(iosArtifact.outputDir).toBe(
      path.join(root, '.bundle-drop/artifacts/expo-artifacts-ios'),
    );
    expect(androidArtifact.outputDir).toBe(
      path.join(root, '.bundle-drop/artifacts/expo-artifacts-android'),
    );
    expect(fs.readFileSync(iosArtifact.bundlePath, 'utf8')).toBe('ios-bundle');
    expect(fs.readFileSync(androidArtifact.bundlePath, 'utf8')).toBe('android-bundle');
    expect(iosArtifact.bundlePath).not.toBe(androidArtifact.bundlePath);
    expect(iosArtifact.manifestPath).not.toBe(androidArtifact.manifestPath);
    if (!('expoExportDirectory' in iosArtifact) || !('expoExportDirectory' in androidArtifact)) {
      throw new Error('Concurrent Expo exports must return their raw export directories');
    }
    expect(iosArtifact.expoExportDirectory).not.toBe(androidArtifact.expoExportDirectory);
  });

  it('cleans only the selected Expo platform before exporting', async () => {
    const root = fixture();
    const artifactRoot = path.join(root, '.bundle-drop', 'artifacts');
    const iosOutput = path.join(artifactRoot, 'expo-artifacts-ios');
    const iosExport = path.join(artifactRoot, 'expo-export-ios');
    const androidOutput = path.join(artifactRoot, 'expo-artifacts-android');
    const androidExport = path.join(artifactRoot, 'expo-export-android');
    fs.ensureDirSync(iosOutput);
    fs.ensureDirSync(iosExport);
    fs.ensureDirSync(androidOutput);
    fs.ensureDirSync(androidExport);
    fs.writeFileSync(path.join(iosOutput, 'stale'), 'stale-ios-output');
    fs.writeFileSync(path.join(iosExport, 'stale'), 'stale-ios-export');
    fs.writeFileSync(path.join(androidOutput, 'sentinel'), 'android-output');
    fs.writeFileSync(path.join(androidExport, 'sentinel'), 'android-export');

    await exportProjectArtifact({
      projectRoot: root,
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
    });

    expect(fs.existsSync(path.join(iosOutput, 'stale'))).toBe(false);
    expect(fs.existsSync(path.join(iosExport, 'stale'))).toBe(false);
    expect(fs.readFileSync(path.join(androidOutput, 'sentinel'), 'utf8')).toBe('android-output');
    expect(fs.readFileSync(path.join(androidExport, 'sentinel'), 'utf8')).toBe('android-export');
  });
});
