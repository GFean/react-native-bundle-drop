import {
  commitActiveBundle,
  evaluateRollbackOnLaunch,
  getRollbackPolicy,
  isBundleHashFailed,
  markCandidateActivated,
  readRollbackState,
  reportActiveBundleHealthy,
  rollbackToPreviousIfNeeded,
  rollbackToPreviousOrNative,
} from '../../manager/rollbackState';
import { reportLocalRollback } from '../../manager/reporting';
import { resetContextMocks, setMockConfig, setMockPlatform } from '../mocks/context';
import {
  getMockFile,
  mockReadFile,
  mockUnlink,
  mockWriteFile,
  readMockJson,
  resetNativeFsMocks,
  setMockFile,
} from '../mocks/native/fs';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));
jest.mock('../../manager/reporting', () => ({
  reportLocalRollback: jest.fn(async () => undefined),
}));

const CURRENT_POINTER_PATH = '/mock/doc/bundle-drop/current.json';
const PREVIOUS_POINTER_PATH = '/mock/doc/bundle-drop/previous.json';
const STATE_PATH = '/mock/doc/bundle-drop/state.json';
const BUNDLE_INFO_PATH = '/mock/doc/bundle-info.json';

const DEFAULT_POLICY = { maxCrashCount: 3, healthCheckMode: 'auto' as const, healthyAfterSec: 0 };

describe('manager/rollbackState', () => {
  beforeEach(() => {
    resetContextMocks();
    resetNativeFsMocks();
    (reportLocalRollback as jest.Mock).mockReset();
    (reportLocalRollback as jest.Mock).mockResolvedValue(undefined);
  });

  it('marks a newly activated candidate and tracks the previous hash', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
        bundlePath: '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );

    await markCandidateActivated('2222222222222222222222222222222222222222222222222222222222222222');

    expect(readMockJson(STATE_PATH)).toEqual({
      activeHash: '2222222222222222222222222222222222222222222222222222222222222222',
      candidateHash: '2222222222222222222222222222222222222222222222222222222222222222',
      candidateActivatedAt: 1000,
      candidateCommitted: false,
      crashCount: 0,
      lastLaunchAt: 1000,
      lastGoodHash: '1111111111111111111111111111111111111111111111111111111111111111',
    });

    nowSpy.mockRestore();
  });

  it('returns null when rollback state is missing or malformed', async () => {
    await expect(readRollbackState()).resolves.toBeNull();

    setMockFile(STATE_PATH, '{invalid json');
    await expect(readRollbackState()).resolves.toBeNull();
  });

  it('commits the active bundle as the last good hash', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);

    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
      }),
    );

    await commitActiveBundle();

    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        activeHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: true,
        crashCount: 0,
        lastGoodHash: '3333333333333333333333333333333333333333333333333333333333333333',
      })
    );

    nowSpy.mockRestore();
  });

  it('commits cached pointers and skips empty current pointers', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(3_000_000);

    await commitActiveBundle({ currentPointer: null });
    expect(readMockJson(STATE_PATH)).toBeNull();

    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '4444444444444444444444444444444444444444444444444444444444444444',
        candidateCommitted: false,
      }),
    );
    await commitActiveBundle({
      currentPointer: {
        hash: '4444444444444444444444444444444444444444444444444444444444444444',
        bundlePath: '/mock/doc/bundle-drop/bundles/4444444444444444444444444444444444444444444444444444444444444444/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    });
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        activeHash: '4444444444444444444444444444444444444444444444444444444444444444',
        candidateHash: '4444444444444444444444444444444444444444444444444444444444444444',
        candidateCommitted: true,
        lastGoodHash: '4444444444444444444444444444444444444444444444444444444444444444',
      }),
    );

    nowSpy.mockRestore();
  });

  it('does not mark non-candidates healthy and ignores mismatched expected hashes', async () => {
    await expect(reportActiveBundleHealthy({ currentPointer: null })).resolves.toBe(false);
    await expect(isBundleHashFailed(null)).resolves.toBe(false);

    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
      }),
    );

    await expect(
      reportActiveBundleHealthy(
        {
          currentPointer: {
            hash: '3333333333333333333333333333333333333333333333333333333333333333',
            bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
        },
        'other-hash',
      ),
    ).resolves.toBe(false);

    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: 'other-hash',
        candidateCommitted: false,
      }),
    );
    await expect(
      reportActiveBundleHealthy({
        currentPointer: {
          hash: '3333333333333333333333333333333333333333333333333333333333333333',
          bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
      }),
    ).resolves.toBe(false);

    resetNativeFsMocks();
    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    await expect(reportActiveBundleHealthy()).resolves.toBe(false);
  });

  it('requests rollback once failed candidate launches reach the crash limit', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000_000);

    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
        crashCount: 1,
        candidateActivatedAt: 10000,
      })
    );

    await expect(
      evaluateRollbackOnLaunch({
        maxCrashCount: 2,
        healthCheckMode: 'auto',
        healthyAfterSec: 0,
      })
    ).resolves.toEqual({
      shouldRollback: true,
      reason: 'crash_loop',
    });

    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
        crashCount: 0,
        candidateActivatedAt: 9500,
      })
    );

    await expect(
      evaluateRollbackOnLaunch({
        maxCrashCount: 5,
        healthCheckMode: 'auto',
        healthyAfterSec: 0,
      })
    ).resolves.toEqual({ shouldRollback: false });

    nowSpy.mockRestore();
  });

  it('returns no rollback when there is no active pointer or the crash limit is not reached', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(40_000_000);

    await expect(
      evaluateRollbackOnLaunch(DEFAULT_POLICY, {
        currentPointer: null,
      }),
    ).resolves.toEqual({ shouldRollback: false });
    expect(readMockJson(STATE_PATH)).toBeNull();

    await expect(
      evaluateRollbackOnLaunch(DEFAULT_POLICY, {
        currentPointer: {
          hash: '3333333333333333333333333333333333333333333333333333333333333333',
          bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
        rollbackState: {
          candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
          candidateCommitted: false,
          crashCount: 1,
        },
      }),
    ).resolves.toEqual({ shouldRollback: false });
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        activeHash: '3333333333333333333333333333333333333333333333333333333333333333',
        crashCount: 2,
        lastLaunchAt: 40000,
      }),
    );

    nowSpy.mockRestore();
  });

  it('returns no rollback for safe launches and exposes the configured rollback policy', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(50_000_000);

    setMockConfig({
      rollback: {
        maxCrashCount: 7,
        healthCheckMode: 'manual',
        healthyAfterSec: 12,
      },
    });
    expect(getRollbackPolicy()).toEqual({
      maxCrashCount: 7,
      healthCheckMode: 'manual',
      healthyAfterSec: 12,
    });

    await expect(
      rollbackToPreviousIfNeeded(DEFAULT_POLICY, {
        currentPointer: {
          hash: '3333333333333333333333333333333333333333333333333333333333333333',
          bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
        rollbackState: {
          candidateHash: 'other-hash',
          candidateCommitted: false,
        },
      }),
    ).resolves.toEqual({ rolledBack: false });
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        activeHash: '3333333333333333333333333333333333333333333333333333333333333333',
        lastLaunchAt: 50000,
      }),
    );

    nowSpy.mockRestore();
  });

  it('reads persisted rollback state and increments the candidate launch count', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(60_000_000);

    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
        candidateActivatedAt: 59990,
      }),
    );

    await expect(
      evaluateRollbackOnLaunch(DEFAULT_POLICY, {
        currentPointer: {
          hash: '3333333333333333333333333333333333333333333333333333333333333333',
          bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
      }),
    ).resolves.toEqual({ shouldRollback: false });
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        activeHash: '3333333333333333333333333333333333333333333333333333333333333333',
        crashCount: 1,
        lastLaunchAt: 60000,
      }),
    );

    nowSpy.mockRestore();
  });

  it('rolls back to the previous OTA bundle and restores metadata', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(20_000_000);

    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        lastInstalledReportedHash: '3333333333333333333333333333333333333333333333333333333333333333',
      }),
    );
    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
        bundlePath: '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );
    setMockFile(
      '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/metadata-android.json',
      JSON.stringify({
        bundleVersion: 3,
        version: 'metadata-version',
        runtimeVersion: 'metadata-runtime',
      })
    );
    setMockFile(
      '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/bundle-manifest.json',
      JSON.stringify({
        manifestVersion: 1,
        bundleHash: '1111111111111111111111111111111111111111111111111111111111111111',
        version: '1.0.3',
        runtimeVersion: '1.0.0',
      }),
    );

    await expect(rollbackToPreviousOrNative()).resolves.toEqual({ rolledBack: true });

    expect(readMockJson(CURRENT_POINTER_PATH)).toEqual(
      expect.objectContaining({
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
      })
    );
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
        bundleVersion: 3,
        version: '1.0.3',
        runtimeVersion: '1.0.0',
        pendingApply: false,
        lastInstalledReportedHash: '1111111111111111111111111111111111111111111111111111111111111111',
      })
    );
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        activeHash: '1111111111111111111111111111111111111111111111111111111111111111',
        candidateHash: '1111111111111111111111111111111111111111111111111111111111111111',
        candidateCommitted: true,
        lastGoodHash: '1111111111111111111111111111111111111111111111111111111111111111',
      })
    );

    nowSpy.mockRestore();
  });

  it('rolls back through the previous-pointer flow when launch evaluation demands it', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(25_000_000);

    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
        bundlePath: '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    setMockFile(
      '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/metadata-android.json',
      JSON.stringify({
        bundleVersion: 9,
        version: '2.0.0',
        runtimeVersion: '2.0.0',
      }),
    );

    await expect(
      rollbackToPreviousIfNeeded(
        {
          maxCrashCount: 2,
          healthCheckMode: 'auto',
          healthyAfterSec: 0,
        },
        {
          currentPointer: {
            hash: '3333333333333333333333333333333333333333333333333333333333333333',
            bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          rollbackState: {
            candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
            candidateCommitted: false,
            crashCount: 1,
            candidateActivatedAt: 25000,
          },
        },
      ),
    ).resolves.toEqual({
      rolledBack: true,
      reason: 'crash_loop',
    });
    expect(await isBundleHashFailed('3333333333333333333333333333333333333333333333333333333333333333')).toBe(true);
    expect(reportLocalRollback).toHaveBeenCalledWith(
      '3333333333333333333333333333333333333333333333333333333333333333',
      expect.objectContaining({
        reason: 'crash_loop',
        previousHash: '1111111111111111111111111111111111111111111111111111111111111111',
      }),
    );
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        activeHash: '1111111111111111111111111111111111111111111111111111111111111111',
        candidateHash: '1111111111111111111111111111111111111111111111111111111111111111',
        candidateCommitted: true,
        lastGoodHash: '1111111111111111111111111111111111111111111111111111111111111111',
        failedBundles: expect.objectContaining({
          '3333333333333333333333333333333333333333333333333333333333333333': expect.objectContaining({
            reason: 'crash_loop',
            previousHash: '1111111111111111111111111111111111111111111111111111111111111111',
          }),
        }),
      }),
    );

    nowSpy.mockRestore();
  });

  it('waits for local rollback telemetry before resolving rollback', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(26_000_000);
    let finishReport!: () => void;
    const reportPromise = new Promise<void>(resolve => {
      finishReport = resolve;
    });
    (reportLocalRollback as jest.Mock).mockReturnValueOnce(reportPromise);

    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
        bundlePath: '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );

    const rollbackPromise = rollbackToPreviousIfNeeded(
      {
        maxCrashCount: 2,
        healthCheckMode: 'auto',
        healthyAfterSec: 0,
      },
      {
        currentPointer: {
          hash: '3333333333333333333333333333333333333333333333333333333333333333',
          bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
        rollbackState: {
          candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
          candidateCommitted: false,
          crashCount: 1,
        },
      },
    );

    await Promise.resolve();
    let resolved = false;
    rollbackPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    finishReport();
    await expect(rollbackPromise).resolves.toEqual({
      rolledBack: true,
      reason: 'crash_loop',
    });

    nowSpy.mockRestore();
  });

  it('keeps only the newest failed bundle quarantine records', async () => {
    const failedBundles = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `old-${index}`,
        {
          reason: 'crash_loop',
          failedAt: index + 1,
        },
      ]),
    );
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
        crashCount: 1,
        failedBundles,
      }),
    );
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        channelName: 'General',
        runtimeVersion: '1.0.0',
      }),
    );

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(70_000_000);
    await rollbackToPreviousIfNeeded(
      { maxCrashCount: 2, healthCheckMode: 'auto', healthyAfterSec: 0 },
      {
        currentPointer: {
          hash: '3333333333333333333333333333333333333333333333333333333333333333',
          bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
        rollbackState: {
          candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
          candidateCommitted: false,
          crashCount: 1,
        },
      },
    );

    const state = readMockJson<{ failedBundles: Record<string, unknown> }>(STATE_PATH);
    expect(Object.keys(state?.failedBundles || {})).toHaveLength(20);
    expect(state?.failedBundles).toHaveProperty('3333333333333333333333333333333333333333333333333333333333333333');
    expect(state?.failedBundles).not.toHaveProperty('old-0');
    nowSpy.mockRestore();
  });

  it('records failed bundles when rollback evaluation reads the current pointer itself', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(80_000_000);

    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
        crashCount: 1,
      }),
    );

    await expect(
      rollbackToPreviousIfNeeded({
        maxCrashCount: 2,
        healthCheckMode: 'auto',
        healthyAfterSec: 0,
      }),
    ).resolves.toEqual({
      rolledBack: true,
      reason: 'crash_loop',
    });

    await expect(isBundleHashFailed('3333333333333333333333333333333333333333333333333333333333333333')).resolves.toBe(true);
    nowSpy.mockRestore();
  });

  it('does not roll back when the active pointer disappears after launch evaluation', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(90_000_000);
    const readFileImplementation = mockReadFile.getMockImplementation();
    let currentPointerReads = 0;

    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
        crashCount: 1,
      }),
    );
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === CURRENT_POINTER_PATH) {
        currentPointerReads += 1;
        if (currentPointerReads > 1) {
          throw new Error('ENOENT');
        }
      }
      const content = getMockFile(path);
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    });

    try {
      await expect(
        rollbackToPreviousIfNeeded({
          maxCrashCount: 2,
          healthCheckMode: 'auto',
          healthyAfterSec: 0,
        }),
      ).resolves.toEqual({ rolledBack: false });
      expect(reportLocalRollback).not.toHaveBeenCalled();
    } finally {
      if (readFileImplementation) {
        mockReadFile.mockImplementation(readFileImplementation);
      }
      nowSpy.mockRestore();
    }
  });

  it('does not quarantine the candidate when the local rollback write fails', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(92_000_000);
    const writeFileImplementation = mockWriteFile.getMockImplementation();

    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: '1111111111111111111111111111111111111111111111111111111111111111',
        bundlePath: '/mock/doc/bundle-drop/bundles/1111111111111111111111111111111111111111111111111111111111111111/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
        crashCount: 1,
      }),
    );
    mockWriteFile.mockImplementation(async (path: string) => {
      if (path.includes('current.json')) {
        throw new Error('disk full');
      }
    });

    try {
      await expect(
        rollbackToPreviousIfNeeded(
          {
            maxCrashCount: 2,
            healthCheckMode: 'auto',
            healthyAfterSec: 0,
          },
          {
            currentPointer: {
              hash: '3333333333333333333333333333333333333333333333333333333333333333',
              bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
              updatedAt: '2026-03-01T00:00:00.000Z',
            },
            rollbackState: {
              candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
              candidateCommitted: false,
              crashCount: 1,
            },
          },
        ),
      ).rejects.toThrow('disk full');
      await expect(isBundleHashFailed('3333333333333333333333333333333333333333333333333333333333333333')).resolves.toBe(false);
      expect(reportLocalRollback).not.toHaveBeenCalled();
    } finally {
      if (writeFileImplementation) {
        mockWriteFile.mockImplementation(writeFileImplementation);
      }
      nowSpy.mockRestore();
    }
  });

  it('does not quarantine the candidate when native fallback pointer clearing fails', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(93_000_000);
    const unlinkImplementation = mockUnlink.getMockImplementation();

    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: '3333333333333333333333333333333333333333333333333333333333333333',
        bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
        candidateCommitted: false,
        crashCount: 1,
      }),
    );
    mockUnlink.mockImplementation(async (path: string) => {
      if (path === CURRENT_POINTER_PATH) {
        throw new Error('permission denied');
      }
      await unlinkImplementation?.(path);
    });

    try {
      await expect(
        rollbackToPreviousIfNeeded({
          maxCrashCount: 2,
          healthCheckMode: 'auto',
          healthyAfterSec: 0,
        }),
      ).rejects.toThrow('permission denied');
      await expect(isBundleHashFailed('3333333333333333333333333333333333333333333333333333333333333333')).resolves.toBe(false);
      expect(reportLocalRollback).not.toHaveBeenCalled();
      expect(getMockFile(CURRENT_POINTER_PATH)).toBeDefined();
    } finally {
      if (unlinkImplementation) {
        mockUnlink.mockImplementation(unlinkImplementation);
      }
      nowSpy.mockRestore();
    }
  });

  it('swallows local rollback telemetry failures', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(95_000_000);
    (reportLocalRollback as jest.Mock).mockRejectedValueOnce(new Error('network down'));

    await expect(
      rollbackToPreviousIfNeeded(
        {
          maxCrashCount: 2,
          healthCheckMode: 'auto',
          healthyAfterSec: 0,
        },
        {
          currentPointer: {
            hash: '3333333333333333333333333333333333333333333333333333333333333333',
            bundlePath: '/mock/doc/bundle-drop/bundles/3333333333333333333333333333333333333333333333333333333333333333/main.jsbundle',
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
          rollbackState: {
            candidateHash: '3333333333333333333333333333333333333333333333333333333333333333',
            candidateCommitted: false,
            crashCount: 1,
          },
        },
      ),
    ).resolves.toEqual({
      rolledBack: true,
      reason: 'crash_loop',
    });
    await Promise.resolve();

    nowSpy.mockRestore();
  });

  it('falls back to the native bundle when there is no previous OTA pointer', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(30_000_000);

    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: '5555555555555555555555555555555555555555555555555555555555555555',
        bundlePath: '/mock/doc/bundle-drop/bundles/5555555555555555555555555555555555555555555555555555555555555555/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: '5555555555555555555555555555555555555555555555555555555555555555',
        bundleVersion: 5,
        pendingApply: true,
      })
    );

    await expect(rollbackToPreviousOrNative()).resolves.toEqual({
      rolledBack: true,
      toNative: true,
    });

    expect(readMockJson(CURRENT_POINTER_PATH)).toBeNull();
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        pendingApply: false,
      })
    );
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        candidateCommitted: true,
        crashCount: 0,
      })
    );

    nowSpy.mockRestore();
  });

  it('forces native rollback instead of activating a previous OTA bundle', async () => {
    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        bundlePath: '/mock/doc/bundle-drop/bundles/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        bundlePath: '/mock/doc/bundle-drop/bundles/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/main.jsbundle',
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
    );

    await expect(
      rollbackToPreviousOrNative({ forceNative: true }),
    ).resolves.toEqual({ rolledBack: true, toNative: true });

    expect(readMockJson(CURRENT_POINTER_PATH)).toBeNull();
    expect(readMockJson(PREVIOUS_POINTER_PATH)).toBeNull();
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({ candidateCommitted: true, crashCount: 0 }),
    );
    expect(readMockJson(STATE_PATH)).not.toHaveProperty('activeHash');
    expect(readMockJson(STATE_PATH)).not.toHaveProperty('candidateHash');
  });

  it('falls back to native when the previous pointer matches the active bundle', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(32_000_000);

    const activePointer = {
      hash: '5555555555555555555555555555555555555555555555555555555555555555',
      bundlePath: '/mock/doc/bundle-drop/bundles/5555555555555555555555555555555555555555555555555555555555555555/main.jsbundle',
      updatedAt: '2026-03-01T00:00:00.000Z',
    };
    setMockFile(CURRENT_POINTER_PATH, JSON.stringify(activePointer));
    setMockFile(PREVIOUS_POINTER_PATH, JSON.stringify(activePointer));
    setMockFile(
      BUNDLE_INFO_PATH,
      JSON.stringify({
        hash: '5555555555555555555555555555555555555555555555555555555555555555',
        bundleVersion: 5,
        pendingApply: false,
      })
    );

    await expect(rollbackToPreviousOrNative()).resolves.toEqual({
      rolledBack: true,
      toNative: true,
    });

    expect(readMockJson(CURRENT_POINTER_PATH)).toBeNull();
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        pendingApply: false,
      })
    );
    expect(readMockJson(BUNDLE_INFO_PATH)).not.toEqual(
      expect.objectContaining({
        hash: '5555555555555555555555555555555555555555555555555555555555555555',
      })
    );
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        candidateCommitted: true,
        crashCount: 0,
      })
    );
    expect(readMockJson(STATE_PATH)).not.toEqual(expect.objectContaining({ activeHash: '5555555555555555555555555555555555555555555555555555555555555555' }));
    expect(readMockJson(STATE_PATH)).not.toEqual(expect.objectContaining({ candidateHash: '5555555555555555555555555555555555555555555555555555555555555555' }));

    nowSpy.mockRestore();
  });

  it('falls back to native and clears previous when the previous bundle previously failed', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(33_000_000);

    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: '5555555555555555555555555555555555555555555555555555555555555555',
        bundlePath: '/mock/doc/bundle-drop/bundles/5555555555555555555555555555555555555555555555555555555555555555/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );
    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: '6666666666666666666666666666666666666666666666666666666666666666',
        bundlePath: '/mock/doc/bundle-drop/bundles/6666666666666666666666666666666666666666666666666666666666666666/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );
    setMockFile(
      STATE_PATH,
      JSON.stringify({
        failedBundles: {
          '6666666666666666666666666666666666666666666666666666666666666666': {
            reason: 'crash_loop',
            failedAt: 32000,
          },
        },
      })
    );

    await expect(rollbackToPreviousOrNative()).resolves.toEqual({
      rolledBack: true,
      toNative: true,
    });

    expect(readMockJson(CURRENT_POINTER_PATH)).toBeNull();
    expect(readMockJson(PREVIOUS_POINTER_PATH)).toBeNull();
    expect(readMockJson(BUNDLE_INFO_PATH)).not.toEqual(
      expect.objectContaining({
        hash: '6666666666666666666666666666666666666666666666666666666666666666',
      })
    );
    expect(readMockJson(STATE_PATH)).toEqual(
      expect.objectContaining({
        failedBundles: expect.objectContaining({
          '6666666666666666666666666666666666666666666666666666666666666666': expect.any(Object),
        }),
        candidateCommitted: true,
        crashCount: 0,
      })
    );
    expect(readMockJson(STATE_PATH)).not.toEqual(expect.objectContaining({ activeHash: '6666666666666666666666666666666666666666666666666666666666666666' }));
    expect(readMockJson(STATE_PATH)).not.toEqual(expect.objectContaining({ candidateHash: '6666666666666666666666666666666666666666666666666666666666666666' }));

    nowSpy.mockRestore();
  });

  it('reads iOS metadata and tolerates missing or malformed rollback metadata', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(35_000_000);

    setMockPlatform('ios');
    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: '7777777777777777777777777777777777777777777777777777777777777777',
        bundlePath: '/mock/lib/bundle-drop/bundles/7777777777777777777777777777777777777777777777777777777777777777/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    setMockFile(
      '/mock/lib/bundle-drop/bundles/7777777777777777777777777777777777777777777777777777777777777777/metadata-ios.json',
      JSON.stringify({
        bundleVersion: 4,
        version: '1.0.4',
        runtimeVersion: '4.0.0',
      }),
    );

    await expect(rollbackToPreviousOrNative()).resolves.toEqual({ rolledBack: true });
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        hash: '7777777777777777777777777777777777777777777777777777777777777777',
        bundleVersion: 4,
        version: '1.0.4',
        runtimeVersion: '4.0.0',
      }),
    );

    resetNativeFsMocks();
    setMockPlatform('android');
    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: '8888888888888888888888888888888888888888888888888888888888888888',
        bundlePath: '/mock/doc/bundle-drop/bundles/8888888888888888888888888888888888888888888888888888888888888888/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    setMockFile(
      '/mock/doc/bundle-drop/bundles/8888888888888888888888888888888888888888888888888888888888888888/metadata-android.json',
      '{bad json',
    );

    await expect(rollbackToPreviousOrNative()).resolves.toEqual({ rolledBack: true });
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        hash: '8888888888888888888888888888888888888888888888888888888888888888',
        pendingApply: false,
      }),
    );
    expect(readMockJson(BUNDLE_INFO_PATH)).not.toHaveProperty('bundleVersion');
    expect(readMockJson(BUNDLE_INFO_PATH)).not.toHaveProperty('version');
    expect(readMockJson(BUNDLE_INFO_PATH)).not.toHaveProperty('runtimeVersion');

    resetNativeFsMocks();
    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: '9999999999999999999999999999999999999999999999999999999999999999',
        bundlePath: '/mock/doc/bundle-drop/bundles/9999999999999999999999999999999999999999999999999999999999999999/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );

    await expect(rollbackToPreviousOrNative()).resolves.toEqual({ rolledBack: true });
    expect(readMockJson(BUNDLE_INFO_PATH)).toEqual(
      expect.objectContaining({
        hash: '9999999999999999999999999999999999999999999999999999999999999999',
        pendingApply: false,
      }),
    );
    expect(readMockJson(BUNDLE_INFO_PATH)).not.toHaveProperty('bundleVersion');
    expect(readMockJson(BUNDLE_INFO_PATH)).not.toHaveProperty('version');
    expect(readMockJson(BUNDLE_INFO_PATH)).not.toHaveProperty('runtimeVersion');

    nowSpy.mockRestore();
  });
});
