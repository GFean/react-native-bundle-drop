import { spawn, type SpawnOptions as NodeSpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

export type SpawnOptions = NodeSpawnOptions;
export type SpawnResult = { stdout: string; stderr: string; status: number };
export type SpawnPromise<T = SpawnResult> = Promise<T> & { child: ReturnType<typeof spawn> };

/** Bounded, project-local commands. No shell or implicit package installation. */
export default function spawnAsync(command: string, args: string[] = [], options: SpawnOptions = {}): SpawnPromise {
  if (command === 'node') command = process.execPath;
  if (command === 'npx') {
    if (args.join(' ') !== 'react-native config' || typeof options.cwd !== 'string') {
      throw new Error('Fingerprint collection cannot install or invoke arbitrary npx commands.');
    }
    const projectRequire = createRequire(path.join(options.cwd, 'package.json'));
    args = [projectRequire.resolve('react-native/cli.js'), 'config'];
    command = process.execPath;
  }
  const child = spawn(command, args, { ...options, shell: false, timeout: 60_000 });
  const promise = new Promise<SpawnResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      if (status === 0) resolve({ stdout, stderr, status });
      else reject(new Error(`Fingerprint subprocess failed (${command}, status ${status}): ${stderr.trim()}`));
    });
  }) as SpawnPromise;
  promise.child = child;
  return promise;
}
