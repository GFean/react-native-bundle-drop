import { setMockConfig } from '../mocks/context';

jest.mock('../../context', () => require('../mocks/context'));

type ClientModule = typeof import('../../api/client');

const loadClientModule = (
  configure?: (deps: {
    context: typeof import('../mocks/context');
  }) => void
) => {
  jest.resetModules();
  const context = require('../mocks/context') as typeof import('../mocks/context');
  configure?.({ context });
  const client = require('../../api/client') as ClientModule;
  return { client, context };
};

describe('api/client', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends JSON requests to the configured server URL with default headers', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { client } = loadClientModule(({ context }) => {
      context.setMockConfig({
        serverUrl: 'https://bundledrop.app',
        project: {
          name: 'Bundle Drop',
          slug: 'bundle-drop-app',
          apiKey: 'project-key',
        },
      });
    });

    await expect(client.apiClient.post('/ota/resolve', { installId: 'install-1' }, {
      headers: { Accept: 'application/json' },
      timeout: 15000,
    })).resolves.toMatchObject({
      data: { ok: true },
      status: 200,
    });

    expect(fetchMock).toHaveBeenCalledWith('https://bundledrop.app/ota/resolve', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'x-api-key': 'project-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ installId: 'install-1' }),
      signal: expect.any(Object),
    });
  });

  it('preserves explicit request headers and skips api key injection when not configured', async () => {
    const fetchMock = jest.fn(async () => new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { client } = loadClientModule(({ context }) => {
      context.setMockConfig({
        serverUrl: 'https://bundledrop.app/',
        project: {
          name: 'Bundle Drop',
          slug: 'bundle-drop-app',
          apiKey: undefined,
        },
      });
    });

    await expect(client.apiClient.get('/channels/public', {
      headers: {
        Accept: 'text/plain',
        'x-api-key': 'manual-key',
      },
    })).resolves.toMatchObject({
      data: undefined,
      status: 204,
    });

    expect(fetchMock).toHaveBeenCalledWith('https://bundledrop.app/channels/public', {
      method: 'GET',
      headers: {
        Accept: 'text/plain',
        'x-api-key': 'manual-key',
      },
      body: undefined,
      signal: expect.any(Object),
    });
  });

  it('rejects non-success responses with the parsed response attached', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ error: 'bad request' }), {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json' },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { client } = loadClientModule(({ context }) => {
      context.setMockConfig({
        serverUrl: 'https://bundledrop.app',
        project: {
          name: 'Bundle Drop',
          slug: 'bundle-drop-app',
          apiKey: undefined,
        },
      });
    });

    await expect(client.apiClient.get('/bad')).rejects.toMatchObject({
      message: 'Bundle Drop API request failed with status 400',
      response: {
        data: { error: 'bad request' },
        status: 400,
      },
      isAxiosError: true,
    });
  });

  it('supports absolute URLs and plain-text responses from older fetch implementations', async () => {
    const originalAbortController = globalThis.AbortController;
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => 'plain response',
    }));

    global.fetch = fetchMock as unknown as typeof fetch;
    (globalThis as { AbortController?: typeof AbortController }).AbortController = undefined;

    try {
      const { client } = loadClientModule(({ context }) => {
        context.setMockConfig({
          serverUrl: 'https://bundledrop.app',
          project: {
            name: 'Bundle Drop',
            slug: 'bundle-drop-app',
            apiKey: undefined,
          },
        });
      });

      await expect(client.apiClient.get('https://cdn.example.com/ping')).resolves.toMatchObject({
        data: 'plain response',
        headers: {},
        status: 200,
      });

      expect(fetchMock).toHaveBeenCalledWith('https://cdn.example.com/ping', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        body: undefined,
        signal: undefined,
      });
    } finally {
      globalThis.AbortController = originalAbortController;
    }
  });

  it('aborts requests that exceed their timeout', async () => {
    jest.useFakeTimers();

    const fetchMock = jest.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { client } = loadClientModule(({ context }) => {
        context.setMockConfig({
          serverUrl: 'https://bundledrop.app',
          project: {
            name: 'Bundle Drop',
            slug: 'bundle-drop-app',
            apiKey: undefined,
          },
        });
      });

      const request = client.apiClient.get('/slow', { timeout: 5 });
      jest.advanceTimersByTime(5);

      await expect(request).rejects.toThrow('aborted');
    } finally {
      jest.useRealTimers();
    }
  });
});
