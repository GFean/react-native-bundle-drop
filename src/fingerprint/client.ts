import { spawnSync } from 'child_process';
import path from 'path';
import type { NativeFingerprint } from './types';

/** The existing build/config APIs are synchronous. Isolate async discovery in
 * a bounded process instead of adding Node/collector code to mobile bundles.
 */
export function calculateFingerprintSync(projectRoot: string, platform: 'ios' | 'android'): NativeFingerprint {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'worker.js'), path.resolve(projectRoot), platform], {
    encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV === 'development' ? 'development' : 'production' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Fingerprint collection failed: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout) as NativeFingerprint;
}
