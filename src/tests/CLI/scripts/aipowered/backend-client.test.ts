import { mockAxiosNodePost } from '../../../mocks/modules/axiosNode';

jest.mock('axios', () => require('../../../mocks/modules/axiosNode'));

import { requestAiSetupPlan } from '../../../../CLI/scripts/aipowered/backend-client';

describe('CLI/scripts/aipowered/backend-client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockAxiosNodePost.mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('allows the AI planning timeout to be increased by environment variable', async () => {
    process.env.BUNDLE_DROP_AI_INIT_TIMEOUT_MS = '240000';
    mockAxiosNodePost.mockResolvedValue({
      data: { confidence: 'high', summary: 'ok', actions: [], changes: [], warnings: [] },
    });

    await requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'pat-token',
      request: {} as any,
    });

    expect(mockAxiosNodePost).toHaveBeenCalledWith(
      'https://api.example.com/ai/setup-plan',
      {},
      expect.objectContaining({ timeout: 240000 })
    );
  });

  it('posts typed unified setup requests to the additive setup endpoint', async () => {
    const plan = {
      confidence: 'high' as const,
      summary: 'Expo setup is ready.',
      actions: [{
        type: 'register_expo_plugin' as const,
        reason: 'Register native integration.',
        requiresConfirmation: false,
      }],
      changes: [],
      warnings: [],
    };
    const request = {
      schemaVersion: 1 as const,
      orgSlug: 'alpha-org',
      projectSlug: 'demo-app',
      projectType: 'expo' as const,
      detected: {
        rnVersion: '0.86.0',
        expoSdkVersion: '57.0.0',
        bundleDropStatus: 'partial' as const,
        hasNativeDirectories: false,
        usesExpoRouter: true,
        jsEngine: 'hermes' as const,
        expoUpdatesStatus: 'absent' as const,
        codePushDetected: false,
        signals: ['expoProject'],
      },
      files: [],
    };
    mockAxiosNodePost.mockResolvedValue({ data: plan });

    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'setup-token',
      request,
    })).resolves.toBe(plan);

    expect(mockAxiosNodePost).toHaveBeenCalledWith(
      'https://api.example.com/ai/setup-plan',
      request,
      {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer setup-token',
        },
        timeout: 180000,
      },
    );
  });

  it('ignores the generic timeout environment variable for setup requests', async () => {
    process.env.AI_INIT_TIMEOUT_MS = '210000';
    mockAxiosNodePost.mockResolvedValue({ data: { actions: [], changes: [], warnings: [] } });

    await requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    });

    expect(mockAxiosNodePost).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ timeout: 180000 }),
    );
  });

  it('formats setup timeout and backend failure shapes', async () => {
    mockAxiosNodePost.mockRejectedValueOnce({ code: 'ECONNABORTED' });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('AI setup planning timed out');

    mockAxiosNodePost.mockRejectedValueOnce({ message: 'request timeout' });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('AI setup planning timed out');

    mockAxiosNodePost.mockRejectedValueOnce({ response: { data: { error: 'Not allowed' } } });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('AI setup planning failed: Not allowed');

    mockAxiosNodePost.mockRejectedValueOnce({ response: { data: { code: 'INVALID_SETUP' } } });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('{"code":"INVALID_SETUP"}');

    mockAxiosNodePost.mockRejectedValueOnce({ response: { data: 'maintenance' } });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('maintenance');

    mockAxiosNodePost.mockRejectedValueOnce({});
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('AI setup planning failed');
  });
});
