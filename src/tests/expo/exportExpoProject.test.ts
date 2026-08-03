import fs from 'fs';
import path from 'path';
import { exportExpoProject } from '../../expo';
import type { ExpoBuildIdentity } from '../../expo';
import { createExpoFixture, removeFixture } from './fixture';

describe('exportExpoProject', () => {
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

  it('runs project-local export:embed and treats Hermes output as opaque bytecode', async () => {
    const root = fixture({ expoVersion: '57.0.0', reactNativeVersion: '0.86.0' });
    const outputDirectory = path.join(root, 'export-output');
    const result = await exportExpoProject({
      projectRoot: root,
      platform: 'android',
      outputDirectory,
      resetCache: true,
    });

    const args = JSON.parse(
      fs.readFileSync(path.join(outputDirectory, 'argv.json'), 'utf8'),
    ) as string[];
    expect(args.slice(0, 2)).toEqual(['export:embed', '--platform']);
    expect(args).toContain('--bytecode');
    expect(args).toContain('--reset-cache');
    expect(args).toContain('--sourcemap-output');
    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('opaque-hermes-bytecode');
    expect(result.sourceMapDebugId).toBe('debug-123');
    expect(result.entryFile).toBe(path.join(root, 'src/custom-entry.js'));
    expect(result.buildIdentity).toEqual(
      expect.objectContaining({ javaScriptEngine: 'hermes', platform: 'android' }),
    );
    expect(result.files).toEqual([
      'argv.json',
      'assets/icon.png',
      'main.jsbundle',
      'main.jsbundle.map',
    ]);
  });

  it('exports JSC without requesting Hermes bytecode', async () => {
    const root = fixture({
      config: {
        version: '1.0.0',
        runtimeVersion: 'jsc-runtime',
        jsEngine: 'jsc',
        ios: { buildNumber: '1' },
      },
    });
    const outputDirectory = path.join(root, 'export-output');
    const result = await exportExpoProject({
      projectRoot: root,
      platform: 'ios',
      outputDirectory,
    });
    const args = JSON.parse(
      fs.readFileSync(path.join(outputDirectory, 'argv.json'), 'utf8'),
    ) as string[];
    expect(args).not.toContain('--bytecode');
    expect(args).not.toContain('--reset-cache');
    expect(fs.readFileSync(result.bundlePath, 'utf8')).toBe('jsc-javascript');
  });

  it('uses an exact supplied remote EAS build identity without resolving local defaults', async () => {
    const root = fixture({
      config: {
        version: '1.0.0',
        runtimeVersion: { policy: 'nativeVersion' },
        ios: { buildNumber: '1' },
      },
    });
    fs.writeFileSync(path.join(root, 'eas.json'), JSON.stringify({
      cli: { appVersionSource: 'remote' },
    }));
    const buildIdentity: ExpoBuildIdentity = {
      platform: 'ios',
      runtimeVersion: '1.0.0(412)',
      runtimeVersionPolicy: 'nativeVersion',
      expoSdkVersion: '55.0.0',
      reactNativeVersion: '0.83.0',
      javaScriptEngine: 'hermes',
      appVersion: '1.0.0',
      nativeVersion: '1.0.0(412)',
      identityHash: 'receipt-hash',
    };
    const result = await exportExpoProject({
      projectRoot: root,
      platform: 'ios',
      outputDirectory: path.join(root, 'out'),
      buildIdentity,
    });
    expect(result.buildIdentity).toBe(buildIdentity);
  });

  it('rejects a supplied build identity for a different platform', async () => {
    const root = fixture();
    const buildIdentity: ExpoBuildIdentity = {
      platform: 'android',
      runtimeVersion: 'android-runtime',
      runtimeVersionPolicy: 'literal',
      expoSdkVersion: '55.0.0',
      reactNativeVersion: '0.83.0',
      javaScriptEngine: 'hermes',
      appVersion: '1.0.0',
      nativeVersion: '1.0.0(1)',
      identityHash: 'receipt-hash',
    };
    await expect(
      exportExpoProject({
        projectRoot: root,
        platform: 'ios',
        outputDirectory: path.join(root, 'out'),
        buildIdentity,
      }),
    ).rejects.toThrow('supplied Expo build identity is for android, not ios');
  });

  it('accepts a pre-created empty output directory', async () => {
    const root = fixture();
    const outputDirectory = path.join(root, 'export-output');
    fs.mkdirSync(outputDirectory);
    await expect(
      exportExpoProject({ projectRoot: root, platform: 'ios', outputDirectory }),
    ).resolves.toEqual(expect.objectContaining({ outputDirectory }));
  });

  it('resolves project-local relative custom entries', async () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'node_modules/expo/node_modules/@expo/config/paths/index.js'),
      `exports.resolveEntryPoint = () => 'src/custom-entry.js';`,
    );
    const result = await exportExpoProject({
      projectRoot: root,
      platform: 'ios',
      outputDirectory: path.join(root, 'out'),
    });
    expect(result.entryFile).toBe(path.join(root, 'src/custom-entry.js'));
  });

  it('rejects non-empty, file, and symlink output paths', async () => {
    const nonEmptyRoot = fixture();
    const nonEmptyOutput = path.join(nonEmptyRoot, 'export-output');
    fs.mkdirSync(nonEmptyOutput);
    fs.writeFileSync(path.join(nonEmptyOutput, 'stale'), 'stale');
    await expect(
      exportExpoProject({
        projectRoot: nonEmptyRoot,
        platform: 'ios',
        outputDirectory: nonEmptyOutput,
      }),
    ).rejects.toThrow('must be empty');

    const fileRoot = fixture();
    const fileOutput = path.join(fileRoot, 'export-output');
    fs.writeFileSync(fileOutput, 'file');
    await expect(
      exportExpoProject({ projectRoot: fileRoot, platform: 'ios', outputDirectory: fileOutput }),
    ).rejects.toThrow('must be a real directory');

    const linkRoot = fixture();
    const target = path.join(linkRoot, 'target');
    const linkOutput = path.join(linkRoot, 'export-output');
    fs.mkdirSync(target);
    fs.symlinkSync(target, linkOutput);
    await expect(
      exportExpoProject({ projectRoot: linkRoot, platform: 'ios', outputDirectory: linkOutput }),
    ).rejects.toThrow('must be a real directory');
  });

  it('reports unresolved entries and incompatible paths APIs', async () => {
    const missingEntryRoot = fixture();
    fs.writeFileSync(
      path.join(
        missingEntryRoot,
        'node_modules/expo/node_modules/@expo/config/paths/index.js',
      ),
      'exports.resolveEntryPoint = () => null;',
    );
    await expect(
      exportExpoProject({
        projectRoot: missingEntryRoot,
        platform: 'ios',
        outputDirectory: path.join(missingEntryRoot, 'out'),
      }),
    ).rejects.toThrow('could not resolve the ios entrypoint');

    const incompatibleRoot = fixture();
    fs.writeFileSync(
      path.join(incompatibleRoot, 'node_modules/expo/node_modules/@expo/config/paths/index.js'),
      'exports.resolveEntryPoint = null;',
    );
    await expect(
      exportExpoProject({
        projectRoot: incompatibleRoot,
        platform: 'android',
        outputDirectory: path.join(incompatibleRoot, 'out'),
      }),
    ).rejects.toThrow('does not export resolveEntryPoint');
  });

  it('contains project-local CLI failures and never creates a valid artifact', async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'fail-cli'), 'yes');
    await expect(
      exportExpoProject({
        projectRoot: root,
        platform: 'android',
        outputDirectory: path.join(root, 'out'),
      }),
    ).rejects.toThrow('No Bundle Drop artifact was created');
  });
});
