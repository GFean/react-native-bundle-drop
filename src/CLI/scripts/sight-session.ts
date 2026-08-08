import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo, Socket } from 'net';
import type { SightArtifacts } from './sight-artifacts';

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOST = '127.0.0.1';

export type SightSession = {
  sightUrl: string;
  waitForTransfer: () => Promise<void>;
  close: () => Promise<void>;
};

type StartSightSessionOptions = {
  artifacts: SightArtifacts;
  sightPageUrl: string;
  timeoutMs?: number;
};

function sessionFragment(port: number, token: string): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, port, token }), 'utf8')
    .toString('base64url');
  return `sight-session=${payload}`;
}

function multipartHeader(boundary: string, field: string, filePath: string): Buffer {
  const filename = path.basename(filePath).replace(/["\r\n]/g, '_');
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
}

function writeFilePart(
  response: http.ServerResponse,
  header: Buffer,
  filePath: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : new Error('Sight closed the local artifact transfer.');
      input.destroy(reason);
    };

    input.once('error', error => {
      cleanup();
      reject(error);
    });
    input.once('end', () => {
      cleanup();
      resolve();
    });
    signal.addEventListener('abort', abort, { once: true });

    response.write(header);
    input.pipe(response, { end: false });
  });
}

function closeServer(
  server: http.Server,
  sockets: Set<Socket>,
  force = false,
): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    if (force) {
      sockets.forEach(socket => socket.destroy());
    }
  });
}

export function openSightInBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'explorer.exe', args: [url] }
        : { file: 'xdg-open', args: [url] };

  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function startSightSession({
  artifacts,
  sightPageUrl,
  timeoutMs = SESSION_TIMEOUT_MS,
}: StartSightSessionOptions): Promise<SightSession> {
  const pageUrl = new URL(sightPageUrl);
  const isOfficialSightPage =
    pageUrl.origin === 'https://bundledrop.app' && pageUrl.pathname === '/sight';
  const isLocalSightPage =
    ['http:', 'https:'].includes(pageUrl.protocol) &&
    ['localhost', LOOPBACK_HOST].includes(pageUrl.hostname) &&
    pageUrl.pathname === '/sight';
  if (!isOfficialSightPage && !isLocalSightPage) {
    throw new Error(
      'Sight URL must be https://bundledrop.app/sight or a localhost development page.',
    );
  }
  const allowedOrigin = pageUrl.origin;
  const token = randomBytes(32).toString('hex');
  const boundary = `bundle-drop-sight-${randomBytes(12).toString('hex')}`;
  const sockets = new Set<Socket>();
  let consumed = false;
  let settleTransfer: (() => void) | undefined;
  let rejectTransfer: ((error: Error) => void) | undefined;
  const transfer = new Promise<void>((resolve, reject) => {
    settleTransfer = resolve;
    rejectTransfer = reject;
  });

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    const isAllowedOrigin = origin === allowedOrigin;
    if (origin && !isAllowedOrigin) {
      response.writeHead(403).end('Origin not allowed');
      return;
    }

    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin) {
        response.writeHead(403).end('Origin not allowed');
        return;
      }
      response.writeHead(204, {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Allow-Private-Network': 'true',
        Vary: 'Origin',
      }).end();
      return;
    }

    if (request.method !== 'GET' || request.url !== '/session') {
      response.writeHead(404).end('Not found');
      return;
    }
    if (!isAllowedOrigin) {
      response.writeHead(403).end('Origin not allowed');
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('Unauthorized');
      return;
    }
    if (consumed) {
      response.writeHead(410).end('Session already used');
      return;
    }
    consumed = true;
    const transferAbort = new AbortController();
    const rejectPrematureClose = () => {
      const error = new Error(
        'Bundle Drop Sight closed before the generated files finished loading.',
      );
      transferAbort.abort(error);
      rejectTransfer?.(error);
      void closeServer(server, sockets, true);
    };
    request.once('aborted', rejectPrematureClose);
    response.once('close', rejectPrematureClose);

    response.writeHead(200, {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Cache-Control': 'no-store',
      Connection: 'close',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
    });

    try {
      await writeFilePart(
        response,
        multipartHeader(boundary, 'bundle', artifacts.bundlePath),
        artifacts.bundlePath,
        transferAbort.signal,
      );
      response.write('\r\n');
      await writeFilePart(
        response,
        multipartHeader(boundary, 'sourceMap', artifacts.sourceMapPath),
        artifacts.sourceMapPath,
        transferAbort.signal,
      );
      response.once('finish', () => {
        request.removeListener('aborted', rejectPrematureClose);
        response.removeListener('close', rejectPrematureClose);
        settleTransfer?.();
      });
      response.end(`\r\n--${boundary}--\r\n`);
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined);
      rejectTransfer?.(
        error instanceof Error ? error : new Error('Failed to transfer Sight artifacts.'),
      );
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });

  const timeout = setTimeout(() => {
    rejectTransfer?.(new Error('Timed out waiting for Bundle Drop Sight to load the generated files.'));
    void closeServer(server, sockets, true);
  }, timeoutMs);
  timeout.unref();
  void transfer.finally(() => clearTimeout(timeout)).catch(() => undefined);

  const address = server.address() as AddressInfo;
  pageUrl.hash = sessionFragment(address.port, token);

  return {
    sightUrl: pageUrl.toString(),
    waitForTransfer: () => transfer,
    close: () => closeServer(server, sockets),
  };
}
