import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs-extra';
import http, { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import prompts from 'prompts';
import { AddressInfo } from 'net';
import { spawn } from 'child_process';
import { Socket } from 'net';

import { getBundleDropConfigPath, hasExistingBundleDropConfig, initConfig } from './init-config';
import { runPostInitPrompts } from './post-init';
import { detectProjectType } from '../../expo';

type CliSessionResponse = {
  sessionId: string;
  state: string;
  authorizeUrl: string;
  expiresAt: string;
};

type Project = { name: string; slug: string; orgId: string };
type Org = { slug: string; orgId: string; name: string };

type CliExchangeResponse = {
  token: string;
  email: string;
  firstName: string;
  lastName: string;
  projects?: Project[];
  organizations?: Org[];
  memberships?: unknown[];
  downloadApiKey?: string;
};

type CallbackPayload = {
  sessionId: string;
  state: string;
  exchangeCode: string;
};

type AuthFilePayload = {
  token: string;
  user: {
    email: string;
    firstName: string;
    lastName: string;
  };
  projects: Project[];
  organizations: Org[];
  memberships: unknown[];
  downloadApiKey: string;
  serverUrl: string;
};

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DOCS_MANUAL_SETUP_URL = 'https://bundledrop.app/docs/manual-setup';

export const getBaseUrl = () =>
  process.env.BUNDLE_DROP_SERVER_URL
    ? process.env.BUNDLE_DROP_SERVER_URL.replace(/\/$/, '')
    : 'https://api.bundledrop.app';

export const getClientName = () => {
  const hostname = os.hostname();
  const termProgram = (process.env.TERM_PROGRAM || '').toLowerCase();
  const term = (process.env.TERM || '').toLowerCase();

  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT) {
    return `Cursor on ${hostname}`;
  }
  if (process.env.VSCODE_GIT_IPC_HANDLE || termProgram === 'vscode') {
    return `VS Code on ${hostname}`;
  }
  if (termProgram.includes('warp')) {
    return `Warp on ${hostname}`;
  }
  if (term.includes('windsurf')) {
    return `Windsurf on ${hostname}`;
  }

  return `your IDE on ${hostname}`;
};

export const openBrowser = async (url: string) => {
  const platform = process.platform;
  const command =
    platform === 'darwin'
      ? { file: 'open', args: [url] }
      : platform === 'win32'
        ? { file: 'explorer.exe', args: [url] }
        : { file: 'xdg-open', args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
    });

    child.once('error', reject);
    child.once('spawn', () => resolve());
    child.unref();
  });
};

export const writeAuthFile = async ({
  payload,
  serverUrl,
}: {
  payload: CliExchangeResponse;
  serverUrl: string;
}) => {
  const tokenPath = path.join(os.homedir(), '.bundle-drop', 'auth.json');
  const authFile: AuthFilePayload = {
    token: payload.token,
    user: {
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
    },
    projects: payload.projects || [],
    organizations: payload.organizations || [],
    memberships: payload.memberships || [],
    downloadApiKey: payload.downloadApiKey || '',
    serverUrl,
  };

  await fs.ensureDir(path.dirname(tokenPath));
  await fs.writeJson(tokenPath, authFile, { spaces: 2 });

  return authFile;
};

export const respondJson = (
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    Connection: 'close',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
};

export const readJsonBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 20_000) {
        reject(new Error('CLI callback payload is too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });

export const createLoginSession = async ({
  baseUrl,
  clientName,
  callbackUrl,
}: {
  baseUrl: string;
  clientName: string;
  callbackUrl: string;
}) => {
  const response = await axios.post<CliSessionResponse>(`${baseUrl}/auth/cli/sessions`, {
    clientName,
    callbackUrl,
  });

  return response.data;
};

export const exchangeSession = async ({
  baseUrl,
  payload,
}: {
  baseUrl: string;
  payload: CallbackPayload;
}) => {
  const response = await axios.post<CliExchangeResponse>(`${baseUrl}/auth/cli/exchange`, payload);
  return response.data;
};

export const waitForExchangeWithTimeout = (exchangePromise: Promise<CliExchangeResponse>) =>
  new Promise<CliExchangeResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for browser authorization'));
    }, LOGIN_TIMEOUT_MS);

    timeout.unref();

    exchangePromise.then(
      payload => {
        clearTimeout(timeout);
        resolve(payload);
      },
      error => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });

export const startCallbackServer = ({
  baseUrl,
}: {
  baseUrl: string;
}) =>
  new Promise<{
    callbackUrl: string;
    waitForExchange: () => Promise<CliExchangeResponse>;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    let settled = false;
    let exchangeInFlight = false;
    let exchangeResolve: ((payload: CliExchangeResponse) => void) | null = null;
    let exchangeReject: ((error: Error) => void) | null = null;
    const sockets = new Set<Socket>();
    const exchangePromise = new Promise<CliExchangeResponse>((innerResolve, innerReject) => {
      exchangeResolve = innerResolve;
      exchangeReject = innerReject;
    });

    const server = http.createServer(async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      if (req.method !== 'POST' || req.url !== '/callback') {
        respondJson(res, 404, { error: 'Not found' });
        return;
      }

      if (exchangeInFlight) {
        respondJson(res, 409, { error: 'CLI login is already being completed' });
        return;
      }

      exchangeInFlight = true;

      try {
        const rawBody = await readJsonBody(req);
        const parsed = JSON.parse(rawBody || '{}') as Partial<CallbackPayload>;
        const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
        const state = typeof parsed.state === 'string' ? parsed.state.trim() : '';
        const exchangeCode =
          typeof parsed.exchangeCode === 'string' ? parsed.exchangeCode.trim() : '';

        if (!sessionId || !state || !exchangeCode) {
          throw new Error('Missing CLI login callback payload');
        }

        const authPayload = await exchangeSession({
          baseUrl,
          payload: { sessionId, state, exchangeCode },
        });

        respondJson(res, 200, { ok: true });
        exchangeResolve?.(authPayload);
      } catch (error) {
        const message =
          axios.isAxiosError(error)
            ? (error.response?.data as { error?: string } | undefined)?.error || error.message
            : (error as Error).message;

        respondJson(res, 400, { error: message });
        exchangeReject?.(new Error(message));
      } finally {
        exchangeInFlight = false;
      }
    });

    server.on('error', reject);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });
    server.keepAliveTimeout = 1;
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        reject(new Error('Unable to start the local CLI callback server'));
        return;
      }

      settled = true;
      const callbackUrl = `http://127.0.0.1:${address.port}/callback`;
      resolve({
        callbackUrl,
        waitForExchange: () => exchangePromise,
        close: () =>
          new Promise<void>((innerResolve, innerReject) => {
            server.close(error => {
              if (error) {
                innerReject(error);
                return;
              }
              innerResolve();
            });
            sockets.forEach(socket => {
              socket.destroy();
            });
          }),
      });
    });

    const startupTimeout = setTimeout(() => {
      if (!settled) {
        reject(new Error('Timed out while starting the local CLI callback server'));
      }
    }, 5_000);
    startupTimeout.unref();
  });

const login = async () => {
  const { shouldOpenBrowser } = await prompts({
    type: 'confirm',
    name: 'shouldOpenBrowser',
    message: 'Open the browser to sign in?',
    initial: true,
  });

  if (shouldOpenBrowser === false) {
    console.log(chalk.gray('A sign-in URL will be printed. Open it manually in your browser.'));
  }

  const baseUrl = getBaseUrl();
  const clientName = getClientName();
  let serverHandle:
    | {
        callbackUrl: string;
        waitForExchange: () => Promise<CliExchangeResponse>;
        close: () => Promise<void>;
      }
    | undefined;
  let loginCompleted = false;
  let createdConfigPath: string | null = null;

  try {
    serverHandle = await startCallbackServer({ baseUrl });
    const session = await createLoginSession({
      baseUrl,
      clientName,
      callbackUrl: serverHandle.callbackUrl,
    });

    console.log(chalk.cyan(`Signing in for ${clientName}`));
    console.log(chalk.gray(`If the browser does not open, use this URL:\n${session.authorizeUrl}`));

    if (shouldOpenBrowser !== false) {
      try {
        await openBrowser(session.authorizeUrl);
      } catch (error) {
        console.log(
          chalk.yellow(
            `Could not open the browser automatically. Open this URL manually:\n${session.authorizeUrl}`
          )
        );
      }
    }

    const exchangePromise = serverHandle.waitForExchange();
    const authPayload = await waitForExchangeWithTimeout(exchangePromise);

    const authFile = await writeAuthFile({
      payload: authPayload,
      serverUrl: baseUrl,
    });
    loginCompleted = true;

    console.log(
      chalk.green('✅ Logged in successfully as:'),
      chalk.cyan(`${authFile.user.firstName} ${authFile.user.lastName}`)
    );

    if (hasExistingBundleDropConfig()) {
      console.log(
        chalk.gray(
          `ℹ️ Found existing bundle.drop.config.js at ${getBundleDropConfigPath()}. Skipping setup prompts.`
        )
      );
      return;
    }

    const projectType = detectProjectType({ projectRoot: process.cwd() });

    const configResult = await initConfig({
      serverUrl: baseUrl,
      projects: authFile.projects,
      organizations: authFile.organizations,
      downloadApiKey: authFile.downloadApiKey,
      authToken: authFile.token,
      projectType,
    });
    if (configResult?.created) {
      createdConfigPath = configResult.configPath;
    }
    await runPostInitPrompts({ projectType });
  } catch (error) {
    const message =
      axios.isAxiosError(error)
        ? (error.response?.data as { error?: string } | undefined)?.error || error.message
        : (error as Error).message;
    const failureLabel = loginCompleted ? '❌ Setup failed after login:' : '❌ Login failed:';
    console.error(chalk.red(failureLabel), message);
    if (loginCompleted) {
      if (createdConfigPath) {
        console.error(chalk.gray(`Project config retained at ${createdConfigPath}`));
      }
      console.error(chalk.gray(`Manual setup: ${DOCS_MANUAL_SETUP_URL}`));
    }
    process.exitCode = 1;
  } finally {
    if (serverHandle) {
      await serverHandle.close().catch(() => undefined);
    }
  }
};

export default login;
