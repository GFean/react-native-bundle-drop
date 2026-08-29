import { reportInstalledIfReady, reportLocalRollback } from '../../manager/reporting';
import { setMockConfig } from '../mocks/context';
import { mockReportInstalled, mockReportLocalRollback } from '../mocks/api/clientApi';
import { mockGetDownloadedBundlePathNative } from '../mocks/native/bundleDropNative';
import { readMockJson, setMockFile } from '../mocks/native/fs';
import { initializeBundleDropRuntime, resetBundleDropRuntimeForTests } from '../../runtime/initState';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));
jest.mock('../../api/clientApi', () => require('../mocks/api/clientApi'));
jest.mock('../../native/bundleDropNative', () => require('../mocks/native/bundleDropNative'));

const BUNDLE_INFO_PATH = '/mock/doc/bundle-info.json';
const INSTALL_ID_PATH = '/mock/doc/bundle-drop/install-id.txt';
const USER_PROPERTIES_PATH = '/mock/doc/bundle-drop/user-properties.json';

describe('manager/reporting', () => {
  beforeEach(() => {
    resetBundleDropRuntimeForTests();
  });

  it('skips reporting when the bundle is missing, pending, not active, or already reported', async () => {
    await reportInstalledIfReady({ hasBundle: true, info: null });
    await reportInstalledIfReady({
      hasBundle: true,
      info: { hash: 'hash-1', pendingApply: true },
    });
    await reportInstalledIfReady({
      hasBundle: false,
      info: { hash: 'hash-1', pendingApply: false },
    });
    await reportInstalledIfReady({
      hasBundle: true,
      info: {
        hash: 'hash-1',
        pendingApply: false,
        lastInstalledReportedHash: 'hash-1',
      },
    });
    await reportInstalledIfReady({
      hasBundle: true,
      info: {
        hash: 'hash-1',
        pendingApply: false,
        installedReportedHashes: ['hash-1'],
      },
    });

    expect(mockReportInstalled).not.toHaveBeenCalled();
  });

  it('reports the installed bundle with install id and user properties, then marks it as reported', async () => {
    setMockConfig({
      project: {
        name: 'Bundle Drop',
        slug: 'bundle-drop-app',
        apiKey: 'test-api-key',
      },
    });
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: 'hash-2',
        channelName: 'General',
        platform: 'android',
        pendingApply: false,
        runtimeVersion: '2.0.0',
        installedReportedHashes: ['hash-old'],
      })
    );
    setMockFile(INSTALL_ID_PATH, 'install-xyz');
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          tier: 'beta',
          age: 33,
          preview: true,
        },
      })
    );
    mockGetDownloadedBundlePathNative.mockResolvedValue('/mock/doc/bundle-drop/bundles/hash-2/main.jsbundle');
    mockReportInstalled.mockResolvedValue({ data: undefined } as never);

    await reportInstalledIfReady();

    expect(mockReportInstalled).toHaveBeenCalledWith('bundle-drop-app', 'hash-2', {
      channelName: 'General',
      platform: 'android',
      installId: 'install-xyz',
      runtimeVersion: '2.0.0',
      environment: null,
      userProperties: {
        tier: 'beta',
        age: 33,
        preview: true,
      },
    });
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        lastInstalledReportedHash: 'hash-2',
        installedReportedHashes: ['hash-old', 'hash-2'],
      })
    );
  });

  it('dedupes concurrent installed reports for the same bundle hash', async () => {
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: 'hash-concurrent',
        channelName: 'General',
        platform: 'android',
        pendingApply: false,
      }),
    );
    setMockFile(INSTALL_ID_PATH, 'install-concurrent');
    mockGetDownloadedBundlePathNative.mockResolvedValue('/mock/doc/bundle-drop/bundles/hash-concurrent/main.jsbundle');

    let finishReport: ((value: { data: undefined }) => void) | undefined;
    let markReportStarted: (() => void) | undefined;
    const reportStarted = new Promise<void>(resolve => {
      markReportStarted = resolve;
    });
    mockReportInstalled.mockImplementationOnce(
      () => new Promise(resolve => {
        finishReport = resolve;
        markReportStarted?.();
      }) as never,
    );

    const firstReport = reportInstalledIfReady();
    await reportStarted;
    const secondReport = reportInstalledIfReady();
    finishReport?.({ data: undefined });
    await Promise.all([firstReport, secondReport]);

    expect(mockReportInstalled).toHaveBeenCalledTimes(1);
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        lastInstalledReportedHash: 'hash-concurrent',
        installedReportedHashes: ['hash-concurrent'],
      }),
    );
  });

  it('does not overwrite the report marker when active metadata changes during reporting', async () => {
    setMockConfig({
      project: {
        name: 'Bundle Drop',
        slug: 'bundle-drop-app',
        apiKey: 'test-api-key',
      },
    });
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: 'hash-candidate',
        channelName: 'General',
        platform: 'ios',
        pendingApply: false,
      }),
    );
    setMockFile(INSTALL_ID_PATH, 'install-race');
    mockGetDownloadedBundlePathNative.mockResolvedValue('/mock/doc/bundle-drop/bundles/hash-candidate/main.jsbundle');
    mockReportInstalled.mockImplementationOnce(async () => {
      setMockFile(
        BUNDLE_INFO_PATH,
        JSON.stringify({
          hash: 'hash-previous',
          channelName: 'General',
          platform: 'ios',
          pendingApply: false,
          lastInstalledReportedHash: 'hash-previous',
        }),
      );
      return { data: undefined } as never;
    });

    await reportInstalledIfReady();

    expect(mockReportInstalled).toHaveBeenCalledWith('bundle-drop-app', 'hash-candidate', {
      channelName: 'General',
      platform: 'ios',
      installId: 'install-race',
      runtimeVersion: '1.0.0',
      environment: null,
      userProperties: undefined,
    });
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        hash: 'hash-previous',
        lastInstalledReportedHash: 'hash-previous',
        installedReportedHashes: ['hash-candidate'],
      }),
    );
  });

  it('falls back to the runtime version from context and swallows report errors', async () => {
    setMockConfig({
      runtimeVersion: {
        ios: '3.0.0',
        android: '3.1.0',
      },
    });
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: 'hash-3',
        channelName: 'Beta',
        platform: 'android',
        pendingApply: false,
      })
    );
    setMockFile(INSTALL_ID_PATH, 'install-runtime-fallback');
    mockGetDownloadedBundlePathNative.mockResolvedValue('/mock/doc/bundle-drop/bundles/hash-3/main.jsbundle');

    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockReportInstalled.mockRejectedValue(new Error('report failed'));

    await reportInstalledIfReady();

    expect(mockReportInstalled).toHaveBeenCalledWith('bundle-drop-app', 'hash-3', {
      channelName: 'Beta',
      platform: 'android',
      installId: 'install-runtime-fallback',
      runtimeVersion: '3.1.0',
      environment: null,
      userProperties: undefined,
    });
    expect(consoleSpy).toHaveBeenCalled();
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.not.objectContaining({
        lastInstalledReportedHash: 'hash-3',
      })
    );
  });

  it('reports a null runtime version and logs raw non-Error failures', async () => {
    const contextModule = require('../mocks/context') as typeof import('../mocks/context') & {
      runtimeVersion?: string;
    };
    setMockConfig({
      runtimeVersion: undefined,
      project: {
        name: 'Bundle Drop',
        slug: 'bundle-drop-app',
      },
    });
    contextModule.runtimeVersion = undefined;
    setMockFile(INSTALL_ID_PATH, 'install-null-runtime');
    mockReportInstalled.mockRejectedValue(null);
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await reportInstalledIfReady({
      hasBundle: true,
      info: {
        hash: 'hash-raw-error',
        channelName: 'General',
        platform: 'ios',
        pendingApply: false,
      },
    });

    expect(mockReportInstalled).toHaveBeenCalledWith('bundle-drop-app', 'hash-raw-error', {
      channelName: 'General',
      platform: 'ios',
      installId: 'install-null-runtime',
      runtimeVersion: null,
      environment: null,
      userProperties: undefined,
    });
    expect(consoleSpy).toHaveBeenCalledWith('⚠️ Failed to report bundle install:', null);
    consoleSpy.mockRestore();
  });

  it('reports initialized runtime environment with install telemetry', async () => {
    initializeBundleDropRuntime({
      environment: 'production',
    });
    setMockFile(INSTALL_ID_PATH, 'install-env');
    mockGetDownloadedBundlePathNative.mockResolvedValue(
      '/mock/doc/bundle-drop/bundles/hash-env/main.jsbundle',
    );
    mockReportInstalled.mockResolvedValue({ data: undefined } as never);

    await reportInstalledIfReady({
      hasBundle: true,
      info: {
        hash: 'hash-env',
        channelName: 'General',
        platform: 'android',
        pendingApply: false,
        runtimeVersion: '1.0.0',
      },
    });

    expect(mockReportInstalled).toHaveBeenCalledWith('bundle-drop-app', 'hash-env', {
      channelName: 'General',
      platform: 'android',
      installId: 'install-env',
      runtimeVersion: '1.0.0',
      environment: 'production',
      userProperties: undefined,
    });
  });

  it('reports local rollback telemetry with empty optional context', async () => {
    setMockFile(INSTALL_ID_PATH, 'install-minimal');
    mockReportLocalRollback.mockResolvedValue({ data: undefined } as never);

    await reportLocalRollback('hash-minimal', {
      reason: 'crash_loop',
      failedAt: 0,
    });

    expect(mockReportLocalRollback).toHaveBeenCalledWith('bundle-drop-app', 'hash-minimal', {
      reason: 'crash_loop',
      previousHash: null,
      channelName: null,
      platform: 'android',
      installId: 'install-minimal',
      runtimeVersion: '1.0.0',
      environment: null,
      userProperties: undefined,
      crashCount: null,
      failedAt: null,
    });
  });

  it('reports local rollback telemetry with a null runtime when no fallback exists', async () => {
    const contextModule = require('../mocks/context') as typeof import('../mocks/context') & {
      runtimeVersion?: string;
    };
    contextModule.runtimeVersion = undefined;
    setMockFile(INSTALL_ID_PATH, 'install-rollback-null-runtime');
    mockReportLocalRollback.mockResolvedValue({ data: undefined } as never);

    await reportLocalRollback('hash-rollback-null-runtime', {
      reason: 'crash_loop',
      failedAt: 0,
    });

    expect(mockReportLocalRollback).toHaveBeenCalledWith('bundle-drop-app', 'hash-rollback-null-runtime', {
      reason: 'crash_loop',
      previousHash: null,
      channelName: null,
      platform: 'android',
      installId: 'install-rollback-null-runtime',
      runtimeVersion: null,
      environment: null,
      userProperties: undefined,
      crashCount: null,
      failedAt: null,
    });
  });

  it('reports local rollback health telemetry and propagates delivery failures', async () => {
    initializeBundleDropRuntime({
      environment: 'production',
    });
    setMockFile(INSTALL_ID_PATH, 'install-rollback');
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          tier: 'beta',
        },
      }),
    );
    mockReportLocalRollback.mockResolvedValue({ data: undefined } as never);

    await reportLocalRollback('hash-bad', {
      reason: 'crash_loop',
      failedAt: 1_000,
      crashCount: 3,
      channelName: 'General',
      runtimeVersion: '2.0.0',
      previousHash: 'hash-prev',
    });

    expect(mockReportLocalRollback).toHaveBeenCalledWith('bundle-drop-app', 'hash-bad', {
      reason: 'crash_loop',
      previousHash: 'hash-prev',
      channelName: 'General',
      platform: 'android',
      installId: 'install-rollback',
      runtimeVersion: '2.0.0',
      environment: 'production',
      userProperties: {
        tier: 'beta',
      },
      crashCount: 3,
      failedAt: '1970-01-01T00:16:40.000Z',
    });

    mockReportLocalRollback.mockRejectedValueOnce(null);
    await expect(
      reportLocalRollback('hash-bad', {
        reason: 'crash_loop',
        failedAt: 1_000,
      }),
    ).rejects.toBeNull();
  });
});
