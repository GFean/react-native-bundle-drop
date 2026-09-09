import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkComparisonAbort,
  runComparisonProcess,
} from '../../../../CLI/scripts/sight-compare/process';

describe('Sight comparison subprocesses', () => {
  const roots: string[] = [];
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const fixture = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-process-test-'));
    roots.push(root);
    return root;
  };
  const options = (script: string) => ({ command: process.execPath, args: ['-e', script], cwd: fixture(), phase: 'Test build' });
  const fakeChild = (pid: number | undefined = 123456) => Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(),
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    Object.defineProperty(process, 'platform', platform);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('captures stdout and redacts credential values and URL passwords in logs and stderr', async () => {
    const args = options('process.stdout.write("output"); process.stderr.write("https://user:pass@example.test https://token@example.test abcsecret");');
    const logPath = path.join(args.cwd, 'logs', 'build.log');
    const result = await runComparisonProcess({ ...args, logPath, env: { ...process.env, TEST_TOKEN: 'abcsecret', EMPTY_TOKEN: '', SHORT_PASSWORD: 'abc' } });
    expect(result).toEqual({ stdout: 'output', stderr: 'https://[redacted]@example.test https://[redacted]@example.test [redacted]', exitCode: 0 });
    expect(fs.readFileSync(logPath, 'utf8')).toBe('outputhttps://[redacted]@example.test https://[redacted]@example.test [redacted]');
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('writes stdin and permits explicitly expected nonzero exits', async () => {
    const result = await runComparisonProcess({ ...options('process.stdin.pipe(process.stdout); process.stdin.on("end",()=>{process.exitCode=1})'), input: 'paths\0with spaces', allowedExitCodes: [0, 1] });
    expect(result.stdout).toBe('paths\0with spaces');
    expect(result.exitCode).toBe(1);
  });

  it('reports exit failures with useful stderr, including empty stderr', async () => {
    await expect(runComparisonProcess(options('console.error("install failed"); process.exit(2)'))).rejects.toThrow('Test build failed (exit 2).\ninstall failed');
    await expect(runComparisonProcess(options('process.exit(3)'))).rejects.toThrow('Test build failed (exit 3).');
    await expect(runComparisonProcess(options('process.kill(process.pid, "SIGTERM")'))).rejects.toThrow('SIGTERM');
  });

  it('reports executable spawn errors', async () => {
    await expect(runComparisonProcess({ ...options(''), command: 'sight-does-not-exist-xyz' })).rejects.toThrow('could not start or finish');
  });

  it('handles cancellation before spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => checkComparisonAbort(controller.signal)).toThrow('cancelled');
    await expect(runComparisonProcess({ ...options(''), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('terminates a real process and its long-lived child before returning', async () => {
    const controller = new AbortController();
    const args = options('');
    const ready = path.join(args.cwd, 'ready');
    args.args = ['-e', "const cp=require('child_process');const fs=require('fs');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)", ready];
    const pending = runComparisonProcess({ ...args, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    while (!fs.existsSync(ready)) await new Promise(resolve => setTimeout(resolve, 10));
    const descendant = Number(fs.readFileSync(ready, 'utf8'));
    controller.abort();
    await rejection;
    // SIGKILL is dispatched to the group before the promise settles; wait for kernel reaping.
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try { process.kill(descendant, 0); } catch { alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(alive).toBe(false);
  });

  it('escalates cancellation when a child ignores SIGTERM', async () => {
    jest.useFakeTimers();
    const child = fakeChild();
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    const kill = jest.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('exited'), { code: 'ESRCH' });
      return true;
    });
    const controller = new AbortController();
    const pending = runComparisonProcess({ ...options(''), signal: controller.signal, inheritStdin: true });
    controller.abort();
    jest.advanceTimersByTime(1000);
    child.emit('close', null, 'SIGKILL');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  });

  it('ignores already-exited groups and falls back to the child for other kill errors', async () => {
    for (const code of ['ESRCH', 'EPERM']) {
      const child = fakeChild();
      jest.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      jest.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('kill failed'), { code }); });
      const controller = new AbortController();
      const pending = runComparisonProcess({ ...options(''), signal: controller.signal });
      controller.abort();
      child.emit('close', 0, null);
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(child.kill).toHaveBeenCalledTimes(code === 'EPERM' ? 2 : 0);
      jest.restoreAllMocks();
    }
  });

  it('uses Windows taskkill for the entire process tree, including taskkill failure', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const failure of [false, true]) {
      const child = fakeChild();
      const killer = fakeChild();
      const spawn = jest.spyOn(childProcess, 'spawn').mockReturnValueOnce(child as never).mockReturnValueOnce(killer as never);
      const controller = new AbortController();
      const pending = runComparisonProcess({ ...options(''), signal: controller.signal });
      controller.abort();
      if (failure) killer.emit('error', new Error('taskkill missing'));
      killer.emit('close', 0);
      child.emit('close', 1, null);
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(spawn).toHaveBeenLastCalledWith('taskkill', ['/pid', '123456', '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      expect(child.kill).toHaveBeenCalledTimes(failure ? 1 : 0);
      jest.restoreAllMocks();
    }
  });

  it('covers an abort racing spawn with no PID, and an input pipe error', async () => {
    const controller = new AbortController();
    const child = fakeChild();
    child.pid = undefined;
    jest.spyOn(childProcess, 'spawn').mockImplementation(() => { controller.abort(); return child as never; });
    const pending = runComparisonProcess({ ...options(''), signal: controller.signal });
    child.emit('close', null, null);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    jest.restoreAllMocks();
    const inputChild = fakeChild();
    jest.spyOn(childProcess, 'spawn').mockReturnValue(inputChild as never);
    const inputPending = runComparisonProcess({ ...options(''), input: 'data' });
    inputChild.stdin.emit('error', new Error('pipe failed'));
    inputChild.emit('close', 1, null);
    await expect(inputPending).rejects.toThrow('pipe failed');
  });

  it('rejects log write failures', async () => {
    const args = options('console.log("ok")');
    await expect(runComparisonProcess({ ...args, logPath: args.cwd })).rejects.toThrow();
  });

  it.each([
    [0, 'ignore'], [7, 'ignore'], [0, 'inherit'], [7, 'inherit'],
  ])('stops an unref background descendant after exit %s with %s stdio', async (exitCode, stdio) => {
    const args = options('');
    const pidFile = path.join(args.cwd, 'background-pid');
    args.args = ['-e', "const cp=require('child_process'),fs=require('fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:process.argv[2]});fs.writeFileSync(process.argv[1],String(child.pid));child.unref();process.stdout.write('parent output');process.exitCode=Number(process.argv[3]);", pidFile, stdio, String(exitCode)];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      if (exitCode) await expect(runComparisonProcess({ ...args, signal: controller.signal })).rejects.toThrow(`exit ${exitCode}`);
      else expect(await runComparisonProcess({ ...args, signal: controller.signal })).toMatchObject({ exitCode: 0, stdout: 'parent output' });
    } finally {
      clearTimeout(timeout);
    }
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('escalates successful-completion cleanup when a background descendant ignores SIGTERM', async () => {
    jest.useFakeTimers();
    const child = fakeChild();
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    let terminated = false;
    const kill = jest.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (terminated) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') terminated = true;
      return true;
    });
    const pending = runComparisonProcess(options(''));
    child.emit('close', 0);
    await jest.advanceTimersByTimeAsync(1000);
    expect((await pending).exitCode).toBe(0);
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  });

  it.each(['gone', 'denied', 'persistent'])('handles a %s process group during normal-completion cleanup', async scenario => {
    jest.useFakeTimers();
    const child = fakeChild();
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    jest.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal !== 0 && scenario !== 'persistent') {
        throw Object.assign(new Error('group signal failed'), { code: scenario === 'gone' ? 'ESRCH' : 'EPERM' });
      }
      return true;
    });
    const pending = runComparisonProcess(options(''));
    const result = scenario === 'gone' ? expect(pending).resolves.toMatchObject({ exitCode: 0 }) : expect(pending).rejects.toThrow(scenario === 'denied' ? 'group signal failed' : 'process group running');
    child.emit('close', 0);
    await jest.advanceTimersByTimeAsync(2100);
    await result;
  });

  it('waits for Darwin zombie-only groups to become absent after transient EPERM probes', async () => {
    jest.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const child = fakeChild();
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('unreaped group'), { code: 'EPERM' });
    });
    const pending = runComparisonProcess(options(''));
    child.emit('close', 0);
    await jest.advanceTimersByTimeAsync(40);
    kill.mockImplementation(() => { throw Object.assign(new Error('reaped group'), { code: 'ESRCH' }); });
    await jest.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it.each(['darwin', 'linux'])('rejects persistent EPERM probes on %s without claiming cleanup success', async host => {
    jest.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: host });
    const child = fakeChild();
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    const pending = runComparisonProcess(options(''));
    const rejection = expect(pending).rejects.toThrow('permission denied');
    child.emit('close', 0);
    await jest.advanceTimersByTimeAsync(100);
    await rejection;
    expect(kill).toHaveBeenCalledTimes(host === 'darwin' ? 6 : 1);
  });

  it('executes standard Windows npm, pnpm and Corepack shims through Node without shell interpolation', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const [manager, relativeScript] of [
      ['npm', 'node_modules/npm/bin/npm-cli.js'],
      ['pnpm', 'node_modules/pnpm/bin/pnpm.cjs'],
      ['yarn', 'node_modules/corepack/dist/yarn.js'],
      ['yarn', 'node_modules/yarn/bin/yarn.js'],
    ]) {
      const root = fixture();
      fs.writeFileSync(path.join(root, `${manager}.cmd`), 'Windows shim');
      const script = path.join(root, relativeScript);
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, '');
      const child = fakeChild();
      const spawn = jest.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      const args = ['config', 'get', 'a path with spaces & %VARIABLE%'];
      const pending = runComparisonProcess({ command: manager, args, cwd: root, phase: 'Windows manager', env: { Path: `"${root}"`, PATHEXT: '.EXE;.CMD' } });
      child.emit('close', 0);
      await pending;
      expect(spawn).toHaveBeenCalledWith(process.execPath, [script, ...args], expect.objectContaining({ shell: false, detached: false }));
      jest.restoreAllMocks();
    }
  });

  it('supports native Windows managers, explicit shim paths and local .bin launchers', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const root = fixture();
    const native = path.join(root, 'pnpm.exe');
    fs.writeFileSync(native, 'native executable');
    let child = fakeChild();
    let spawn = jest.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    let pending = runComparisonProcess({ command: native, args: ['--version'], cwd: root, phase: 'Native manager', env: {} });
    child.emit('close', 0);
    await pending;
    expect(spawn).toHaveBeenCalledWith(native, ['--version'], expect.any(Object));
    jest.restoreAllMocks();
    const bin = path.join(root, 'node_modules', '.bin');
    const script = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(path.join(bin, 'npm.bat'), 'shim');
    fs.writeFileSync(script, '');
    child = fakeChild();
    spawn = jest.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    pending = runComparisonProcess({ command: 'npm.bat', args: ['--version'], cwd: root, phase: 'Local manager', env: { PATH: `${path.join(root, 'missing')};${bin}` } });
    child.emit('close', 0);
    await pending;
    expect(spawn).toHaveBeenCalledWith(process.execPath, [script, '--version'], expect.any(Object));
  });

  it('rejects missing or unknown Windows launchers without invoking a shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const root = fixture();
    const spawn = jest.spyOn(childProcess, 'spawn');
    await expect(runComparisonProcess({ command: 'npm', args: [], cwd: root, phase: 'Missing manager', env: {} })).rejects.toThrow('Could not find npm');
    fs.writeFileSync(path.join(root, 'npm.cmd'), 'custom unknown launcher');
    await expect(runComparisonProcess({ command: 'npm', args: [], cwd: root, phase: 'Unknown manager', env: { PATH: root } })).rejects.toThrow('Unsupported Windows npm launcher');
    fs.writeFileSync(path.join(root, 'npm.ps1'), 'powershell launcher');
    await expect(runComparisonProcess({ command: 'npm', args: [], cwd: root, phase: 'Unsupported extension', env: { PATH: root, PATHEXT: '.PS1' } })).rejects.toThrow('Unsupported Windows npm launcher');
    expect(spawn).not.toHaveBeenCalled();
  });
});
