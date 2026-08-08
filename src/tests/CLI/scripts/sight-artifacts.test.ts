import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockSpawn = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import {
  generateSightArtifacts,
  validateSightArtifacts,
} from '../../../CLI/scripts/sight-artifacts';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

type SpawnMode =
  | { type: 'success'; bundle?: Buffer | string; sourceMap?: Record<string, unknown> | string }
  | { type: 'error'; error: Error }
  | { type: 'exit'; code: number | null; signal?: NodeJS.Signals | null };

describe('CLI/scripts/sight-artifacts', () => {
  const roots: string[] = [];
  const generatedDirectories: string[] = [];

  const fixture = () => {
    const root = createTempProjectDir();
    roots.push(root);
    return root;
  };

  const writeModule = (
    projectRoot: string,
    moduleId: string,
    files: Record<string, string>,
  ) => {
    const moduleRoot = path.join(projectRoot, 'node_modules', ...moduleId.split('/'));
    fs.mkdirSync(moduleRoot, { recursive: true });
    fs.writeFileSync(
      path.join(moduleRoot, 'package.json'),
      JSON.stringify({ name: moduleId, version: '1.0.0', main: 'index.js' }),
    );
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(moduleRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
    }
    return moduleRoot;
  };

  const writeBareModules = (projectRoot: string) => {
    writeModule(projectRoot, 'react-native', {
      'index.js': 'module.exports = {};',
      'cli.js': 'module.exports = {};',
    });
  };

  const writeExpoModules = (
    projectRoot: string,
    resolveEntryPointSource =
      'exports.resolveEntryPoint = root => require("path").join(root, "src/expo-entry.js");',
  ) => {
    const expoRoot = writeModule(projectRoot, 'expo', {
      'index.js': 'module.exports = {};',
    });
    writeModule(expoRoot, '@expo/cli', {
      'index.js': 'module.exports = {};',
    });
    const configRoot = writeModule(expoRoot, '@expo/config', {
      'index.js': 'module.exports = {};',
      'paths.js': resolveEntryPointSource,
    });
    const configManifestPath = path.join(configRoot, 'package.json');
    const configManifest = JSON.parse(fs.readFileSync(configManifestPath, 'utf8'));
    configManifest.exports = { '.': './index.js', './paths': './paths.js' };
    fs.writeFileSync(configManifestPath, JSON.stringify(configManifest));
  };

  const sourceMap = (overrides: Record<string, unknown> = {}) => ({
    version: 3,
    sources: ['src/App.tsx'],
    names: [],
    mappings: 'AAAA',
    ...overrides,
  });

  const installSpawn = (mode: SpawnMode = { type: 'success' }) => {
    mockSpawn.mockImplementation((_command: string, args: string[]) => {
      const child = new EventEmitter();
      process.nextTick(() => {
        if (mode.type === 'error') {
          child.emit('error', mode.error);
          return;
        }
        if (mode.type === 'exit') {
          child.emit('exit', mode.code, mode.signal ?? null);
          return;
        }

        const valueFor = (flag: string) => args[args.indexOf(flag) + 1];
        const bundlePath = valueFor('--bundle-output');
        const sourceMapPath = valueFor('--sourcemap-output');
        fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
        fs.writeFileSync(bundlePath, mode.bundle ?? 'console.log("Sight");');
        const mapContents = mode.sourceMap ?? sourceMap({
          file: path.basename(bundlePath),
        });
        fs.writeFileSync(
          sourceMapPath,
          typeof mapContents === 'string' ? mapContents : JSON.stringify(mapContents),
        );
        child.emit('exit', 0, null);
      });
      return child;
    });
  };

  const rememberGeneratedDirectory = <T extends { outputDirectory: string }>(result: T) => {
    generatedDirectories.push(result.outputDirectory);
    return result;
  };

  beforeEach(() => {
    mockSpawn.mockReset();
    installSpawn();
  });

  afterEach(() => {
    for (const directory of generatedDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    for (const root of roots.splice(0)) {
      removeTempDir(root);
    }
  });

  it('generates a temporary bare React Native bundle with project-local, shell-free argv', async () => {
    const root = fixture();
    writeBareModules(root);
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = {};');

    const result = rememberGeneratedDirectory(await generateSightArtifacts({
      projectRoot: root,
      projectType: 'bare',
      platform: 'android',
    }));

    expect(result).toEqual({
      outputDirectory: expect.stringContaining(path.join(os.tmpdir(), 'bundle-drop-sight-')),
      bundlePath: path.join(result.outputDirectory, 'main.android.jsbundle'),
      sourceMapPath: path.join(result.outputDirectory, 'main.android.jsbundle.map'),
      temporary: true,
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringMatching(/node_modules\/react-native\/cli\.js$/),
        'bundle',
        '--platform',
        'android',
        '--dev',
        'false',
        '--entry-file',
        path.join(root, 'index.js'),
        '--bundle-output',
        result.bundlePath,
        '--sourcemap-output',
        result.sourceMapPath,
      ],
      expect.objectContaining({
        cwd: root,
        stdio: 'inherit',
        env: expect.objectContaining({ NODE_ENV: 'production' }),
      }),
    );
  });

  it.each(['index.ts', 'index.tsx', 'index.jsx'])(
    'falls back to the supported bare entry file %s',
    async entryName => {
      const root = fixture();
      writeBareModules(root);
      fs.writeFileSync(path.join(root, entryName), 'module.exports = {};');

      const result = rememberGeneratedDirectory(await generateSightArtifacts({
        projectRoot: root,
        projectType: 'bare',
        platform: 'ios',
      }));

      expect(mockSpawn.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--entry-file', path.join(root, entryName)]),
      );
      expect(result.bundlePath.endsWith('main.ios.jsbundle')).toBe(true);
    },
  );

  it('uses an explicit bare entry and an empty requested output directory', async () => {
    const root = fixture();
    writeBareModules(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/main.ts'), 'module.exports = {};');
    fs.mkdirSync(path.join(root, 'analysis-output'));

    const result = await generateSightArtifacts({
      projectRoot: root,
      projectType: 'bare',
      platform: 'ios',
      entryFile: 'src/main.ts',
      output: 'analysis-output',
    });

    expect(result.outputDirectory).toBe(path.join(root, 'analysis-output'));
    expect(result.temporary).toBe(false);
    expect(mockSpawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--entry-file', path.join(root, 'src/main.ts')]),
    );
  });

  it('keeps generated files under the project when requested', async () => {
    const root = fixture();
    writeBareModules(root);
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = {};');

    const result = await generateSightArtifacts({
      projectRoot: root,
      projectType: 'bare',
      platform: 'ios',
      keep: true,
    });

    expect(result.temporary).toBe(false);
    expect(result.outputDirectory).toMatch(
      new RegExp(`${path.join(root, '.bundle-drop', 'sight').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path.sep}`),
    );
    expect(fs.existsSync(result.bundlePath)).toBe(true);
  });

  it('generates Expo JavaScript through the project-local CLI without Hermes bytecode', async () => {
    const root = fixture();
    writeExpoModules(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/expo-entry.js'), 'module.exports = {};');

    const result = rememberGeneratedDirectory(await generateSightArtifacts({
      projectRoot: root,
      projectType: 'expo',
      platform: 'ios',
    }));
    const args = mockSpawn.mock.calls[0][1] as string[];

    expect(args).toEqual([
      expect.stringMatching(/node_modules\/expo\/node_modules\/@expo\/cli\/index\.js$/),
      'export:embed',
      '--platform',
      'ios',
      '--entry-file',
      path.join(root, 'src/expo-entry.js'),
      '--bundle-output',
      result.bundlePath,
      '--sourcemap-output',
      result.sourceMapPath,
      '--assets-dest',
      path.join(result.outputDirectory, 'assets'),
      '--dev',
      'false',
      '--minify',
      'true',
    ]);
    expect(args).not.toContain('--bytecode');
  });

  it('uses an explicit Expo entry without resolving @expo/config/paths', async () => {
    const root = fixture();
    const expoRoot = writeModule(root, 'expo', { 'index.js': 'module.exports = {};' });
    writeModule(expoRoot, '@expo/cli', {
      'index.js': 'module.exports = {};',
    });
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app/index.js'), 'module.exports = {};');

    const result = rememberGeneratedDirectory(await generateSightArtifacts({
      projectRoot: root,
      projectType: 'expo',
      platform: 'android',
      entryFile: 'app/index.js',
    }));

    expect(mockSpawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--entry-file', path.join(root, 'app/index.js')]),
    );
    expect(result.bundlePath.endsWith('main.android.jsbundle')).toBe(true);
  });

  it.each([
    ['a regular file', (root: string) => fs.writeFileSync(path.join(root, 'output'), 'file')],
    ['a non-empty directory', (root: string) => {
      fs.mkdirSync(path.join(root, 'output'));
      fs.writeFileSync(path.join(root, 'output/stale'), 'stale');
    }],
    ['a symbolic link', (root: string) => {
      fs.mkdirSync(path.join(root, 'target'));
      fs.symlinkSync(path.join(root, 'target'), path.join(root, 'output'));
    }],
  ])('rejects a requested output that is %s', async (_label, prepare) => {
    const root = fixture();
    writeBareModules(root);
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = {};');
    prepare(root);

    await expect(generateSightArtifacts({
      projectRoot: root,
      projectType: 'bare',
      platform: 'ios',
      output: 'output',
    })).rejects.toThrow(/Sight output/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('reports missing project modules, package manifests, and entry files', async () => {
    const missingModuleRoot = fixture();
    await expect(generateSightArtifacts({
      projectRoot: missingModuleRoot,
      projectType: 'bare',
      platform: 'ios',
    })).rejects.toThrow('Could not resolve react-native/cli.js');

    const missingEntryRoot = fixture();
    writeBareModules(missingEntryRoot);
    await expect(generateSightArtifacts({
      projectRoot: missingEntryRoot,
      projectType: 'bare',
      platform: 'ios',
    })).rejects.toThrow('Pass it explicitly with --entry-file');

    const missingManifestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-no-manifest-'));
    roots.push(missingManifestRoot);
    await expect(generateSightArtifacts({
      projectRoot: missingManifestRoot,
      projectType: 'bare',
      platform: 'ios',
    })).rejects.toThrow('No package.json was found');
  });

  it('reports missing and incompatible Expo project modules', async () => {
    const noExpoRoot = fixture();
    await expect(generateSightArtifacts({
      projectRoot: noExpoRoot,
      projectType: 'expo',
      platform: 'ios',
    })).rejects.toThrow('Could not resolve expo/package.json');

    const noCliRoot = fixture();
    writeModule(noCliRoot, 'expo', { 'index.js': 'module.exports = {};' });
    await expect(generateSightArtifacts({
      projectRoot: noCliRoot,
      projectType: 'expo',
      platform: 'ios',
    })).rejects.toThrow('could not resolve @expo/cli');

    for (const resolverSource of [
      'module.exports = {};',
      'exports.resolveEntryPoint = () => null;',
    ]) {
      const root = fixture();
      writeExpoModules(root, resolverSource);
      await expect(generateSightArtifacts({
        projectRoot: root,
        projectType: 'expo',
        platform: 'android',
      })).rejects.toThrow('Expo could not resolve the android entrypoint');
    }
  });

  it.each([
    [{ type: 'error', error: new Error('spawn failed') } as SpawnMode, 'spawn failed'],
    [{ type: 'exit', code: 2 } as SpawnMode, 'exit code 2'],
    [{ type: 'exit', code: null, signal: 'SIGTERM' } as SpawnMode, 'signal SIGTERM'],
  ])('contains Metro command failures and removes temporary output: %s', async (mode, message) => {
    const root = fixture();
    writeBareModules(root);
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = {};');
    installSpawn(mode);
    const before = new Set(
      fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('bundle-drop-sight-')),
    );

    await expect(generateSightArtifacts({
      projectRoot: root,
      projectType: 'bare',
      platform: 'ios',
    })).rejects.toThrow(message);

    const after = fs.readdirSync(os.tmpdir()).filter(
      name => name.startsWith('bundle-drop-sight-') && !before.has(name),
    );
    expect(after).toEqual([]);
  });

  it('retains a user-owned output directory when Metro fails', async () => {
    const root = fixture();
    writeBareModules(root);
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = {};');
    installSpawn({ type: 'exit', code: 1 });

    await expect(generateSightArtifacts({
      projectRoot: root,
      projectType: 'bare',
      platform: 'ios',
      output: 'analysis-output',
    })).rejects.toThrow('exit code 1');
    expect(fs.existsSync(path.join(root, 'analysis-output'))).toBe(true);
  });

  describe('validateSightArtifacts', () => {
    const artifactFixture = () => {
      const root = fixture();
      const bundlePath = path.join(root, 'main.ios.jsbundle');
      const sourceMapPath = `${bundlePath}.map`;
      fs.writeFileSync(bundlePath, 'console.log("Sight");');
      fs.writeFileSync(sourceMapPath, JSON.stringify(sourceMap({
        file: path.basename(bundlePath),
      })));
      return { root, bundlePath, sourceMapPath };
    };

    it('accepts matching file references and debug ID field aliases', () => {
      const { bundlePath, sourceMapPath } = artifactFixture();
      fs.writeFileSync(
        bundlePath,
        `console.log("Sight");\n//# debugId=debug-1\n//# sourceMappingURL=${path.basename(sourceMapPath)}\n`,
      );
      fs.writeFileSync(
        sourceMapPath,
        JSON.stringify(sourceMap({
          file: path.basename(bundlePath),
          debug_id: 'debug-1',
        })),
      );

      expect(() => validateSightArtifacts(bundlePath, sourceMapPath)).not.toThrow();
    });

    it.each([
      ['missing bundle', (bundlePath: string) => fs.unlinkSync(bundlePath)],
      ['bundle directory', (bundlePath: string) => {
        fs.unlinkSync(bundlePath);
        fs.mkdirSync(bundlePath);
      }],
      ['bundle symlink', (bundlePath: string, sourceMapPath: string) => {
        fs.unlinkSync(bundlePath);
        fs.symlinkSync(sourceMapPath, bundlePath);
      }],
      ['missing source map', (_bundlePath: string, sourceMapPath: string) => fs.unlinkSync(sourceMapPath)],
    ])('rejects an unsafe or absent artifact: %s', (_label, mutate) => {
      const { bundlePath, sourceMapPath } = artifactFixture();
      mutate(bundlePath, sourceMapPath);
      expect(() => validateSightArtifacts(bundlePath, sourceMapPath)).toThrow(
        'Sight generation did not create',
      );
    });

    it('rejects empty and Hermes bytecode bundles', () => {
      const empty = artifactFixture();
      fs.writeFileSync(empty.bundlePath, '');
      expect(() => validateSightArtifacts(empty.bundlePath, empty.sourceMapPath)).toThrow(
        'empty JavaScript bundle',
      );

      const hermes = artifactFixture();
      fs.writeFileSync(
        hermes.bundlePath,
        Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f, 0x00]),
      );
      expect(() => validateSightArtifacts(hermes.bundlePath, hermes.sourceMapPath)).toThrow(
        'Hermes bytecode',
      );
    });

    it.each([
      ['invalid JSON', '{'],
      ['wrong version', JSON.stringify(sourceMap({ version: 2 }))],
      ['missing sources', JSON.stringify({ version: 3, mappings: '' })],
      ['non-string mappings', JSON.stringify(sourceMap({ mappings: [] }))],
    ])('rejects a malformed source map: %s', (_label, contents) => {
      const { bundlePath, sourceMapPath } = artifactFixture();
      fs.writeFileSync(sourceMapPath, contents);
      expect(() => validateSightArtifacts(bundlePath, sourceMapPath)).toThrow(
        _label === 'invalid JSON' ? 'invalid source-map JSON' : 'source-map version 3',
      );
    });

    it('rejects mismatched source-map references and debug IDs', () => {
      const bundleReference = artifactFixture();
      fs.writeFileSync(
        bundleReference.bundlePath,
        'console.log("Sight");\n//# sourceMappingURL=other.map\n',
      );
      expect(() => validateSightArtifacts(
        bundleReference.bundlePath,
        bundleReference.sourceMapPath,
      )).toThrow('bundle references a different source-map');

      const mapReference = artifactFixture();
      fs.writeFileSync(
        mapReference.sourceMapPath,
        JSON.stringify(sourceMap({ file: 'other.jsbundle' })),
      );
      expect(() => validateSightArtifacts(
        mapReference.bundlePath,
        mapReference.sourceMapPath,
      )).toThrow('source map references a different bundle');

      const debugId = artifactFixture();
      fs.writeFileSync(debugId.bundlePath, '//# debugId=bundle-debug\n');
      fs.writeFileSync(
        debugId.sourceMapPath,
        JSON.stringify(sourceMap({ debugId: 'map-debug' })),
      );
      expect(() => validateSightArtifacts(debugId.bundlePath, debugId.sourceMapPath)).toThrow(
        'different debug IDs',
      );
    });
  });
});
