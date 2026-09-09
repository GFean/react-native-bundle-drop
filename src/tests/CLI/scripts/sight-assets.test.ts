import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as assetCollector from '../../../CLI/scripts/sight-compare/assets';

jest.mock('../../../CLI/scripts/sight-artifacts');
jest.mock('../../../CLI/scripts/sight-ota');
import { generateSightArtifacts } from '../../../CLI/scripts/sight-artifacts';
import { measureSightOta } from '../../../CLI/scripts/sight-ota';
import { generateSightAnalysisArtifacts } from '../../../CLI/scripts/sight-assets';

describe('single Sight analysis asset generation', () => {
  let root: string;
  let assetsDirectory: string;
  let temporary: boolean;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-single-assets-test-'));
    temporary = true;
    jest.mocked(measureSightOta).mockResolvedValue({ status: 'available', engine: 'hermes', bundleBytes: 20, zipBytes: 800 });
    jest.mocked(generateSightArtifacts).mockImplementation(async options => {
      assetsDirectory = options.assetsDirectory!;
      const outputDirectory = path.join(root, 'output');
      fs.mkdirSync(outputDirectory);
      const bundlePath = path.join(outputDirectory, 'main.android.jsbundle');
      const sourceMapPath = bundlePath + '.map';
      fs.writeFileSync(bundlePath, 'console.log(1)');
      fs.writeFileSync(sourceMapPath, '{"version":3,"sources":[],"mappings":""}');
      fs.mkdirSync(path.join(assetsDirectory, 'drawable-mdpi'));
      fs.writeFileSync(path.join(assetsDirectory, 'drawable-mdpi/icon.png'), 'image');
      return { outputDirectory, bundlePath, sourceMapPath, temporary };
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(assetsDirectory, { recursive: true, force: true });
  });
  const generate = () => generateSightAnalysisArtifacts({ projectRoot: root, projectType: 'bare', platform: 'android' });

  it('binds emitted asset sizes to exact JavaScript and source-map content, keeping no binaries', async () => {
    const result = await generate();
    expect(fs.existsSync(assetsDirectory)).toBe(false);
    expect(fs.readdirSync(result.outputDirectory).sort()).toEqual(['analysis-assets.json', 'main.android.jsbundle', 'main.android.jsbundle.map']);
    expect(JSON.parse(fs.readFileSync(result.assetManifestPath!, 'utf8'))).toEqual({
      version: 1, mode: 'analyze', metric: 'emitted-asset-bytes',
      artifacts: {
        bundle: { path: 'main.android.jsbundle', bytes: 14, sha256: createHash('sha256').update('console.log(1)').digest('hex') },
        sourceMap: { path: 'main.android.jsbundle.map', bytes: 40, sha256: createHash('sha256').update('{"version":3,"sources":[],"mappings":""}').digest('hex') },
      },
      assets: [{ path: 'drawable-mdpi/icon.png', bytes: 5, sha256: createHash('sha256').update('image').digest('hex') }],
      ota: { status: 'available', engine: 'hermes', bundleBytes: 20, zipBytes: 800 },
    });
  });

  it('retains JavaScript and assets when exact OTA measurement is unavailable', async () => {
    jest.mocked(measureSightOta).mockResolvedValue({ status: 'unavailable', reason: 'Runtime version is unavailable.' });
    const result = await generateSightAnalysisArtifacts({ projectRoot: root, projectType: 'bare', platform: 'android', env: { CUSTOM_BUILD: '1' } });
    const manifest = JSON.parse(fs.readFileSync(result.assetManifestPath!, 'utf8'));
    expect(manifest.ota).toEqual({ status: 'unavailable', reason: 'Runtime version is unavailable.' });
    expect(manifest.assets).toHaveLength(1);
    expect(generateSightArtifacts).toHaveBeenLastCalledWith(expect.objectContaining({ env: { CUSTOM_BUILD: '1', NODE_ENV: 'production', BUNDLE_DROP_OTA_BUILD: '1' } }));
  });

  it('cleans its emitted asset directory if generation fails before returning artifacts', async () => {
    jest.mocked(generateSightArtifacts).mockImplementation(async options => {
      assetsDirectory = options.assetsDirectory!;
      fs.writeFileSync(path.join(assetsDirectory, 'partial.png'), 'partial');
      throw new Error('Metro failed');
    });
    await expect(generate()).rejects.toThrow('Metro failed');
    expect(fs.existsSync(assetsDirectory)).toBe(false);
  });

  it('honors an explicitly supplied build runner', async () => {
    const implementation = jest.mocked(generateSightArtifacts).getMockImplementation()!;
    jest.mocked(generateSightArtifacts).mockImplementation(async options => {
      await options.runCommand!(root, 'custom-cli.js', ['bundle']);
      return implementation(options);
    });
    const runCommand = jest.fn().mockResolvedValue(undefined);
    await generateSightAnalysisArtifacts({ projectRoot: root, projectType: 'bare', platform: 'android', runCommand });
    expect(runCommand).toHaveBeenCalledWith(root, 'custom-cli.js', ['bundle']);
  });

  it('stops a real Metro child and descendant before removing single-analysis output on cancellation', async () => {
    const realGenerate = jest.requireActual<typeof import('../../../CLI/scripts/sight-artifacts')>('../../../CLI/scripts/sight-artifacts').generateSightArtifacts;
    jest.mocked(generateSightArtifacts).mockImplementation(async options => {
      assetsDirectory = options.assetsDirectory!;
      return realGenerate(options);
    });
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'index.js'), '');
    const rnRoot = path.join(root, 'node_modules/react-native');
    fs.mkdirSync(rnRoot, { recursive: true });
    fs.writeFileSync(path.join(rnRoot, 'package.json'), '{"name":"react-native"}');
    const ready = path.join(root, 'ready.json');
    fs.writeFileSync(path.join(rnRoot, 'cli.js'), `
      const fs = require('fs'), path = require('path'), cp = require('child_process');
      const assets = process.argv[process.argv.indexOf('--assets-dest') + 1];
      const bundle = process.argv[process.argv.indexOf('--bundle-output') + 1];
      fs.writeFileSync(path.join(assets, 'partial.png'), 'partial');
      const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ descendant: child.pid, output: path.dirname(bundle) }));
      setInterval(() => {}, 1000);
    `);
    const before = ['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    const pending = expect(generate()).rejects.toMatchObject({ name: 'AbortError' });
    try {
      for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(ready)).toBe(true);
    } finally {
      process.emit('SIGINT');
      await pending;
    }
    const details = JSON.parse(fs.readFileSync(ready, 'utf8'));
    expect(() => process.kill(details.descendant, 0)).toThrow();
    expect(fs.existsSync(details.output)).toBe(false);
    expect(fs.existsSync(assetsDirectory)).toBe(false);
    expect(['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(before);
  });

  it('aborts asset inventory with the invocation signal and removes listeners and temporary files', async () => {
    const before = ['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    jest.spyOn(assetCollector, 'collectComparisonAssets').mockImplementation(async (_directory, signal) => {
      process.emit('SIGTERM');
      signal.throwIfAborted();
      return [];
    });
    await expect(generate()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(assetsDirectory)).toBe(false);
    expect(fs.existsSync(path.join(root, 'output'))).toBe(false);
    expect(['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(before);
  });

  it.each([true, false])('cleans emitted copies on inventory failure with temporary=%s', async isTemporary => {
    temporary = isTemporary;
    jest.spyOn(assetCollector, 'collectComparisonAssets').mockRejectedValue(new Error('invalid emitted asset'));
    await expect(generate()).rejects.toThrow('invalid emitted asset');
    expect(fs.existsSync(assetsDirectory)).toBe(false);
    expect(fs.existsSync(path.join(root, 'output'))).toBe(!isTemporary);
    expect(fs.existsSync(path.join(root, 'output', 'analysis-assets.json'))).toBe(false);
  });

  it('bounds the complete manifest including its JavaScript descriptors before writing', async () => {
    jest.spyOn(assetCollector, 'collectComparisonAssets').mockResolvedValue([
      { path: 'x'.repeat(assetCollector.MAX_ASSET_MANIFEST_BYTES), bytes: 1, sha256: 'a'.repeat(64) },
    ]);
    await expect(generate()).rejects.toThrow('4 MiB');
    expect(fs.existsSync(assetsDirectory)).toBe(false);
    expect(fs.existsSync(path.join(root, 'output'))).toBe(false);
  });
});
