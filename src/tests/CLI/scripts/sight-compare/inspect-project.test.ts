import fs from 'fs';
import os from 'os';
import path from 'path';
import { inspectInstalledProject, inspectSightProject, inspectSourceMapContext, prepareProjectEnvironment } from '../../../../CLI/scripts/sight-compare/inspect-project';
import { detectProjectType } from '../../../../expo';
import { runComparisonProcess } from '../../../../CLI/scripts/sight-compare/process';

jest.mock('../../../../expo', () => ({ detectProjectType: jest.fn() }));
jest.mock('../../../../CLI/scripts/sight-compare/process', () => ({ runComparisonProcess: jest.fn() }));
const detect = jest.mocked(detectProjectType);
const run = jest.mocked(runComparisonProcess);

describe('snapshot project inspection', () => {
  let root: string;
  const write = (file: string, value: unknown = {}) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const options = () => ({ snapshotRoot: root, projectRoot: root, platform: 'ios' as const });
  const inspect = (overrides = {}) => inspectInstalledProject({ ...options(), ...overrides });
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sight-inspect-')));
    write('package.json', { name: 'app' });
    write('node_modules/react-native/package.json', { name: 'react-native', version: '0.79.0' });
    write('index.js', 'module.exports = {};');
    detect.mockReturnValue('bare');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('detects a bare app in its snapshot and records its logical entry and local framework versions', () => {
    write('node_modules/metro/package.json', { version: '0.82.0' });
    const result = inspect();
    expect(result).toEqual({ projectType: 'bare', entry: { kind: 'relative', value: 'index.js' }, resolvedEntryFile: path.join(root, 'index.js'), versions: { reactNative: '0.79.0', metro: '0.82.0' } });
    expect(detect).toHaveBeenCalledWith({ projectRoot: root, explicitType: undefined });
  });
  it('finds a Metro dependency nested under React Native', () => {
    write('node_modules/react-native/node_modules/metro/package.json', { version: '0.81.0' });
    expect(inspect().versions.metro).toBe('0.81.0');
  });
  it.each(['index.ts', 'index.tsx', 'index.jsx'])('finds a bare %s entry', entry => {
    fs.unlinkSync(path.join(root, 'index.js'));
    write(entry, '// entry');
    expect(inspect().entry.value).toBe(entry);
  });
  it('ignores entry-name directories and reports a missing entry', () => {
    fs.unlinkSync(path.join(root, 'index.js'));
    fs.mkdirSync(path.join(root, 'index.js'));
    expect(() => inspect()).toThrow('Could not find');
  });
  it('uses a relative override independently in each snapshot', () => {
    write('src/main.ts', '// entry');
    expect(inspect({ entryFile: 'src/main.ts' }).entry).toEqual({ kind: 'relative', value: 'src/main.ts' });
    expect(inspect({ logicalEntry: { kind: 'relative', value: 'src/main.ts' } }).resolvedEntryFile).toBe(path.join(root, 'src/main.ts'));
  });
  it.each([undefined, 'index.js'])('resolves each snapshot’s own entry symlink with override %s', entryFile => {
    for (const side of ['baseline', 'current']) {
      write(`${side}/package.json`, { name: 'app' });
      write(`${side}/node_modules/react-native/package.json`, { name: 'react-native', version: '0.83.1' });
      write(`${side}/old.js`, '// old entry');
      write(`${side}/new.js`, '// new entry');
      fs.symlinkSync(side === 'baseline' ? 'old.js' : 'new.js', path.join(root, side, 'index.js'));
    }
    const currentRoot = path.join(root, 'current');
    const baselineRoot = path.join(root, 'baseline');
    const current = inspectInstalledProject({ ...options(), snapshotRoot: currentRoot, projectRoot: currentRoot, entryFile });
    const baseline = inspectInstalledProject({ ...options(), snapshotRoot: baselineRoot, projectRoot: baselineRoot, logicalEntry: current.entry });
    expect(current.entry).toEqual({ kind: 'relative', value: 'index.js' });
    expect(current.resolvedEntryFile).toBe(path.join(currentRoot, 'new.js'));
    expect(baseline.resolvedEntryFile).toBe(path.join(baselineRoot, 'old.js'));
  });
  it('rejects an absolute override and an entry directory', () => {
    expect(() => inspect({ entryFile: path.join(root, 'index.js') })).toThrow('must be relative');
    expect(() => inspect({ entryFile: 'node_modules' })).toThrow('must be a file');
  });
  it('rejects absent baseline entries and symlinks escaping the snapshot', () => {
    expect(() => inspect({ logicalEntry: { kind: 'relative', value: 'missing.js' } })).toThrow();
    fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
    expect(() => inspect({ entryFile: 'outside' })).toThrow('outside the repository snapshot');
  });
  it('rejects an app directory outside its snapshot', () => {
    expect(() => inspect({ projectRoot: path.dirname(root) })).toThrow('outside the repository snapshot');
  });

  const expo = (resolver = 'root => require("path").join(root, "index.js")') => {
    detect.mockReturnValue('expo');
    write('node_modules/expo/package.json', { name: 'expo', version: '55.0.0' });
    write('node_modules/expo/node_modules/@expo/config/package.json', { name: '@expo/config', version: '55.0.0' });
    write('node_modules/expo/node_modules/@expo/config/paths.js', `exports.resolveEntryPoint = ${resolver};`);
  };
  it('resolves Expo entrypoints through that revision’s own Expo configuration', () => {
    expo();
    write('node_modules/expo/node_modules/metro/package.json', { version: '0.83.0' });
    expect(inspect()).toMatchObject({ projectType: 'expo', entry: { kind: 'relative', value: 'index.js' }, versions: { expo: '55.0.0', metro: '0.83.0' } });
  });
  it('preserves expo-router/entry as a module specifier', () => {
    expo('root => require("path").join(root, "node_modules/expo-router/entry.js")');
    write('package.json', { main: 'expo-router/entry' });
    write('node_modules/expo-router/package.json', { name: 'expo-router', version: '5.0.0' });
    write('node_modules/expo-router/entry.js', '// router');
    expect(inspect().entry).toEqual({ kind: 'module', value: 'expo-router/entry' });
    expect(inspect({ logicalEntry: { kind: 'module', value: 'expo-router/entry' } }).resolvedEntryFile).toBe(path.join(root, 'node_modules/expo-router/entry.js'));
  });
  it('normalizes physical pnpm node_modules paths to a logical module', () => {
    expo('root => require("path").join(root, "node_modules/.pnpm/expo-router@5.0.0/node_modules/expo-router/entry.js")');
    write('node_modules/.pnpm/expo-router@5.0.0/node_modules/expo-router/entry.js', '// router');
    expect(inspect().entry).toEqual({ kind: 'module', value: 'expo-router/entry' });
  });
  it.each(['./index.js', 'index.js', '/another/entry.js', 'different-package'])('handles Expo main=%s without guessing a different entry', main => {
    expo();
    write('package.json', { main });
    expect(inspect().entry).toEqual({ kind: 'relative', value: 'index.js' });
  });
  it('keeps the entry resolved by Expo when package main points to a different module', () => {
    expo();
    write('package.json', { main: 'other' });
    write('node_modules/other/package.json', { main: 'entry.js' });
    write('node_modules/other/entry.js', '// other');
    expect(inspect().entry.kind).toBe('relative');
  });
  it('reports Expo failing to resolve an entrypoint', () => {
    expo('() => null');
    expect(() => inspect()).toThrow('Expo could not resolve the ios entrypoint');
  });

  it('runs all dynamic inspection in a child Node process using the installed helper', async () => {
    const metadata = inspect();
    detect.mockClear();
    run.mockResolvedValue({ stdout: `app config output\nBUNDLE_DROP_SIGHT_PROJECT=${JSON.stringify(metadata)}\n`, stderr: '', exitCode: 0 });
    await expect(inspectSightProject(options())).resolves.toEqual(metadata);
    expect(detect).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: process.execPath, args: ['-e', expect.stringContaining('inspectInstalledProject'), expect.stringContaining('inspect-project'), JSON.stringify(options())], cwd: root, env: expect.objectContaining({ NODE_ENV: 'production', PATH: process.env.PATH }) }));
  });
  it('uses the last marked result and forwards cancellation/environment options', async () => {
    const controller = new AbortController();
    const metadata = inspect();
    run.mockResolvedValue({ stdout: `BUNDLE_DROP_SIGHT_PROJECT={}\nBUNDLE_DROP_SIGHT_PROJECT=${JSON.stringify(metadata)}\n`, stderr: '', exitCode: 0 });
    await expect(inspectSightProject(options(), { signal: controller.signal, env: { PATH: '/chosen/bin' }, logPath: '/tmp/inspect.log' })).resolves.toEqual(metadata);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, env: { PATH: '/chosen/bin', NODE_ENV: 'production' }, logPath: '/tmp/inspect.log' }));
  });
  it('reports incomplete child inspection metadata', async () => {
    run.mockResolvedValue({ stdout: 'only project logs\n', stderr: '', exitCode: 0 });
    await expect(inspectSightProject(options())).rejects.toThrow('did not return comparison metadata');
  });

  it('uses repository-relative filesystem sources for bare Metro output', async () => {
    await expect(inspectSourceMapContext(options(), 'bare')).resolves.toEqual({ sourceMapBase: root, sourcePathConvention: 'filesystem' });
  });

  const expoLoader = (configExpression: string) => {
    expo();
    write('node_modules/expo/node_modules/@expo/config/index.js', 'exports.getConfig = () => ({exp: {name: "fixture-app"}});');
    write('node_modules/expo/node_modules/@expo/cli/package.json', { name: '@expo/cli' });
    write('node_modules/expo/node_modules/@expo/cli/build/src/start/server/metro/instantiateMetro.js', `exports.loadMetroConfigAsync = async (root, options, context) => {
      if (!context.isExporting || context.exp.name !== 'fixture-app' || Object.keys(options).length) throw new Error('Wrong export configuration context');
      return {config: ${configExpression}};
    };`);
  };
  it('uses the authoritative Expo export loader and custom server root', async () => {
    write('custom-server/.keep', '');
    expoLoader('{projectRoot: root, server: {unstable_serverRoot: require("path").join(root, "custom-server")}}');
    await expect(inspectSourceMapContext(options(), 'expo')).resolves.toEqual({ sourceMapBase: path.join(root, 'custom-server'), sourcePathConvention: 'expo-server-root' });
  });
  it.each(['{projectRoot: root}', '{projectRoot: root, server: {}}'])('falls back to the actual merged Metro projectRoot: %s', async config => {
    expoLoader(config);
    await expect(inspectSourceMapContext(options(), 'expo')).resolves.toEqual({ sourceMapBase: root, sourcePathConvention: 'expo-server-root' });
  });
  it('rejects an Expo server root outside the captured repository', async () => {
    expoLoader('{projectRoot: root, server: {unstable_serverRoot: require("path").dirname(root)}}');
    await expect(inspectSourceMapContext(options(), 'expo')).rejects.toThrow('outside the repository snapshot');
  });
  it('fails closed when the installed Expo CLI has no configuration loader', async () => {
    expo();
    await expect(inspectSourceMapContext(options(), 'expo')).rejects.toThrow('does not expose its Metro configuration loader');
  });
  it('fails closed for an incompatible Expo configuration-loader API', async () => {
    expoLoader('{projectRoot: root}');
    write('node_modules/expo/node_modules/@expo/cli/build/src/start/server/metro/instantiateMetro.js', 'module.exports = {};');
    await expect(inspectSourceMapContext(options(), 'expo')).rejects.toThrow('does not expose loadMetroConfigAsync');
  });

  it('skips Expo environment/config evaluation for an explicitly bare app', () => {
    expo();
    detect.mockClear();
    prepareProjectEnvironment({ ...options(), explicitType: 'bare' });
    expect(detect).not.toHaveBeenCalled();
  });
  it('does not require Expo environment support for apps without Expo', () => {
    detect.mockClear();
    prepareProjectEnvironment(options());
    expect(detect).not.toHaveBeenCalled();
  });
  it('permits a detected bare app with Expo modules but no export environment loader', () => {
    expo();
    detect.mockReturnValue('bare');
    expect(() => prepareProjectEnvironment(options())).not.toThrow();
  });
  it.each(['missing', 'incompatible'])('fails closed for %s Expo environment-loading support', support => {
    expo();
    if (support === 'incompatible') {
      write('node_modules/expo/node_modules/@expo/cli/package.json', { name: '@expo/cli' });
      write('node_modules/expo/node_modules/@expo/cli/build/src/utils/nodeEnv.js', 'module.exports = {};');
    }
    expect(() => prepareProjectEnvironment({ ...options(), explicitType: 'expo' })).toThrow('does not expose its environment loader');
  });
  it('loads the captured project environment before dynamic project inspection and leaves opt-out policy to Expo', () => {
    expo();
    write('node_modules/expo/node_modules/@expo/cli/package.json', { name: '@expo/cli' });
    write('node_modules/expo/node_modules/@expo/cli/build/src/utils/nodeEnv.js', `exports.loadEnvFiles = root => {
      const fs = require('fs'); const path = require('path');
      fs.writeFileSync(path.join(root, '.env-loader-called'), JSON.stringify({root, disabled: process.env.EXPO_NO_DOTENV}));
    };`);
    const previous = process.env.EXPO_NO_DOTENV;
    process.env.EXPO_NO_DOTENV = '1';
    try {
      prepareProjectEnvironment(options());
      expect(JSON.parse(fs.readFileSync(path.join(root, '.env-loader-called'), 'utf8'))).toEqual({ root, disabled: '1' });
    } finally {
      if (previous === undefined) delete process.env.EXPO_NO_DOTENV;
      else process.env.EXPO_NO_DOTENV = previous;
    }
  });
});
