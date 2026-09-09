import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export type ComparisonProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  phase: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  inheritStdin?: boolean;
  inheritOutput?: boolean;
  input?: string;
  allowedExitCodes?: number[];
};

export type ComparisonProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export function comparisonAbortError(): Error {
  const error = new Error('Sight comparison cancelled.');
  error.name = 'AbortError';
  return error;
}

export function checkComparisonAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw comparisonAbortError();
}

function redactOutput(output: string, env: NodeJS.ProcessEnv): string {
  let result = output.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
  for (const [name, value] of Object.entries(env)) {
    if (/(token|password|secret|credential|authorization)/i.test(name) && value && value.length >= 4) {
      result = result.split(value).join('[redacted]');
    }
  }
  return result;
}

function windowsPackageManager(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const manager = path.basename(command).match(/^(npm|yarn|pnpm)(?:\.(?:cmd|bat|exe|com))?$/i)?.[1]?.toLowerCase();
  if (process.platform !== 'win32' || !manager) return { command, args };
  const variables = Object.fromEntries(Object.entries(env).map(([name, value]) => [name.toUpperCase(), value]));
  const extensions = (variables.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(extension => extension.toLowerCase());
  const directories = path.isAbsolute(command) || /[/\\]/.test(command)
    ? [path.dirname(path.resolve(cwd, command))]
    : (variables.PATH || '').split(';').filter(Boolean).map(directory => directory.replace(/^"|"$/g, ''));
  const names = path.extname(command) ? [path.basename(command)] : extensions.map(extension => `${manager}${extension}`);
  let executable: string | undefined;
  for (const directory of directories) {
    executable = names.map(name => path.resolve(directory, name)).find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    if (executable) break;
  }
  if (!executable) throw new Error(`Could not find ${manager} on PATH. Install the required package manager before comparing.`);
  if (/\.(?:exe|com)$/i.test(executable)) return { command: executable, args };
  if (/\.(?:cmd|bat)$/i.test(executable)) {
    const directory = path.dirname(executable);
    const entries = {
      npm: 'npm/bin/npm-cli.js',
      yarn: 'yarn/bin/yarn.js',
      pnpm: 'pnpm/bin/pnpm.cjs',
    };
    const candidates = [
      path.join(directory, 'node_modules', entries[manager]),
      path.join(directory, 'node_modules', 'corepack', 'dist', `${manager}.js`),
    ];
    if (path.basename(directory) === '.bin') {
      candidates.push(path.resolve(directory, '..', entries[manager]), path.resolve(directory, '..', 'corepack', 'dist', `${manager}.js`));
    }
    const script = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    if (script) return { command: process.execPath, args: [script, ...args] };
  }
  throw new Error(`Unsupported Windows ${manager} launcher. Install a standard Node/npm or Corepack package-manager shim, or provide its native executable on PATH.`);
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const permissionDeadline = Date.now() + Math.max(timeoutMs, 100);
  while (true) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      // Darwin can report EPERM for a group containing only unreaped zombies.
      // Require a later ESRCH; a persistent permission failure must still reject.
      if (process.platform === 'darwin' && (error as NodeJS.ErrnoException).code === 'EPERM' && Date.now() < permissionDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        continue;
      }
      throw error;
    }
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function stopRemainingProcessGroup(pid: number | undefined): Promise<void> {
  // Windows taskkill requires a live leader; Job Object containment is not provided here.
  if (process.platform === 'win32' || !pid || await waitForProcessGroupExit(pid, 0)) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try { process.kill(-pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (await waitForProcessGroupExit(pid, 1000)) return;
  }
  throw new Error('A comparison subprocess left a process group running after termination.');
}

/** Run in a separate process group so cancelling also stops Metro/install children. */
export async function runComparisonProcess({
  command,
  args,
  cwd,
  phase,
  signal,
  env = process.env,
  logPath,
  inheritStdin = false,
  inheritOutput = false,
  input,
  allowedExitCodes = [0],
}: ComparisonProcessOptions): Promise<ComparisonProcessResult> {
  checkComparisonAbort(signal);
  if (logPath) fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const executable = windowsPackageManager(command, args, cwd, env);
  return new Promise((resolve, reject) => {
    const child = spawn(executable.command, executable.args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [input !== undefined ? 'pipe' : inheritStdin ? 'inherit' : 'ignore', inheritOutput ? 'inherit' : 'pipe', inheritOutput ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let processError: Error | undefined;
    let windowsTermination: Promise<void> | undefined;
    let groupTermination: Promise<void> | undefined;
    let groupCleanupTimer: ReturnType<typeof setTimeout> | undefined;

    const stopGroup = () => {
      groupTermination ??= stopRemainingProcessGroup(child.pid).catch(error => { processError = error; });
      return groupTermination;
    };

    const terminateGroup = (force: boolean) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        windowsTermination = new Promise(done => {
          killer.once('error', () => { child.kill(); done(); });
          killer.once('close', () => done());
        });
      } else {
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            processError = error as Error;
            child.kill(force ? 'SIGKILL' : 'SIGTERM');
          }
        }
      }
    };
    const abort = () => {
      terminateGroup(false);
      if (process.platform !== 'win32') {
        escalation = setTimeout(() => terminateGroup(true), 1000);
      }
    };

    child.stdout?.setEncoding('utf8');
    if (input !== undefined) {
      child.stdin!.on('error', error => { processError = error; });
      child.stdin!.end(input);
    }
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', error => { processError = error; });
    // Descendants can keep the output pipes open after the leader exits, delaying close.
    child.once('exit', () => {
      // Give normally exiting children a turn to release their pipes and process group.
      groupCleanupTimer = setTimeout(stopGroup, 20);
    });
    child.once('close', async (code, exitSignal) => {
      if (groupCleanupTimer) clearTimeout(groupCleanupTimer);
      signal?.removeEventListener('abort', abort);
      if (escalation) {
        // The leader may exit before descendants; finish killing its group before cleanup.
        clearTimeout(escalation);
        terminateGroup(true);
      }
      await windowsTermination;
      await stopGroup();
      const safeStdout = redactOutput(stdout, env);
      const safeStderr = redactOutput(stderr, env);
      try {
        if (logPath) fs.writeFileSync(logPath, `${safeStdout}${safeStderr}`, { mode: 0o600 });
      } catch (error) {
        reject(error);
        return;
      }
      if (signal?.aborted) {
        reject(comparisonAbortError());
      } else if (processError) {
        reject(new Error(`${phase} could not start or finish: ${redactOutput(processError.message, env)}`));
      } else if (code === null || !allowedExitCodes.includes(code)) {
        const detail = safeStderr.trim().slice(-2000);
        reject(new Error(`${phase} failed (${exitSignal || `exit ${code}`}).${detail ? `\n${detail}` : ''}`));
      } else {
        resolve({ stdout, stderr: safeStderr, exitCode: code });
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
