import fs from 'fs';
import os from 'os';
import path from 'path';

const mockPrompts = jest.fn();
const mockDetectProjectType = jest.fn();
const mockGenerateSightArtifacts = jest.fn();
const mockOpenSightInBrowser = jest.fn();
const mockStartSightSession = jest.fn();
const mockRunSightComparison = jest.fn();

jest.mock('../../../CLI/scripts/sight-compare/run', () => ({
  runSightComparison: (...args: unknown[]) => mockRunSightComparison(...args),
}));

jest.mock('prompts', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockPrompts(...args),
}));
jest.mock('../../../expo', () => ({
  detectProjectType: (...args: unknown[]) => mockDetectProjectType(...args),
}));
jest.mock('../../../CLI/scripts/sight-artifacts', () => ({
  generateSightArtifacts: (...args: unknown[]) => mockGenerateSightArtifacts(...args),
}));
jest.mock('../../../CLI/scripts/sight-ota', () => ({
  measureSightOta: async () => ({ status: 'available', engine: 'hermes', bundleBytes: 100, zipBytes: 800 }),
}));
jest.mock('../../../CLI/scripts/sight-session', () => ({
  openSightInBrowser: (...args: unknown[]) => mockOpenSightInBrowser(...args),
  startSightSession: (...args: unknown[]) => mockStartSightSession(...args),
}));

import { runSightCommand } from '../../../CLI/scripts/sight-cli';
import { buildBundleDropLogo } from '../../../CLI/logo';

describe('CLI/scripts/sight-cli', () => {
  let projectRoot: string;
  let outputDirectory: string;
  let cwdSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  const waitForTransfer = jest.fn();
  const close = jest.fn();

  it('routes comparison before inspecting or building the original project', async () => {
    const options = { compare: 'main', platform: 'ios' as const, include: ['.env'], fetch: false };
    await runSightCommand(options);
    expect(mockRunSightComparison).toHaveBeenCalledWith(options);
    expect(mockDetectProjectType).not.toHaveBeenCalled();
    expect(mockGenerateSightArtifacts).not.toHaveBeenCalled();
  });

  it.each([{ fetch: true }, { include: ['.env'] }])('rejects comparison-only flags without a baseline: %j', async options => {
    await expect(runSightCommand(options)).rejects.toThrow('require --compare');
  });

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-sight-cli-project-'));
    outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-sight-cli-output-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockPrompts.mockReset();
    mockDetectProjectType.mockReset().mockReturnValue('bare');
    mockGenerateSightArtifacts.mockReset().mockImplementation(async ({ assetsDirectory, platform }) => {
      const bundlePath = path.join(outputDirectory, `main.${platform}.jsbundle`);
      const sourceMapPath = bundlePath + '.map';
      fs.writeFileSync(bundlePath, 'console.log("bundle");');
      fs.writeFileSync(sourceMapPath, '{"version":3,"sources":[],"mappings":""}');
      fs.writeFileSync(path.join(assetsDirectory, 'image.png'), 'asset bytes');
      return { outputDirectory, bundlePath, sourceMapPath, temporary: true };
    });
    mockOpenSightInBrowser.mockReset().mockResolvedValue(undefined);
    waitForTransfer.mockReset().mockResolvedValue(undefined);
    close.mockReset().mockResolvedValue(undefined);
    mockStartSightSession.mockReset().mockResolvedValue({
      sightUrl: 'https://bundledrop.app/sight#sight-session=opaque',
      waitForTransfer,
      close,
    });
    delete process.env.BUNDLE_DROP_SIGHT_URL;
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    consoleLogSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    delete process.env.BUNDLE_DROP_SIGHT_URL;
  });

  it('detects the project, generates a pair, opens Sight, and removes transferred temp files', async () => {
    mockPrompts.mockResolvedValueOnce({ openSight: true });

    await runSightCommand({ platform: 'ios', entryFile: 'src/index.ts' });

    expect(consoleLogSpy.mock.calls[0][0]).toBe(buildBundleDropLogo());
    expect(consoleLogSpy.mock.calls[1][0]).toContain('Bundle Drop Sight');

    expect(mockDetectProjectType).toHaveBeenCalledWith({
      projectRoot,
      explicitType: undefined,
    });
    expect(mockGenerateSightArtifacts).toHaveBeenCalledWith({
      projectRoot,
      projectType: 'bare',
      platform: 'ios',
      output: undefined,
      keep: undefined,
      entryFile: 'src/index.ts',
      assetsDirectory: expect.stringContaining('bundle-drop-sight-assets-'),
      runCommand: expect.any(Function),
      env: expect.objectContaining({ NODE_ENV: 'production', BUNDLE_DROP_OTA_BUILD: '1' }),
    });
    expect(mockStartSightSession).toHaveBeenCalledWith({
      artifacts: expect.objectContaining({ outputDirectory }),
      sightPageUrl: 'https://bundledrop.app/sight',
    });
    expect(mockOpenSightInBrowser).toHaveBeenCalledWith(
      'https://bundledrop.app/sight#sight-session=opaque',
    );
    expect(waitForTransfer).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it('keeps generated files and prints exact manual instructions when the prompt is declined', async () => {
    mockPrompts.mockResolvedValueOnce({ openSight: false });

    await runSightCommand({ platform: 'ios' });

    expect(mockStartSightSession).not.toHaveBeenCalled();
    expect(fs.existsSync(outputDirectory)).toBe(true);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Source files have been generated here:'),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Open https://bundledrop.app/sight and attach the bundle and source map for JavaScript analysis.',
      ),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('analysis-assets.json is a local record.'));
  });

  it('treats --no-open as the manual flow without prompting', async () => {
    await runSightCommand({ platform: 'android', open: false });

    expect(mockPrompts).not.toHaveBeenCalled();
    expect(mockStartSightSession).not.toHaveBeenCalled();
    expect(mockGenerateSightArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'android' }),
    );
    expect(JSON.parse(fs.readFileSync(path.join(outputDirectory, 'analysis-assets.json'), 'utf8'))).toMatchObject({
      version: 1, mode: 'analyze', metric: 'emitted-asset-bytes',
      artifacts: { bundle: { path: 'main.android.jsbundle' }, sourceMap: { path: 'main.android.jsbundle.map' } },
      assets: [{ path: 'image.png', bytes: 11 }],
    });
    expect(fs.existsSync(mockGenerateSightArtifacts.mock.calls[0][0].assetsDirectory)).toBe(false);
  });

  it('prompts for an ambiguous platform and accepts Android', async () => {
    fs.mkdirSync(path.join(projectRoot, 'ios'));
    fs.mkdirSync(path.join(projectRoot, 'android'));
    mockPrompts
      .mockResolvedValueOnce({ platform: 'android' })
      .mockResolvedValueOnce({ openSight: false });

    await runSightCommand({});

    expect(mockGenerateSightArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'android' }),
    );
  });

  it('uses the only native platform without asking a platform question', async () => {
    fs.mkdirSync(path.join(projectRoot, 'ios'));
    mockPrompts.mockResolvedValueOnce({ openSight: false });

    await runSightCommand({ projectType: 'expo' });

    expect(mockDetectProjectType).toHaveBeenCalledWith({
      projectRoot,
      explicitType: 'expo',
    });
    expect(mockGenerateSightArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'ios' }),
    );
    expect(mockPrompts).toHaveBeenCalledTimes(1);
  });

  it('stops before generation when platform selection is cancelled', async () => {
    mockPrompts.mockResolvedValueOnce({});

    await expect(runSightCommand({})).rejects.toThrow(
      'No platform was selected. Pass --platform ios or --platform android.',
    );
    expect(mockGenerateSightArtifacts).not.toHaveBeenCalled();
  });

  it('prints the one-time URL when the OS browser opener fails', async () => {
    mockPrompts.mockResolvedValueOnce({ openSight: true });
    mockOpenSightInBrowser.mockRejectedValueOnce(new Error('no opener'));

    await runSightCommand({ platform: 'ios' });

    expect(waitForTransfer).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Open this one-time URL manually:'),
    );
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it('retains generated files when the loopback session cannot start', async () => {
    mockPrompts.mockResolvedValueOnce({ openSight: true });
    mockStartSightSession.mockRejectedValueOnce(new Error('loopback unavailable'));

    await expect(runSightCommand({ platform: 'ios' })).rejects.toThrow(
      'loopback unavailable',
    );

    expect(fs.existsSync(outputDirectory)).toBe(true);
    expect(fs.existsSync(path.join(outputDirectory, 'analysis-assets.json'))).toBe(true);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Source files have been generated here:'),
    );
  });

  it('retains the files and closes the server when transfer fails', async () => {
    mockPrompts.mockResolvedValueOnce({ openSight: true });
    waitForTransfer.mockRejectedValueOnce(new Error('transfer failed'));

    await expect(runSightCommand({ platform: 'ios' })).rejects.toThrow('transfer failed');

    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(outputDirectory)).toBe(true);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Source files have been generated here:'),
    );
  });

  it.each([
    [{ keep: true }, 'keep'],
    [{ output: './analysis' }, 'output'],
  ] as const)('retains successful artifacts requested through %s', async (option, _label) => {
    mockPrompts.mockResolvedValueOnce({ openSight: true });

    await runSightCommand({ platform: 'ios', ...option });

    expect(fs.existsSync(outputDirectory)).toBe(true);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Generated files were kept here:'),
    );
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Open https://bundledrop.app/sight'),
    );
  });

  it('uses an approved development Sight URL override', async () => {
    process.env.BUNDLE_DROP_SIGHT_URL = 'http://localhost:3000/sight';
    mockPrompts.mockResolvedValueOnce({ openSight: true });

    await runSightCommand({ platform: 'ios' });

    expect(mockStartSightSession).toHaveBeenCalledWith(
      expect.objectContaining({ sightPageUrl: 'http://localhost:3000/sight' }),
    );
  });

  it.each([
    [{ platform: 'web' }, '--platform must be ios or android.'],
    [{ projectType: 'hybrid' }, '--project-type must be expo or bare.'],
  ])('rejects invalid command options before project detection', async (options, message) => {
    await expect(runSightCommand(options as never)).rejects.toThrow(message);
    expect(mockDetectProjectType).not.toHaveBeenCalled();
  });
});
