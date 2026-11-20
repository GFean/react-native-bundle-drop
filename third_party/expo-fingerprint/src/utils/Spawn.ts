import { spawn, type SpawnOptions as NodeSpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export type SpawnOptions = NodeSpawnOptions;
export type SpawnResult = { stdout: string; stderr: string; status: number };
export type SpawnPromise<T = SpawnResult> = Promise<T> & { child: ReturnType<typeof spawn> };

function resolveReactNativeCli(projectRoot: string): string {
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  try {
    return projectRequire.resolve('react-native/cli.js');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;

    // React Native still declares a CLI binary when its exports map hides cli.js.
    const manifest = projectRequire.resolve('react-native/package.json');
    const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const executable = typeof bin === 'string' ? bin : bin?.['react-native'];
    if (typeof executable !== 'string' || !executable || path.isAbsolute(executable)) throw error;

    const packageRoot = fs.realpathSync(path.dirname(manifest));
    const cliPath = fs.realpathSync(path.resolve(packageRoot, executable));
    const relative = path.relative(packageRoot, cliPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) || !fs.statSync(cliPath).isFile()) {
      throw error;
    }
    return cliPath;
  }
}

/** Bounded, project-local commands. No shell or implicit package installation. */
export default function spawnAsync(command: string, args: string[] = [], options: SpawnOptions = {}): SpawnPromise {
  if (command === 'node') command = process.execPath;
  if (command === 'npx') {
    if (args.join(' ') !== 'react-native config' || typeof options.cwd !== 'string') {
      throw new Error('Fingerprint collection cannot install or invoke arbitrary npx commands.');
    }
    args = [resolveReactNativeCli(options.cwd), 'config'];
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
