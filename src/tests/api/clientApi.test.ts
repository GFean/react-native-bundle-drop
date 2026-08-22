import type { AxiosResponse } from 'axios';

jest.mock('../../context', () => require('../mocks/context'));

type ClientApiModule = typeof import('../../api/clientApi');
type ClientModule = typeof import('../../api/client');

const apiResponse = <T>(data: T): AxiosResponse<T> => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: {},
  config: {} as never,
});

const loadClientApiModule = () => {
  jest.resetModules();
  const client = require('../../api/client') as ClientModule;
  const clientApi = require('../../api/clientApi') as ClientApiModule;
  return { clientApi, apiClient: client.apiClient };
};

describe('api/clientApi', () => {
  it('posts OTA resolve requests with encoded slugs and JSON headers', async () => {
    const { clientApi, apiClient } = loadClientApiModule();
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue(
      apiResponse({ action: 'NOOP' as const, reason: 'UP_TO_DATE' as const }),
    );

    await clientApi.postOtaResolve('my project', {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: '1.0.0',
      environment: null,
      currentHash: null,
      currentUserProperties: { age: 33, beta: true, plan: 'pro' },
      rejectedHashes: ['bad-hash'],
      installId: 'install-1',
      transport: {
        manifestVersion: 1,
        patchAlgorithms: ['xdelta3-vcdiff'],
        supportsContentAddressedAssets: true,
      },
    });

    expect(post).toHaveBeenCalledWith(
      '/projects/my%20project/ota/resolve',
      expect.objectContaining({
        installId: 'install-1',
        currentUserProperties: { age: 33, beta: true, plan: 'pro' },
        rejectedHashes: ['bad-hash'],
      }),
      {
        headers: {
          Accept: 'application/json',
        },
        timeout: 15000,
      }
    );
  });

  it('uses the shared artifact-authorization and throttled heartbeat contracts exactly', async () => {
    const { clientApi, apiClient } = loadClientApiModule();
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue(apiResponse({ action: 'NOOP' }));
    const authorization = {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: '1.0.0',
      generation: 7,
      targetReleaseRef: 'release-7',
      targetHash: 'a'.repeat(64),
      mode: 'patch' as const,
      patchArtifactRef: 'patch-6-7',
      currentHash: 'b'.repeat(64),
      rejectedHashes: ['c'.repeat(64)],
      installId: 'install-7',
      transport: {
        manifestVersion: 1 as const,
        patchAlgorithms: ['xdelta3-vcdiff'],
        supportsContentAddressedAssets: true,
      },
    };
    await clientApi.postOtaArtifactAuthorization('team/app', authorization);
    expect(post).toHaveBeenCalledWith(
      '/projects/team%2Fapp/ota/artifacts/authorize',
      authorization,
      { headers: { Accept: 'application/json' }, timeout: 15000 },
    );

    const heartbeat = {
      channelName: 'General',
      platform: 'android',
      runtimeVersion: '1.0.0',
      installId: 'install-7',
      currentHash: 'b'.repeat(64),
      environment: 'production',
    };
    await clientApi.postOtaActiveInstallHeartbeat('team/app', heartbeat);
    expect(post).toHaveBeenCalledWith(
      '/projects/team%2Fapp/ota/active-install',
      heartbeat,
      { headers: { Accept: 'application/json' }, timeout: 3000 },
    );
  });

  it('calls the public channel and installed-report endpoints with encoded params', async () => {
    const { clientApi, apiClient } = loadClientApiModule();
    const get = jest.spyOn(apiClient, 'get').mockResolvedValue(apiResponse(['General']));
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue(apiResponse(undefined));

    await clientApi.getPublicChannels({ projectSlug: 'team/app' });
    await clientApi.reportInstalled('team/app', 'hash/1', {
      channelName: 'General',
      platform: 'ios',
      installId: 'install-2',
      runtimeVersion: '2.0.0',
      userProperties: { age: 33, beta: true, plan: 'pro' },
    });
    await clientApi.reportLocalRollback('team/app', 'hash/1', {
      reason: 'crash_loop',
      channelName: 'General',
      platform: 'ios',
      installId: 'install-2',
      runtimeVersion: '2.0.0',
      previousHash: 'hash-0',
    });
    await clientApi.reportPatchApplyFailure('team/app', {
      platform: 'ios',
      runtimeVersion: '2.0.0',
      installId: 'install-2',
      baseHash: 'hash-0',
      targetHash: 'hash-1',
      reason: 'xdelta failed',
    });

    expect(get).toHaveBeenCalledWith('/projects/team%2Fapp/channels/public', {
      headers: {
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    expect(post).toHaveBeenCalledWith(
      '/projects/team%2Fapp/bundle/hash%2F1/installed',
      {
        channelName: 'General',
        platform: 'ios',
        installId: 'install-2',
        runtimeVersion: '2.0.0',
        userProperties: { age: 33, beta: true, plan: 'pro' },
      },
      {
        headers: {
          Accept: 'application/json',
        },
        timeout: 3000,
      }
    );
    expect(post).toHaveBeenCalledWith(
      '/projects/team%2Fapp/bundle/hash%2F1/local-rollback-report',
      {
        reason: 'crash_loop',
        channelName: 'General',
        platform: 'ios',
        installId: 'install-2',
        runtimeVersion: '2.0.0',
        previousHash: 'hash-0',
      },
      {
        headers: {
          Accept: 'application/json',
        },
        timeout: 10000,
      }
    );
    expect(post).toHaveBeenCalledWith(
      '/projects/team%2Fapp/ota/patch/apply-failure',
      {
        platform: 'ios',
        runtimeVersion: '2.0.0',
        installId: 'install-2',
        baseHash: 'hash-0',
        targetHash: 'hash-1',
        reason: 'xdelta failed',
      },
      {
        headers: {
          Accept: 'application/json',
        },
        timeout: 3000,
      }
    );
  });

  it('builds the bundle list query string from the provided filters', async () => {
    const { clientApi, apiClient } = loadClientApiModule();
    const get = jest.spyOn(apiClient, 'get').mockResolvedValue(apiResponse({
      items: [],
      nextCursor: null,
      hasMore: false,
    }));

    await clientApi.getBundleList('demo project', {
      channelName: 'Beta Users',
      platform: 'android',
      limit: 50,
      cursor: 'next/123',
    });

    expect(get).toHaveBeenCalledWith(
      '/projects/demo%20project/bundle/list?channelName=Beta%20Users&platform=android&limit=50&cursor=next%2F123',
      {
        headers: { Accept: 'application/json' },
        timeout: 15000,
      }
    );
  });
});
