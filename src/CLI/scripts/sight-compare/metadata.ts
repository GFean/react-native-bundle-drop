import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ComparisonArtifact, ComparisonArtifacts, ComparisonMetadata } from './types';

export const MAX_COMPARISON_METADATA_BYTES = 64 * 1024;

export function describeArtifact(outputDirectory: string, filePath: string): ComparisonArtifact {
  const contents = fs.readFileSync(filePath);
  return {
    path: path.relative(outputDirectory, filePath).split(path.sep).join('/'),
    bytes: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

export function writeComparisonMetadata(
  artifacts: ComparisonArtifacts,
  metadata: Omit<ComparisonMetadata, 'artifacts'>,
): ComparisonMetadata {
  const describe = (filePath: string) => describeArtifact(artifacts.outputDirectory, filePath);
  const document: ComparisonMetadata = {
    ...metadata,
    artifacts: {
      baselineBundle: describe(artifacts.baseline.bundlePath),
      baselineSourceMap: describe(artifacts.baseline.sourceMapPath),
      currentBundle: describe(artifacts.current.bundlePath),
      currentSourceMap: describe(artifacts.current.sourceMapPath),
    },
    ...(artifacts.assetManifestPath ? { assetManifest: describe(artifacts.assetManifestPath) } : {}),
  };
  const json = JSON.stringify(document, null, 2) + '\n';
  if (Buffer.byteLength(json) > MAX_COMPARISON_METADATA_BYTES) {
    throw new Error('Sight comparison metadata exceeds 64 KiB. Reduce the included paths and retry.');
  }
  fs.writeFileSync(artifacts.metadataPath, json, { mode: 0o600 });
  return document;
}
