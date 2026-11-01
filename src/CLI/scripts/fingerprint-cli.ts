import fs from 'fs';
import path from 'path';
import { calculateFingerprintSync } from '../../fingerprint/client';
import type { NativeFingerprint } from '../../fingerprint/types';

export function compareFingerprintSources(before: NativeFingerprint, after: NativeFingerprint) {
  if (!Array.isArray(before.sources) || !Array.isArray(after.sources)) throw new Error('Invalid fingerprint report.');
  const oldSources = new Map(before.sources.map(source => [`${source.type}:${source.id}`, source.hash]));
  const newSources = new Map(after.sources.map(source => [`${source.type}:${source.id}`, source.hash]));
  return [...new Set([...oldSources.keys(), ...newSources.keys()])].sort()
    .filter(id => (oldSources.get(id) ?? null) !== (newSources.get(id) ?? null))
    .map(id => ({ id, before: oldSources.get(id) ?? null, after: newSources.get(id) ?? null }));
}

export function runFingerprintCli(options: { platform: string; output?: string; compare?: string; json?: boolean }) {
  if (options.platform !== 'ios' && options.platform !== 'android') throw new Error('Fingerprint platform must be ios or android.');
  const report = calculateFingerprintSync(process.cwd(), options.platform);
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const changes = options.compare
    ? compareFingerprintSources(JSON.parse(fs.readFileSync(path.resolve(options.compare), 'utf8')), report)
    : undefined;
  console.log(options.json ? JSON.stringify({ ...report, ...(changes ? { changes } : {}) })
    : `${report.runtimeVersion}\nScheme 1; calculation contract frozen.` +
      (changes ? `\n${JSON.stringify(changes, null, 2)}` : ''));
  return report;
}
