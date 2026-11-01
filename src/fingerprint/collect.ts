import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { selectRuntimeVersion } from './config';
import { normalizeAndroidBuildNumber } from './normalizeBuildNumber';
import { normalizeIosProjectBuildNumber } from './normalizeIosBuildNumber';
import type { FingerprintExtraSource, NativeFingerprint } from './types';

// The complete maintained adaptation is packaged independently of the mobile SDK.
const upstreamRoot = path.resolve(__dirname, '..', '..', 'third_party', 'expo-fingerprint', 'build');
const upstream = (file: string): any => require(path.join(upstreamRoot, file));

const GENERATED_PATHS = [
  '**/.bundle-drop/generated/**', '**/.bundle-drop/artifacts/**',
  '**/.bundle-drop/fingerprints/**', '**/.bundle-drop/build-identity.json',
  '**/.bundle-drop/runtime-delivery.lock.json', '**/.bundle-drop/runtime-delivery.generated.json',
  '**/bundle.drop.config.js',
  '**/node_modules/@gfean/react-native-bundle-drop/dist/**',
  '**/*-gradle-plugin/.kotlin/**', '**/android/.kotlin/**', '**/android/local.properties',
  '**/android/**/debug.keystore', '**/android/**/output-metadata.json',
];

type ExtraInput =
  | { type: 'contents'; id: string; contents: string; reasons: string[] }
  | { type: 'file' | 'dir'; filePath: string; overrideHashKey: string; reasons: string[] };

function extraSources(projectRoot: string, platform: 'ios' | 'android', entries: FingerprintExtraSource[]): ExtraInput[] {
  const ids = new Set<string>();
  return entries.flatMap<ExtraInput>(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() ||
        typeof entry.value !== 'string' || !entry.value ||
        !['file', 'dir', 'environment'].includes(entry.type)) {
      throw new Error('Invalid fingerprint extra source. Supply id, type, and value.');
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate fingerprint extra source: ${entry.id}`);
    ids.add(entry.id);
    if (entry.platforms && !entry.platforms.includes(platform)) return [];
    const value = entry.type === 'environment' ? process.env[entry.value] : path.resolve(projectRoot, entry.value);
    const present = entry.type === 'environment' ? value !== undefined : fs.existsSync(value!);
    if (!present) {
      if (!entry.optional) throw new Error(`Required fingerprint extra source is missing: ${entry.id}`);
      return [{ type: 'contents', id: `extra:${entry.id}`, contents: 'absent', reasons: ['explicitOptionalInput'] }];
    }
    if (entry.type === 'environment') {
      return [{ type: 'contents', id: `extra:${entry.id}`, contents: JSON.stringify({ value }), reasons: ['explicitEnvironment'] }];
    }
    const stat = fs.statSync(value!);
    if ((entry.type === 'file' && !stat.isFile()) || (entry.type === 'dir' && !stat.isDirectory())) {
      throw new Error(`Fingerprint extra source has the wrong type: ${entry.id}`);
    }
    return [{ type: entry.type, filePath: path.relative(projectRoot, value!).split(path.sep).join('/'),
      overrideHashKey: `extra:${entry.id}`, reasons: ['explicitNativeInput'] }];
  });
}

/** Each call collects fresh source inputs; receipts and previous reports are never read. */
export async function collectNativeFingerprint(projectRoot: string, platform: 'ios' | 'android'): Promise<NativeFingerprint> {
  // Config modules are resolved by Node to physical paths. Use the same root
  // for source IDs so a checkout symlink cannot change the native identity.
  projectRoot = fs.realpathSync(path.resolve(projectRoot));
  const configPath = path.join(projectRoot, 'bundle.drop.config.js');
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  const selected = selectRuntimeVersion(config.runtimeVersion, platform);
  if (selected.source !== 'fingerprint') throw new Error('Fingerprint collection requires compatibilitySource: fingerprint.');
  const mode = selected.options.nativeProjectMode?.[platform];
  if (mode === 'native' && !fs.statSync(path.join(projectRoot, platform)).isDirectory()) {
    throw new Error(`The selected native fingerprint project is missing ${platform}/.`);
  }
  const bufferedFiles = new Map<string, Buffer[]>();
  const options = await upstream('Options').normalizeOptionsAsync(projectRoot, {
    platforms: [platform], preset: 'strict', hashAlgorithm: 'sha256', concurrentIoLimit: 8,
    nativeModuleSourceType: 'files', configPluginSourceType: 'files',
    bundleDropNativeProjectMode: selected.options.nativeProjectMode,
    sourceSkips: upstream('sourcer/SourceSkips').SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun |
      upstream('sourcer/SourceSkips').SourceSkips.ExpoConfigVersions |
      upstream('sourcer/SourceSkips').SourceSkips.GitIgnore,
    ignorePaths: GENERATED_PATHS,
    extraSources: extraSources(projectRoot, platform, selected.options.extraSources ?? []),
    debug: true, silent: true,
    fileHookTransform: (source: any, chunk: Buffer | null, isEnd: boolean) => {
      const normalize = /\.gradle(?:\.kts)?$/.test(source.filePath) ? normalizeAndroidBuildNumber
        : /^ios\/[^/]+\.xcodeproj\/project\.pbxproj$/.test(source.filePath) ? normalizeIosProjectBuildNumber : null;
      if (source.type !== 'file' || !normalize) return chunk;
      const chunks = bufferedFiles.get(source.filePath) ?? [];
      if (chunk) chunks.push(Buffer.from(chunk));
      if (!isEnd) { bufferedFiles.set(source.filePath, chunks); return null; }
      bufferedFiles.delete(source.filePath);
      return normalize(Buffer.concat(chunks).toString('utf8'));
    },
  });
  if (!options.useCNGForPlatforms[platform] && !fs.existsSync(path.join(projectRoot, platform))) {
    throw new Error(`Required native fingerprint directory is missing: ${platform}/.`);
  }
  const collected = await upstream('sourcer/Sourcer').getHashSourcesAsync(projectRoot, options);
  const sources = upstream('Sort').sortSources(upstream('Dedup').dedupSources(collected, projectRoot));
  const fingerprint = await upstream('hash/Hash').createFingerprintFromSourcesAsync(sources, projectRoot, options);
  const runtimeVersion = `bdfp1-${crypto.createHash('sha256').update(JSON.stringify({
    domain: 'bundle-drop-native-fingerprint', schemeVersion: 1, platform,
    manualBoundary: selected.boundary, nativeHash: fingerprint.hash,
  })).digest('hex')}`;
  return {
    status: 'stable', schemeVersion: 1, platform, runtimeVersion,
    nativeHash: fingerprint.hash, manualBoundary: selected.boundary,
    sources: fingerprint.sources.map((source: any) => ({
      type: source.type, id: upstream('hash/Hash').createSourceId(source),
      hash: source.hash, reasons: source.reasons, debugInfo: source.debugInfo,
    })),
  };
}
