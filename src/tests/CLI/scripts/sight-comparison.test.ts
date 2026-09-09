import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

jest.mock('../../../CLI/scripts/sight-compare/snapshot');
jest.mock('../../../CLI/scripts/sight-compare/dependencies');
jest.mock('../../../CLI/scripts/sight-compare/inspect-project');
jest.mock('../../../CLI/scripts/sight-compare/process');
jest.mock('../../../CLI/scripts/sight-artifacts');
jest.mock('../../../CLI/scripts/sight-ota');
jest.mock('../../../CLI/scripts/sight-session');
jest.mock('prompts', () => jest.fn());

import prompts from 'prompts';
import { buildBundleDropLogo } from '../../../CLI/logo';
import { createComparisonSnapshots } from '../../../CLI/scripts/sight-compare/snapshot';
import { inspectDependencyPlan, installDependencies } from '../../../CLI/scripts/sight-compare/dependencies';
import { inspectSightProject } from '../../../CLI/scripts/sight-compare/inspect-project';
import { runComparisonProcess } from '../../../CLI/scripts/sight-compare/process';
import { generateSightArtifacts } from '../../../CLI/scripts/sight-artifacts';
import { measureSightOta } from '../../../CLI/scripts/sight-ota';
import { openSightInBrowser, startSightSession } from '../../../CLI/scripts/sight-session';
import { comparisonEnvironment, runSightComparison } from '../../../CLI/scripts/sight-compare/run';
import { writeComparisonMetadata } from '../../../CLI/scripts/sight-compare/metadata';
import type { ComparisonMetadata } from '../../../CLI/scripts/sight-compare/types';

describe('Sight comparison orchestration', () => {
  let root: string;
  let output: string;
  let snapshot: any;
  let tty: PropertyDescriptor | undefined;
  let session: any;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(measureSightOta).mockResolvedValue({ status: 'available', engine: 'hermes', bundleBytes: 100, zipBytes: 800 });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-orchestration-'));
    output = path.join(root, 'results');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    jest.spyOn(process, 'cwd').mockReturnValue(root);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    snapshot = {
      directory: path.join(root, 'snapshots'), currentRoot: root, baselineRoot: root,
      currentProjectRoot: root, baselineProjectRoot: root,
      currentCommit: 'c'.repeat(40), baselineCommit: 'b'.repeat(40),
      currentLabel: 'feature/current', baselineLabel: 'main', currentBranch: 'feature/current',
      currentDirty: true, snapshotHash: 'f'.repeat(64), baselineInputFingerprint: 'b'.repeat(40),
      includedPaths: ['.env.production'], cleanup: jest.fn().mockResolvedValue(undefined),
      assertIdentity: jest.fn().mockResolvedValue(undefined),
    };
    jest.mocked(createComparisonSnapshots).mockResolvedValue(snapshot);
    jest.mocked(inspectDependencyPlan).mockResolvedValue({
      snapshotRoot: root, projectRoot: root, installRoot: root, inputFiles: [path.join(root, 'package.json')],
      packageManager: { name: 'npm', version: '10.9.2' }, installArgs: ['ci'],
    });
    jest.mocked(inspectSightProject).mockResolvedValue({
      sourceMapBase: root, sourcePathConvention: 'filesystem',
      projectType: 'bare', entry: { kind: 'relative', value: 'index.js' },
      resolvedEntryFile: path.join(root, 'index.js'), versions: { reactNative: '0.83.1' },
    });
    jest.mocked(generateSightArtifacts).mockImplementation(async options => {
      fs.mkdirSync(options.output!, { recursive: true });
      fs.mkdirSync(options.assetsDirectory!, { recursive: true });
      fs.writeFileSync(path.join(options.assetsDirectory!, 'icon.png'), 'asset');
      const bundlePath = path.join(options.output!, `main.${options.platform}.jsbundle`);
      const sourceMapPath = bundlePath + '.map';
      fs.writeFileSync(bundlePath, 'console.log(1)');
      fs.writeFileSync(sourceMapPath, '{"version":3,"sources":[],"mappings":""}');
      await options.runCommand!(options.projectRoot, 'metro-cli.js', ['bundle']);
      return { outputDirectory: options.output!, bundlePath, sourceMapPath, temporary: false };
    });
    session = { sightUrl: 'https://bundledrop.app/sight#test', waitForTransfer: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) };
    jest.mocked(startSightSession).mockResolvedValue(session);
    jest.mocked(prompts).mockResolvedValue({ openSight: true });
  });
  afterEach(() => {
    const calls = jest.mocked(generateSightArtifacts).mock.calls;
    for (const [options] of calls) {
      if (options.output && !options.output.startsWith(root)) fs.rmSync(path.dirname(options.output), { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete (process.stdin as any).isTTY;
    jest.restoreAllMocks();
  });

  it('retains original current HEAD and writes a verified sidecar for no-open comparison', async () => {
    await runSightComparison({ compare: 'main', platform: 'android', output, open: false });
    expect(jest.mocked(console.log).mock.calls[0][0]).toBe(buildBundleDropLogo());
    expect(jest.mocked(console.log).mock.calls[1][0]).toContain('Bundle Drop Sight — Compare');
    const document = JSON.parse(fs.readFileSync(path.join(output, 'comparison.json'), 'utf8')) as ComparisonMetadata;
    expect(document.current.commit).toBe(snapshot.currentCommit);
    expect(document.baseline.commit).toBe(snapshot.baselineCommit);
    expect(document.current.dirty).toBe(true);
    expect(document.artifacts.currentBundle.sha256).toBe(createHash('sha256').update('console.log(1)').digest('hex'));
    expect(document.artifacts.currentBundle.path).toBe('current/main.android.jsbundle');
    expect(document.assetManifest?.path).toBe('comparison-assets.json');
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'comparison-assets.json'), 'utf8'));
    expect(manifest.baseline).toEqual([{ path: 'icon.png', bytes: 5, sha256: createHash('sha256').update('asset').digest('hex') }]);
    expect(manifest.current).toEqual(manifest.baseline);
    expect(manifest.ota.baseline).toEqual({ status: 'available', engine: 'hermes', bundleBytes: 100, zipBytes: 800 });
    expect(manifest.ota.current).toEqual(manifest.ota.baseline);
    expect(fs.existsSync(path.join(snapshot.directory, 'baseline-assets'))).toBe(false);
    expect(fs.existsSync(path.join(snapshot.directory, 'current-assets'))).toBe(false);
    expect(startSightSession).not.toHaveBeenCalled();
    expect(snapshot.cleanup).toHaveBeenCalledTimes(1);
    expect(runComparisonProcess).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ NODE_ENV: 'production' }) }));
    expect(inspectSightProject).toHaveBeenLastCalledWith(expect.objectContaining({ logicalEntry: { kind: 'relative', value: 'index.js' } }), expect.anything());
  });

  it('keeps the comparison when only one revision has an OTA identity', async () => {
    jest.mocked(measureSightOta).mockResolvedValueOnce({ status: 'unavailable', reason: 'Runtime version is unavailable.' });
    await runSightComparison({ compare: 'main', platform: 'ios', output, open: false });
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'comparison-assets.json'), 'utf8'));
    expect(manifest.ota.baseline.status).toBe('unavailable');
    expect(manifest.ota.current.status).toBe('available');
    expect(manifest.baseline).toHaveLength(1);
    expect(manifest.current).toHaveLength(1);
  });

  it('rejects dependency input mutations during OTA measurement', async () => {
    jest.mocked(measureSightOta).mockImplementationOnce(async () => {
      fs.writeFileSync(path.join(root, 'package.json'), '{"modified":true}');
      return { status: 'available', engine: 'javascript', bundleBytes: 100, zipBytes: 800 };
    });
    await expect(runSightComparison({ compare: 'main', platform: 'ios', output, open: false })).rejects.toThrow('OTA measurement modified');
    expect(snapshot.cleanup).toHaveBeenCalledTimes(1);
    expect(startSightSession).not.toHaveBeenCalled();
  });

  it('opens v2 and removes default output after transfer', async () => {
    await runSightComparison({ compare: 'main', platform: 'ios' });
    const call = jest.mocked(startSightSession).mock.calls[0][0];
    expect(call.comparison).toBeDefined();
    expect(fs.existsSync(call.comparison!.outputDirectory)).toBe(false);
    expect(session.close).toHaveBeenCalled();
  });

  it.each([{ keep: true }, { output: true }])('retains complete artifacts when requested: %j', async retained => {
    await runSightComparison({ compare: 'main', platform: 'ios', ...(retained.keep ? { keep: true } : { output }) });
    const call = jest.mocked(startSightSession).mock.calls[0][0];
    expect(fs.existsSync(call.comparison!.metadataPath)).toBe(true);
  });

  it('keeps the sidecar on transfer failure and closes the session', async () => {
    session.waitForTransfer.mockRejectedValue(new Error('transfer failed'));
    await expect(runSightComparison({ compare: 'main', platform: 'ios', output })).rejects.toThrow('transfer failed');
    expect(fs.existsSync(path.join(output, 'comparison.json'))).toBe(true);
    expect(fs.existsSync(path.join(output, 'comparison-assets.json'))).toBe(true);
    expect(session.close).toHaveBeenCalled();
    expect(snapshot.cleanup).toHaveBeenCalled();
  });

  it('retains completed artifacts if session creation fails', async () => {
    jest.mocked(startSightSession).mockRejectedValue(new Error('session failed'));
    await expect(runSightComparison({ compare: 'main', platform: 'ios', output })).rejects.toThrow('session failed');
    expect(fs.existsSync(path.join(output, 'comparison.json'))).toBe(true);
  });

  it('prints a one-time URL if browser opening fails', async () => {
    jest.mocked(openSightInBrowser).mockRejectedValue(new Error('no browser'));
    await runSightComparison({ compare: 'main', platform: 'ios', output });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(session.sightUrl));
  });

  it('retains clean current metadata and annotates toolchain differences', async () => {
    snapshot.currentDirty = false;
    jest.mocked(inspectSightProject).mockResolvedValueOnce({
      sourceMapBase: root, sourcePathConvention: 'filesystem',
      projectType: 'bare', entry: { kind: 'relative', value: 'index.js' },
      resolvedEntryFile: 'index.js', versions: { reactNative: '0.84.0' },
    });
    await runSightComparison({ compare: 'main', platform: 'ios', output, open: false });
    const document = JSON.parse(fs.readFileSync(path.join(output, 'comparison.json'), 'utf8'));
    expect(document.current.dirty).toBe(false);
    expect(document.warnings).toContain('Framework or bundler versions differ between builds.');
  });

  it('cleans up on build failure without publishing incomplete metadata', async () => {
    jest.mocked(generateSightArtifacts).mockRejectedValue(new Error('build failed'));
    await expect(runSightComparison({ compare: 'main', platform: 'ios' })).rejects.toThrow('build failed');
    expect(snapshot.cleanup).toHaveBeenCalled();
  });

  it('reports cleanup failure without masking a build failure', async () => {
    jest.mocked(installDependencies).mockRejectedValue(new Error('install failed'));
    snapshot.cleanup.mockRejectedValue(new Error('locked file'));
    await expect(runSightComparison({ compare: 'main', platform: 'ios' })).rejects.toThrow('install failed');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Could not remove comparison worktrees'));
  });

  it('cancels installation and restores signal handlers before cleanup', async () => {
    const before = process.listenerCount('SIGTERM');
    jest.mocked(installDependencies).mockImplementation(async (_plan, options) => {
      process.emit('SIGTERM');
      options?.signal?.throwIfAborted();
    });
    await expect(runSightComparison({ compare: 'main', platform: 'ios' })).rejects.toThrow('cancelled');
    expect(snapshot.cleanup).toHaveBeenCalled();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('does not report success when cleanup of a completed comparison fails', async () => {
    snapshot.cleanup.mockRejectedValue(new Error('locked worktree'));
    await expect(runSightComparison({ compare: 'main', platform: 'ios', output, open: false })).rejects.toThrow('Could not remove comparison worktrees');
    expect(fs.existsSync(path.join(output, 'comparison.json'))).toBe(true);
  });

  it('preserves cancellation while the browser confirmation is open', async () => {
    jest.mocked(prompts).mockImplementation(async () => {
      process.emit('SIGINT');
      return {};
    });
    await expect(runSightComparison({ compare: 'main', platform: 'ios', output })).rejects.toThrow('cancelled');
    expect(startSightSession).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(output, 'comparison.json'))).toBe(true);
  });

  it('fingerprints bundler configuration and rejects build-time input mutation', async () => {
    fs.writeFileSync(path.join(root, 'metro.config.js'), 'module.exports = {};');
    fs.mkdirSync(path.join(root, 'app.config.js'));
    jest.mocked(generateSightArtifacts).mockImplementation(async () => {
      fs.writeFileSync(path.join(root, 'metro.config.js'), 'module.exports = {changed:true};');
      return { outputDirectory: output, bundlePath: 'bundle', sourceMapPath: 'map', temporary: false };
    });
    await expect(runSightComparison({ compare: 'main', platform: 'ios', output })).rejects.toThrow('modified its dependency or build configuration');
    expect(fs.existsSync(path.join(output, 'comparison.json'))).toBe(false);
  });

  it('reports revision-specific configuration changes in metadata', async () => {
    const baselineRoot = path.join(root, 'baseline-project');
    fs.mkdirSync(baselineRoot);
    fs.writeFileSync(path.join(baselineRoot, 'package.json'), '{"name":"old"}');
    jest.mocked(inspectDependencyPlan).mockResolvedValueOnce({
      snapshotRoot: baselineRoot, projectRoot: baselineRoot, installRoot: baselineRoot,
      packageManager: { name: 'npm', version: '10.9.2' }, installArgs: ['ci'],
      inputFiles: [path.join(baselineRoot, 'package.json')],
    });
    await runSightComparison({ compare: 'main', platform: 'ios', output, open: false });
    const metadata = JSON.parse(fs.readFileSync(path.join(output, 'comparison.json'), 'utf8'));
    expect(metadata.warnings).toContain('Dependency or build configuration inputs differ between builds.');
  });

  it('rejects different project types before building', async () => {
    jest.mocked(inspectSightProject).mockResolvedValueOnce({
      sourceMapBase: root, sourcePathConvention: 'filesystem',
      projectType: 'expo', entry: { kind: 'module', value: 'expo-router/entry' },
      resolvedEntryFile: 'index.js', versions: { reactNative: '0.83.1' },
    });
    await expect(runSightComparison({ compare: 'main', platform: 'ios' })).rejects.toThrow('different project types');
    expect(generateSightArtifacts).not.toHaveBeenCalled();
  });

  it.each(['', ' '])('rejects empty refs before starting', async compare => {
    await expect(runSightComparison({ compare, platform: 'ios' })).rejects.toThrow('requires a Git ref');
    expect(createComparisonSnapshots).not.toHaveBeenCalled();
  });

  it('infers a single native platform', async () => {
    fs.mkdirSync(path.join(root, 'android'));
    await runSightComparison({ compare: 'main', output, open: false });
    expect(generateSightArtifacts).toHaveBeenCalledWith(expect.objectContaining({ platform: 'android' }));
  });

  it('prompts for platform and handles declining browser opening', async () => {
    jest.mocked(prompts).mockResolvedValueOnce({ platform: 'ios' }).mockResolvedValueOnce({ openSight: false });
    await runSightComparison({ compare: 'main', output });
    expect(startSightSession).not.toHaveBeenCalled();
  });

  it('requires platform in an ambiguous noninteractive project', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    await expect(runSightComparison({ compare: 'main' })).rejects.toThrow('--platform');
  });

  it('rejects cancelled platform selection', async () => {
    jest.mocked(prompts).mockResolvedValue({});
    await expect(runSightComparison({ compare: 'main' })).rejects.toThrow('No platform');
  });

  it('does not overwrite nonempty output', async () => {
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'existing'), 'keep');
    await expect(runSightComparison({ compare: 'main', platform: 'ios', output })).rejects.toThrow('empty real directory');
    expect(fs.readFileSync(path.join(output, 'existing'), 'utf8')).toBe('keep');
  });

  it('allows an existing empty output directory', async () => {
    fs.mkdirSync(output);
    await runSightComparison({ compare: 'main', platform: 'ios', output, open: false });
    expect(fs.existsSync(path.join(output, 'comparison.json'))).toBe(true);
  });

  it('removes checkout-sensitive environment without altering the caller environment', () => {
    const env = { GIT_DIR: '/original/.git', NODE_PATH: '/original/node_modules', PWD: '/original', API_KEY: 'retained' };
    expect(comparisonEnvironment(env)).toEqual({ API_KEY: 'retained' });
    expect(env.GIT_DIR).toBe('/original/.git');
  });

  it('limits metadata before writing a sidecar', async () => {
    await runSightComparison({ compare: 'main', platform: 'ios', output, open: false });
    const metadataPath = path.join(output, 'comparison.json');
    const original = fs.readFileSync(metadataPath, 'utf8');
    const document = JSON.parse(original);
    document.warnings = ['x'.repeat(65 * 1024)];
    const pair = (side: string) => ({ outputDirectory: path.join(output, side), bundlePath: path.join(output, side, 'main.ios.jsbundle'), sourceMapPath: path.join(output, side, 'main.ios.jsbundle.map'), temporary: false });
    expect(() => writeComparisonMetadata({ outputDirectory: output, metadataPath, baseline: pair('baseline'), current: pair('current') }, document)).toThrow('64 KiB');
    expect(fs.readFileSync(metadataPath, 'utf8')).toBe(original);
  });
});
