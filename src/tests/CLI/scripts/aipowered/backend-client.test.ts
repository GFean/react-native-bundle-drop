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
    })).rejects.toThrow(/^AI setup planning failed$/);

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

  it('prefers bounded sanitized backend details without exposing structured data', async () => {
    mockAxiosNodePost.mockRejectedValueOnce({
      response: {
        status: 424,
        data: {
          error: 'Invalid request.',
          details: {
            reason: 'AI setup plan removed existing native structure: RCTBundleURLProvider',
            ignored: { arbitrary: 'must not be serialized' },
          },
        },
      },
    });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow(
      'AI setup planning failed: AI setup plan removed existing native structure: RCTBundleURLProvider',
    );

    mockAxiosNodePost.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Invalid request.',
          details: { reason: 'Safe reason\u001b[2J\roverwrite\u202e' },
        },
      },
    });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('Safe reason\\x1b[2J\\roverwrite\\u202e');

    mockAxiosNodePost.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Invalid request.',
          details: { reason: { message: 'AI setup plan removed a file' }, source: 'arbitrary' },
        },
      },
    });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('AI setup planning failed: Invalid request.');

    const getterDetails = {};
    Object.defineProperty(getterDetails, 'reason', {
      enumerable: true,
      get: () => {
        throw new Error('must not invoke backend object getters');
      },
    });
    mockAxiosNodePost.mockRejectedValueOnce({
      response: { data: { error: 'Invalid request.', details: getterDetails } },
    });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('AI setup planning failed: Invalid request.');

    mockAxiosNodePost.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Invalid request.',
          details: { reason: 'bdp_proj_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG' },
        },
      },
    });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('AI setup planning failed: Invalid request.');

    mockAxiosNodePost.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Invalid request.',
          details: { reason: 'x'.repeat(1001) },
        },
      },
    });
    await expect(requestAiSetupPlan({
      serverUrl: 'https://api.example.com',
      authToken: 'token',
      request: {} as any,
    })).rejects.toThrow('AI setup planning failed: Invalid request.');
  });
});
