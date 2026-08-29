import fs from 'fs';
import os from 'os';
import path from 'path';

import { createTempProjectDir, removeTempDir } from '../utils/tempDir';
import { mockProcessExit } from '../utils/processExit';

type MockZipInstance = {
  addFile: jest.Mock;
  writeZip: jest.Mock;
};

const zipInstances: MockZipInstance[] = [];
const mockExecSync = jest.fn();
const spawnCalls: Array<{ executable: string; args: string[]; options: unknown }> = [];

const quotePath = (value: string) => `"${value}"`;
const legacyCommand = (executable: string, args: string[]) => {
  if (executable === process.execPath) {
    if (args[0]?.replace(/\\/g, '/').endsWith('/react-native/cli.js')) {
      return ['npx', 'react-native', ...args.slice(1).map(arg =>
        arg.includes(path.sep) ? quotePath(arg) : arg,
      )].join(' ');
    }
    return ['node', ...args.map(arg => arg.startsWith('-') ? arg : quotePath(arg))].join(' ');
  }
  return [quotePath(executable), ...args.map(arg => arg.startsWith('-') ? arg : quotePath(arg))]
    .join(' ');
};

jest.mock('child_process', () => ({
  spawnSync: (executable: string, args: string[], options: unknown) => {
    spawnCalls.push({ executable, args, options });
    const output = mockExecSync(legacyCommand(executable, args), options);
    if (output && typeof output === 'object' && 'status' in output) return output;
    return { status: 0, stdout: output ?? '', stderr: '' };
  },
}));
jest.mock('adm-zip', () =>
  jest.fn().mockImplementation(() => {
    const zip: MockZipInstance = {
      addFile: jest.fn(),
      writeZip: jest.fn(),
    };
    zipInstances.push(zip);
    return zip;
  }),
);

import {
  findProjectRoot,
  runBundleScript as runBundleScriptImplementation,
} from '../../scripts/bundle';

describe('scripts/bundle', () => {
  const originalArgv = [...process.argv];
  const originalCwd = process.cwd();
  let tempProjectDir = '';
  let tempPackageRoot = '';
  let distDir = '';
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  const runBundleScript = (
    options: Parameters<typeof runBundleScriptImplementation>[0] = {},
  ) => runBundleScriptImplementation({ ...options, packageRoot: tempPackageRoot });

  const osBin =
    process.platform === 'darwin'
      ? 'osx-bin'
      : process.platform === 'win32'
        ? 'win64-bin'
        : 'linux64-bin';

  beforeEach(() => {
    tempProjectDir = createTempProjectDir();
    tempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-package-root-'));
    distDir = path.join(tempPackageRoot, 'dist');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    zipInstances.length = 0;
    spawnCalls.length = 0;
    mockExecSync.mockReset().mockImplementation((command: string) => {
      if (command.includes('react-native bundle')) {
        fs.mkdirSync(path.join(distDir, 'assets', 'drawable-mdpi'), { recursive: true });
        fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'plain-bundle', 'utf8');
        fs.writeFileSync(
          path.join(distDir, 'assets', 'drawable-mdpi', 'login_background.jpg'),
          'asset-data',
          'utf8',
        );
        fs.mkdirSync(path.join(distDir, 'assets', 'raw'), { recursive: true });
        fs.writeFileSync(
          path.join(distDir, 'assets', 'raw', 'legal.pdf'),
          'pdf-data',
          'utf8',
        );
        return;
      }

      if (command.includes('hermesc') && command.includes('-help')) {
        return [
          '  -O                              - Expensive optimizations',
          '  -g0                              - Do not emit debug info',
          '  -output-source-map               - Emit a source map',
        ].join('\n');
      }

      if (command.includes('hermesc')) {
        const hbcPath = command.match(/-out "([^"]+)"/)?.[1];
        if (hbcPath) {
          fs.writeFileSync(hbcPath, 'compiled-bundle', 'utf8');
        }
      }
    });
    process.env.BUNDLE_DROP_APP_VERSION = '1.2.3';
    process.argv = [...originalArgv];
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tempProjectDir, 'ios'), { recursive: true });
    fs.mkdirSync(path.join(tempProjectDir, 'android'), { recursive: true });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.chdir(originalCwd);
    process.argv = [...originalArgv];
    removeTempDir(tempProjectDir);
    fs.rmSync(tempPackageRoot, { recursive: true, force: true });
    delete process.env.BUNDLE_DROP_APP_VERSION;
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('finds the native project root from nested directories', () => {
    const nestedDir = path.join(tempProjectDir, 'android', 'app', 'src');
    fs.mkdirSync(nestedDir, { recursive: true });

    expect(findProjectRoot(nestedDir)).toBe(tempProjectDir);
  });

  it('returns the start directory when no native project root can be found', () => {
    const isolatedDir = createTempProjectDir();

    try {
      expect(findProjectRoot(isolatedDir)).toBe(isolatedDir);
    } finally {
      removeTempDir(isolatedDir);
    }
  });

  it('bundles Android output, compiles Hermes bytecode, and injects image manifest aliases', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
  hermesBytecode: { android: true, ios: false },
};`,
      'utf8',
    );
    const hermesPath = path.join(
      tempProjectDir,
      'node_modules',
      'react-native',
      'sdks',
      'hermesc',
      osBin,
      'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const result = runBundleScript({
      platform: 'android',
      cwd: path.join(tempProjectDir, 'android', 'app'),
    });

    const zip = zipInstances[0];
    const metadata = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
    const manifestBuffer = zip.addFile.mock.calls.find(
      ([fileName]) => fileName === 'image-manifest.json',
    )?.[1] as Buffer;
    const manifest = JSON.parse(manifestBuffer.toString('utf8'));
    const bundleManifestBuffer = zip.addFile.mock.calls.find(
      ([fileName]) => fileName === 'bundle-manifest.json',
    )?.[1] as Buffer;
    const bundleManifest = JSON.parse(bundleManifestBuffer.toString('utf8'));

    expect(result.projectRoot).toBe(tempProjectDir);
    expect(result.runtimeVersion).toBe('3.0.0');
    expect(result.hash).toBe(result.bundleHash);
    expect(result.jsBundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata).toEqual(
      expect.objectContaining({
        platform: 'android',
        runtimeVersion: '3.0.0',
        bundlePath: 'main.jsbundle',
        jsBundleHash: result.jsBundleHash,
      }),
    );
    expect(metadata.hash).toBeUndefined();
    expect(metadata.bundleHash).toBeUndefined();
    expect(metadata.timestamp).toBeUndefined();
    expect(bundleManifest).toEqual(
      expect.objectContaining({
        manifestVersion: 1,
        bundleHash: result.bundleHash,
        jsBundleHash: result.jsBundleHash,
        platform: 'android',
        runtimeVersion: '3.0.0',
        version: '1.2.3',
      }),
    );
    expect(bundleManifest.createdAt).toBeUndefined();
    expect(bundleManifest.files.map((file: { path: string }) => file.path)).toEqual([
      'drawable-mdpi/login_background.jpg',
      'image-manifest.json',
      'main.jsbundle',
      'metadata-android.json',
      'raw/legal.pdf',
    ]);
    expect(bundleManifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'main.jsbundle', role: 'jsbundle' }),
        expect.objectContaining({ path: 'metadata-android.json', role: 'metadata' }),
        expect.objectContaining({ path: 'image-manifest.json', role: 'androidImageManifest' }),
      ]),
    );
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(zip.addFile.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining([
        'main.jsbundle',
        'metadata-android.json',
        'bundle-manifest.json',
        'drawable-mdpi/login_background.jpg',
        'raw/legal.pdf',
        'image-manifest.json',
      ]),
    );
    expect(manifest).toEqual(
      expect.objectContaining({
        'drawable-mdpi/login_background.jpg': 'drawable-mdpi/login_background.jpg',
        'raw/legal.pdf': 'raw/legal.pdf',
      }),
    );
    expect(manifest).not.toHaveProperty('drawable-mdpi/login_background');
    expect(manifest).not.toHaveProperty('assets/drawable-mdpi/login_background.jpg');
    expect(manifest).not.toHaveProperty('login_background');
    expect(manifest).not.toHaveProperty('login_background.jpg');
    expect(manifest).not.toHaveProperty('legal');
    expect(manifest).not.toHaveProperty('legal.pdf');
    expect(zip.writeZip).toHaveBeenCalledWith(path.join(distDir, 'bundle-android.zip'));
  });

  it('preserves legacy bare traversal for symlinks and reserved asset names', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
  hermesBytecode: { android: false },
};`,
      'utf8',
    );
    mockExecSync.mockImplementation((command: string) => {
      if (!command.includes('react-native bundle')) return;
      const assetsDir = path.join(distDir, 'assets');
      const externalAsset = path.join(tempProjectDir, 'linked-asset.bin');
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'plain-bundle', 'utf8');
      fs.writeFileSync(externalAsset, 'linked-asset', 'utf8');
      fs.symlinkSync(externalAsset, path.join(assetsDir, 'linked.bin'));
      fs.writeFileSync(path.join(assetsDir, 'main.jsbundle'), 'reserved-main', 'utf8');
      fs.writeFileSync(path.join(assetsDir, 'metadata-android.json'), 'reserved-metadata', 'utf8');
      fs.writeFileSync(path.join(assetsDir, 'bundle-manifest.json'), 'reserved-manifest', 'utf8');
      fs.writeFileSync(path.join(assetsDir, 'image-manifest.json'), 'reserved-image', 'utf8');
    });

    expect(() => runBundleScript({ platform: 'android', cwd: tempProjectDir })).not.toThrow();

    const zip = zipInstances[0];
    expect(zip.addFile.mock.calls.find(([name]) => name === 'linked.bin')?.[1]).toEqual(
      Buffer.from('linked-asset'),
    );
    expect(zip.addFile.mock.calls.find(([name]) => name === 'main.jsbundle')?.[1]).toEqual(
      Buffer.from('reserved-main'),
    );
  });

  it('auto-detects Android Hermes from native project settings', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
};`,
      'utf8',
    );
    fs.mkdirSync(path.join(tempProjectDir, 'android'), { recursive: true });
    fs.writeFileSync(path.join(tempProjectDir, 'android', 'gradle.properties'), 'hermesEnabled=true\n', 'utf8');
    const hermesPath = path.join(
      tempProjectDir,
      'node_modules',
      'react-native',
      'sdks',
      'hermesc',
      osBin,
      'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const result = runBundleScript({ platform: 'android', cwd: tempProjectDir });

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('compiled-bundle');
  });

  it('finds Hermes in the hermes-compiler package layout', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
  hermesBytecode: { android: true },
};`,
      'utf8',
    );
    const hermesPath = path.join(
      tempProjectDir,
      'node_modules',
      'hermes-compiler',
      'hermesc',
      osBin,
      'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const result = runBundleScript({ platform: 'android', cwd: tempProjectDir });

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('compiled-bundle');
    expect(
      mockExecSync.mock.calls.some(
        ([command]: [string]) => command.includes('hermes-compiler') && command.includes('hermesc'),
      ),
    ).toBe(true);
  });

  it('auto-detects iOS Hermes from Xcode project settings', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
};`,
      'utf8',
    );
    const projectFile = path.join(tempProjectDir, 'ios', 'TestApp.xcodeproj', 'project.pbxproj');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, 'USE_HERMES = true;\n', 'utf8');
    const hermesPath = path.join(
      tempProjectDir,
      'node_modules',
      'react-native',
      'sdks',
      'hermesc',
      osBin,
      'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const result = runBundleScript({ platform: 'ios', cwd: tempProjectDir });

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('compiled-bundle');
  });

  it('respects iOS Hermes false settings even when the compiler is present', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
};`,
      'utf8',
    );
    const projectFile = path.join(tempProjectDir, 'ios', 'TestApp.xcodeproj', 'project.pbxproj');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, 'USE_HERMES = false;\n', 'utf8');
    const hermesPath = path.join(
      tempProjectDir,
      'node_modules',
      'react-native',
      'sdks',
      'hermesc',
      osBin,
      'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const result = runBundleScript({ platform: 'ios', cwd: tempProjectDir });

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('plain-bundle');
    expect(consoleLogSpy).toHaveBeenCalledWith('ℹ️  Hermes bytecode disabled for ios — bundling plain JS');
  });

  it('respects native Hermes false settings even when the compiler is present', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
};`,
      'utf8',
    );
    fs.mkdirSync(path.join(tempProjectDir, 'android'), { recursive: true });
    fs.writeFileSync(path.join(tempProjectDir, 'android', 'gradle.properties'), 'hermesEnabled=false\n', 'utf8');
    const hermesPath = path.join(
      tempProjectDir,
      'node_modules',
      'react-native',
      'sdks',
      'hermesc',
      osBin,
      'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const result = runBundleScript({ platform: 'android', cwd: tempProjectDir });

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('plain-bundle');
    expect(consoleLogSpy).toHaveBeenCalledWith('ℹ️  Hermes bytecode disabled for android — bundling plain JS');
  });

  it('does not infer Hermes from unrelated native build settings', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
};`,
      'utf8',
    );
    fs.mkdirSync(path.join(tempProjectDir, 'android'), { recursive: true });
    fs.writeFileSync(path.join(tempProjectDir, 'android', 'gradle.properties'), 'newArchEnabled=true\n', 'utf8');

    const result = runBundleScript({ platform: 'android', cwd: tempProjectDir });

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('plain-bundle');
    expect(consoleLogSpy).toHaveBeenCalledWith('ℹ️  Hermes bytecode disabled for android — bundling plain JS');
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not detect Hermes'),
    );
  });

  it('warns when Hermes auto mode cannot detect native settings', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
  hermesBytecode: { ios: 'auto' },
};`,
      'utf8',
    );

    runBundleScript({ platform: 'ios', cwd: tempProjectDir });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not detect Hermes for ios'),
    );
  });

  it('supports top-level Hermes auto mode', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
  hermesBytecode: 'auto',
};`,
      'utf8',
    );

    runBundleScript({ platform: 'ios', cwd: tempProjectDir });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not detect Hermes for ios'),
    );
  });

  it('logs clearly when Hermes is enabled but the compiler is missing', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
  hermesBytecode: { android: true },
};`,
      'utf8',
    );

    runBundleScript({ platform: 'android', cwd: tempProjectDir });

    expect(consoleLogSpy).toHaveBeenCalledWith('ℹ️  Hermes compiler not found — bundling plain JS');
  });

  it('fails when runtimeVersion config is missing for the requested platform', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0' },
};`,
      'utf8',
    );
    const exitSpy = mockProcessExit();

    try {
      expect(() =>
        runBundleScript({
          platform: 'ios',
          cwd: tempProjectDir,
        }),
      ).toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('❌ Missing runtimeVersion.ios in bundle.drop.config.js'),
      );
      expect(mockExecSync).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('uses process.argv platform selection and process.cwd() when explicit options are omitted', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '6.0.0', ios: '5.0.0' },
};`,
      'utf8',
    );
    process.chdir(tempProjectDir);
    process.argv = ['node', 'bundle-drop', 'android'];

    const result = runBundleScript();

    expect(fs.realpathSync(result.projectRoot)).toBe(fs.realpathSync(tempProjectDir));
    expect(result.runtimeVersion).toBe('6.0.0');
  });

  it('fails when app version is missing from the upload environment', () => {
    delete process.env.BUNDLE_DROP_APP_VERSION;
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
};`,
      'utf8',
    );
    const exitSpy = mockProcessExit();

    try {
      expect(() => runBundleScript({ platform: 'android', cwd: tempProjectDir }))
        .toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '❌ BUNDLE_DROP_APP_VERSION is required so bundle-manifest.json can include the app version',
      );
      expect(mockExecSync).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      process.env.BUNDLE_DROP_APP_VERSION = '1.2.3';
    }
  });

  it('defaults to ios when neither options.platform nor process.argv[2] is set', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '7.0.0' },
};`,
      'utf8',
    );
    process.chdir(tempProjectDir);
    process.argv = ['node', 'bundle-drop'];

    const result = runBundleScript();
    const metadata = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));

    expect(result.runtimeVersion).toBe('7.0.0');
    expect(metadata.platform).toBe('ios');
  });

  it('cleans stale dist files before writing a new bundle', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
};`,
      'utf8',
    );
    fs.mkdirSync(path.join(distDir, 'assets', 'stale'), { recursive: true });
    for (const staleFile of [
      'main.jsbundle',
      'bundle-android.zip',
      'metadata-android.json',
      'bundle-manifest.json',
      'main.jsbundle.map',
    ]) {
      fs.writeFileSync(path.join(distDir, staleFile), 'stale', 'utf8');
    }
    fs.writeFileSync(path.join(distDir, 'assets', 'stale', 'old.txt'), 'stale-asset', 'utf8');

    const result = runBundleScript({ platform: 'android', cwd: tempProjectDir });

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('plain-bundle');
    expect(fs.existsSync(path.join(distDir, 'assets', 'stale', 'old.txt'))).toBe(false);
  });

  it('derives the package root from the script directory when none is injected', () => {
    const originalResolve = path.resolve.bind(path);

    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '9.0.0' },
};`,
      'utf8',
    );
    const resolveSpy = jest.spyOn(path, 'resolve').mockImplementation((...args: string[]) => {
      if (
        args.length === 3 &&
        args[1] === '..' &&
        args[2] === '..' &&
        typeof args[0] === 'string' &&
        args[0].endsWith(`${path.sep}src${path.sep}scripts`)
      ) {
        return tempPackageRoot;
      }
      return originalResolve(...args);
    });

    try {
      const result = runBundleScriptImplementation({
        platform: 'ios',
        cwd: tempProjectDir,
      });

      expect(result.outputDir).toBe(path.join(tempPackageRoot, 'dist'));
      expect(result.runtimeVersion).toBe('9.0.0');
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it('fails when config is missing before rebundling', () => {
    fs.mkdirSync(path.join(distDir, 'assets', 'drawable-mdpi'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'stale-bundle', 'utf8');
    fs.writeFileSync(path.join(distDir, 'bundle-ios.zip'), 'stale-zip', 'utf8');
    fs.writeFileSync(path.join(distDir, 'metadata-ios.json'), 'stale-metadata', 'utf8');
    fs.writeFileSync(
      path.join(distDir, 'assets', 'drawable-mdpi', 'stale.png'),
      'stale-asset',
      'utf8',
    );

    const exitSpy = mockProcessExit();
    try {
      expect(() =>
        runBundleScript({
          platform: 'ios',
          cwd: tempProjectDir,
        }),
      ).toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('❌ bundle.drop.config.js not found in project root');
      expect(mockExecSync).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('warns and falls back to the plain JS bundle when Hermes compilation fails', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '8.0.0', ios: '1.0.0' },
  hermesBytecode: { android: true },
};`,
      'utf8',
    );
    const hermesPath = path.join(
      tempProjectDir,
      'node_modules',
      'react-native',
      'sdks',
      'hermesc',
      osBin,
      'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('react-native bundle')) {
        fs.mkdirSync(path.join(distDir, 'assets', 'drawable-mdpi'), { recursive: true });
        fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'plain-bundle', 'utf8');
        return;
      }

      if (command.includes('hermesc')) {
        throw new Error('hermes failed');
      }
    });

    const result = runBundleScript({
      platform: 'android',
      cwd: tempProjectDir,
    });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '⚠️ Hermes compilation failed, falling back to plain JS bundle:',
      'hermes failed',
    );
    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('plain-bundle');
  });

  it('rejects unsupported platform values', () => {
    const exitSpy = mockProcessExit();

    try {
      expect(() =>
        runBundleScript({
          platform: 'web',
          cwd: tempProjectDir,
        }),
      ).toThrow('process.exit(1)');
      expect(consoleErrorSpy).toHaveBeenCalledWith('❌ Please provide platform: ios or android');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('composes Hermes + Metro source map via compose-source-maps.js when both are present', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { android: '3.0.0' }, hermesBytecode: { android: true } };`,
      'utf8',
    );
    const hermesPath = path.join(
      tempProjectDir, 'node_modules', 'react-native', 'sdks', 'hermesc', osBin, 'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const composeScript = path.join(
      tempProjectDir, 'node_modules', 'react-native', 'scripts', 'compose-source-maps.js',
    );
    fs.mkdirSync(path.dirname(composeScript), { recursive: true });
    fs.writeFileSync(composeScript, '/* stub */', 'utf8');

    const metroMap = { version: 3, sources: ['index.js'], mappings: 'AAAA' };
    const composedMap = { version: 3, sources: ['App.tsx'], sourcesContent: ['// app'], mappings: 'CCCC', names: [] };

    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('react-native bundle')) {
        fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'plain-bundle', 'utf8');
        fs.writeFileSync(path.join(distDir, 'main.jsbundle.map'), JSON.stringify(metroMap), 'utf8');
        return;
      }
      if (command.includes('hermesc') && command.includes('-help')) {
        return '-O\n-g0\n-output-source-map\n';
      }
      if (command.includes('hermesc')) {
        const hbcPath = command.match(/-out "([^"]+)"/)?.[1];
        if (hbcPath) {
          fs.writeFileSync(hbcPath, 'hermes-bytecode', 'utf8');
          fs.writeFileSync(hbcPath + '.map', '{"version":3}', 'utf8');
        }
        return;
      }
      if (command.includes('compose-source-maps')) {
        const outMatch = command.match(/-o "([^"]+)"/);
        if (outMatch) fs.writeFileSync(outMatch[1], JSON.stringify(composedMap), 'utf8');
      }
    });

    const result = runBundleScript({ platform: 'android', cwd: tempProjectDir, sourcemap: true });

    const hermesCompileCommand = mockExecSync.mock.calls.find(
      ([cmd]: [string]) => typeof cmd === 'string' && cmd.includes('hermesc') && !cmd.includes('-help'),
    )?.[0];
    expect(hermesCompileCommand).toContain('-output-source-map');
    expect(hermesCompileCommand).toContain('-O -g0');

    expect(mockExecSync.mock.calls.find(
      ([cmd]: [string]) => typeof cmd === 'string' && cmd.includes('compose-source-maps'),
    )).toBeDefined();

    const finalMap = JSON.parse(fs.readFileSync(result.sourceMapPath!, 'utf8'));
    expect(finalMap.sources).toEqual(['App.tsx']);
    expect(finalMap.mappings).toBe('CCCC');

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('hermes-bytecode');
    expect(fs.existsSync(path.join(distDir, 'main.jsbundle.hbc.map'))).toBe(false);
  });

  it('preserves Hermes bytecode and Metro map when compose-source-maps.js throws', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { android: '3.0.0' }, hermesBytecode: { android: true } };`,
      'utf8',
    );
    const hermesPath = path.join(
      tempProjectDir, 'node_modules', 'react-native', 'sdks', 'hermesc', osBin, 'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const composeScript = path.join(
      tempProjectDir, 'node_modules', 'react-native', 'scripts', 'compose-source-maps.js',
    );
    fs.mkdirSync(path.dirname(composeScript), { recursive: true });
    fs.writeFileSync(composeScript, '/* stub */', 'utf8');

    const metroMap = { version: 3, sources: ['App.tsx'], mappings: 'AAAA' };

    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('react-native bundle')) {
        fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'plain-bundle', 'utf8');
        fs.writeFileSync(path.join(distDir, 'main.jsbundle.map'), JSON.stringify(metroMap), 'utf8');
        return;
      }
      if (command.includes('hermesc') && command.includes('-help')) {
        return '-O\n-g0\n-output-source-map\n';
      }
      if (command.includes('hermesc')) {
        const hbcPath = command.match(/-out "([^"]+)"/)?.[1];
        if (hbcPath) {
          fs.writeFileSync(hbcPath, 'hermes-bytecode', 'utf8');
          fs.writeFileSync(hbcPath + '.map', '{"version":3}', 'utf8');
        }
        return;
      }
      if (command.includes('compose-source-maps')) {
        throw new Error('composition crashed');
      }
    });

    const result = runBundleScript({ platform: 'android', cwd: tempProjectDir, sourcemap: true });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Source map composition failed'),
      'composition crashed',
    );

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('hermes-bytecode');

    const finalMap = JSON.parse(fs.readFileSync(result.sourceMapPath!, 'utf8'));
    expect(finalMap.sources).toEqual(['App.tsx']);
    expect(finalMap.mappings).toBe('AAAA');

    expect(fs.existsSync(path.join(distDir, 'main.jsbundle.hbc.map'))).toBe(false);
  });

  it('packages iOS Hermes bytecode when sourcemap compilation removes the Metro bundle input', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' }, hermesBytecode: { ios: true } };`,
      'utf8',
    );
    const hermesPath = path.join(
      tempProjectDir, 'node_modules', 'react-native', 'sdks', 'hermesc', osBin, 'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const composeScript = path.join(
      tempProjectDir, 'node_modules', 'react-native', 'scripts', 'compose-source-maps.js',
    );
    fs.mkdirSync(path.dirname(composeScript), { recursive: true });
    fs.writeFileSync(composeScript, '/* stub */', 'utf8');

    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('react-native bundle')) {
        fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'plain-bundle', 'utf8');
        fs.writeFileSync(path.join(distDir, 'main.jsbundle.map'), '{"version":3}', 'utf8');
        return;
      }
      if (command.includes('hermesc') && command.includes('-help')) {
        return '-O\n-g0\n-output-source-map\n';
      }
      if (command.includes('hermesc')) {
        const hbcPath = command.match(/-out "([^"]+)"/)?.[1];
        if (hbcPath) {
          fs.unlinkSync(path.join(distDir, 'main.jsbundle'));
          fs.writeFileSync(hbcPath, 'ios-hermes-bytecode', 'utf8');
          fs.writeFileSync(hbcPath + '.map', '{"version":3}', 'utf8');
        }
        return;
      }
      if (command.includes('compose-source-maps')) {
        throw new Error('composition crashed');
      }
    });

    const result = runBundleScript({ platform: 'ios', cwd: tempProjectDir, sourcemap: true });

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('ios-hermes-bytecode');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Source map composition failed'),
      'composition crashed',
    );
    expect(fs.existsSync(path.join(distDir, 'main.jsbundle.hbc'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'main.jsbundle.hbc.map'))).toBe(false);
  });

  it('warns and keeps Metro map when compose-source-maps.js is not found', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { android: '3.0.0' }, hermesBytecode: { android: true } };`,
      'utf8',
    );
    const hermesPath = path.join(
      tempProjectDir, 'node_modules', 'react-native', 'sdks', 'hermesc', osBin, 'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');

    const metroMap = { version: 3, sources: ['App.tsx'], mappings: 'AAAA' };

    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('react-native bundle')) {
        fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'plain-bundle', 'utf8');
        fs.writeFileSync(path.join(distDir, 'main.jsbundle.map'), JSON.stringify(metroMap), 'utf8');
        return;
      }
      if (command.includes('hermesc') && command.includes('-help')) {
        return '-O\n-g0\n-output-source-map\n';
      }
      if (command.includes('hermesc')) {
        const hbcPath = command.match(/-out "([^"]+)"/)?.[1];
        if (hbcPath) {
          fs.writeFileSync(hbcPath, 'hermes-bytecode', 'utf8');
          fs.writeFileSync(hbcPath + '.map', '{"version":3}', 'utf8');
        }
      }
    });

    const result = runBundleScript({ platform: 'android', cwd: tempProjectDir, sourcemap: true });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('compose-source-maps.js not found'),
    );

    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('hermes-bytecode');

    const finalMap = JSON.parse(fs.readFileSync(result.sourceMapPath!, 'utf8'));
    expect(finalMap.sources).toEqual(['App.tsx']);
    expect(finalMap.mappings).toBe('AAAA');

    expect(fs.existsSync(path.join(distDir, 'main.jsbundle.hbc.map'))).toBe(false);
  });

  it('passes --sourcemap-output to Metro and returns sourceMapPath when sourcemap option is set', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );

    const result = runBundleScript({ platform: 'ios', cwd: tempProjectDir, sourcemap: true });

    const bundleCall = mockExecSync.mock.calls.find(
      ([cmd]: [string]) => typeof cmd === 'string' && cmd.includes('react-native bundle'),
    );
    expect(bundleCall).toBeDefined();
    expect(bundleCall[0]).toContain('--reset-cache');
    expect(bundleCall[0]).toContain('--sourcemap-output');
    expect(result.sourceMapPath).toBe(path.join(distDir, 'main.jsbundle.map'));
  });

  it('marks only the Metro subprocess as a Bundle Drop OTA build and preserves inherited variables', () => {
    const inheritedVariableName = 'BUNDLE_DROP_TEST_SENTINEL';
    process.env[inheritedVariableName] = 'preserved';

    try {
      fs.writeFileSync(
        path.join(tempProjectDir, 'bundle.drop.config.js'),
        `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
        'utf8',
      );

      runBundleScript({ platform: 'ios', cwd: tempProjectDir });

      const metroCall = mockExecSync.mock.calls.find(
        ([cmd]: [string]) => typeof cmd === 'string' && cmd.includes('react-native bundle'),
      );
      expect(metroCall).toBeDefined();
      expect(metroCall[1]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            BUNDLE_DROP_OTA_BUILD: '1',
            [inheritedVariableName]: 'preserved',
          }),
        }),
      );
      expect(process.env.BUNDLE_DROP_OTA_BUILD).toBeUndefined();
    } finally {
      delete process.env[inheritedVariableName];
    }
  });

  it.each(['//# debugId=1234', 'sentry-dbid-1234'])(
    'warns when a Hermes OTA Metro bundle contains the Sentry marker %s without rewriting it',
    sentryMarker => {
      fs.writeFileSync(
        path.join(tempProjectDir, 'bundle.drop.config.js'),
        `module.exports = {
  runtimeVersion: { ios: '1.0.0' },
  hermesBytecode: { ios: true },
};`,
        'utf8',
      );
      const hermesPath = path.join(
        tempProjectDir, 'node_modules', 'react-native', 'sdks', 'hermesc', osBin, 'hermesc',
      );
      fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
      fs.writeFileSync(hermesPath, '', 'utf8');

      const sourceBundleContents = `plain-bundle\n${sentryMarker}\n`;
      mockExecSync.mockImplementation((command: string) => {
        if (command.includes('react-native bundle')) {
          fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
          fs.writeFileSync(path.join(distDir, 'main.jsbundle'), sourceBundleContents, 'utf8');
          return;
        }
        if (command.includes('hermesc') && command.includes('-help')) {
          return '-O\n-g0\n-output-source-map\n';
        }
        if (command.includes('hermesc')) {
          const hbcPath = command.match(/-out "([^"]+)"/)?.[1];
          if (hbcPath) {
            fs.writeFileSync(hbcPath, sourceBundleContents, 'utf8');
          }
        }
      });

      const result = runBundleScript({ platform: 'ios', cwd: tempProjectDir });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Sentry Debug ID detected in a Hermes OTA bundle'),
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'https://bundledrop.app/docs/observability#sentry-and-hermes-ota-builds',
        ),
      );
      expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe(sourceBundleContents);
    },
  );

  it('does not warn about a Sentry Debug ID when Hermes bytecode is disabled', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('react-native bundle')) {
        fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
        fs.writeFileSync(
          path.join(distDir, 'main.jsbundle'),
          'plain-bundle\n//# debugId=1234\n',
          'utf8',
        );
      }
    });

    runBundleScript({ platform: 'ios', cwd: tempProjectDir });

    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Sentry Debug ID detected in a Hermes OTA bundle'),
    );
  });

  it('does not generate sourcemaps and returns undefined sourceMapPath when sourcemap is not set', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );

    const result = runBundleScript({ platform: 'ios', cwd: tempProjectDir });

    const bundleCall = mockExecSync.mock.calls.find(
      ([cmd]: [string]) => typeof cmd === 'string' && cmd.includes('react-native bundle'),
    );
    expect(bundleCall[0]).not.toContain('--sourcemap-output');
    expect(result.sourceMapPath).toBeUndefined();
  });

  it('passes file paths as discrete arguments with shell execution disabled', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );

    runBundleScript({ platform: 'ios', cwd: tempProjectDir });

    const bundleCall = mockExecSync.mock.calls.find(
      ([cmd]: [string]) => typeof cmd === 'string' && cmd.includes('react-native bundle'),
    );
    expect(bundleCall).toBeDefined();
    const cmd = bundleCall[0] as string;
    expect(cmd).toMatch(/--bundle-output "[^"]+main\.jsbundle"/);
    expect(cmd).toMatch(/--assets-dest "[^"]+assets"/);

    const spawnCall = spawnCalls.find(call =>
      call.executable === process.execPath &&
      call.args[0]?.replace(/\\/g, '/').endsWith('/react-native/cli.js') &&
      call.args.includes('bundle'),
    );
    expect(spawnCall).toEqual(
      expect.objectContaining({
        executable: process.execPath,
        args: expect.arrayContaining([
          expect.stringMatching(/react-native[\\/]cli\.js$/),
          'bundle',
          '--bundle-output',
          path.join(distDir, 'main.jsbundle'),
          '--assets-dest',
          path.join(distDir, 'assets'),
        ]),
        options: expect.objectContaining({ shell: false }),
      }),
    );
  });

  it('runs the resolved React Native JavaScript CLI without a platform shell shim', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { android: '1.0.0' } };`,
      'utf8',
    );
    const cliPath = path.join(tempProjectDir, 'node_modules', 'react-native', 'cli.js');
    const packageJsonPath = path.join(path.dirname(cliPath), 'package.json');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '', 'utf8');
    fs.writeFileSync(packageJsonPath, '{}', 'utf8');
    const resolveModule = jest.fn(() => packageJsonPath);

    runBundleScriptImplementation({
      platform: 'android',
      cwd: tempProjectDir,
      packageRoot: tempPackageRoot,
      resolveModule,
    });

    expect(resolveModule).toHaveBeenCalledWith('react-native/package.json', [
      tempProjectDir,
      tempPackageRoot,
      expect.any(String),
    ]);
    expect(spawnCalls[0]).toEqual(expect.objectContaining({
      executable: process.execPath,
      args: expect.arrayContaining([cliPath, 'bundle', '--platform', 'android']),
      options: expect.objectContaining({ shell: false }),
    }));
  });

  it('does not interpret shell metacharacters in generated artifact paths', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );
    const packageRoot = path.join(
      tempPackageRoot,
      'output";touch bundle-drop-pwned;# $()',
    );
    const sentinelPath = path.join(tempProjectDir, 'bundle-drop-pwned');
    const calls: Array<{ executable: string; args: string[]; options: unknown }> = [];
    const safeSpawn = ((executable: string, args: string[], options: unknown) => {
      calls.push({ executable, args, options });
      const bundleOutputIndex = args.indexOf('--bundle-output');
      const assetsOutputIndex = args.indexOf('--assets-dest');
      if (bundleOutputIndex >= 0) {
        fs.mkdirSync(args[assetsOutputIndex + 1], { recursive: true });
        fs.writeFileSync(args[bundleOutputIndex + 1], 'plain-bundle', 'utf8');
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as typeof import('child_process').spawnSync;

    process.chdir(tempProjectDir);
    const result = runBundleScriptImplementation({
      platform: 'ios',
      cwd: tempProjectDir,
      packageRoot,
      spawnProcess: safeSpawn,
    });

    expect(result.bundlePath).toBe(path.join(packageRoot, 'dist', 'main.jsbundle'));
    expect(calls[0].options).toEqual(expect.objectContaining({ shell: false }));
    expect(calls[0].args).toContain(result.bundlePath);
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('falls back to the plain JS bundle when the Hermes compiler writes no bytecode output', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  runtimeVersion: { android: '3.0.0', ios: '1.0.0' },
  hermesBytecode: { android: true },
};`,
      'utf8',
    );
    const hermesPath = path.join(
      tempProjectDir, 'node_modules', 'react-native', 'sdks', 'hermesc', osBin, 'hermesc',
    );
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, '', 'utf8');
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('react-native bundle')) {
        fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'plain-bundle', 'utf8');
        return;
      }
      if (command.includes('hermesc') && command.includes('-help')) {
        return '-O\n-g0\n-output-source-map\n';
      }
      // Hermes "succeeds" but intentionally writes no -out bytecode file.
    });

    const result = runBundleScript({ platform: 'android', cwd: tempProjectDir });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '⚠️ Hermes compilation failed, falling back to plain JS bundle:',
      expect.stringContaining('did not write bytecode output'),
    );
    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('plain-bundle');
  });

  it('throws when the bundle output is missing after bundling', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );
    mockExecSync.mockImplementation((command: string) => {
      // Metro runs but never writes main.jsbundle, so the post-bundle guard trips.
      if (command.includes('react-native bundle')) {
        return;
      }
    });

    expect(() => runBundleScript({ platform: 'ios', cwd: tempProjectDir })).toThrow(
      /Bundle output missing after bundling/,
    );
  });

  it('propagates a Metro spawn error', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );
    const spawnError = new Error('could not start Metro');
    const failingSpawn = jest.fn().mockReturnValue({
      status: null,
      error: spawnError,
    }) as unknown as typeof import('child_process').spawnSync;

    expect(() =>
      runBundleScriptImplementation({
        platform: 'ios',
        cwd: tempProjectDir,
        packageRoot: tempPackageRoot,
        spawnProcess: failingSpawn,
      }),
    ).toThrow(spawnError);
  });

  it('reports stderr when Metro exits unsuccessfully', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );
    const failingSpawn = jest.fn().mockReturnValue({
      status: 9,
      stdout: '',
      stderr: 'Metro rejected the arguments',
    }) as unknown as typeof import('child_process').spawnSync;

    expect(() =>
      runBundleScriptImplementation({
        platform: 'ios',
        cwd: tempProjectDir,
        packageRoot: tempPackageRoot,
        spawnProcess: failingSpawn,
      }),
    ).toThrow('Metro rejected the arguments');
  });

  it('handles an iOS project without a native ios directory', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );
    fs.rmSync(path.join(tempProjectDir, 'ios'), { recursive: true, force: true });

    expect(runBundleScript({ platform: 'ios', cwd: tempProjectDir }).runtimeVersion).toBe(
      '1.0.0',
    );
  });

  it('refuses a generated cleanup path that escapes dist', () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { ios: '1.0.0' } };`,
      'utf8',
    );
    const originalResolve = path.resolve.bind(path);
    const bundlePath = path.join(distDir, 'main.jsbundle');
    const resolveSpy = jest.spyOn(path, 'resolve').mockImplementation((...args: string[]) => {
      if (args.length === 1 && args[0] === bundlePath) {
        return path.join(tempPackageRoot, 'outside-main.jsbundle');
      }
      return originalResolve(...args);
    });

    try {
      expect(() => runBundleScript({ platform: 'ios', cwd: tempProjectDir })).toThrow(
        /escaped the package output directory/,
      );
    } finally {
      resolveSpy.mockRestore();
    }
  });
});
