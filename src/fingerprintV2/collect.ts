import fs from 'node:fs';
import path from 'node:path';
import type { FingerprintOptions } from '../fingerprint/types';
import { portableCocoaPodsLock } from './cocoapodsLock';
import { dependencySources, loadDependencyLock, patchSources } from './dependencies';
import { canonicalJson, compareText, digest, isProjectDirectoryIgnored, posix, projectFileSources, type Platform, type Source } from './files';

type Scheme2Options = Pick<FingerprintOptions, 'nativeProjectMode' | 'extraSources'>;
type DiscoveredSource =
  | { type: 'contents'; id: string; contents: string; reasons: string[] }
  | { type: 'dir' | 'file'; filePath: string; reasons: string[] }
  | { type: 'package'; name: string; version: string; filePath: string; reasons: string[] };

const bundledDiscovery = path.resolve(__dirname, '..', '..', 'third_party', 'expo-fingerprint', 'build');
const discovery = (file: string): any => require(path.join(bundledDiscovery, file));
const resolveFrom = require('resolve-from') as { silent(root: string, module: string): string | undefined };
const generatedPaths = [
  '**/.bundle-drop/**',
  '**/bundle.drop.config.js',
  '**/android/*/build/**',
  '**/android/**/.cxx/**',
  '**/android/**/.gradle/**',
  '**/android/**/.kotlin/**',
  '**/*-gradle-plugin/.kotlin/**',
  '**/android/local.properties',
  '**/android/**/debug.keystore',
  '**/android/**/output-metadata.json',
  '**/ios/**/xcuserdata/**',
  '**/ios/**/.xcode.env.local',
];

const autolinkingSource = (source: DiscoveredSource): boolean => source.reasons.some(reason =>
  /^rncoreAutolinking|^expoAutolinking/.test(reason));

function inferNativeMode(root: string, workspaceRoot: string, platform: Platform): 'cng' | 'native' {
  if (!resolveFrom.silent(root, 'expo/config')) return 'native';
  const nativePath = path.join(root, platform);
  return !fs.existsSync(nativePath) || isProjectDirectoryIgnored(workspaceRoot, nativePath) ? 'cng' : 'native';
}

function packageManifestAbove(root: string, sourcePath: string): string | undefined {
  let directory = path.resolve(root, sourcePath);
  for (;;) {
    if (directory === root || directory === path.dirname(directory)) return undefined;
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) return posix(path.relative(root, manifest));
    directory = path.dirname(directory);
  }
}

function relativeLocation(value: string, root: string, moduleRoot?: string): string {
  const candidate = posix(value);
  if (moduleRoot && (candidate === moduleRoot || candidate.startsWith(`${moduleRoot}/`))) {
    return `dependency:${candidate.slice(moduleRoot.length).replace(/^\//, '')}`;
  }
  const normalizedRoot = posix(root);
  if (candidate.startsWith(`${normalizedRoot}/`)) return `project:${candidate.slice(normalizedRoot.length + 1)}`;
  const installedPackage = candidate.match(/^(?:(?:\.\.\/)*|\/.*\/)?node_modules\/(?:.*\/node_modules\/)?((?:@[^/]+\/)?[^/]+)(\/.*)?$/);
  if (installedPackage) return `package:${installedPackage[1]}${installedPackage[2] ?? ''}`;
  return candidate;
}

function normalizedAutolinkingConfig(source: Extract<DiscoveredSource, { type: 'contents' }>, root: string, platform: Platform): string {
  function normalize(value: unknown, moduleRoot?: string): unknown {
    if (typeof value === 'string') return relativeLocation(value, root, moduleRoot);
    if (Array.isArray(value)) return value.map(entry => normalize(entry, moduleRoot)).filter(entry => entry !== undefined);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (record.platforms && typeof record.platforms === 'object') {
      const selected = (record.platforms as Record<string, unknown>)[platform];
      if (!selected) return undefined;
      const location = typeof record.root === 'string' ? posix(record.root) : undefined;
      const { root: _installationPath, platforms: _platforms, ...rest } = record;
      return { ...rest, platforms: { [platform]: normalize(selected, location) } };
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, normalize(entry, moduleRoot)]));
  }
  return canonicalJson(normalize(JSON.parse(source.contents)));
}

function unlinkedPackageRoots(sources: DiscoveredSource[], root: string, platform: Platform): Set<string> {
  const unlinked = sources.flatMap(source => {
    if (source.type !== 'contents' || !source.id.startsWith('rncoreAutolinkingConfig')) return [];
    const dependencies = JSON.parse(source.contents) as Record<string, { root: string; platforms: Partial<Record<Platform, unknown>> }>;
    return Object.values(dependencies).filter(dependency => !dependency.platforms[platform])
      .map(dependency => path.resolve(root, dependency.root));
  });
  return new Set(unlinked);
}

function explicitSources(root: string, platform: Platform, entries: NonNullable<Scheme2Options['extraSources']>): Source[] {
  const declaredIds = new Set<string>();
  return entries.flatMap<Source>(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() ||
        typeof entry.value !== 'string' || !entry.value ||
        !['file', 'dir', 'environment'].includes(entry.type)) {
      throw new Error('Invalid fingerprint extra source. Supply id, type, and value.');
    }
    if (entry.platforms !== undefined &&
        (!Array.isArray(entry.platforms) || entry.platforms.length === 0
          || entry.platforms.some(name => name !== 'ios' && name !== 'android'))) {
      throw new Error(`Invalid fingerprint extra source platforms: ${entry.id}. Use a nonempty array of ios or android.`);
    }
    if (entry.optional !== undefined && typeof entry.optional !== 'boolean') {
      throw new Error(`Invalid fingerprint extra source optional flag: ${entry.id}. Use a boolean.`);
    }
    if (declaredIds.has(entry.id)) throw new Error(`Duplicate fingerprint extra source: ${entry.id}`);
    declaredIds.add(entry.id);
    if (entry.platforms && !entry.platforms.includes(platform)) return [];
    const id = `extra:${entry.id}`;
    const reasons = ['explicitNativeInput'];
    if (entry.type === 'environment') {
      const value = process.env[entry.value];
      if (value === undefined && !entry.optional) throw new Error(`Required fingerprint extra source is missing: ${entry.id}`);
      return [{ type: 'contents', id, hash: digest(canonicalJson({ value })), reasons }];
    }
    const file = path.resolve(root, entry.value);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      if (!entry.optional) throw new Error(`Required fingerprint extra source is missing: ${entry.id}`);
      return [{ type: 'contents', id, hash: digest('absent'), reasons }];
    }
    if (entry.type === 'file' && stat.isFile()) return [{ type: 'file', id, hash: digest(fs.readFileSync(file)), reasons }];
    if (entry.type === 'dir' && stat.isDirectory()) {
      const files = projectFileSources({ root: file, directory: '', idPrefix: '', reason: reasons[0] });
      return [{ type: 'dir', id, hash: digest(canonicalJson(files.map(source => [source.id, source.hash]))), reasons }];
    }
    throw new Error(`Fingerprint extra source has the wrong type: ${entry.id}`);
  });
}

function isCodegenSpec(file: string, platform: Platform): boolean {
  const filename = path.basename(file).replace(/\.fb(\.|$)/, '$1');
  if (!/^(Native.+|.+NativeComponent)/.test(filename) ||
      !/\.(?:js|ts|tsx)$/.test(filename) ||
      /__tests|NativeUIManager\.js$|\.d\.ts$|NativeSampleTurboModule/.test(file)) return false;
  const parts = filename.split('.');
  return parts.length === 2 || parts[1] === platform;
}

function codegenSources(root: string, workspaceRoot: string, platform: Platform): Source[] {
  type Codegen = { jsSrcsDir?: string; libraries?: Codegen[]; platforms?: Partial<Record<Platform, { jsSrcsDir?: string }>> };
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { codegenConfig?: Codegen };
  const config = manifest.codegenConfig;
  if (!config) return [];
  const directories = (config.libraries ?? [config])
    .map(entry => entry.platforms?.[platform]?.jsSrcsDir ?? entry.jsSrcsDir)
    .filter((directory): directory is string => typeof directory === 'string');
  const sources: Source[] = [{
    type: 'contents', id: 'appCodegenConfig', hash: digest(canonicalJson(config)), reasons: ['appCodegen'],
  }];
  for (const directory of new Set(directories)) {
    const relative = path.relative(root, path.resolve(root, directory));
    if (relative.split(path.sep)[0] === '..' || path.isAbsolute(relative)) {
      throw new Error('App codegen sources must be within the project. Declare external inputs with fingerprint.extraSources.');
    }
    sources.push(...projectFileSources({
      root, directory: relative, idPrefix: relative ? `codegen:${posix(relative)}/` : 'codegen:',
      reason: 'appCodegen', honorGitignore: true, ignoreRoot: workspaceRoot,
      skip: (file, isDirectory) => !isDirectory && !isCodegenSpec(file, platform),
    }));
  }
  return sources;
}

export async function collectNativeFingerprintV2(
  projectRoot: string,
  platform: Platform,
  options: Scheme2Options,
  manualBoundary: string | null,
) {
  const root = fs.realpathSync(projectRoot);
  const lock = loadDependencyLock(root);
  const mode = options.nativeProjectMode?.[platform] ?? inferNativeMode(root, lock.root, platform);
  const native = mode === 'native';
  if (native && !fs.statSync(path.join(root, platform), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Required native fingerprint directory is missing: ${platform}/.`);
  }
  const { SourceSkips } = discovery('sourcer/SourceSkips');
  const settings = await discovery('Options').normalizeOptionsAsync(root, {
    platforms: [platform], preset: 'balanced', hashAlgorithm: 'sha256', concurrentIoLimit: 8,
    nativeModuleSourceType: 'package', configPluginSourceType: 'package',
    bundleDropNativeProjectMode: { [platform]: mode },
    sourceSkips: SourceSkips.PackageJsonScriptsAll | SourceSkips.ExpoConfigVersions
      | SourceSkips.ExpoConfigRuntimeVersionIfString | SourceSkips.GitIgnore
      | SourceSkips.EasJson | SourceSkips.Easignore,
    ignorePaths: generatedPaths,
    silent: true,
  });
  const { isIgnoredPathWithMatchObjects } = discovery('utils/Path');
  const skip = (relative: string, directory: boolean): boolean => isIgnoredPathWithMatchObjects(relative,
    directory ? settings.ignoreDirMatchObjects : settings.ignorePathMatchObjects);
  const raw = await discovery('sourcer/Sourcer').getHashSourcesAsync(root, settings) as DiscoveredSource[];
  const unlinked = unlinkedPackageRoots(raw, root, platform);
  const sources = new Map<string, Source>();
  const collectedNativeConfig = raw.some(source => source.type === 'contents' && source.id === 'expoConfig');
  if (!native && !collectedNativeConfig) throw new Error('CNG fingerprinting requires a discoverable Expo configuration.');

  function add(source: Source): void {
    const key = `${source.type}:${source.id}`;
    const previous = sources.get(key);
    if (previous && source.hash !== previous.hash) throw new Error(`Conflicting native fingerprint input: ${key}`);
    if (previous) previous.reasons = [...new Set([...previous.reasons, ...source.reasons])].sort(compareText);
    else sources.set(key, source);
  }

  if (native) {
    const files = projectFileSources({
      root, directory: platform, idPrefix: `${platform}/`, reason: 'appNativeProject',
      skip, honorGitignore: true, ignoreRoot: lock.root, normalizeBuildNumbers: true,
    });
    if (files.length === 0) throw new Error(`No app-owned native fingerprint inputs found under ${platform}/.`);
    const reactNative = platform === 'ios' ? raw.find(source => source.type === 'package'
      && source.name === 'react-native' && source.reasons.includes('package:react-native')) : undefined;
    for (const source of files) {
      if (source.id === 'ios/Podfile.lock' && reactNative?.type === 'package') {
        const file = path.join(root, source.id);
        const packageRoot = path.dirname(path.resolve(root, reactNative.filePath));
        source.hash = digest(portableCocoaPodsLock(fs.readFileSync(file), path.dirname(file), packageRoot));
      }
      add(source);
    }
  }
  for (const name of ['react-native.config.js', 'react-native.config.cjs', 'react-native.config.ts']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) add({ type: 'file', id: name, hash: digest(fs.readFileSync(file)), reasons: ['appAutolinkingConfig'] });
  }
  codegenSources(root, lock.root, platform).forEach(add);

  for (const source of raw) {
    if (source.reasons.some(reason => ['bareNativeDir', 'patchPackage', 'expoCNGPatches'].includes(reason))) continue;
    if (source.type === 'contents') {
      const content = autolinkingSource(source) ? normalizedAutolinkingConfig(source, root, platform) : source.contents;
      add({ type: 'contents', id: source.id, hash: digest(content), reasons: source.reasons });
      continue;
    }
    const manifest = source.type === 'package' ? source.filePath
      : source.type === 'dir' && autolinkingSource(source) ? packageManifestAbove(root, source.filePath) : undefined;
    if (manifest) {
      if (source.reasons.some(reason => reason.startsWith('rncoreAutolinking'))
        && unlinked.has(path.dirname(path.resolve(root, manifest)))) continue;
      const name = source.type === 'package' ? source.name
        : (JSON.parse(fs.readFileSync(path.resolve(root, manifest), 'utf8')) as { name?: string }).name;
      if (!name) throw new Error(`Native dependency manifest has no name: ${manifest}`);
      dependencySources(root, lock, { name, packageJson: manifest }, source.reasons, skip).forEach(add);
    } else if (!skip(source.filePath, source.type === 'dir')) {
      if (source.type === 'file') {
        add({ type: 'file', id: source.filePath, hash: digest(fs.readFileSync(path.resolve(root, source.filePath))), reasons: source.reasons });
      } else if (source.type === 'dir') {
        projectFileSources({
          root: path.resolve(root, source.filePath), directory: '', idPrefix: `${source.filePath}/`,
          reason: source.reasons[0], skip, honorGitignore: true,
        }).forEach(add);
      }
    }
  }
  patchSources(root, lock).forEach(add);
  explicitSources(root, platform, options.extraSources ?? []).forEach(add);
  const ordered = [...sources.values()].sort((left, right) => compareText(`${left.type}:${left.id}`, `${right.type}:${right.id}`));
  const nativeHash = digest(canonicalJson(ordered.map(source => [source.type, source.id, source.hash])));
  const runtimeVersion = `bdfp2-${digest(canonicalJson({
    domain: 'bundle-drop-native-fingerprint', schemeVersion: 2, platform, manualBoundary, nativeHash,
  }))}`;
  return { status: 'stable', schemeVersion: 2, platform, runtimeVersion, nativeHash, manualBoundary, sources: ordered } as const;
}
