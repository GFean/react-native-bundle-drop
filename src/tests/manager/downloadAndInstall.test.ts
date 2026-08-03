import { BundleDropError, InstallPhaseError } from '../../errors';
import * as bundleInfoModule from '../../bundleInfo';
import { downloadUpdate, installBundle } from '../../manager/downloadAndInstall';
import { resetContextMocks } from '../mocks/context';
import { mockInstallFromPatchSet, mockInstallFromZip } from '../mocks/install/installFromZip';
import { mockCheckForUpdate } from '../mocks/manager/updateCheck';
import { getMockFile, readMockJson, resetNativeFsMocks, setMockFile } from '../mocks/native/fs';
import { mockReportPatchApplyFailure } from '../mocks/api/clientApi';
import { mockGetDownloadedBundlePathNative, resetBundleDropNativeMocks } from '../mocks/native/bundleDropNative';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));
jest.mock('../../install/installFromZip', () => require('../mocks/install/installFromZip'));
jest.mock('../../patch-engine/installFromPatchSet', () => ({
  installFromPatchSet: require('../mocks/install/installFromZip').installFromPatchSet,
}));
jest.mock('../../manager/updateCheck', () => require('../mocks/manager/updateCheck'));
jest.mock('../../api/clientApi', () => require('../mocks/api/clientApi'));
jest.mock('../../native/bundleDropNative', () => require('../mocks/native/bundleDropNative'));

const BUNDLE_INFO_PATH = '/mock/doc/bundle-info.json';
const CURRENT_POINTER_PATH = '/mock/doc/bundle-drop/current.json';
const PREVIOUS_POINTER_PATH = '/mock/doc/bundle-drop/previous.json';
const STATE_PATH = '/mock/doc/bundle-drop/state.json';

describe('manager/downloadAndInstall', () => {
  beforeEach(() => {
    resetContextMocks();
    resetNativeFsMocks();
    resetBundleDropNativeMocks();
    mockGetDownloadedBundlePathNative.mockImplementation(async () => {
      const pointer = readMockJson(CURRENT_POINTER_PATH) as { hash?: string } | null;
      return pointer?.hash
        ? `/mock/doc/bundle-drop/bundles/${pointer.hash}/main.jsbundle`
        : null;
    });
    mockCheckForUpdate.mockReset();
    mockInstallFromZip.mockReset();
    mockInstallFromPatchSet.mockReset();
    mockReportPatchApplyFailure.mockResolvedValue({ data: undefined } as never);
    jest.restoreAllMocks();
  });

  it('returns upToDate and incompatible states without downloading', async () => {
    const statusSpy = jest.fn();

    mockCheckForUpdate.mockResolvedValueOnce({
      action: 'NOOP',
      upToDate: true,
      channelName: 'General',
      reason: 'UP_TO_DATE',
    });

    await expect(downloadUpdate(undefined, statusSpy)).resolves.toEqual({
      status: 'upToDate',
      reason: 'UP_TO_DATE',
    });

    mockCheckForUpdate.mockResolvedValueOnce({
      action: 'NOOP',
      upToDate: false,
      incompatible: true,
      channelName: 'General',
      reason: 'NO_COMPATIBLE_BUNDLE',
    });

    await expect(downloadUpdate()).resolves.toEqual({ status: 'incompatible' });
    expect(statusSpy).toHaveBeenCalledWith('✅ You have the latest version');
  });

  it('returns local quarantine no-op details without downloading', async () => {
    mockCheckForUpdate.mockResolvedValueOnce({
      action: 'NOOP',
      upToDate: false,
      channelName: 'General',
      reason: 'BUNDLE_PREVIOUSLY_FAILED',
      skippedFailedBundle: true,
      skippedHash: 'hash-failed',
    });
    const statusSpy = jest.fn();

    await expect(downloadUpdate(undefined, statusSpy)).resolves.toEqual({
      status: 'upToDate',
      reason: 'BUNDLE_PREVIOUSLY_FAILED',
      skippedFailedBundle: true,
      skippedHash: 'hash-failed',
    });
    expect(statusSpy).toHaveBeenCalledWith(
      '✅ Current bundle retained; requested update previously failed on this device',
    );
    expect(mockInstallFromZip).not.toHaveBeenCalled();
  });

  it('returns rollback decisions and throws when no resolve decision is available', async () => {
    const statusSpy = jest.fn();

    mockCheckForUpdate.mockResolvedValueOnce({
      action: 'ROLLBACK',
      reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
    } as never);
    await expect(downloadUpdate(undefined, statusSpy)).resolves.toEqual({
      status: 'rollback',
      reason: 'CURRENT_REVOKED_NO_SAFE_TARGET',
    });
    expect(statusSpy).toHaveBeenCalledWith('↩️ Rollback requested');

    mockCheckForUpdate.mockResolvedValueOnce(null);
    await expect(downloadUpdate()).rejects.toEqual(
      expect.objectContaining<Partial<BundleDropError>>({
        code: 'RESOLVE_FAILED',
        step: 'resolve',
      }),
    );
  });

  it('downloads, installs, and stages a resolved bundle', async () => {
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: 'hash-previous',
        lastInstalledReportedHash: 'hash-previous',
      }),
    );
    mockCheckForUpdate.mockResolvedValue({
      action: 'INSTALL',
      upToDate: false,
      channelName: 'General',
      hash: '1111111111111111111111111111111111111111111111111111111111111111',
      downloadUrl: 'https://cdn.example.com/bundle.zip',
      bundleVersion: 8,
      version: '1.2.0',
      runtimeVersion: '1.0.0',
    });
    mockInstallFromZip.mockResolvedValue({
      bundlePath: '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/main.jsbundle',
      metadataFromZip: {
        bundleVersion: 8,
        version: '1.2.0',
        runtimeVersion: '1.0.0',
      },
    });

    const statusSpy = jest.fn();
    await expect(downloadUpdate(undefined, statusSpy)).resolves.toEqual({
      status: 'staged',
      bundlePath: '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/main.jsbundle',
      hash: '1111111111111111111111111111111111111111111111111111111111111111',
    });

    expect(mockInstallFromZip).toHaveBeenCalledWith({
      downloadUrl: 'https://cdn.example.com/bundle.zip',
      hash: '1111111111111111111111111111111111111111111111111111111111111111',
      platform: 'android',
      statusCb: statusSpy,
    });

    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        bundleVersion: 8,
        version: '1.2.0',
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
        channelName: 'General',
        platform: 'android',
        pendingApply: true,
        runtimeVersion: '1.0.0',
        lastInstalledReportedHash: 'hash-previous',
      })
    );
    expect(readMockJson(CURRENT_POINTER_PATH)).toEqual(
      expect.objectContaining({
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
      })
    );
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        activeHash: '1111111111111111111111111111111111111111111111111111111111111111',
        candidateHash: '1111111111111111111111111111111111111111111111111111111111111111',
        candidateCommitted: false,
      })
    );
  });

  it('clears the candidate pointer before throwing when native rejects without a previous pointer', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      mockGetDownloadedBundlePathNative.mockResolvedValueOnce(null);
      mockCheckForUpdate.mockResolvedValue({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: '2222222222222222222222222222222222222222222222222222222222222222',
        downloadUrl: 'https://cdn.example.com/bundle.zip',
        bundleVersion: 9,
        version: '1.2.1',
        runtimeVersion: '1.0.0',
      });
      mockInstallFromZip.mockResolvedValue({
        bundlePath: '/mock/doc/bundle-drop/bundles/2222222222222222222222222222222222222222222222222222222222222222/main.jsbundle',
        metadataFromZip: {
          bundleVersion: 9,
          version: '1.2.1',
          runtimeVersion: '1.0.0',
        },
      });

      await expect(downloadUpdate()).rejects.toEqual(
        expect.objectContaining<Partial<BundleDropError>>({
          code: 'INSTALL_FAILED',
          step: 'install',
        }),
      );
      expect(getMockFile(CURRENT_POINTER_PATH)).toBeUndefined();
      expect(getMockFile(BUNDLE_INFO_PATH)).toBeUndefined();
      expect(getMockFile(STATE_PATH)).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('restores the previous verified pointer before throwing when native rejects the installed pointer', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const previousHash = '1111111111111111111111111111111111111111111111111111111111111111';
    const rejectedHash = '2222222222222222222222222222222222222222222222222222222222222222';

    try {
      setMockFile(
        CURRENT_POINTER_PATH,
        JSON.stringify({
          hash: previousHash,
          updatedAt: '2026-03-01T00:00:00.000Z',
        }),
      );
      mockGetDownloadedBundlePathNative.mockRejectedValueOnce(new Error('native rejected candidate'));
      mockCheckForUpdate.mockResolvedValue({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: rejectedHash,
        downloadUrl: 'https://cdn.example.com/bundle.zip',
        bundleVersion: 9,
        version: '1.2.1',
        runtimeVersion: '1.0.0',
      });
      mockInstallFromZip.mockResolvedValue({
        bundlePath: `/mock/doc/bundle-drop/bundles/${rejectedHash}/main.jsbundle`,
        metadataFromZip: {
          bundleVersion: 9,
          version: '1.2.1',
          runtimeVersion: '1.0.0',
        },
      });

      await expect(downloadUpdate()).rejects.toEqual(
        expect.objectContaining<Partial<BundleDropError>>({
          code: 'INSTALL_FAILED',
          step: 'install',
          cause: expect.objectContaining({ message: 'native rejected candidate' }),
        }),
      );
      expect(readMockJson(CURRENT_POINTER_PATH)).toEqual(
        expect.objectContaining({
          hash: previousHash,
        }),
      );
      expect(readMockJson(PREVIOUS_POINTER_PATH)).toBeNull();
      expect(getMockFile(BUNDLE_INFO_PATH)).toBeUndefined();
      expect(getMockFile(STATE_PATH)).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('restores both current and previous pointers when native rejects after writing candidate pointer', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const currentHash = '1111111111111111111111111111111111111111111111111111111111111111';
    const rollbackHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const rejectedHash = '2222222222222222222222222222222222222222222222222222222222222222';

    try {
      setMockFile(CURRENT_POINTER_PATH, JSON.stringify({
        hash: currentHash,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }));
      setMockFile(PREVIOUS_POINTER_PATH, JSON.stringify({
        hash: rollbackHash,
        updatedAt: '2026-02-01T00:00:00.000Z',
      }));
      mockGetDownloadedBundlePathNative.mockRejectedValueOnce(new Error('native rejected candidate'));
      mockCheckForUpdate.mockResolvedValue({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: rejectedHash,
        downloadUrl: 'https://cdn.example.com/bundle.zip',
        bundleVersion: 9,
        version: '1.2.1',
        runtimeVersion: '1.0.0',
      });
      mockInstallFromZip.mockResolvedValue({
        bundlePath: `/mock/doc/bundle-drop/bundles/${rejectedHash}/main.jsbundle`,
        metadataFromZip: {
          bundleVersion: 9,
          version: '1.2.1',
          runtimeVersion: '1.0.0',
        },
      });

      await expect(downloadUpdate()).rejects.toEqual(
        expect.objectContaining<Partial<BundleDropError>>({
          code: 'INSTALL_FAILED',
          step: 'install',
        }),
      );
      expect(readMockJson(CURRENT_POINTER_PATH)).toEqual(expect.objectContaining({ hash: currentHash }));
      expect(readMockJson(PREVIOUS_POINTER_PATH)).toEqual(expect.objectContaining({ hash: rollbackHash }));
      expect(getMockFile(BUNDLE_INFO_PATH)).toBeUndefined();
      expect(getMockFile(STATE_PATH)).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('restores the previous verified pointer when native resolves a different bundle path', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const previousHash = '1111111111111111111111111111111111111111111111111111111111111111';
    const targetHash = '2222222222222222222222222222222222222222222222222222222222222222';

    try {
      setMockFile(
        CURRENT_POINTER_PATH,
        JSON.stringify({
          hash: previousHash,
          updatedAt: '2026-03-01T00:00:00.000Z',
        }),
      );
      mockGetDownloadedBundlePathNative.mockResolvedValueOnce(
        `/mock/doc/bundle-drop/bundles/${previousHash}/main.jsbundle`,
      );
      mockCheckForUpdate.mockResolvedValue({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: targetHash,
        downloadUrl: 'https://cdn.example.com/bundle.zip',
        bundleVersion: 9,
        version: '1.2.1',
        runtimeVersion: '1.0.0',
      });
      mockInstallFromZip.mockResolvedValue({
        bundlePath: `/mock/doc/bundle-drop/bundles/${targetHash}/main.jsbundle`,
        metadataFromZip: {
          bundleVersion: 9,
          version: '1.2.1',
          runtimeVersion: '1.0.0',
        },
      });

      await expect(downloadUpdate()).rejects.toEqual(
        expect.objectContaining<Partial<BundleDropError>>({
          code: 'INSTALL_FAILED',
          step: 'install',
          context: expect.objectContaining({
            expectedBundlePath: `/mock/doc/bundle-drop/bundles/${targetHash}/main.jsbundle`,
            resolvedBundlePath: `/mock/doc/bundle-drop/bundles/${previousHash}/main.jsbundle`,
          }),
        }),
      );
      expect(readMockJson(CURRENT_POINTER_PATH)).toEqual(
        expect.objectContaining({
          hash: previousHash,
        }),
      );
      expect(getMockFile(BUNDLE_INFO_PATH)).toBeUndefined();
      expect(getMockFile(STATE_PATH)).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('falls back to the full bundle when patch install fails without mutating the pointer early', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const statusSpy = jest.fn();

    try {
      mockCheckForUpdate.mockResolvedValue({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        bundleHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        mode: 'patch',
        manifestUrl: 'https://cdn.example.com/target-manifest.json',
        baseHash: 'base-hash',
        patchSet: {
          algorithm: 'xdelta3-vcdiff',
          patchSetHash: 'patch-hash',
          patchesUrl: 'https://cdn.example.com/patch.zip',
          assets: {
            missingAssetsUrl: 'https://cdn.example.com/assets.zip',
            missingAssetsHash: 'assets-hash',
          },
        },
        fallback: {
          mode: 'full',
          downloadUrl: 'https://cdn.example.com/full.zip',
        },
        bundleVersion: 13,
      });
      mockInstallFromPatchSet.mockImplementationOnce(async () => {
        expect(readMockJson(CURRENT_POINTER_PATH)).toBeNull();
        throw new InstallPhaseError('install', new Error('xdelta unavailable'));
      });
      mockInstallFromZip.mockResolvedValue({
        bundlePath: '/mock/doc/bundle-drop/bundles/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/main.jsbundle',
        metadataFromZip: {
          bundleVersion: 13,
        },
      });

      await expect(downloadUpdate(undefined, statusSpy)).resolves.toEqual({
        status: 'staged',
        bundlePath: '/mock/doc/bundle-drop/bundles/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/main.jsbundle',
        hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockInstallFromPatchSet).toHaveBeenCalledWith({
        patchesUrl: 'https://cdn.example.com/patch.zip',
        patchSetHash: 'patch-hash',
        manifestUrl: 'https://cdn.example.com/target-manifest.json',
        missingAssetsUrl: 'https://cdn.example.com/assets.zip',
        missingAssetsHash: 'assets-hash',
        baseHash: 'base-hash',
        targetHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        algorithm: 'xdelta3-vcdiff',
        platform: 'android',
        statusCb: statusSpy,
      });
      expect(mockInstallFromZip).toHaveBeenCalledWith({
        downloadUrl: 'https://cdn.example.com/full.zip',
        hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        platform: 'android',
        statusCb: statusSpy,
      });
      expect(readMockJson(CURRENT_POINTER_PATH)).toEqual(
        expect.objectContaining({
          hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        }),
      );
      expect(statusSpy).toHaveBeenCalledWith('↩️ Patch install failed; falling back to full bundle ZIP');
      expect(mockReportPatchApplyFailure).toHaveBeenCalledWith('bundle-drop-app', {
        platform: 'android',
        runtimeVersion: '1.0.0',
        installId: expect.any(String),
        baseHash: 'base-hash',
        targetHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        algorithm: 'xdelta3-vcdiff',
        reason: 'xdelta unavailable',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('requires patch decisions to include a signed full fallback URL', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      mockCheckForUpdate.mockResolvedValue({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        mode: 'patch',
        baseHash: 'base-hash',
        patchSet: {
          algorithm: 'xdelta3-vcdiff',
          patchSetHash: 'patch-hash',
          patchesUrl: 'https://cdn.example.com/patch.zip',
        },
      });

      await expect(downloadUpdate()).rejects.toEqual(
        expect.objectContaining<Partial<BundleDropError>>({
          code: 'DOWNLOAD_URL_MISSING',
          step: 'resolve',
        }),
      );
      expect(mockInstallFromPatchSet).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('falls back to full when patch install rejects with a non-error value', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      mockCheckForUpdate.mockResolvedValue({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        mode: 'patch',
        baseHash: 'base-hash',
        patchSet: {
          algorithm: 'xdelta3-vcdiff',
          patchSetHash: 'patch-hash',
          patchesUrl: 'https://cdn.example.com/patch.zip',
        },
        fallback: {
          mode: 'full',
          downloadUrl: 'https://cdn.example.com/full.zip',
        },
        runtimeVersion: '2.0.0',
      });
      mockInstallFromPatchSet.mockRejectedValueOnce(null);
      mockInstallFromZip.mockResolvedValue({
        bundlePath: '/mock/doc/bundle-drop/bundles/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/main.jsbundle',
        metadataFromZip: {},
      });

      await expect(downloadUpdate()).resolves.toEqual({
        status: 'staged',
        bundlePath: '/mock/doc/bundle-drop/bundles/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/main.jsbundle',
        hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
        expect.objectContaining({
          hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          runtimeVersion: '2.0.0',
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '⚠️ Patch install failed; falling back to full bundle ZIP:',
        null,
      );
      expect(mockReportPatchApplyFailure).toHaveBeenCalledWith(
        'bundle-drop-app',
        expect.objectContaining({
          reason: 'patch_install_failed',
          runtimeVersion: '2.0.0',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('throws a structured error when the resolve result is missing a download URL', async () => {
    mockCheckForUpdate.mockResolvedValue({
      action: 'INSTALL',
      upToDate: false,
      channelName: 'General',
      hash: '1111111111111111111111111111111111111111111111111111111111111111',
    } as never);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(downloadUpdate()).rejects.toEqual(
      expect.objectContaining<Partial<BundleDropError>>({
        code: 'DOWNLOAD_URL_MISSING',
        step: 'resolve',
      })
    );
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('wraps install failures with INSTALL_FAILED', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const statusSpy = jest.fn();

    try {
      mockCheckForUpdate.mockResolvedValueOnce({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: 'hash-install-fail',
        downloadUrl: 'https://cdn.example.com/install.zip',
      });
      mockInstallFromZip.mockRejectedValueOnce(
        new InstallPhaseError('install', new Error('invalid zip')),
      );

      await expect(downloadUpdate(undefined, statusSpy)).rejects.toEqual(
        expect.objectContaining<Partial<BundleDropError>>({
          code: 'INSTALL_FAILED',
          step: 'install',
        }),
      );
      expect(statusSpy).toHaveBeenCalledWith('❌ OTA update failed (INSTALL_FAILED/install)');
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('wraps download failures with DOWNLOAD_FAILED', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const statusSpy = jest.fn();

    try {
      mockCheckForUpdate.mockResolvedValueOnce({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: 'hash-dl-fail',
        downloadUrl: 'https://cdn.example.com/fail.zip',
      });
      mockInstallFromZip.mockRejectedValueOnce(
        new InstallPhaseError('download', new Error('network timeout')),
      );

      await expect(downloadUpdate(undefined, statusSpy)).rejects.toEqual(
        expect.objectContaining<Partial<BundleDropError>>({
          code: 'DOWNLOAD_FAILED',
          step: 'download',
        }),
      );
      expect(statusSpy).toHaveBeenCalledWith('❌ OTA update failed (DOWNLOAD_FAILED/download)');
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('wraps untagged errors as INSTALL_FAILED and preserves the raw cause', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      mockCheckForUpdate.mockResolvedValueOnce({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: 'hash-raw-err',
        downloadUrl: 'https://cdn.example.com/raw.zip',
      });
      const rawError = new Error('unexpected failure');
      mockInstallFromZip.mockRejectedValueOnce(rawError);

      const rejection = await downloadUpdate().catch((e: unknown) => e) as BundleDropError;
      expect(rejection.code).toBe('INSTALL_FAILED');
      expect(rejection.cause).toBe(rawError);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('installs a bundle directly when the resolved target is provided by the caller', async () => {
    mockInstallFromZip.mockResolvedValue({
      bundlePath: '/mock/doc/bundle-drop/bundles/2222222222222222222222222222222222222222222222222222222222222222/main.jsbundle',
      metadataFromZip: {
        bundleVersion: 11,
        version: '2.0.0',
        runtimeVersion: '2.0.0',
      },
    });

    await expect(
      installBundle('2222222222222222222222222222222222222222222222222222222222222222', 'https://cdn.example.com/direct.zip', 11, '2.0.0', '2.0.0', {
        channelName: 'Beta',
      })
    ).resolves.toEqual({
      status: 'staged',
      bundlePath: '/mock/doc/bundle-drop/bundles/2222222222222222222222222222222222222222222222222222222222222222/main.jsbundle',
      hash: '2222222222222222222222222222222222222222222222222222222222222222',
    });

    expect(mockCheckForUpdate).not.toHaveBeenCalled();
    expect(getMockFile(BUNDLE_INFO_PATH)).toContain('"channelName": "Beta"');
  });

  it('refuses to install a locally failed bundle hash', async () => {
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        failedBundles: {
          'hash-failed': {
            reason: 'crash_loop',
            failedAt: 1000,
          },
        },
      }),
    );
    const statusSpy = jest.fn();

    await expect(
      installBundle('hash-failed', 'https://cdn.example.com/failed.zip', 12, '3.0.0', '1.0.0', {
        channelName: 'Beta',
        onStatusUpdate: statusSpy,
      }),
    ).resolves.toEqual({
      status: 'upToDate',
      reason: 'BUNDLE_PREVIOUSLY_FAILED',
      skippedFailedBundle: true,
      skippedHash: 'hash-failed',
    });

    expect(mockInstallFromZip).not.toHaveBeenCalled();
    expect(readMockJson(CURRENT_POINTER_PATH)).toBeNull();
    expect(statusSpy).toHaveBeenCalledWith(
      '✅ Current bundle retained; selected update previously failed on this device',
    );
  });

  it('rejects install decisions without a server-selected bundleHash before downloading', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      mockCheckForUpdate.mockResolvedValue({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        downloadUrl: 'https://cdn.example.com/metadata-only.zip',
      } as never);
      mockInstallFromZip.mockResolvedValue({
        bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
        metadataFromZip: {
          hash: '3333333333333333333333333333333333333333333333333333333333333333',
          bundleVersion: 12,
          version: '3.1.0',
        },
      });

      await expect(downloadUpdate()).rejects.toEqual(
        expect.objectContaining<Partial<BundleDropError>>({
          code: 'HASH_MISSING',
          step: 'resolve',
        }),
      );
      expect(mockInstallFromZip).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('wraps unexpected persistence errors as UNKNOWN failures', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const statusSpy = jest.fn();
    const writeBundleInfoSpy = jest
      .spyOn(bundleInfoModule, 'writeBundleInfo')
      .mockRejectedValueOnce(new Error('disk full'));

    try {
      mockCheckForUpdate.mockResolvedValue({
        action: 'INSTALL',
        upToDate: false,
        channelName: 'General',
        hash: '4444444444444444444444444444444444444444444444444444444444444444',
        downloadUrl: 'https://cdn.example.com/unknown.zip',
      });
      mockInstallFromZip.mockResolvedValue({
        bundlePath: '/mock/doc/bundle-drop/bundles/4444444444444444444444444444444444444444444444444444444444444444/main.jsbundle',
        metadataFromZip: {
          runtimeVersion: '1.0.0',
        },
      });

      await expect(downloadUpdate(undefined, statusSpy)).rejects.toEqual(
        expect.objectContaining<Partial<BundleDropError>>({
          code: 'UNKNOWN',
          step: 'install',
        }),
      );
      expect(statusSpy).toHaveBeenCalledWith('❌ OTA update failed (UNKNOWN/install)');
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      writeBundleInfoSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});
