import { spawnSync } from 'child_process';
import path from 'path';
import type { NativeFingerprint } from '../fingerprint/types';

export type RuntimeFingerprint = NativeFingerprint;

export function calculateRuntimeFingerprint(
  projectRoot: string,
  platform: 'ios' | 'android',
): RuntimeFingerprint {
  const args = [path.join(__dirname, 'worker.js'), platform];
  const result = spawnSync(process.execPath, args, {
    cwd: path.resolve(projectRoot),
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV === 'development' ? 'development' : 'production' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Fingerprint collection failed: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout) as RuntimeFingerprint;
}
