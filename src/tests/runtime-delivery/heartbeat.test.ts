jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));
jest.mock('../../api/clientApi', () => require('../mocks/api/clientApi'));

import {
  reportActiveInstallWhenDue,
  resetRuntimeDeliveryHeartbeatForTests,
} from '../../runtime-delivery/heartbeat';
import { mockPostOtaActiveInstallHeartbeat } from '../mocks/api/clientApi';
import {
  mockWriteFile,
  resetNativeFsMocks,
  setMockFile,
} from '../mocks/native/fs';

const HEARTBEAT_STATE_PATH = '/mock/doc/bundle-drop/runtime-delivery-heartbeats.json';

const flushAsyncWork = () => new Promise(resolve => setTimeout(resolve, 0));

describe('runtime-delivery/heartbeat', () => {
  beforeEach(() => {
    resetNativeFsMocks();
    resetRuntimeDeliveryHeartbeatForTests();
    mockPostOtaActiveInstallHeartbeat.mockReset().mockResolvedValue({ data: undefined } as never);
  });

  it('reports unchanged v2 install state at most once per persisted seven-day window', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const payload = {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: '1.0.0',
      installId: 'install-1',
      currentHash: null,
      environment: 'production',
    };
    reportActiveInstallWhenDue('project', payload);
    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_800_000_000_000 + 24 * 60 * 60 * 1000);
    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_800_000_000_000 + 7 * 24 * 60 * 60 * 1000 - 1);
    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_800_000_000_000 + 7 * 24 * 60 * 60 * 1000);
    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('reports state changes immediately but ignores user-property key order', async () => {
    const payload = {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: '1.0.0',
      installId: 'install-1',
      currentHash: 'a'.repeat(64),
      environment: 'production',
      userProperties: { cohort: 'beta', enabled: true },
    };
    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();

    reportActiveInstallWhenDue('project', {
      ...payload,
      userProperties: { enabled: true, cohort: 'beta' },
    });
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(1);

    reportActiveInstallWhenDue('project', { ...payload, currentHash: 'b'.repeat(64) });
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(2);

    reportActiveInstallWhenDue('project', {
      ...payload,
      currentHash: 'b'.repeat(64),
      userProperties: { cohort: 'stable', enabled: true },
    });
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(3);

    reportActiveInstallWhenDue('project', {
      ...payload,
      currentHash: 'b'.repeat(64),
      environment: 'preview',
      userProperties: { cohort: 'stable', enabled: true },
    });
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(4);
  });

  it('upgrades a legacy cache and reports when its timestamp is missing', async () => {
    const payload = {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: '1.0.0',
      installId: 'install-1',
      currentHash: null,
    };
    const fingerprint = require('crypto')
      .createHash('sha256')
      .update(JSON.stringify({ currentHash: null, environment: null, userProperties: null }))
      .digest('hex');
    setMockFile(HEARTBEAT_STATE_PATH, JSON.stringify({
      schemaVersion: 1,
      reportedAt: {},
      fingerprints: {
        'project/General/android/1.0.0/install-1': fingerprint,
      },
    }));

    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(1);

    setMockFile(HEARTBEAT_STATE_PATH, JSON.stringify({ schemaVersion: 1, reportedAt: {} }));
    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('does not make heartbeat failure authoritative and retries later', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPostOtaActiveInstallHeartbeat.mockRejectedValueOnce(new Error('offline'));
    const payload = {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: '1.0.0',
      installId: 'install-1',
      currentHash: null,
    };
    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();
    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();
    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('recovers the serialized state queue after a cache write fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockWriteFile
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'));
    const payload = {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: '1.0.0',
      installId: 'install-1',
      currentHash: null,
    };

    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();
    reportActiveInstallWhenDue('project', payload);
    await flushAsyncWork();

    expect(mockPostOtaActiveInstallHeartbeat).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
