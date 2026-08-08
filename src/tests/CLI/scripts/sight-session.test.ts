import { EventEmitter } from 'events';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';

import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

const mockSpawn = jest.fn();

jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import {
  openSightInBrowser,
  startSightSession,
  type SightSession,
} from '../../../CLI/scripts/sight-session';

type LoopbackResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

type SessionConnection = {
  origin: string;
  token: string;
  url: URL;
};

function sessionConnection(sightUrl: string): SessionConnection {
  const sightPageUrl = new URL(sightUrl);
  const encodedSession = sightPageUrl.hash.replace(/^#sight-session=/, '');
  const payload = JSON.parse(
    Buffer.from(encodedSession, 'base64url').toString('utf8'),
  ) as { version: number; port: number; token: string };

  expect(payload.version).toBe(1);
  expect(payload.port).toBeGreaterThan(0);
  expect(payload.token).toMatch(/^[a-f0-9]{64}$/);

  return {
    origin: sightPageUrl.origin,
    token: payload.token,
    url: new URL(`http://127.0.0.1:${payload.port}/session`),
  };
}

function requestLoopback(
  url: URL,
  {
    method = 'GET',
    headers = {},
  }: {
    method?: 'GET' | 'OPTIONS' | 'POST';
    headers?: http.OutgoingHttpHeaders;
  } = {},
): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        agent: false,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      response => {
        const chunks: Buffer[] = [];
        response.once('aborted', () => reject(new Error('Response aborted')));
        response.once('error', reject);
        response.on('data', chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.once('error', reject);
    request.end();
  });
}

function spawnedChild(event: 'error' | 'spawn') {
  const child = new EventEmitter() as EventEmitter & { unref: jest.Mock };
  child.unref = jest.fn();
  process.nextTick(() => {
    child.emit(event, event === 'error' ? new Error('browser unavailable') : undefined);
  });
  return child;
}

describe('CLI/scripts/sight-session', () => {
  const sightPageUrl = 'https://bundledrop.app/sight';
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const sessions: SightSession[] = [];
  let tempDirectory = '';
  let bundlePath = '';
  let sourceMapPath = '';

  async function createSession(timeoutMs?: number): Promise<SightSession> {
    const session = await startSightSession({
      artifacts: {
        outputDirectory: tempDirectory,
        bundlePath,
        sourceMapPath,
        temporary: true,
      },
      sightPageUrl,
      timeoutMs,
    });
    sessions.push(session);
    return session;
  }

  beforeEach(() => {
    tempDirectory = createTempProjectDir();
    bundlePath = path.join(tempDirectory, 'analysis.jsbundle');
    sourceMapPath = path.join(tempDirectory, 'analysis.jsbundle.map');
    fs.writeFileSync(bundlePath, Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]));
    fs.writeFileSync(sourceMapPath, Buffer.from('{"version":3,"mappings":"AAAA"}\n'));
    mockSpawn.mockReset().mockImplementation(() => spawnedChild('spawn'));
  });

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map(session => session.close()));
    removeTempDir(tempDirectory);
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it.each([
    'http://bundledrop.app/sight',
    'https://attacker.example/sight',
    'https://bundledrop.app/not-sight',
    'http://localhost:3000/not-sight',
  ])('rejects an unapproved Sight page before opening a server: %s', async (url) => {
    await expect(startSightSession({
      artifacts: {
        outputDirectory: tempDirectory,
        bundlePath,
        sourceMapPath,
        temporary: true,
      },
      sightPageUrl: url,
    })).rejects.toThrow(
      'Sight URL must be https://bundledrop.app/sight or a localhost development page.',
    );
  });

  it('answers an exact-origin private-network preflight with restrictive CORS headers', async () => {
    const session = await createSession();
    const connection = sessionConnection(session.sightUrl);

    const response = await requestLoopback(connection.url, {
      method: 'OPTIONS',
      headers: {
        Origin: connection.origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
        'Access-Control-Request-Private-Network': 'true',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toHaveLength(0);
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': connection.origin,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Authorization',
      'access-control-allow-private-network': 'true',
      vary: 'Origin',
    });

    const hostileResponse = await requestLoopback(connection.url, {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example' },
    });
    expect(hostileResponse.statusCode).toBe(403);
    expect(hostileResponse.body.toString('utf8')).toBe('Origin not allowed');
    expect(hostileResponse.headers['access-control-allow-origin']).toBeUndefined();
    expect(hostileResponse.headers['access-control-allow-private-network']).toBeUndefined();

    const missingOriginResponse = await requestLoopback(connection.url, {
      method: 'OPTIONS',
    });
    expect(missingOriginResponse.statusCode).toBe(403);
  });

  it('protects the session route with its exact origin, method, path, and bearer token', async () => {
    const session = await createSession();
    const connection = sessionConnection(session.sightUrl);
    const authorizedHeaders = {
      Origin: connection.origin,
      Authorization: `Bearer ${connection.token}`,
    };

    const wrongPath = new URL('/other', connection.url);
    await expect(requestLoopback(wrongPath, { headers: authorizedHeaders })).resolves.toMatchObject({
      statusCode: 404,
      body: Buffer.from('Not found'),
    });
    await expect(requestLoopback(connection.url, {
      method: 'POST',
      headers: authorizedHeaders,
    })).resolves.toMatchObject({ statusCode: 404, body: Buffer.from('Not found') });
    await expect(requestLoopback(connection.url, {
      headers: { Origin: 'https://attacker.example', Authorization: authorizedHeaders.Authorization },
    })).resolves.toMatchObject({ statusCode: 403, body: Buffer.from('Origin not allowed') });
    await expect(requestLoopback(connection.url, {
      headers: { Authorization: authorizedHeaders.Authorization },
    })).resolves.toMatchObject({ statusCode: 403, body: Buffer.from('Origin not allowed') });
    await expect(requestLoopback(connection.url, {
      headers: { Origin: connection.origin },
    })).resolves.toMatchObject({ statusCode: 401, body: Buffer.from('Unauthorized') });
    await expect(requestLoopback(connection.url, {
      headers: { Origin: connection.origin, Authorization: 'Bearer incorrect' },
    })).resolves.toMatchObject({ statusCode: 401, body: Buffer.from('Unauthorized') });
  });

  it('streams both artifacts byte-for-byte in one multipart response and consumes the token once', async () => {
    const session = await createSession();
    const connection = sessionConnection(session.sightUrl);
    const headers = {
      Origin: connection.origin,
      Authorization: `Bearer ${connection.token}`,
    };

    const response = await requestLoopback(connection.url, { headers });
    await session.waitForTransfer();

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': connection.origin,
      'cache-control': 'no-store',
      connection: 'close',
      vary: 'Origin',
      'x-content-type-options': 'nosniff',
    });
    const contentType = response.headers['content-type'];
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const boundary = contentType?.replace('multipart/form-data; boundary=', '');
    expect(boundary).toMatch(/^bundle-drop-sight-[a-f0-9]{24}$/);

    const expectedBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="bundle"; filename="analysis.jsbundle"\r\n' +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      fs.readFileSync(bundlePath),
      Buffer.from(
        `\r\n--${boundary}\r\n` +
          'Content-Disposition: form-data; name="sourceMap"; filename="analysis.jsbundle.map"\r\n' +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      fs.readFileSync(sourceMapPath),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    expect(response.body.equals(expectedBody)).toBe(true);

    const repeatedResponse = await requestLoopback(connection.url, { headers });
    expect(repeatedResponse.statusCode).toBe(410);
    expect(repeatedResponse.body.toString('utf8')).toBe('Session already used');
  });

  it('rejects the pending transfer and closes the loopback listener after timeout', async () => {
    const session = await createSession(20);
    const connection = sessionConnection(session.sightUrl);
    const socket = net.createConnection({
      host: connection.url.hostname,
      port: Number(connection.url.port),
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    await expect(session.waitForTransfer()).rejects.toThrow(
      'Timed out waiting for Bundle Drop Sight to load the generated files.',
    );
    await new Promise<void>(resolve => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
    });
    await expect(requestLoopback(connection.url, {
      headers: {
        Origin: connection.origin,
        Authorization: `Bearer ${connection.token}`,
      },
    })).rejects.toThrow();
  });

  it('rejects promptly and closes the listener when the browser aborts the transfer', async () => {
    fs.writeFileSync(bundlePath, Buffer.alloc(5 * 1024 * 1024, 0x61));
    const session = await createSession(5_000);
    const connection = sessionConnection(session.sightUrl);
    const startedAt = Date.now();

    const request = http.request({
      agent: false,
      hostname: connection.url.hostname,
      port: connection.url.port,
      path: connection.url.pathname,
      headers: {
        Origin: connection.origin,
        Authorization: `Bearer ${connection.token}`,
      },
    });
    request.once('response', response => {
      response.once('data', () => request.destroy());
    });
    request.once('error', () => undefined);
    request.end();

    await expect(session.waitForTransfer()).rejects.toThrow(
      'closed before the generated files finished loading',
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(requestLoopback(connection.url, {
      headers: {
        Origin: connection.origin,
        Authorization: `Bearer ${connection.token}`,
      },
    })).rejects.toThrow();
  });

  it('rejects the transfer when an artifact disappears during the one-time stream', async () => {
    const session = await createSession();
    const connection = sessionConnection(session.sightUrl);
    fs.rmSync(sourceMapPath);

    await expect(requestLoopback(connection.url, {
      headers: {
        Origin: connection.origin,
        Authorization: `Bearer ${connection.token}`,
      },
    })).rejects.toThrow();
    await expect(session.waitForTransfer()).rejects.toThrow(
      'Failed to transfer Sight artifacts.',
    );
  });

  it('propagates a file-stream Error through the pending transfer', async () => {
    const session = await createSession();
    const connection = sessionConnection(session.sightUrl);
    const realCreateReadStream = fs.createReadStream.bind(fs);
    const streamSpy = jest.spyOn(fs, 'createReadStream').mockImplementation(
      ((filePath: fs.PathLike, options?: BufferEncoding | object) => {
        if (String(filePath) === sourceMapPath) {
          throw new Error('source map stream failed');
        }
        return realCreateReadStream(filePath, options as never);
      }) as typeof fs.createReadStream,
    );

    try {
      await expect(requestLoopback(connection.url, {
        headers: {
          Origin: connection.origin,
          Authorization: `Bearer ${connection.token}`,
        },
      })).rejects.toThrow();
      await expect(session.waitForTransfer()).rejects.toThrow(
        'source map stream failed',
      );
    } finally {
      streamSpy.mockRestore();
    }
  });

  it.each([
    ['darwin', 'open', ['https://bundledrop.app/sight#session']],
    ['linux', 'xdg-open', ['https://bundledrop.app/sight#session']],
    ['win32', 'explorer.exe', ['https://bundledrop.app/sight#session']],
  ] as const)('opens the browser safely on %s without attaching stdio', async (
    platform,
    executable,
    args,
  ) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    const child = spawnedChild('spawn');
    mockSpawn.mockReturnValue(child);

    await expect(openSightInBrowser('https://bundledrop.app/sight#session')).resolves.toBeUndefined();

    expect(mockSpawn).toHaveBeenCalledWith(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('passes a Windows URL as one argument without invoking a command shell', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const child = spawnedChild('spawn');
    mockSpawn.mockReturnValue(child);
    const url = 'https://bundledrop.app/sight?mode=local&theme=dark#sight-session=opaque';

    await expect(openSightInBrowser(url)).resolves.toBeUndefined();

    expect(mockSpawn).toHaveBeenCalledWith('explorer.exe', [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(mockSpawn).not.toHaveBeenCalledWith('cmd', expect.anything(), expect.anything());
  });

  it('reports a browser process launch failure without detaching it', async () => {
    const child = spawnedChild('error');
    mockSpawn.mockReturnValue(child);

    await expect(openSightInBrowser('https://bundledrop.app/sight')).rejects.toThrow(
      'browser unavailable',
    );
    expect(child.unref).not.toHaveBeenCalled();
  });
});
