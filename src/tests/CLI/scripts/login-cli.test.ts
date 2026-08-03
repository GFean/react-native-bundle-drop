import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import { mockAxiosNodePost } from '../../mocks/modules/axiosNode';
import { queuePromptResponse } from '../../mocks/modules/prompts';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

const mockHasExistingBundleDropConfig = jest.fn();
const mockGetBundleDropConfigPath = jest.fn();
const mockInitConfig = jest.fn();
const mockRunPostInitPrompts = jest.fn();
const mockSpawn = jest.fn();
const mockDetectProjectType = jest.fn();

jest.mock('axios', () => require('../../mocks/modules/axiosNode'));
jest.mock('prompts', () => require('../../mocks/modules/prompts'));
jest.mock('../../../CLI/scripts/init-config', () => ({
  getBundleDropConfigPath: (...args: unknown[]) => mockGetBundleDropConfigPath(...args),
  hasExistingBundleDropConfig: (...args: unknown[]) => mockHasExistingBundleDropConfig(...args),
  initConfig: (...args: unknown[]) => mockInitConfig(...args),
}));
jest.mock('../../../CLI/scripts/post-init', () => ({
  runPostInitPrompts: (...args: unknown[]) => mockRunPostInitPrompts(...args),
}));
jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));
jest.mock('../../../expo', () => ({
  detectProjectType: (...args: unknown[]) => mockDetectProjectType(...args),
}));

import login, {
  createLoginSession,
  exchangeSession,
  getBaseUrl,
  getClientName,
  openBrowser,
  readJsonBody,
  respondJson,
  startCallbackServer,
  waitForExchangeWithTimeout,
  writeAuthFile,
} from '../../../CLI/scripts/login-cli';

describe('CLI/scripts/login-cli', () => {
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;
  let tempHome = '';
  let homedirSpy: jest.SpyInstance;
  let hostnameSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  const sendRequest = (
    requestUrl: string,
    {
      method = 'POST',
      body,
    }: {
      method?: 'GET' | 'OPTIONS' | 'POST';
      body?: string;
    } = {},
  ) =>
    new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const url = new URL(requestUrl);
      const req = http.request(
        {
          agent: false,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method,
          headers: body
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              }
            : undefined,
        },
        res => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', chunk => {
            raw += chunk;
          });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode || 0, body: raw });
          });
        },
      );

      req.on('error', reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });

  const createSpawnChild = (mode: 'spawn' | 'error') => {
    const child = new EventEmitter() as EventEmitter & { unref: jest.Mock };
    child.unref = jest.fn();

    process.nextTick(() => {
      if (mode === 'spawn') {
        child.emit('spawn');
      } else {
        child.emit('error', new Error('browser unavailable'));
      }
    });

    return child;
  };

  const createMockRequest = () => {
    const req = new EventEmitter() as EventEmitter & {
      setEncoding: jest.Mock;
      destroy: jest.Mock;
    };
    req.setEncoding = jest.fn();
    req.destroy = jest.fn();
    return req;
  };

  const createFakeServer = (options?: {
    address?: { port: number } | null;
    closeError?: Error;
    callListenCallback?: boolean;
  }) => {
    const fakeServer = {
      keepAliveTimeout: 0,
      on: jest.fn().mockReturnThis(),
      listen: jest.fn((_port: number, _host: string, callback: () => void) => {
        if (options?.callListenCallback !== false) {
          callback();
        }
      }),
      address: jest.fn(() =>
        options && 'address' in options ? options.address : { port: 43210 }
      ),
      close: jest.fn((callback: (error?: Error | null) => void) => {
        callback(options?.closeError || null);
      }),
    };

    return fakeServer;
  };

  const waitForValue = async <T>(reader: () => T, predicate: (value: T) => boolean) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const value = reader();
      if (predicate(value)) {
        return value;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    throw new Error('Timed out waiting for value');
  };

  beforeEach(() => {
    tempHome = createTempProjectDir();
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    hostnameSpy = jest.spyOn(os, 'hostname').mockReturnValue('devbox');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAxiosNodePost.mockReset();
    mockHasExistingBundleDropConfig.mockReset().mockReturnValue(false);
    mockGetBundleDropConfigPath.mockReset().mockReturnValue('/tmp/project/bundle.drop.config.js');
    mockInitConfig.mockReset().mockResolvedValue(undefined);
    mockRunPostInitPrompts.mockReset().mockResolvedValue(undefined);
    mockSpawn.mockReset().mockImplementation(() => createSpawnChild('spawn'));
    mockDetectProjectType.mockReset().mockReturnValue('expo');
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    hostnameSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    removeTempDir(tempHome);
    process.env = { ...originalEnv };
    process.exitCode = originalExitCode;
    jest.useRealTimers();
  });

  it('derives base URLs and client names from the environment', () => {
    process.env.BUNDLE_DROP_SERVER_URL = 'https://api.example.com/';
    process.env.CURSOR_TRACE_ID = 'trace';
    expect(getBaseUrl()).toBe('https://api.example.com');
    expect(getClientName()).toBe('Cursor on devbox');

    delete process.env.CURSOR_TRACE_ID;
    delete process.env.CURSOR_AGENT;
    process.env.VSCODE_GIT_IPC_HANDLE = '1';
    expect(getClientName()).toBe('VS Code on devbox');

    delete process.env.VSCODE_GIT_IPC_HANDLE;
    process.env.TERM_PROGRAM = 'Warp';
    expect(getClientName()).toBe('Warp on devbox');

    delete process.env.TERM_PROGRAM;
    process.env.TERM = 'windsurf-terminal';
    expect(getClientName()).toBe('Windsurf on devbox');

    delete process.env.TERM;
    expect(getClientName()).toBe('your IDE on devbox');
  });

  it('times out unresolved exchanges and resolves completed ones', async () => {
    jest.useFakeTimers();

    const timeoutPromise = waitForExchangeWithTimeout(new Promise(() => undefined));
    jest.advanceTimersByTime(10 * 60 * 1000);
    await expect(timeoutPromise).rejects.toThrow('Timed out waiting for browser authorization');

    await expect(
      waitForExchangeWithTimeout(
        Promise.resolve({
          token: 'jwt-token',
          email: 'jane@example.com',
          firstName: 'Jane',
          lastName: 'Doe',
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        token: 'jwt-token',
      }),
    );

    const exchangeError = new Error('exchange failed');
    await expect(waitForExchangeWithTimeout(Promise.reject(exchangeError))).rejects.toBe(
      exchangeError,
    );
  });

  it('wraps axios helpers, auth persistence, response writing, and body parsing', async () => {
    mockAxiosNodePost
      .mockResolvedValueOnce({
        data: {
          sessionId: 'session-1',
          state: 'state-1',
          authorizeUrl: 'https://api.example.com/authorize',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({
        data: {
          token: 'jwt-token',
          email: 'jane@example.com',
          firstName: 'Jane',
          lastName: 'Doe',
        },
      });

    await expect(
      createLoginSession({
        baseUrl: 'https://api.example.com',
        clientName: 'VS Code on devbox',
        callbackUrl: 'http://127.0.0.1:9999/callback',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        authorizeUrl: 'https://api.example.com/authorize',
      }),
    );

    await expect(
      exchangeSession({
        baseUrl: 'https://api.example.com',
        payload: {
          sessionId: 'session-1',
          state: 'state-1',
          exchangeCode: 'exchange-1',
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        token: 'jwt-token',
      }),
    );

    const authFile = await writeAuthFile({
      payload: {
        token: 'jwt-token',
        email: 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
      },
      serverUrl: 'https://api.example.com',
    });
    expect(authFile).toEqual({
      token: 'jwt-token',
      user: {
        email: 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
      },
      projects: [],
      organizations: [],
      memberships: [],
      downloadApiKey: '',
      serverUrl: 'https://api.example.com',
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(tempHome, '.bundle-drop', 'auth.json'), 'utf8')),
    ).toEqual(authFile);

    const res = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };
    respondJson(res as never, 201, { ok: true });
    expect(res.writeHead).toHaveBeenCalledWith(
      201,
      expect.objectContaining({
        'Content-Type': 'application/json',
        Connection: 'close',
      }),
    );
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));

    const req = createMockRequest();
    const readPromise = readJsonBody(req as never);
    req.emit('data', '{"ok":');
    req.emit('data', 'true}');
    req.emit('end');
    await expect(readPromise).resolves.toBe('{"ok":true}');

    const largeReq = createMockRequest();
    const largePromise = readJsonBody(largeReq as never);
    largeReq.emit('data', 'x'.repeat(20_001));
    await expect(largePromise).rejects.toThrow('CLI callback payload is too large');
    expect(largeReq.destroy).toHaveBeenCalled();

    const reqError = createMockRequest();
    const reqErrorPromise = readJsonBody(reqError as never);
    reqError.emit('error', new Error('stream failed'));
    await expect(reqErrorPromise).rejects.toThrow('stream failed');
  });

  it('accepts callback requests and resolves the exchanged auth payload', async () => {
    mockAxiosNodePost.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/cli/exchange')) {
        return {
          data: {
            token: 'auth-token',
            email: 'jane@example.com',
            firstName: 'Jane',
            lastName: 'Doe',
            projects: [],
            organizations: [],
            memberships: [],
            downloadApiKey: 'download-key',
          },
        };
      }

      throw new Error(`Unexpected POST ${url}`);
    });

    const server = await startCallbackServer({ baseUrl: 'https://api.example.com' });

    try {
      await expect(sendRequest(server.callbackUrl, { method: 'OPTIONS' })).resolves.toEqual(
        expect.objectContaining({ statusCode: 204 }),
      );
      await expect(
        sendRequest(server.callbackUrl.replace('/callback', '/missing'), { method: 'GET' }),
      ).resolves.toEqual(expect.objectContaining({ statusCode: 404 }));

      const exchangePromise = server.waitForExchange();
      await expect(
        sendRequest(server.callbackUrl, {
          method: 'POST',
          body: JSON.stringify({
            sessionId: 'session-1',
            state: 'state-1',
            exchangeCode: 'exchange-1',
          }),
        }),
      ).resolves.toEqual(expect.objectContaining({ statusCode: 200 }));

      await expect(exchangePromise).resolves.toEqual(
        expect.objectContaining({
          token: 'auth-token',
        }),
      );
      expect(mockAxiosNodePost).toHaveBeenCalledWith(
        'https://api.example.com/auth/cli/exchange',
        {
          sessionId: 'session-1',
          state: 'state-1',
          exchangeCode: 'exchange-1',
        },
      );
    } finally {
      await server.close();
    }
  });

  it('rejects invalid or concurrent callback requests', async () => {
    mockAxiosNodePost.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/cli/exchange')) {
        return {
          data: {
            token: 'auth-token',
            email: 'jane@example.com',
            firstName: 'Jane',
            lastName: 'Doe',
          },
        };
      }

      throw new Error(`Unexpected POST ${url}`);
    });

    const invalidServer = await startCallbackServer({ baseUrl: 'https://api.example.com' });

    try {
      const invalidExchange = invalidServer.waitForExchange().then(
        () => null,
        error => error,
      );
      await expect(
        sendRequest(invalidServer.callbackUrl, {
          method: 'POST',
          body: JSON.stringify({
            sessionId: ' ',
            state: 'state-1',
            exchangeCode: 'exchange-1',
          }),
        }),
      ).resolves.toEqual(expect.objectContaining({ statusCode: 400 }));
      await expect(invalidExchange).resolves.toEqual(
        expect.objectContaining({ message: 'Missing CLI login callback payload' }),
      );
    } finally {
      await invalidServer.close();
    }

    const concurrentServer = await startCallbackServer({ baseUrl: 'https://api.example.com' });

    try {
      const concurrentExchange = concurrentServer.waitForExchange().catch(error => {
        throw error;
      });
      const url = new URL(concurrentServer.callbackUrl);
      const slowResponse = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            agent: false,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
          },
          res => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
              raw += chunk;
            });
            res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: raw }));
          },
        );
        req.on('error', reject);
        req.write('{"sessionId":"session-2",');

        setTimeout(() => {
          req.end('"state":"state-2","exchangeCode":"exchange-2"}');
        }, 10);
      });

      await new Promise(resolve => setTimeout(resolve, 1));
      await expect(
        sendRequest(concurrentServer.callbackUrl, {
          method: 'POST',
          body: JSON.stringify({
            sessionId: 'session-3',
            state: 'state-3',
            exchangeCode: 'exchange-3',
          }),
        }),
      ).resolves.toEqual(expect.objectContaining({ statusCode: 409 }));
      await expect(slowResponse).resolves.toEqual(expect.objectContaining({ statusCode: 200 }));
      await expect(concurrentExchange).resolves.toEqual(
        expect.objectContaining({ token: 'auth-token' }),
      );
    } finally {
      await concurrentServer.close();
    }
  });

  it('surfaces axios callback errors from the local exchange server', async () => {
    mockAxiosNodePost.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/cli/exchange')) {
        throw {
          isAxiosError: true,
          message: 'fallback',
          response: {
            data: {
              error: 'exchange denied',
            },
          },
        };
      }

      throw new Error(`Unexpected POST ${url}`);
    });

    const server = await startCallbackServer({ baseUrl: 'https://api.example.com' });

    try {
      const exchangePromise = server.waitForExchange().then(
        () => null,
        error => error,
      );
      await expect(
        sendRequest(server.callbackUrl, {
          method: 'POST',
          body: JSON.stringify({
            sessionId: 'session-1',
            state: 'state-1',
            exchangeCode: 'exchange-1',
          }),
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          statusCode: 400,
          body: JSON.stringify({ error: 'exchange denied' }),
        }),
      );
      await expect(exchangePromise).resolves.toEqual(
        expect.objectContaining({ message: 'exchange denied' }),
      );
    } finally {
      await server.close();
    }
  });

  it('handles callback server startup edge cases and close failures', async () => {
    const noAddressServer = createFakeServer({ address: null });
    const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(noAddressServer as never);

    try {
      await expect(startCallbackServer({ baseUrl: 'https://api.example.com' })).rejects.toThrow(
        'Unable to start the local CLI callback server',
      );
    } finally {
      createServerSpy.mockRestore();
    }

    jest.useFakeTimers();
    const timeoutServer = createFakeServer({ callListenCallback: false });
    const timeoutSpy = jest.spyOn(http, 'createServer').mockReturnValue(timeoutServer as never);

    try {
      const startupPromise = startCallbackServer({ baseUrl: 'https://api.example.com' });
      jest.advanceTimersByTime(5_000);
      await expect(startupPromise).rejects.toThrow(
        'Timed out while starting the local CLI callback server',
      );
    } finally {
      timeoutSpy.mockRestore();
      jest.useRealTimers();
    }

    const closeErrorServer = createFakeServer({ closeError: new Error('close failed') });
    const closeSpy = jest.spyOn(http, 'createServer').mockReturnValue(closeErrorServer as never);

    try {
      const handle = await startCallbackServer({ baseUrl: 'https://api.example.com' });
      await expect(handle.close()).rejects.toThrow('close failed');
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('destroys tracked sockets when the callback server closes', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const fakeServer = {
      keepAliveTimeout: 0,
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
        return fakeServer;
      }),
      listen: jest.fn((_port: number, _host: string, callback: () => void) => {
        callback();
      }),
      address: jest.fn(() => ({ port: 43210 })),
      close: jest.fn((callback: (error?: Error | null) => void) => {
        callback(null);
      }),
    };
    const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer as never);

    try {
      const handle = await startCallbackServer({ baseUrl: 'https://api.example.com' });
      const socket = {
        on: jest.fn().mockReturnThis(),
        destroy: jest.fn(),
      };

      handlers.get('connection')?.(socket);
      await handle.close();

      expect(socket.destroy).toHaveBeenCalledTimes(1);
    } finally {
      createServerSpy.mockRestore();
    }
  });

  it('opens browsers directly and reports login failures in manual mode', async () => {
    mockSpawn.mockImplementation(() => createSpawnChild('spawn'));
    await expect(openBrowser('https://api.example.com/login')).resolves.toBeUndefined();

    queuePromptResponse({ shouldOpenBrowser: false });
    mockAxiosNodePost.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/cli/sessions')) {
        throw {
          isAxiosError: true,
          message: 'session failed',
          response: {
            data: {
              error: 'access denied',
            },
          },
        };
      }

      throw new Error(`Unexpected POST ${url}`);
    });

    await login();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(
      consoleLogSpy.mock.calls.some(call =>
        call.join(' ').includes('A sign-in URL will be printed. Open it manually in your browser.')
      ),
    ).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), 'access denied');
  });

  it('logs in successfully, writes auth state, and runs init prompts for new projects', async () => {
    queuePromptResponse({ shouldOpenBrowser: true });

    let callbackUrl = '';
    mockAxiosNodePost.mockImplementation(async (url: string, payload?: Record<string, unknown>) => {
      if (url.endsWith('/auth/cli/sessions')) {
        callbackUrl = String(payload?.callbackUrl || '');
        return {
          data: {
            sessionId: 'session-1',
            state: 'state-1',
            authorizeUrl: 'https://api.example.com/authorize',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        };
      }

      if (url.endsWith('/auth/cli/exchange')) {
        return {
          data: {
            token: 'jwt-token',
            email: 'jane@example.com',
            firstName: 'Jane',
            lastName: 'Doe',
            projects: [{ name: 'Demo', slug: 'demo-app', orgId: 'org-1' }],
            organizations: [{ name: 'Alpha', slug: 'alpha-org', orgId: 'org-1' }],
            memberships: [{ role: 'owner' }],
            downloadApiKey: 'download-key',
          },
        };
      }

      throw new Error(`Unexpected POST ${url}`);
    });

    const loginPromise = login();
    const resolvedCallbackUrl = await waitForValue(() => callbackUrl, value => value.length > 0);

    await sendRequest(resolvedCallbackUrl, {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'session-1',
        state: 'state-1',
        exchangeCode: 'exchange-1',
      }),
    });

    await loginPromise;

    const authPath = path.join(tempHome, '.bundle-drop', 'auth.json');
    const stored = JSON.parse(fs.readFileSync(authPath, 'utf8'));

    expect(stored).toEqual(
      expect.objectContaining({
        token: 'jwt-token',
        serverUrl: 'https://api.bundledrop.app',
        downloadApiKey: 'download-key',
      }),
    );
    expect(mockInitConfig).toHaveBeenCalledWith({
      serverUrl: 'https://api.bundledrop.app',
      projects: [{ name: 'Demo', slug: 'demo-app', orgId: 'org-1' }],
      organizations: [{ name: 'Alpha', slug: 'alpha-org', orgId: 'org-1' }],
      downloadApiKey: 'download-key',
      authToken: 'jwt-token',
      projectType: 'expo',
    });
    expect(mockRunPostInitPrompts).toHaveBeenCalledWith({ projectType: 'expo' });
    expect(mockSpawn).toHaveBeenCalledWith(
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open',
      process.platform === 'win32'
        ? ['/c', 'start', '', 'https://api.example.com/authorize']
        : ['https://api.example.com/authorize'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      }),
    );
  });

  it('reports setup failures separately after authentication succeeds', async () => {
    queuePromptResponse({ shouldOpenBrowser: true });
    mockRunPostInitPrompts.mockRejectedValueOnce(new Error('setup failed'));
    const configPath = path.join(tempHome, 'project', 'bundle.drop.config.js');
    mockGetBundleDropConfigPath.mockReturnValue(configPath);
    mockInitConfig.mockImplementationOnce(async () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, 'module.exports = {};\n');
      return { configPath, content: 'module.exports = {};\n', created: true };
    });

    let callbackUrl = '';
    mockAxiosNodePost.mockImplementation(async (url: string, payload?: Record<string, unknown>) => {
      if (url.endsWith('/auth/cli/sessions')) {
        callbackUrl = String(payload?.callbackUrl || '');
        return {
          data: {
            sessionId: 'session-1',
            state: 'state-1',
            authorizeUrl: 'https://api.example.com/authorize',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        };
      }
      if (url.endsWith('/auth/cli/exchange')) {
        return {
          data: {
            token: 'jwt-token',
            email: 'jane@example.com',
            firstName: 'Jane',
            lastName: 'Doe',
            projects: [],
            organizations: [],
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const loginPromise = login();
    const resolvedCallbackUrl = await waitForValue(() => callbackUrl, value => value.length > 0);
    await sendRequest(resolvedCallbackUrl, {
      body: JSON.stringify({
        sessionId: 'session-1',
        state: 'state-1',
        exchangeCode: 'exchange-1',
      }),
    });
    await loginPromise;

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Setup failed after login'),
      'setup failed',
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Manual installation: https://bundledrop.app/docs/installation',
      ),
    );
    expect(fs.existsSync(configPath)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('falls back to a printed URL when the browser cannot be opened and skips setup for existing configs', async () => {
    queuePromptResponse({ shouldOpenBrowser: true });
    mockHasExistingBundleDropConfig.mockReturnValue(true);
    mockSpawn.mockImplementation(() => createSpawnChild('error'));

    let callbackUrl = '';
    mockAxiosNodePost.mockImplementation(async (url: string, payload?: Record<string, unknown>) => {
      if (url.endsWith('/auth/cli/sessions')) {
        callbackUrl = String(payload?.callbackUrl || '');
        return {
          data: {
            sessionId: 'session-1',
            state: 'state-1',
            authorizeUrl: 'https://api.example.com/authorize',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        };
      }

      if (url.endsWith('/auth/cli/exchange')) {
        return {
          data: {
            token: 'jwt-token',
            email: 'jane@example.com',
            firstName: 'Jane',
            lastName: 'Doe',
            projects: [],
            organizations: [],
            memberships: [],
            downloadApiKey: '',
          },
        };
      }

      throw new Error(`Unexpected POST ${url}`);
    });

    const loginPromise = login();
    const resolvedCallbackUrl = await waitForValue(() => callbackUrl, value => value.length > 0);

    await sendRequest(resolvedCallbackUrl, {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'session-1',
        state: 'state-1',
        exchangeCode: 'exchange-1',
      }),
    });

    await loginPromise;

    expect(mockInitConfig).not.toHaveBeenCalled();
    expect(mockRunPostInitPrompts).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(call =>
        call.join(' ').includes('Could not open the browser automatically. Open this URL manually:')
      ),
    ).toBe(true);
    expect(
      consoleLogSpy.mock.calls.some(call =>
        call.join(' ').includes('Skipping setup prompts.')
      ),
    ).toBe(true);
  });
});
