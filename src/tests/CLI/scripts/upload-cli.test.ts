import fs from 'fs';
import os from 'os';
import path from 'path';

import { mockAxiosNodePost } from '../../mocks/modules/axiosNode';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';
import { mockProcessExit } from '../../utils/processExit';

type MockFormDataInstance = {
  entries: Array<{ name: string; value: unknown }>;
  append: jest.Mock;
  getHeaders: jest.Mock;
};

const formInstances: MockFormDataInstance[] = [];
const mockExecSync = jest.fn();
const spawnCalls: Array<{ executable: string; args: string[]; options: unknown }> = [];
const mockResolveExpoUploadIdentity = jest.fn();
const mockExportProjectArtifact = jest.fn();
const mockDetectProjectType = jest.fn();
const mockEvaluateExpoConfig = jest.fn();
const mockLog = {
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  arrow: jest.fn(),
  label: jest.fn(),
};

jest.mock('axios', () => require('../../mocks/modules/axiosNode'));
jest.mock('child_process', () => ({
  spawnSync: (executable: string, args: string[], options: unknown) => {
    spawnCalls.push({ executable, args, options });
    const commandName = executable === process.execPath ? 'node' : executable;
    const command = [
      commandName,
      ...args.map(arg => arg.includes(path.sep) ? `"${arg}"` : arg),
    ].join(' ');
    const { shell: _shell, ...legacyOptions } = options as Record<string, unknown>;
    const output = mockExecSync(command, legacyOptions);
    if (output && typeof output === 'object' && 'status' in output) return output;
    return { status: 0, stdout: output ?? '', stderr: '' };
  },
}));
jest.mock('form-data', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const form: MockFormDataInstance = {
      entries: [],
      append: jest.fn(function append(this: MockFormDataInstance, name: string, value: unknown) {
        this.entries.push({ name, value });
      }),
      getHeaders: jest.fn(() => ({
        'content-type': 'multipart/form-data',
      })),
    };
    formInstances.push(form);
    return form;
  }),
}));
jest.mock('../../../CLI/utils/ui', () => ({
  log: mockLog,
  startLoadingStatus: () => ({ stop: jest.fn() }),
}));
jest.mock('../../../CLI/scripts/expo/build-receipt', () => ({
  resolveExpoUploadIdentity: (...args: unknown[]) => mockResolveExpoUploadIdentity(...args),
}));
jest.mock('../../../scripts/exportProject', () => ({
  exportProjectArtifact: (...args: unknown[]) => mockExportProjectArtifact(...args),
}));
jest.mock('../../../expo', () => ({
  detectProjectType: (...args: unknown[]) => mockDetectProjectType(...args),
  evaluateExpoConfig: (...args: unknown[]) => mockEvaluateExpoConfig(...args),
  resolveBundleDropRuntimeVersionAuthority: (...args: unknown[]) =>
    jest.requireActual('../../../expo/runtimeVersion')
      .resolveBundleDropRuntimeVersionAuthority(...args),
  assertExpoUpdatesDoesNotOwnStartup: (...args: unknown[]) =>
    jest.requireActual('../../../expo/expoUpdatesOwnership').assertExpoUpdatesDoesNotOwnStartup(...args),
}));

import uploadWithDefaultDependencies, { runUpload } from '../../../CLI/scripts/upload-cli';

describe('CLI/scripts/upload-cli', () => {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  let tempProjectDir = '';
  let tempHome = '';
  let tempPackageRoot = '';
  let distDir = '';
  let homedirSpy: jest.SpyInstance;
  let createReadStreamSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  const upload = (
    platform: string,
    options: Parameters<typeof runUpload>[1],
  ) => runUpload(platform, options, {
    packageRoot: tempPackageRoot,
    spawnProcess: require('child_process').spawnSync,
    resolveModule: moduleId => {
      if (moduleId !== 'ts-node/dist/bin.js') throw new Error(`Unexpected module: ${moduleId}`);
      return path.join(tempPackageRoot, 'test-tools', 'ts-node.js');
    },
  });

  const writeConfig = (content: string) => {
    const configPath = path.join(tempProjectDir, 'bundle.drop.config.js');
    fs.writeFileSync(configPath, content, 'utf8');
    try {
      delete require.cache[require.resolve(configPath)];
    } catch {
      // Ignore missing cache entries before first load.
    }
  };

  const writeAuth = (token = 'jwt-token') => {
    const authDir = path.join(tempHome, '.bundle-drop');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify({ token, serverUrl: 'https://api.example.com' }),
      'utf8',
    );
  };

  const prepareDist = (platform: 'ios' | 'android', runtimeVersion = '2.0.0') => {
    fs.mkdirSync(path.join(distDir, 'assets', 'drawable-mdpi'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'bundle-data', 'utf8');
    fs.writeFileSync(path.join(distDir, 'bundle-drop-result.json'), '', 'utf8');
    fs.writeFileSync(path.join(distDir, `bundle-${platform}.zip`), 'zip-data', 'utf8');
    fs.writeFileSync(
      path.join(distDir, `metadata-${platform}.json`),
      JSON.stringify({ runtimeVersion }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(distDir, 'bundle-manifest.json'),
      JSON.stringify({ manifestVersion: 1, runtimeVersion }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(distDir, 'assets', 'drawable-mdpi', 'login_background.jpg'),
      'image-data',
      'utf8',
    );
  };

  const prepareExpoDist = (
    platform: 'ios' | 'android',
    runtimeVersion: string,
  ) => {
    const artifactRoot = path.join(
      fs.realpathSync(tempProjectDir),
      '.bundle-drop',
      'artifacts',
    );
    const outputDir = path.join(artifactRoot, `expo-artifacts-${platform}`);
    const expoExportDirectory = path.join(artifactRoot, `expo-export-${platform}`);
    const bundlePath = path.join(outputDir, 'main.jsbundle');
    const sourceMapPath = path.join(outputDir, 'main.jsbundle.map');
    const metadataPath = path.join(outputDir, `metadata-${platform}.json`);
    const manifestPath = path.join(outputDir, 'bundle-manifest.json');
    const zipPath = path.join(outputDir, `bundle-${platform}.zip`);
    fs.mkdirSync(path.join(expoExportDirectory, 'assets'), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(bundlePath, `${platform}-bundle`, 'utf8');
    fs.writeFileSync(sourceMapPath, `${platform}-source-map`, 'utf8');
    fs.writeFileSync(metadataPath, JSON.stringify({ runtimeVersion }), 'utf8');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ manifestVersion: 1, runtimeVersion }),
      'utf8',
    );
    fs.writeFileSync(zipPath, `${platform}-zip`, 'utf8');
    fs.writeFileSync(
      path.join(expoExportDirectory, 'assets', `${platform}.png`),
      `${platform}-asset`,
      'utf8',
    );
    return {
      outputDir,
      bundlePath,
      sourceMapPath,
      metadataPath,
      manifestPath,
      zipPath,
      expoExportDirectory,
    };
  };

  beforeEach(() => {
    tempProjectDir = createTempProjectDir();
    tempHome = createTempProjectDir();
    tempPackageRoot = createTempProjectDir();
    distDir = path.join(tempPackageRoot, 'dist');
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    createReadStreamSpy = jest
      .spyOn(fs, 'createReadStream')
      .mockImplementation((filePath: fs.PathLike) => ({ path: filePath }) as fs.ReadStream);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.chdir(tempProjectDir);
    mockAxiosNodePost.mockReset();
    mockExecSync.mockReset();
    spawnCalls.length = 0;
    mockResolveExpoUploadIdentity.mockReset();
    mockExportProjectArtifact.mockReset().mockResolvedValue(undefined);
    mockDetectProjectType.mockReset().mockImplementation(() => {
      const configPath = path.join(tempProjectDir, 'bundle.drop.config.js');
      const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
      return content.includes("projectType: 'expo'") || content.includes("source: 'expo'")
        ? 'expo'
        : 'bare';
    });
    mockEvaluateExpoConfig.mockReset().mockReturnValue({ exp: {} });
    Object.values(mockLog).forEach(mockFn => mockFn.mockReset());
    formInstances.length = 0;
    process.exitCode = undefined;
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    homedirSpy.mockRestore();
    createReadStreamSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    removeTempDir(tempProjectDir);
    removeTempDir(tempHome);
    removeTempDir(tempPackageRoot);
    process.exitCode = originalExitCode;
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('uploads an Android bundle using build.gradle and metadata-derived runtime version', async () => {
    fs.mkdirSync(path.join(tempProjectDir, 'android', 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(tempProjectDir, 'android', 'app', 'build.gradle'),
      'android { defaultConfig { versionName "1.2.3" } }',
      'utf8',
    );
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    writeAuth();
    prepareDist('android', '2.0.0');
    fs.mkdirSync(path.join(distDir, 'expo-export-android'), { recursive: true });
    fs.writeFileSync(
      path.join(tempPackageRoot, 'package.json'),
      JSON.stringify({ version: '0.4.1' }),
      'utf8',
    );
    mockAxiosNodePost.mockResolvedValue({
      data: {
        bundleId: 'bundle-1',
        bundleVersion: 7,
        bundleVersionLabel: 'v7',
        hash: 'abc123',
        runtimeVersion: '2.0.0',
        packageVersion: '0.4.1',
      },
    });

    await upload('android', {
      channel: 'General',
      releaseNotes: 'x'.repeat(2105),
    });

    const requestConfig = mockAxiosNodePost.mock.calls[0][2];
    const form = formInstances[0];
    const releaseNotesField = form.entries.find(entry => entry.name === 'releaseNotes');

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringMatching(/(bundle\.js"|src\/scripts\/bundle\.ts") android$/),
      {
        stdio: 'inherit',
        env: expect.objectContaining({
          BUNDLE_DROP_APP_VERSION: '1.2.3',
        }),
      }
    );
    expect(mockAxiosNodePost).toHaveBeenCalledWith(
      'https://api.example.com/bundle/upload',
      form,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
        }),
      }),
    );
    expect(form.entries.map(entry => entry.name)).toEqual(
      expect.arrayContaining([
        'orgSlug',
        'projectSlug',
        'platform',
        'version',
        'channelName',
        'runtimeVersion',
        'packageVersion',
        'releaseNotes',
        'file',
      ]),
    );
    expect(form.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'packageVersion', value: '0.4.1' }),
      ]),
    );
    expect(releaseNotesField?.value).toHaveLength(2000);
    expect(requestConfig.headers).toEqual(
      expect.objectContaining({
        'content-type': 'multipart/form-data',
      }),
    );

    const result = JSON.parse(
      fs.readFileSync(path.join(distDir, 'bundle-drop-result.json'), 'utf8'),
    );
    expect(result).toEqual(
      expect.objectContaining({
        platform: 'android',
        appVersion: '1.2.3',
        channel: 'General',
        runtimeVersion: '2.0.0',
        packageVersion: '0.4.1',
        bundleId: 'bundle-1',
      }),
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Release notes too long'),
    );
    expect(fs.existsSync(path.join(distDir, 'bundle-android.zip'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'metadata-android.json'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'main.jsbundle'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'assets'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'expo-export-android'))).toBe(false);
  });

  it('prefers the compiled bundle script when it exists in the package root', async () => {
    const compiledScriptPath = path.join(tempPackageRoot, 'lib', 'scripts', 'bundle.js');

    fs.mkdirSync(path.dirname(compiledScriptPath), { recursive: true });
    fs.writeFileSync(compiledScriptPath, '// compiled bundle script', 'utf8');
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    prepareDist('android', '2.0.0');
    mockAxiosNodePost.mockResolvedValue({ data: {} });

    await upload('android', {
      version: '1.2.3',
      channel: 'General',
      token: 'override-token',
    });

    expect(mockExecSync).toHaveBeenCalledWith(`node "${compiledScriptPath}" android`, {
      stdio: 'inherit',
      env: expect.objectContaining({
        BUNDLE_DROP_APP_VERSION: '1.2.3',
      }),
    });
  });

  it('passes a platform containing shell metacharacters as one inert argument', async () => {
    const platform = 'android";touch bundle-drop-upload-pwned;# $()';
    const sentinelPath = path.join(tempProjectDir, 'bundle-drop-upload-pwned');
    const compiledScriptPath = path.join(tempPackageRoot, 'lib', 'scripts', 'bundle.js');
    fs.mkdirSync(path.dirname(compiledScriptPath), { recursive: true });
    fs.writeFileSync(compiledScriptPath, '// compiled bundle script', 'utf8');
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'bundle-data', 'utf8');
    fs.writeFileSync(path.join(distDir, `bundle-${platform}.zip`), 'zip-data', 'utf8');
    fs.writeFileSync(
      path.join(distDir, `metadata-${platform}.json`),
      JSON.stringify({ runtimeVersion: '2.0.0' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(distDir, 'bundle-manifest.json'),
      JSON.stringify({ manifestVersion: 1, runtimeVersion: '2.0.0' }),
      'utf8',
    );
    mockAxiosNodePost.mockResolvedValue({ data: {} });

    await upload(platform, {
      version: '1.2.3',
      channel: 'General',
      token: 'explicit-token',
    });

    expect(spawnCalls[0]).toEqual(
      expect.objectContaining({
        executable: process.execPath,
        args: [compiledScriptPath, platform],
        options: expect.objectContaining({ shell: false }),
      }),
    );
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('uses the plist version, token override, and manifest runtimeVersion for iOS uploads', async () => {
    fs.mkdirSync(path.join(tempProjectDir, 'ios'), { recursive: true });
    fs.writeFileSync(
      path.join(tempProjectDir, 'ios', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict>
        <key>CFBundleShortVersionString</key>
        <string>2.3.4</string>
      </dict></plist>`,
      'utf8',
    );
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    prepareDist('ios', '9.9.9');
    mockAxiosNodePost.mockResolvedValue({
      data: {
        bundleId: 'bundle-2',
        runtimeVersion: '9.9.9',
      },
    });

    await upload('ios', {
      plistFile: path.join(tempProjectDir, 'ios', 'Info.plist'),
      channel: 'Beta',
      token: 'override-token',
      author: 'Sam',
    });

    const form = formInstances[0];
    expect(form.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'version', value: '2.3.4' }),
        expect.objectContaining({ name: 'runtimeVersion', value: '9.9.9' }),
        expect.objectContaining({ name: 'author', value: 'Sam' }),
      ]),
    );
    expect(form.entries.some(entry => entry.name === 'packageVersion')).toBe(false);
    expect(mockAxiosNodePost.mock.calls[0][2].headers.Authorization).toBe(
      'Bearer override-token',
    );
  });

  it('rejects uploads when the manifest runtimeVersion is missing', async () => {
    const exitSpy = mockProcessExit();

    try {
      fs.mkdirSync(path.join(tempProjectDir, 'ios'), { recursive: true });
      fs.writeFileSync(
        path.join(tempProjectDir, 'ios', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict>
          <key>CFBundleShortVersionString</key>
          <string>2.3.4</string>
        </dict></plist>`,
        'utf8',
      );
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
      prepareDist('ios', undefined as never);
      fs.writeFileSync(path.join(distDir, 'bundle-manifest.json'), JSON.stringify({ manifestVersion: 1 }), 'utf8');

      await expect(
        upload('ios', {
          plistFile: path.join(tempProjectDir, 'ios', 'Info.plist'),
          channel: 'Beta',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        '❌ bundle-manifest.json is missing runtimeVersion\nSee https://bundledrop.app/docs/runtime-version',
      );
      expect(mockAxiosNodePost).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('rejects uploads when the manifest version is not the hard-shift v1 contract', async () => {
    const exitSpy = mockProcessExit();

    try {
      fs.mkdirSync(path.join(tempProjectDir, 'ios'), { recursive: true });
      fs.writeFileSync(
        path.join(tempProjectDir, 'ios', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict>
          <key>CFBundleShortVersionString</key>
          <string>2.3.4</string>
        </dict></plist>`,
        'utf8',
      );
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
      prepareDist('ios', '1.0.0');
      fs.writeFileSync(path.join(distDir, 'bundle-manifest.json'), JSON.stringify({ manifestVersion: 2, runtimeVersion: '1.0.0' }), 'utf8');

      await expect(
        upload('ios', {
          plistFile: path.join(tempProjectDir, 'ios', 'Info.plist'),
          channel: 'Beta',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        '❌ bundle-manifest.json must use manifestVersion 1\nSee https://bundledrop.app/docs/runtime-version',
      );
      expect(mockAxiosNodePost).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails fast when the required channel argument is missing', async () => {
    const exitSpy = mockProcessExit();

    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
      writeAuth();

      await expect(upload('android', { version: '1.2.3' })).rejects.toMatchObject({
        code: 1,
      });
      expect(mockLog.error).toHaveBeenCalledWith('❌ Missing required --channel argument');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails when the config file is missing', async () => {
    const exitSpy = mockProcessExit();

    try {
      await expect(
        upload('android', {
          version: '1.2.3',
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        '❌ bundle.drop.config.js not found in project root\n' +
          'See https://bundledrop.app/docs/installation',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('constructs default production dependencies in the public upload entrypoint', async () => {
    const exitSpy = mockProcessExit();
    try {
      await expect(
        uploadWithDefaultDependencies('android', {
          version: '1.2.3',
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('bundle.drop.config.js not found'),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('clears stale artifact-dir output before early validation failures', async () => {
    const exitSpy = mockProcessExit();
    const artifactDir = path.join(tempPackageRoot, 'ci-artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'main.jsbundle'), 'old-bundle', 'utf8');
    fs.writeFileSync(path.join(artifactDir, 'main.jsbundle.map'), 'old-map', 'utf8');
    fs.writeFileSync(
      path.join(artifactDir, 'bundle-drop-result.json'),
      JSON.stringify({ success: true, orgSlug: 'old-org' }),
      'utf8',
    );

    try {
      await expect(
        upload('android', {
          version: '1.2.3',
          channel: 'General',
          token: 'override-token',
          artifactDir,
        }),
      ).rejects.toMatchObject({ code: 1 });

      expect(fs.existsSync(path.join(artifactDir, 'main.jsbundle'))).toBe(false);
      expect(fs.existsSync(path.join(artifactDir, 'main.jsbundle.map'))).toBe(false);
      expect(fs.existsSync(path.join(artifactDir, 'bundle-drop-result.json'))).toBe(false);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('rejects uploads when bundle-manifest.json is missing', async () => {
    const exitSpy = mockProcessExit();
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '5.0.0', ios: '1.0.0' },
};`);
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'bundle-android.zip'), 'zip-data', 'utf8');
    fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'bundle-data', 'utf8');
    try {
      await expect(upload('android', {
        version: '1.2.3',
        channel: 'General',
        token: 'override-token',
      })).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('❌ bundle-manifest.json is required and must be valid JSON:'),
      );
      expect(mockAxiosNodePost).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('formats structured upload errors and exits', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '5.0.0', ios: '1.0.0' },
};`);
    prepareDist('android', '2.0.0');
    mockAxiosNodePost.mockRejectedValue({
      response: {
        data: { error: 'upload failed' },
      },
    });

    await upload('android', {
      version: '1.2.3',
      channel: 'General',
      token: 'override-token',
    });

    expect(process.exitCode).toBe(1);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('"error": "upload failed"'),
    );
    expect(fs.existsSync(path.join(distDir, 'main.jsbundle'))).toBe(false);
  });

  it('recreates the result directory before writing upload metadata when needed', async () => {
    const originalExistsSync = fs.existsSync.bind(fs);
    const existsSyncSpy = jest.spyOn(fs, 'existsSync').mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath) === distDir) {
        return false;
      }
      return originalExistsSync(filePath);
    });

    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '5.0.0', ios: '1.0.0' },
};`);
      prepareDist('android', '2.0.0');
      mockAxiosNodePost.mockResolvedValue({ data: {} });

      await upload('android', {
        version: '1.2.3',
        channel: 'General',
        token: 'override-token',
      });

      expect(fs.existsSync(path.join(distDir, 'bundle-drop-result.json'))).toBe(true);
    } finally {
      existsSyncSpy.mockRestore();
    }
  });

  it('fails when required config values are missing', async () => {
    const exitSpy = mockProcessExit();

    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
};`);
      await expect(
        upload('android', {
          version: '1.2.3',
          channel: 'General',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        '❌ Missing "serverUrl", "org.slug" or "project.slug" in config\n' +
          'See https://bundledrop.app/docs/installation',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails when auth is missing and no token override is provided', async () => {
    const exitSpy = mockProcessExit();

    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
};`);

      await expect(
        upload('android', {
          version: '1.2.3',
          channel: 'General',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        '❌ Not authenticated. Please run `bundle-drop login` or pass --token.\n' +
          'Local setup: https://bundledrop.app/docs/installation\n' +
          'CI/CD tokens: https://bundledrop.app/docs/ci-cd',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('rejects malformed and cross-origin stored credentials before any request', async () => {
    const exitSpy = mockProcessExit();
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
};`);
    const authDir = path.join(tempHome, '.bundle-drop');
    const authPath = path.join(authDir, 'auth.json');
    fs.mkdirSync(authDir, { recursive: true });

    try {
      fs.writeFileSync(authPath, '{ malformed', 'utf8');
      await expect(
        upload('android', { version: '1.2.3', channel: 'General' }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenLastCalledWith(
        '❌ Failed to read CLI auth session. Run `bundle-drop login` again or pass --token.',
      );

      fs.writeFileSync(
        authPath,
        JSON.stringify({ serverUrl: 'https://api.example.com' }),
        'utf8',
      );
      await expect(
        upload('android', { version: '1.2.3', channel: 'General' }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenLastCalledWith(
        '❌ CLI auth session is missing a token. Run `bundle-drop login` again or pass --token.',
      );

      fs.writeFileSync(
        authPath,
        JSON.stringify({
          token: 'staging-token',
          serverUrl: 'https://api-staging.example.com',
        }),
        'utf8',
      );
      await expect(
        upload('android', { version: '1.2.3', channel: 'General' }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenLastCalledWith(
        expect.stringContaining('stored CLI login belongs to'),
      );
      expect(mockAxiosNodePost).not.toHaveBeenCalled();
      expect(spawnCalls).toHaveLength(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('keeps an explicit token usable for the selected project server', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    const authDir = path.join(tempHome, '.bundle-drop');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify({ token: 'wrong-origin-token', serverUrl: 'https://other.example.com' }),
      'utf8',
    );
    prepareDist('android', '2.0.0');
    mockAxiosNodePost.mockResolvedValue({ data: {} });

    await upload('android', {
      version: '1.2.3',
      channel: 'General',
      token: 'explicit-token',
    });

    expect(mockAxiosNodePost.mock.calls[0][2].headers.Authorization).toBe(
      'Bearer explicit-token',
    );
  });

  it('fails on missing or invalid version sources for Android and iOS', async () => {
    const exitSpy = mockProcessExit();

    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);

      await expect(
        upload('ios', {
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        '❌ Provide --version or --plist-file for iOS\n' +
          'See https://bundledrop.app/docs/uploading',
      );

      mockLog.error.mockClear();
      fs.mkdirSync(path.join(tempProjectDir, 'ios'), { recursive: true });
      fs.writeFileSync(
        path.join(tempProjectDir, 'ios', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>`,
        'utf8',
      );
      await expect(
        upload('ios', {
          plistFile: path.join(tempProjectDir, 'ios', 'Info.plist'),
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith('❌ Could not find CFBundleShortVersionString in plist');

      mockLog.error.mockClear();
      await expect(
        upload('android', {
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        '❌ Provide --version or --buildgradle-path for Android\n' +
          'See https://bundledrop.app/docs/uploading',
      );

      mockLog.error.mockClear();
      await expect(
        upload('android', {
          channel: 'General',
          token: 'override-token',
          buildGradlePath: 'android/app/missing.gradle',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('❌ build.gradle not found at'),
      );

      mockLog.error.mockClear();
      fs.mkdirSync(path.join(tempProjectDir, 'android', 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(tempProjectDir, 'android', 'app', 'build.gradle'),
        'android { defaultConfig { versionCode 1 } }',
        'utf8',
      );
      await expect(
        upload('android', {
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith('❌ Could not parse versionName from build.gradle');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails when Info.plist parsing throws before a version can be read', async () => {
    const exitSpy = mockProcessExit();

    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);

      fs.mkdirSync(path.join(tempProjectDir, 'ios'), { recursive: true });
      fs.writeFileSync(path.join(tempProjectDir, 'ios', 'Info.plist'), 'not a plist', 'utf8');

      await expect(
        upload('ios', {
          plistFile: path.join(tempProjectDir, 'ios', 'Info.plist'),
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('❌ Failed to parse Info.plist:'),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails when bundling is unavailable', async () => {
    const exitSpy = mockProcessExit();

    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
};`);

      mockExecSync.mockImplementationOnce(() => {
        throw new Error('bundle failed');
      });
      await expect(
        upload('android', {
          version: '1.2.3',
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith('❌ Bundling failed');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it.each([
    {
      result: { status: null, error: new Error('spawn failed') },
      label: 'spawn error',
    },
    {
      result: { status: 7, stderr: 'bundle rejected' },
      label: 'nonzero child status',
    },
  ])('fails when bundling returns a $label', async ({ result }) => {
    const exitSpy = mockProcessExit();
    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
};`);
      mockExecSync.mockReturnValueOnce(result);

      await expect(
        upload('android', {
          version: '1.2.3',
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith('❌ Bundling failed');
      expect(mockAxiosNodePost).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails when bundle-manifest.json is missing after bundling', async () => {
    const exitSpy = mockProcessExit();

    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
};`);

      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'metadata-android.json'), JSON.stringify({}), 'utf8');
      await expect(
        upload('android', {
          version: '1.2.3',
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('❌ bundle-manifest.json is required and must be valid JSON:'),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails when the bundle zip output is missing after runtime version resolution succeeds', async () => {
    const exitSpy = mockProcessExit();

    try {
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '7.7.7', ios: '1.0.0' },
};`);
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'metadata-android.json'), JSON.stringify({}), 'utf8');
      fs.writeFileSync(path.join(distDir, 'bundle-manifest.json'), JSON.stringify({ manifestVersion: 1, runtimeVersion: '7.7.7' }), 'utf8');

      await expect(
        upload('android', {
          version: '1.2.3',
          channel: 'General',
          token: 'override-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('❌ Bundle ZIP not found at:'),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('resolves $(MARKETING_VERSION) from pbxproj for iOS uploads', async () => {
    fs.mkdirSync(path.join(tempProjectDir, 'ios', 'MyApp.xcodeproj'), { recursive: true });
    fs.writeFileSync(
      path.join(tempProjectDir, 'ios', 'MyApp.xcodeproj', 'project.pbxproj'),
      'MARKETING_VERSION = 7.2.0;',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempProjectDir, 'ios', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict>
        <key>CFBundleShortVersionString</key>
        <string>$(MARKETING_VERSION)</string>
      </dict></plist>`,
      'utf8',
    );
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { ios: '1.0.0' },
};`);
    writeAuth();
    prepareDist('ios', '1.0.0');
    mockAxiosNodePost.mockResolvedValue({ data: { bundleId: 'b-1' } });

    await upload('ios', {
      plistFile: path.join(tempProjectDir, 'ios', 'Info.plist'),
      channel: 'Beta',
      token: 'jwt-token',
    });

    const form = formInstances[0];
    const versionField = form.entries.find((entry: { name: string }) => entry.name === 'version');
    expect(versionField?.value).toBe('7.2.0');
  });

  it('exits when plist contains an unresolvable Xcode variable', async () => {
    const exitSpy = mockProcessExit();

    try {
      fs.mkdirSync(path.join(tempProjectDir, 'ios'), { recursive: true });
      fs.writeFileSync(
        path.join(tempProjectDir, 'ios', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict>
          <key>CFBundleShortVersionString</key>
          <string>$(MARKETING_VERSION)</string>
        </dict></plist>`,
        'utf8',
      );
      writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { ios: '1.0.0' },
};`);
      writeAuth();

      await expect(
        upload('ios', {
          plistFile: path.join(tempProjectDir, 'ios', 'Info.plist'),
          channel: 'Beta',
          token: 'jwt-token',
        }),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('accepts lowercase buildgradlePath as a fallback option name', async () => {
    fs.mkdirSync(path.join(tempProjectDir, 'android', 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(tempProjectDir, 'android', 'app', 'build.gradle'),
      `android { defaultConfig { versionName "6.0.0" } }`,
      'utf8',
    );
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0' },
};`);
    writeAuth();
    prepareDist('android', '1.0.0');
    mockAxiosNodePost.mockResolvedValue({ data: { bundleId: 'b-1' } });

    await upload('android', {
      channel: 'General',
      token: 'jwt-token',
      buildgradlePath: 'android/app/build.gradle',
    } as any);

    const form = formInstances[0];
    const versionField = form.entries.find((entry: { name: string }) => entry.name === 'version');
    expect(versionField?.value).toBe('6.0.0');
  });

  it('formats string upload errors and exits', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '5.0.0', ios: '1.0.0' },
};`);
    prepareDist('android', '2.0.0');
    mockAxiosNodePost.mockRejectedValue(new Error('network down'));

    await upload('android', {
      version: '1.2.3',
      channel: 'General',
      token: 'override-token',
    });

    expect(process.exitCode).toBe(1);
    expect(mockLog.error).toHaveBeenCalledWith('Upload failed: network down');
    expect(fs.existsSync(path.join(distDir, 'main.jsbundle'))).toBe(false);
    expect(mockLog.success).not.toHaveBeenCalledWith('🎉 Done! Bundle uploaded and cleaned.');
  });

  it('replaces stale artifact-dir output with a failed result when upload fails', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '5.0.0', ios: '1.0.0' },
};`);
    writeAuth();
    prepareDist('android', '2.0.0');
    fs.writeFileSync(
      path.join(tempPackageRoot, 'package.json'),
      JSON.stringify({ version: '0.4.1' }),
      'utf8',
    );
    const artifactDir = path.join(tempPackageRoot, 'ci-artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'main.jsbundle'), 'old-bundle', 'utf8');
    fs.writeFileSync(path.join(artifactDir, 'main.jsbundle.map'), 'old-map', 'utf8');
    fs.writeFileSync(
      path.join(artifactDir, 'bundle-drop-result.json'),
      JSON.stringify({ success: true, orgSlug: 'old-org' }),
      'utf8',
    );
    mockAxiosNodePost.mockRejectedValue(new Error('network down'));

    await upload('android', {
      version: '1.2.3',
      channel: 'General',
      token: 'override-token',
      artifactDir,
    });

    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(artifactDir, 'main.jsbundle'))).toBe(false);
    expect(fs.existsSync(path.join(artifactDir, 'main.jsbundle.map'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'main.jsbundle'))).toBe(false);
    const result = JSON.parse(
      fs.readFileSync(path.join(artifactDir, 'bundle-drop-result.json'), 'utf8'),
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        status: 'failed',
        error: 'network down',
        orgSlug: 'alpha-org',
        projectSlug: 'demo-app',
        channel: 'General',
        runtimeVersion: '2.0.0',
        packageVersion: '0.4.1',
      }),
    );
  });

  it('writes structured upload response errors to the failed artifact result', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '5.0.0', ios: '1.0.0' },
};`);
    writeAuth();
    prepareDist('android', '2.0.0');
    const artifactDir = path.join(tempPackageRoot, 'ci-artifacts');
    mockAxiosNodePost.mockRejectedValue({
      response: {
        data: {
          error: 'Cloudflare timeout',
          code: 504,
        },
      },
    });

    await upload('android', {
      version: '1.2.3',
      channel: 'General',
      token: 'override-token',
      artifactDir,
    });

    expect(process.exitCode).toBe(1);
    const result = JSON.parse(
      fs.readFileSync(path.join(artifactDir, 'bundle-drop-result.json'), 'utf8'),
    );
    expect(result.error).toBe(JSON.stringify({ error: 'Cloudflare timeout', code: 504 }, null, 2));
    expect(mockLog.error).toHaveBeenCalledWith(
      `Upload failed: ${JSON.stringify({ error: 'Cloudflare timeout', code: 504 }, null, 2)}`,
    );
  });

  it('passes --sourcemap to the bundle subprocess and includes artifact paths in result when --artifact-dir is set', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    writeAuth();
    prepareDist('android', '2.0.0');
    fs.writeFileSync(path.join(distDir, 'main.jsbundle.map'), 'sourcemap-data', 'utf8');
    mockAxiosNodePost.mockResolvedValue({
      data: { hash: 'map-hash', bundleVersion: 20, bundleVersionLabel: 'v20' },
    });

    const artifactDir = path.join(tempPackageRoot, 'ci-artifacts');

    await upload('android', {
      version: '1.2.3',
      channel: 'General',
      sourcemap: true,
      artifactDir,
    });

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('--sourcemap'),
      expect.any(Object),
    );
    expect(fs.existsSync(path.join(artifactDir, 'main.jsbundle'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'main.jsbundle.map'))).toBe(true);
    const result = JSON.parse(
      fs.readFileSync(path.join(artifactDir, 'bundle-drop-result.json'), 'utf8'),
    );
    expect(result.bundlePath).toBe(path.join(artifactDir, 'main.jsbundle'));
    expect(result.sourceMapPath).toBe(path.join(artifactDir, 'main.jsbundle.map'));
    expect(fs.existsSync(path.join(distDir, 'main.jsbundle'))).toBe(false);
    expect(fs.existsSync(path.join(distDir, 'main.jsbundle.map'))).toBe(false);
  });

  it('warns instead of failing when artifact copy throws', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    writeAuth();
    prepareDist('android', '2.0.0');
    mockAxiosNodePost.mockResolvedValue({
      data: { hash: 'copy-fail-hash', bundleVersion: 50 },
    });

    const artifactDir = path.join(tempPackageRoot, 'ci-artifacts');
    const origCopyFileSync = fs.copyFileSync.bind(fs);
    const copySpy = jest.spyOn(fs, 'copyFileSync').mockImplementation((src: any, dest: any) => {
      if (typeof dest === 'string' && dest.startsWith(artifactDir)) throw new Error('disk full');
      return origCopyFileSync(src, dest);
    });

    await upload('android', {
      version: '1.0.0',
      channel: 'General',
      artifactDir,
    });

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('artifact copy failed'),
    );
    expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining('Upload complete'));
    copySpy.mockRestore();
  });

  it('warns instead of crashing when cleanup throws', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    writeAuth();
    prepareDist('android', '2.0.0');

    const origRmSync = fs.rmSync.bind(fs);
    const rmSpy = jest.spyOn(fs, 'rmSync');
    mockAxiosNodePost.mockImplementation(async () => {
      rmSpy.mockImplementation((p: any, opts: any) => {
        if (typeof p === 'string' && p.endsWith('/assets')) throw new Error('directory locked');
        return origRmSync(p, opts);
      });
      return { data: { hash: 'cleanup-fail-hash', bundleVersion: 51 } };
    });

    await upload('android', {
      version: '1.0.0',
      channel: 'General',
    });

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cleanup failed'),
    );
    expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining('Upload complete'));
    rmSpy.mockRestore();
  });

  it('refuses to remove an Expo artifact outside its generated directory', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    writeConfig(`module.exports = {
  projectType: 'expo',
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { source: 'expo' },
};`);
    const outsideRoot = path.join(tempHome, 'must-survive');
    const outputDir = path.join(outsideRoot, 'artifact');
    const artifact = {
      outputDir,
      bundlePath: path.join(outputDir, 'main.jsbundle'),
      metadataPath: path.join(outputDir, 'metadata-ios.json'),
      manifestPath: path.join(outputDir, 'bundle-manifest.json'),
      zipPath: path.join(outputDir, 'bundle-ios.zip'),
      expoExportDirectory: path.join(outsideRoot, 'export'),
    };
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(artifact.expoExportDirectory, { recursive: true });
    fs.writeFileSync(artifact.bundlePath, 'bundle', 'utf8');
    fs.writeFileSync(artifact.metadataPath, '{}', 'utf8');
    fs.writeFileSync(
      artifact.manifestPath,
      JSON.stringify({ manifestVersion: 1, runtimeVersion: '1.0.0' }),
      'utf8',
    );
    fs.writeFileSync(artifact.zipPath, 'zip', 'utf8');
    mockResolveExpoUploadIdentity.mockResolvedValue({
      platform: 'ios',
      runtimeVersion: '1.0.0',
      appVersion: '1.0.0',
    });
    mockExportProjectArtifact.mockResolvedValue(artifact);
    mockAxiosNodePost.mockResolvedValue({ data: {} });

    await upload('ios', { channel: 'General', token: 'explicit-token' });

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('escaped its generated output directory'),
    );
    expect(fs.existsSync(artifact.zipPath)).toBe(true);
    expect(fs.existsSync(artifact.expoExportDirectory)).toBe(true);
  });

  it('does not copy artifacts or add paths to result when flags are omitted', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    writeAuth();
    prepareDist('android', '2.0.0');
    mockAxiosNodePost.mockResolvedValue({
      data: { hash: 'no-map-hash', bundleVersion: 21 },
    });

    await upload('android', {
      version: '1.2.3',
      channel: 'General',
    });

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.not.stringContaining('--sourcemap'),
      expect.any(Object),
    );
    const result = JSON.parse(
      fs.readFileSync(path.join(distDir, 'bundle-drop-result.json'), 'utf8'),
    );
    expect(result.bundlePath).toBeUndefined();
    expect(result.sourceMapPath).toBeUndefined();
  });

  it('omits the package version when the package manifest cannot be parsed', async () => {
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { android: '1.0.0', ios: '1.0.0' },
};`);
    writeAuth();
    prepareDist('android', '2.0.0');
    // Corrupt the package-root manifest so readPackageVersion falls into its catch branch.
    fs.writeFileSync(path.join(tempPackageRoot, 'package.json'), '{ not valid json', 'utf8');
    mockAxiosNodePost.mockResolvedValue({
      data: { bundleId: 'bundle-1', bundleVersion: 42 },
    });

    await upload('android', {
      version: '1.2.3',
      channel: 'General',
    });

    const form = formInstances[0];
    expect(form.entries.some(entry => entry.name === 'packageVersion')).toBe(false);
    const result = JSON.parse(
      fs.readFileSync(path.join(distDir, 'bundle-drop-result.json'), 'utf8'),
    );
    expect(result.packageVersion).toBeNull();
  });

  it('exports an Expo artifact with the exact proven build identity', async () => {
    const identity = {
      platform: 'ios',
      runtimeVersion: 'expo-runtime',
      runtimeVersionPolicy: 'literal',
      expoSdkVersion: '57.0.0',
      reactNativeVersion: '0.86.0',
      javaScriptEngine: 'hermes',
      appVersion: '2.0.0',
      nativeVersion: '2.0.0(12)',
      identityHash: 'identity-hash',
    };
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { source: 'expo' },
};`);
    const artifact = prepareExpoDist('ios', 'expo-runtime');
    mockResolveExpoUploadIdentity.mockResolvedValue(identity);
    mockExportProjectArtifact.mockResolvedValue(artifact);
    mockAxiosNodePost.mockResolvedValue({ data: {} });

    await upload('ios', {
      channel: 'General',
      token: 'override-token',
      buildReceipt: 'receipts/eas.json',
    });

    expect(mockResolveExpoUploadIdentity).toHaveBeenCalledWith({
      projectRoot: fs.realpathSync(tempProjectDir),
      platform: 'ios',
      receiptFile: 'receipts/eas.json',
    });
    expect(mockExportProjectArtifact).toHaveBeenCalledWith({
      projectRoot: fs.realpathSync(tempProjectDir),
      platform: 'ios',
      appVersion: '2.0.0',
      generateSourceMap: false,
      projectType: 'expo',
      buildReceipt: 'receipts/eas.json',
      buildIdentity: identity,
    });
    expect(fs.existsSync(artifact.expoExportDirectory)).toBe(false);
    expect(fs.existsSync(path.join(artifact.outputDir, 'bundle-drop-result.json'))).toBe(true);
  });

  it('cleans only the uploaded Expo platform artifacts', async () => {
    const iosArtifact = prepareExpoDist('ios', 'ios-runtime');
    const androidArtifact = prepareExpoDist('android', 'android-runtime');
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'main.jsbundle'), 'bare-bundle', 'utf8');
    fs.writeFileSync(
      path.join(distDir, 'bundle-manifest.json'),
      JSON.stringify({ manifestVersion: 1, runtimeVersion: 'bare-runtime' }),
      'utf8',
    );
    fs.writeFileSync(path.join(distDir, 'assets', 'bare.png'), 'bare-asset', 'utf8');
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { source: 'expo' },
};`);
    mockResolveExpoUploadIdentity.mockResolvedValue({
      platform: 'ios',
      runtimeVersion: 'ios-runtime',
      appVersion: '2.0.0',
    });
    mockExportProjectArtifact.mockResolvedValue(iosArtifact);
    mockAxiosNodePost.mockResolvedValue({ data: {} });

    await upload('ios', {
      channel: 'General',
      token: 'override-token',
    });

    expect(fs.existsSync(iosArtifact.bundlePath)).toBe(false);
    expect(fs.existsSync(iosArtifact.manifestPath)).toBe(false);
    expect(fs.existsSync(iosArtifact.expoExportDirectory)).toBe(false);
    expect(fs.existsSync(path.join(iosArtifact.outputDir, 'bundle-drop-result.json'))).toBe(true);
    expect(fs.readFileSync(androidArtifact.bundlePath, 'utf8')).toBe('android-bundle');
    expect(fs.existsSync(androidArtifact.manifestPath)).toBe(true);
    expect(fs.existsSync(androidArtifact.expoExportDirectory)).toBe(true);
    expect(fs.readFileSync(path.join(distDir, 'main.jsbundle'), 'utf8')).toBe('bare-bundle');
    expect(fs.existsSync(path.join(distDir, 'bundle-manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(distDir, 'assets', 'bare.png'))).toBe(true);
  });

  it('keeps concurrent Expo iOS and Android uploads on separate artifact paths', async () => {
    const iosArtifact = prepareExpoDist('ios', 'ios-runtime');
    const androidArtifact = prepareExpoDist('android', 'android-runtime');
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { source: 'expo' },
};`);
    mockResolveExpoUploadIdentity.mockImplementation(
      async ({ platform }: { platform: 'ios' | 'android' }) => ({
        platform,
        runtimeVersion: `${platform}-runtime`,
        appVersion: '2.0.0',
      }),
    );
    mockExportProjectArtifact.mockImplementation(
      async ({ platform }: { platform: 'ios' | 'android' }) =>
        platform === 'ios' ? iosArtifact : androidArtifact,
    );
    mockAxiosNodePost.mockResolvedValue({ data: {} });

    await Promise.all([
      upload('ios', { channel: 'General', token: 'override-token' }),
      upload('android', { channel: 'General', token: 'override-token' }),
    ]);

    const formsByPlatform = new Map(formInstances.map(form => [
      form.entries.find(entry => entry.name === 'platform')?.value,
      form,
    ]));
    const iosFile = formsByPlatform.get('ios')?.entries.find(entry => entry.name === 'file');
    const androidFile = formsByPlatform.get('android')?.entries.find(entry => entry.name === 'file');
    expect(iosFile?.value).toEqual({ path: iosArtifact.zipPath });
    expect(androidFile?.value).toEqual({ path: androidArtifact.zipPath });
    expect(iosArtifact.zipPath).not.toBe(androidArtifact.zipPath);
    expect(fs.existsSync(path.join(iosArtifact.outputDir, 'bundle-drop-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(androidArtifact.outputDir, 'bundle-drop-result.json'))).toBe(true);
    expect(fs.existsSync(iosArtifact.expoExportDirectory)).toBe(false);
    expect(fs.existsSync(androidArtifact.expoExportDirectory)).toBe(false);
  });

  it('uploads an Expo artifact using the default Bundle Drop literal runtime', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    writeConfig(`module.exports = {
  projectType: 'expo',
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { ios: '1.0.0', android: '1.0.0' },
};`);
    const artifact = prepareExpoDist('ios', '1.0.0');
    const identity = {
      platform: 'ios',
      runtimeVersion: '1.0.0',
      runtimeVersionPolicy: 'literal',
      expoSdkVersion: '57.0.0',
      reactNativeVersion: '0.86.0',
      javaScriptEngine: 'hermes',
      appVersion: '2.0.0',
      nativeVersion: '2.0.0(12)',
      identityHash: 'identity-hash',
    };
    mockResolveExpoUploadIdentity.mockResolvedValue(identity);
    mockExportProjectArtifact.mockResolvedValue(artifact);
    mockAxiosNodePost.mockResolvedValue({ data: {} });

    await upload('ios', { channel: 'General', token: 'override-token' });

    expect(mockResolveExpoUploadIdentity).toHaveBeenCalledWith({
      projectRoot: fs.realpathSync(tempProjectDir),
      platform: 'ios',
      receiptFile: undefined,
    });
    expect(mockExportProjectArtifact).toHaveBeenCalledWith(expect.objectContaining({
      projectType: 'expo',
      buildIdentity: identity,
    }));
  });

  it('fails closed when strict bare detection finds a stale Expo runtime marker', async () => {
    const exitSpy = mockProcessExit();
    mockDetectProjectType.mockReturnValue('bare');
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { source: 'expo' },
};`);
    try {
      await expect(upload('ios', {
        version: '1.0.0',
        channel: 'General',
        token: 'override-token',
      })).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenLastCalledWith(
        expect.stringContaining('stale Expo runtime marker'),
      );
      expect(mockExecSync).not.toHaveBeenCalled();
      expect(mockExportProjectArtifact).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails closed when project type detection is ambiguous', async () => {
    const exitSpy = mockProcessExit();
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { ios: '1.0.0', android: '1.0.0' },
};`);
    mockDetectProjectType.mockImplementationOnce(() => {
      throw new Error('Could not determine the project type');
    });
    try {
      await expect(upload('ios', {
        version: '1.0.0',
        channel: 'General',
        token: 'override-token',
      })).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Could not determine the project type'),
      );
      expect(mockDetectProjectType).toHaveBeenCalledWith({
        projectRoot: fs.realpathSync(tempProjectDir),
      });
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('blocks active Expo Updates before resolving upload identity or exporting', async () => {
    const exitSpy = mockProcessExit();
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { source: 'expo' },
};`);
    mockDetectProjectType.mockReturnValue('expo');
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: ['expo-updates'], updates: { enabled: true } },
    });
    try {
      await expect(upload('ios', {
        channel: 'General',
        token: 'override-token',
      })).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Active expo-updates blocks Bundle Drop'),
      );
      expect(mockResolveExpoUploadIdentity).not.toHaveBeenCalled();
      expect(mockExportProjectArtifact).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('rejects Expo upload identities whose app version differs from --version', async () => {
    const exitSpy = mockProcessExit();
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { source: 'expo' },
};`);
    mockResolveExpoUploadIdentity.mockResolvedValue({
      platform: 'android',
      appVersion: '2.0.0',
    });

    try {
      await expect(upload('android', {
        version: '1.0.0',
        channel: 'General',
        token: 'override-token',
      })).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('does not match the proven Expo build version'),
      );
      expect(mockExportProjectArtifact).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('rejects unsupported Expo upload platforms before resolving a receipt', async () => {
    const exitSpy = mockProcessExit();
    writeConfig(`module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
  runtimeVersion: { source: 'expo' },
};`);

    try {
      await expect(upload('web', {
        version: '1.0.0',
        channel: 'General',
        token: 'override-token',
      })).rejects.toMatchObject({ code: 1 });
      expect(mockLog.error).toHaveBeenCalledWith(
        '❌ Expo uploads require platform ios or android',
      );
      expect(mockResolveExpoUploadIdentity).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
