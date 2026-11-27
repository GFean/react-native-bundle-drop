import fs from 'fs';
import path from 'path';
import { calculateRuntimeFingerprint } from '../../runtime-fingerprint/calculate';
import type { RuntimeFingerprint } from '../../runtime-fingerprint/calculate';

type FingerprintCommandOptions = { platform: string; output?: string; compare?: string; json?: boolean };

type ComparableSources = Pick<RuntimeFingerprint, 'sources'>;

function compareSources(before: ComparableSources, after: ComparableSources) {
  if (!Array.isArray(before?.sources)) throw new Error('Invalid fingerprint report.');
  const toMap = (report: ComparableSources) => new Map(
    report.sources.map(source => [`${source.type}:${source.id}`, source.hash]),
  );
  const original = toMap(before);
  const current = toMap(after);
  return [...new Set([...original.keys(), ...current.keys()])].sort()
    .map(id => ({ id, before: original.get(id) ?? null, after: current.get(id) ?? null }))
    .filter(change => change.before !== change.after);
}

export function runFingerprintCommand(options: FingerprintCommandOptions) {
  const { platform } = options;
  if (platform !== 'ios' && platform !== 'android') throw new Error('Fingerprint platform must be ios or android.');
  const report = calculateRuntimeFingerprint(process.cwd(), platform);
  if (options.output) {
    const output = path.resolve(options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  const changes = options.compare
    ? compareSources(JSON.parse(fs.readFileSync(path.resolve(options.compare), 'utf8')), report)
    : undefined;
  console.log(options.json
    ? JSON.stringify({ ...report, ...(changes ? { changes } : {}) })
    : `${report.runtimeVersion}\nScheme 2.${changes ? `\n${JSON.stringify(changes, null, 2)}` : ''}`);
  return report;
}
