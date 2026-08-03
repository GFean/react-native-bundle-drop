import {
  getAvailableBundles,
  getAvailableChannels,
  checkForUpdate,
  getInstalledBundleInfo,
} from '../../manager/updateCheck';
import type { OtaResolveResponse } from '../../api/types';
import { mockGetBundleList, mockGetPublicChannels, mockPostOtaResolve } from '../mocks/api/clientApi';
import { resetContextMocks, setMockConfig, setMockPlatform } from '../mocks/context';
import { mockSupportsXdelta, resetNativeFsMocks, setMockFile } from '../mocks/native/fs';
import { mockGetDownloadedBundlePathNative, resetBundleDropNativeMocks } from '../mocks/native/bundleDropNative';
import { initializeBundleDropRuntime, resetBundleDropRuntimeForTests } from '../../runtime/initState';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));
jest.mock('../../native/bundleDropNative', () => require('../mocks/native/bundleDropNative'));
jest.mock('../../api/clientApi', () => require('../mocks/api/clientApi'));

const BUNDLE_INFO_PATH = '/mock/doc/bundle-info.json';
const CURRENT_POINTER_PATH = '/mock/doc/bundle-drop/current.json';
const PREVIOUS_POINTER_PATH = '/mock/doc/bundle-drop/previous.json';
const STATE_PATH = '/mock/doc/bundle-drop/state.json';
const USER_PROPERTIES_PATH = '/mock/doc/bundle-drop/user-properties.json';
const INSTALL_ID_PATH = '/mock/doc/bundle-drop/install-id.txt';

describe('manager/updateCheck', () => {
  beforeEach(() => {
    resetContextMocks();
    resetNativeFsMocks();
    resetBundleDropNativeMocks();
    resetBundleDropRuntimeForTests();
    mockGetBundleList.mockReset();
    mockGetPublicChannels.mockReset();
    mockPostOtaResolve.mockReset();
  });

  it('fetches the available public channels for the configured project', async () => {
    mockGetPublicChannels.mockResolvedValue({
      data: ['General', 'Beta'],
    } as never);

    await expect(getAvailableChannels()).resolves.toEqual(['General', 'Beta']);
    expect(mockGetPublicChannels).toHaveBeenCalledWith({
      projectSlug: 'bundle-drop-app',
    });
  });

  it('throws when the project slug is missing from config', async () => {
    setMockConfig({
      project: {
        name: 'Bundle Drop',
        slug: '',
      },
    });

    await expect(getAvailableChannels()).rejects.toThrow(
      'Missing project slug in bundle.drop.config.js'
    );
  });

  it('warns and rethrows when the available channel response is invalid', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetPublicChannels.mockResolvedValue({
      data: { invalid: true },
    } as never);

    try {
      await expect(getAvailableChannels()).rejects.toThrow('Invalid channel list response');
      expect(consoleSpy).toHaveBeenCalledWith(
        '⚠️ Failed to fetch available channels:',
        'Error: Invalid channel list response',
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('logs raw available-channel failures without wrapping them', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetPublicChannels.mockRejectedValue(null);

    try {
      await expect(getAvailableChannels()).rejects.toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith('⚠️ Failed to fetch available channels:', null);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('builds the OTA resolve payload from local pointers, metadata, and user properties', async () => {
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        bundleVersion: 7,
        hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      })
    );
    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        bundlePath: '/mock/doc/bundle-drop/bundles/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );
    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        bundlePath: '/mock/doc/bundle-drop/bundles/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          region: 'eu',
          cohort: 'beta',
          age: 33,
          beta: true,
        },
      })
    );
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        failedBundles: {
          'failed-newer': {
            reason: 'crash_loop',
            failedAt: 3000,
          },
          'failed-older': {
            reason: 'crash_loop',
            failedAt: 1000,
          },
        },
      }),
    );
    setMockFile(INSTALL_ID_PATH, 'install-123');
    mockGetDownloadedBundlePathNative.mockResolvedValue(
      '/mock/doc/bundle-drop/bundles/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/main.jsbundle',
    );

    mockPostOtaResolve.mockResolvedValue({
      data: {
        action: 'INSTALL',
        mode: 'full',
        target: {
          bundleHash: 'next-hash',
          downloadUrl: 'https://cdn.example.com/next.zip',
          manifestUrl: 'https://cdn.example.com/next-manifest.json',
          bundleVersion: 8,
          version: '1.2.0',
          runtimeVersion: '1.0.0',
        },
      },
    } as never);

    const statusSpy = jest.fn();
    await expect(checkForUpdate('Beta', statusSpy)).resolves.toEqual({
      action: 'INSTALL',
      upToDate: false,
      channelName: 'Beta',
      hash: 'next-hash',
      bundleHash: 'next-hash',
      mode: 'full',
      baseHash: undefined,
      patchSet: undefined,
      fallback: undefined,
      downloadUrl: 'https://cdn.example.com/next.zip',
      manifestUrl: 'https://cdn.example.com/next-manifest.json',
      bundleVersion: 8,
      version: '1.2.0',
      runtimeVersion: '1.0.0',
    });

    expect(mockPostOtaResolve).toHaveBeenCalledWith('bundle-drop-app', {
      channelName: 'Beta',
      platform: 'android',
      runtimeVersion: '1.0.0',
      environment: null,
      currentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      currentUserProperties: {
        region: 'eu',
        cohort: 'beta',
        age: 33,
        beta: true,
      },
      rejectedHashes: ['failed-newer', 'failed-older'],
      installId: 'install-123',
      transport: {
        manifestVersion: 1,
        patchAlgorithms: ['xdelta3-vcdiff', 'asset-only-v1'],
        supportsContentAddressedAssets: true,
      },
    });
    expect(statusSpy).toHaveBeenNthCalledWith(1, '🔍 Checking for updates...');
    expect(statusSpy).toHaveBeenLastCalledWith('⬇️ Update available');
  });

  it('does not report a raw current pointer hash when native rejects the bundle path', async () => {
    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    mockGetDownloadedBundlePathNative.mockResolvedValue(null);
    mockPostOtaResolve.mockResolvedValue({
      data: {
        action: 'NOOP',
        reason: 'UP_TO_DATE',
      },
    } as never);

    await checkForUpdate('General');

    expect(mockPostOtaResolve).toHaveBeenCalledWith(
      'bundle-drop-app',
      expect.objectContaining({
        currentHash: null,
      }),
    );
  });

  it('marks incompatible binaries when the server reports no compatible bundle', async () => {
    mockPostOtaResolve.mockResolvedValue({
      data: {
        action: 'NOOP',
        reason: 'NO_COMPATIBLE_BUNDLE',
        requestedRuntimeVersion: '1.0.0',
        latestRuntimeVersionOnChannel: '2.0.0',
      },
    } as never);

    const statusSpy = jest.fn();
    await expect(checkForUpdate(undefined, statusSpy)).resolves.toEqual({
      action: 'NOOP',
      upToDate: false,
      channelName: 'General',
      reason: 'NO_COMPATIBLE_BUNDLE',
      incompatible: true,
      requestedRuntimeVersion: '1.0.0',
      latestRuntimeVersionOnChannel: '2.0.0',
    });

    expect(statusSpy).toHaveBeenLastCalledWith('⛔️ No compatible update for this binary');
  });

  it('converts locally failed install targets into a no-op decision', async () => {
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        failedBundles: {
          'failed-hash': {
            reason: 'crash_loop',
            failedAt: 1000,
          },
        },
      }),
    );
    mockPostOtaResolve.mockResolvedValue({
      data: {
        action: 'INSTALL',
        mode: 'full',
        target: {
          bundleHash: 'failed-hash',
          downloadUrl: 'https://cdn.example.com/failed.zip',
          manifestUrl: 'https://cdn.example.com/failed-manifest.json',
          bundleVersion: 9,
          version: '1.2.0',
          runtimeVersion: '1.0.0',
        },
      },
    } as never);

    const statusSpy = jest.fn();
    await expect(checkForUpdate('General', statusSpy)).resolves.toEqual({
      action: 'NOOP',
      upToDate: false,
      channelName: 'General',
      reason: 'BUNDLE_PREVIOUSLY_FAILED',
      skippedFailedBundle: true,
      skippedHash: 'failed-hash',
    });
    expect(statusSpy).toHaveBeenLastCalledWith(
      '✅ Current bundle retained; latest update previously failed on this device',
    );
  });

  it('preserves patch transport fields after target selection', async () => {
    mockPostOtaResolve.mockResolvedValue({
      data: {
        action: 'INSTALL',
        mode: 'patch',
        baseHash: 'base-hash',
        target: {
          bundleHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          manifestUrl: 'https://cdn.example.com/manifest.json',
          bundleVersion: 12,
          version: '2.0.0',
          runtimeVersion: '1.0.0',
        },
        patchSet: {
          algorithm: 'xdelta3-vcdiff',
          patchSetHash: 'patch-hash',
          patchesUrl: 'https://cdn.example.com/patch.zip',
          assets: {
            missingAssetsUrl: 'https://cdn.example.com/assets.zip',
          },
        },
        fallback: {
          mode: 'full',
          downloadUrl: 'https://cdn.example.com/full.zip',
        },
      },
    } as never);

    await expect(checkForUpdate('General')).resolves.toEqual({
      action: 'INSTALL',
      upToDate: false,
      channelName: 'General',
      hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      bundleHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      mode: 'patch',
      baseHash: 'base-hash',
      patchSet: {
        algorithm: 'xdelta3-vcdiff',
        patchSetHash: 'patch-hash',
        patchesUrl: 'https://cdn.example.com/patch.zip',
        assets: {
          missingAssetsUrl: 'https://cdn.example.com/assets.zip',
        },
      },
      fallback: {
        mode: 'full',
        downloadUrl: 'https://cdn.example.com/full.zip',
      },
      downloadUrl: undefined,
      manifestUrl: 'https://cdn.example.com/manifest.json',
      bundleVersion: 12,
      version: '2.0.0',
      runtimeVersion: '1.0.0',
    });
  });

  it('treats targeting misses as a normal no-op resolve decision', async () => {
    const resolveResponse: OtaResolveResponse = {
      action: 'NOOP',
      reason: 'TARGETING_NOT_MATCHED',
    };
    mockPostOtaResolve.mockResolvedValue({
      data: resolveResponse,
    } as never);

    const statusSpy = jest.fn();
    await expect(checkForUpdate('Beta', statusSpy)).resolves.toEqual({
      action: 'NOOP',
      upToDate: true,
      channelName: 'Beta',
      reason: 'TARGETING_NOT_MATCHED',
      incompatible: undefined,
      requestedRuntimeVersion: undefined,
      latestRuntimeVersionOnChannel: undefined,
    });

    expect(statusSpy).toHaveBeenLastCalledWith('✅ You have the latest version');
  });

  it('sends null runtimeVersion when unavailable and rejects incomplete install responses', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    setMockPlatform('android');
    setMockConfig({
      runtimeVersion: {
        android: undefined as unknown as string,
        ios: '1.0.0',
      },
    });
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        bundleVersion: 4,
        hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      }),
    );
    setMockFile(INSTALL_ID_PATH, 'install-456');

    mockPostOtaResolve.mockResolvedValueOnce({
      data: {
        action: 'NOOP',
        reason: 'UP_TO_DATE',
        requestedRuntimeVersion: null,
        latestRuntimeVersionOnChannel: null,
      },
    } as never);

    const statusSpy = jest.fn();
    await expect(checkForUpdate(undefined, statusSpy)).resolves.toEqual({
      action: 'NOOP',
      upToDate: true,
      channelName: 'General',
      reason: 'UP_TO_DATE',
      incompatible: undefined,
      requestedRuntimeVersion: null,
      latestRuntimeVersionOnChannel: null,
    });
    expect(mockPostOtaResolve).toHaveBeenLastCalledWith('bundle-drop-app', {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: null,
      environment: null,
      currentHash: null,
      currentUserProperties: {},
      rejectedHashes: [],
      installId: 'install-456',
      transport: {
        manifestVersion: 1,
        patchAlgorithms: ['xdelta3-vcdiff', 'asset-only-v1'],
        supportsContentAddressedAssets: true,
      },
    });
    expect(statusSpy).toHaveBeenLastCalledWith('✅ You have the latest version');

    try {
      mockPostOtaResolve.mockResolvedValueOnce({
        data: {
          action: 'INSTALL',
          mode: 'full',
          target: {
            bundleHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            downloadUrl: 'https://cdn.example.com/no-runtime.zip',
            manifestUrl: 'https://cdn.example.com/no-runtime-manifest.json',
            bundleVersion: 9,
            version: '2.0.0',
          },
        },
      } as never);

      await expect(checkForUpdate()).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        '⚠️ checkForUpdate failed:',
        'Error: Invalid INSTALL resolve response: target.runtimeVersion is required',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns rollback decisions and null on resolve failures', async () => {
    mockPostOtaResolve.mockResolvedValueOnce({
      data: {
        action: 'ROLLBACK',
        reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
      },
    } as never);

    await expect(checkForUpdate()).resolves.toEqual({
      action: 'ROLLBACK',
      channelName: 'General',
      reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
    });

    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPostOtaResolve.mockRejectedValueOnce(new Error('network down'));

    await expect(checkForUpdate()).resolves.toBeNull();
    expect(consoleSpy).toHaveBeenCalled();

    setMockConfig({
      project: {
        name: 'Bundle Drop',
        slug: '',
      },
    });
    await expect(checkForUpdate()).resolves.toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      '⚠️ checkForUpdate failed:',
      'Error: Missing project slug in bundle.drop.config.js',
    );

    consoleSpy.mockRestore();
  });

  it('logs raw resolve failures and returns null', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPostOtaResolve.mockRejectedValue(null);

    try {
      await expect(checkForUpdate()).resolves.toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith('⚠️ checkForUpdate failed:', null);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('rejects incomplete INSTALL resolve responses before exposing them to install flow', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const validTarget = {
      bundleHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      downloadUrl: 'https://cdn.example.com/target.zip',
      manifestUrl: 'https://cdn.example.com/target-manifest.json',
      runtimeVersion: '1.0.0',
    };
    const cases: Array<[string, OtaResolveResponse]> = [
      ['target.bundleHash', { action: 'INSTALL', mode: 'full', target: { ...validTarget, bundleHash: '' } }],
      ['target.manifestUrl', { action: 'INSTALL', mode: 'full', target: { ...validTarget, manifestUrl: '' } }],
      ['target.downloadUrl', { action: 'INSTALL', mode: 'full', target: { ...validTarget, downloadUrl: '' } }],
      ['mode must be full or patch', { action: 'INSTALL', mode: 'stream' as 'full', target: validTarget }],
      ['baseHash', {
        action: 'INSTALL',
        mode: 'patch',
        baseHash: '',
        target: { ...validTarget, downloadUrl: undefined },
        patchSet: {
          algorithm: 'xdelta3-vcdiff',
          patchSetHash: 'patch-hash',
          patchesUrl: 'https://cdn.example.com/patch.zip',
        },
        fallback: { mode: 'full', downloadUrl: 'https://cdn.example.com/full.zip' },
      }],
      ['patchSet', {
        action: 'INSTALL',
        mode: 'patch',
        baseHash: 'base-hash',
        target: { ...validTarget, downloadUrl: undefined },
        patchSet: {
          algorithm: 'xdelta3-vcdiff',
          patchSetHash: '',
          patchesUrl: 'https://cdn.example.com/patch.zip',
        },
        fallback: { mode: 'full', downloadUrl: 'https://cdn.example.com/full.zip' },
      }],
      ['full fallback', {
        action: 'INSTALL',
        mode: 'patch',
        baseHash: 'base-hash',
        target: { ...validTarget, downloadUrl: undefined },
        patchSet: {
          algorithm: 'xdelta3-vcdiff',
          patchSetHash: 'patch-hash',
          patchesUrl: 'https://cdn.example.com/patch.zip',
        },
        fallback: { mode: 'full', downloadUrl: '' },
      }],
    ];

    try {
      for (const [message, response] of cases) {
        warnSpy.mockClear();
        mockPostOtaResolve.mockResolvedValueOnce({ data: response } as never);
        await expect(checkForUpdate()).resolves.toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          '⚠️ checkForUpdate failed:',
          expect.stringContaining(message),
        );
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('includes initialized runtime environment in ota resolve requests', async () => {
    initializeBundleDropRuntime({
      environment: 'staging',
    });
    setMockFile(INSTALL_ID_PATH, 'install-env');
    mockPostOtaResolve.mockResolvedValue({
      data: {
        action: 'NOOP',
        reason: 'UP_TO_DATE',
      },
    } as never);

    await checkForUpdate('General');

    expect(mockPostOtaResolve).toHaveBeenCalledWith('bundle-drop-app', {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: '1.0.0',
      environment: 'staging',
      currentHash: null,
      currentUserProperties: {},
      rejectedHashes: [],
      installId: 'install-env',
      transport: {
        manifestVersion: 1,
        patchAlgorithms: ['xdelta3-vcdiff', 'asset-only-v1'],
        supportsContentAddressedAssets: true,
      },
    });
  });

  it('advertises asset-only when native xdelta support probing fails', async () => {
    mockSupportsXdelta.mockRejectedValueOnce(new Error('native bridge unavailable'));
    setMockFile(INSTALL_ID_PATH, 'install-no-xdelta');
    mockPostOtaResolve.mockResolvedValue({
      data: {
        action: 'NOOP',
        reason: 'UP_TO_DATE',
      },
    } as never);

    await checkForUpdate('General');

    expect(mockPostOtaResolve).toHaveBeenCalledWith(
      'bundle-drop-app',
      expect.objectContaining({
        transport: {
          manifestVersion: 1,
          patchAlgorithms: ['asset-only-v1'],
          supportsContentAddressedAssets: true,
        },
      }),
    );
  });

  it('lists bundles using the default channel and platform when options are omitted', async () => {
    mockGetBundleList.mockResolvedValue({
      data: {
        items: [{ hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', version: '1.0.0', createdAt: '2026-03-01T00:00:00.000Z' }],
        nextCursor: null,
        hasMore: false,
      },
    } as never);

    await expect(getAvailableBundles()).resolves.toEqual({
      items: [{ hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', version: '1.0.0', createdAt: '2026-03-01T00:00:00.000Z' }],
      nextCursor: null,
      hasMore: false,
    });

    expect(mockGetBundleList).toHaveBeenCalledWith('bundle-drop-app', {
      channelName: 'General',
      platform: 'android',
      limit: undefined,
      cursor: undefined,
    });
  });

  it('lists bundles with explicit options and validates the project slug', async () => {
    mockGetBundleList.mockResolvedValue({
      data: {
        items: [{ hash: '0000000000000000000000000000000000000000000000000000000000000000', version: '9.0.0', createdAt: '2026-03-01T00:00:00.000Z' }],
        nextCursor: 'cursor-9',
        hasMore: true,
      },
    } as never);

    await expect(
      getAvailableBundles({
        channelName: 'Beta',
        platform: 'ios',
        limit: 20,
        cursor: 'cursor-8',
      }),
    ).resolves.toEqual({
      items: [{ hash: '0000000000000000000000000000000000000000000000000000000000000000', version: '9.0.0', createdAt: '2026-03-01T00:00:00.000Z' }],
      nextCursor: 'cursor-9',
      hasMore: true,
    });
    expect(mockGetBundleList).toHaveBeenLastCalledWith('bundle-drop-app', {
      channelName: 'Beta',
      platform: 'ios',
      limit: 20,
      cursor: 'cursor-8',
    });

    setMockConfig({
      project: {
        name: 'Bundle Drop',
        slug: '',
      },
    });
    await expect(getAvailableBundles()).rejects.toThrow(
      'Missing project slug in bundle.drop.config.js',
    );
  });

  it('returns the stored installed bundle info', async () => {
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: 'installed-hash',
        bundleVersion: 11,
      }),
    );

    await expect(getInstalledBundleInfo()).resolves.toEqual({
      hash: 'installed-hash',
      bundleVersion: 11,
    });
  });
});
