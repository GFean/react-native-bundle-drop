import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ComparisonAssetEntry, ComparisonAssetManifest } from './types';

export const MAX_ASSET_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_COMPARISON_ASSETS_PER_SIDE = 10_000;

/** Inventory emitted files, never source directories or assets discovered by filename. */
export async function collectComparisonAssets(directory: string, signal: AbortSignal): Promise<ComparisonAssetEntry[]> {
  signal.throwIfAborted();
  const rootStats = fs.lstatSync(directory);
  if (!rootStats.isDirectory()) {
    throw new Error('Sight emitted assets must be a real directory.');
  }
  const entries: ComparisonAssetEntry[] = [];
  let manifestBytes = 0;
  let totalBytes = 0;
  async function visit(currentDirectory: string, prefix: string): Promise<void> {
    for (const name of fs.readdirSync(currentDirectory).sort()) {
      signal.throwIfAborted();
      const relativePath = prefix + name;
      if (/[\\:\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') {
        throw new Error(`Sight cannot represent this emitted asset path: ${JSON.stringify(relativePath)}.`);
      }
      const filePath = path.join(currentDirectory, name);
      const stats = fs.lstatSync(filePath);
      if (stats.isDirectory()) {
        await visit(filePath, relativePath + '/');
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Sight emitted asset is not a regular file: ${relativePath}.`);
      }
      totalBytes += stats.size;
      if (!Number.isSafeInteger(stats.size) || stats.size < 0 || !Number.isSafeInteger(totalBytes)) {
        throw new Error(`Sight emitted asset sizes exceed the supported byte range: ${relativePath}.`);
      }
      if (entries.length >= MAX_COMPARISON_ASSETS_PER_SIDE) {
        throw new Error('Sight emitted assets exceed 10000 files per comparison side.');
      }
      const hash = createHash('sha256');
      const stream = fs.createReadStream(filePath, { signal });
      for await (const chunk of stream) hash.update(chunk);
      signal.throwIfAborted();
      const after = fs.lstatSync(filePath);
      if (!after.isFile() || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || after.ino !== stats.ino) {
        throw new Error(`Sight emitted asset changed during inventory: ${relativePath}.`);
      }
      const entry = { path: relativePath, bytes: stats.size, sha256: hash.digest('hex') };
      manifestBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (manifestBytes > MAX_ASSET_MANIFEST_BYTES) {
        throw new Error('Sight asset manifest exceeds 4 MiB.');
      }
      entries.push(entry);
    }
  }
  await visit(directory, '');
  return entries;
}

export function writeComparisonAssetManifest(filePath: string, manifest: ComparisonAssetManifest): void {
  const json = JSON.stringify(manifest) + '\n';
  if (Buffer.byteLength(json) > MAX_ASSET_MANIFEST_BYTES) {
    throw new Error('Sight asset manifest exceeds 4 MiB.');
  }
  fs.writeFileSync(filePath, json, { mode: 0o600 });
}
