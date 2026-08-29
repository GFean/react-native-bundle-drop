import fs from 'fs';
import os from 'os';
import path from 'path';

import { mockAxiosNodeGet, mockAxiosNodePost } from '../mocks/modules/axiosNode';
import { createTempProjectDir, removeTempDir } from '../utils/tempDir';
import { mockProcessExit } from '../utils/processExit';

jest.mock('axios', () => require('../mocks/modules/axiosNode'));

import { runDownloadBundle as runDownloadBundleImplementation } from '../../scripts/download-bundle';

describe('scripts/download-bundle', () => {
  let tempProjectDir = '';
  let tempPackageRoot = '';
  let distDir = '';
  let originalArgv: string[];
  let originalCwd = '';
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  const runDownloadBundle = (
    options: Parameters<typeof runDownloadBundleImplementation>[0] = {},
  ) => runDownloadBundleImplementation({ ...options, packageRoot: tempPackageRoot });

  beforeEach(() => {
    tempProjectDir = createTempProjectDir();
    tempPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-package-root-'));
    distDir = path.join(tempPackageRoot, 'dist');
    originalArgv = [...process.argv];
    originalCwd = process.cwd();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAxiosNodePost.mockReset();
    mockAxiosNodeGet.mockReset();
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    removeTempDir(tempProjectDir);
    fs.rmSync(tempPackageRoot, { recursive: true, force: true });
    process.argv = originalArgv;
    process.chdir(originalCwd);
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('resolves and downloads the latest bundle using config auth headers', async () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  serverUrl: 'https://api.example.com',
  defaultChannel: 'General',
  runtimeVersion: { android: '3.0.0' },
  project: { slug: 'demo-app', apiKey: 'project-api-key' },
};`,
      'utf8',
    );
    mockAxiosNodePost.mockResolvedValue({
      data: {
        action: 'INSTALL',
        target: {
          downloadUrl: 'https://cdn.example.com/bundle',
        },
      },
    });
    mockAxiosNodeGet.mockResolvedValue({
      data: Buffer.from('bundle-binary'),
    });

    const outputPath = await runDownloadBundle({
      argv: ['node', 'download-bundle', 'android'],
      cwd: tempProjectDir,
    });

    expect(mockAxiosNodePost).toHaveBeenCalledWith(
      'https://api.example.com/projects/demo-app/ota/resolve',
      {
        channelName: 'General',
        platform: 'android',
        runtimeVersion: '3.0.0',
        environment: null,
        currentHash: null,
        rejectedHashes: [],
        installId: 'cli-download',
        currentUserProperties: {},
        transport: {
          manifestVersion: 1,
          patchAlgorithms: [],
          supportsContentAddressedAssets: true,
        },
      },
      {
        headers: {
          Accept: 'application/json',
          'x-api-key': 'project-api-key',
        },
        timeout: 15000,
      },
    );
    expect(mockAxiosNodeGet).toHaveBeenCalledWith('https://cdn.example.com/bundle', {
      responseType: 'arraybuffer',
    });
    expect(outputPath).toBe(path.join(distDir, 'bundle-android.zip'));
    expect(fs.readFileSync(outputPath as string)).toEqual(Buffer.from('bundle-binary'));
  });

  it('downloads the full fallback ZIP when resolve returns patch transport', async () => {
    fs.writeFileSync(
      path.join(tempProjectDir, 'bundle.drop.config.js'),
      `module.exports = {
  serverUrl: 'https://api.example.com',
  project: { slug: 'demo-app' },
};`,
      'utf8',
    );
    mockAxiosNodePost.mockResolvedValue({
      data: {
        action: 'INSTALL',
        mode: 'patch',
        target: {
          downloadUrl: 'https://cdn.example.com/patch.zip',
        },
        fallback: {
          mode: 'full',
          downloadUrl: 'https://cdn.example.com/full.zip',
        },
      },
    });
    mockAxiosNodeGet.mockResolvedValue({
      data: Buffer.from('full-zip'),
    });

    const outputPath = await runDownloadBundle({
      argv: ['node', 'download-bundle', 'ios'],
      cwd: tempProjectDir,
    });

    expect(mockAxiosNodeGet).toHaveBeenCalledWith('https://cdn.example.com/full.zip', {
      responseType: 'arraybuffer',
    });
    expect(outputPath).toBe(path.join(distDir, 'bundle-ios.zip'));
    expect(fs.readFileSync(outputPath as string)).toEqual(Buffer.from('full-zip'));
  });

  it('fails clearly when serverUrl is missing from config', async () => {
    const exitSpy = mockProcessExit();

    try {
      fs.writeFileSync(
        path.join(tempProjectDir, 'bundle.drop.config.js'),
        `module.exports = {
  project: { slug: 'demo-app' },
};`,
        'utf8',
      );

      await expect(
        runDownloadBundle({
          argv: ['node', 'download-bundle', 'ios'],
          cwd: tempProjectDir,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '❌ Missing "serverUrl" in bundle.drop.config.js',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails clearly when project.slug is missing from config', async () => {
    const exitSpy = mockProcessExit();

    try {
      fs.writeFileSync(
        path.join(tempProjectDir, 'bundle.drop.config.js'),
        `module.exports = {
  serverUrl: 'https://api.example.com',
  project: {},
};`,
        'utf8',
      );

      await expect(
        runDownloadBundle({
          argv: ['node', 'download-bundle', 'ios'],
          cwd: tempProjectDir,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '❌ Missing "project.slug" in bundle.drop.config.js',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails when resolve does not return an installable bundle', async () => {
    const exitSpy = mockProcessExit();

    try {
      fs.writeFileSync(
        path.join(tempProjectDir, 'bundle.drop.config.js'),
        `module.exports = {
  serverUrl: 'https://api.example.com',
  project: { slug: 'demo-app' },
};`,
        'utf8',
      );
      mockAxiosNodePost.mockResolvedValue({
        data: {
          action: 'NOOP',
        },
      });

      await expect(
        runDownloadBundle({
          argv: ['node', 'download-bundle', 'ios'],
          cwd: tempProjectDir,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '❌ Resolve did not return an INSTALL decision with a full bundle downloadUrl',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails when the config file is missing or the platform is invalid', async () => {
    const exitSpy = mockProcessExit();

    try {
      await expect(
        runDownloadBundle({
          argv: ['node', 'download-bundle'],
          cwd: tempProjectDir,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '❌ Please provide platform: ios or android',
      );

      consoleErrorSpy.mockClear();
      await expect(
        runDownloadBundle({
          argv: ['node', 'download-bundle', 'ios'],
          cwd: tempProjectDir,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '❌ bundle.drop.config.js not found in project root',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('uses process argv/cwd fallbacks and logs raw download failures', async () => {
    const exitSpy = mockProcessExit();
    const defaultPackageRoot = path.resolve(__dirname, '../../..');
    const defaultDistDir = path.join(defaultPackageRoot, 'dist');

    try {
      fs.writeFileSync(
        path.join(tempProjectDir, 'bundle.drop.config.js'),
        `module.exports = {
  serverUrl: 'https://api.example.com',
  defaultChannel: 'Fallback',
  project: { slug: 'demo-app' },
};`,
        'utf8',
      );
      process.argv = ['node', 'download-bundle', 'ios'];
      process.chdir(tempProjectDir);
      mockAxiosNodePost.mockRejectedValue({ raw: 'failure payload' });

      await expect(runDownloadBundleImplementation()).rejects.toMatchObject({ code: 1 });
      expect(consoleErrorSpy).toHaveBeenCalledWith('❌ Download failed:', { raw: 'failure payload' });
      expect(fs.existsSync(defaultDistDir)).toBe(true);
    } finally {
      exitSpy.mockRestore();
      fs.rmSync(defaultDistDir, { recursive: true, force: true });
    }
  });
});
