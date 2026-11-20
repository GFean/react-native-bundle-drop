import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { inspectProjectDirectory, inspectProjectFile } from '../safe-file-transaction';
import { projectNativeSetupMetadata } from './native-setup-metadata';
import { hasUnsafeTerminalControl } from './terminal-safety';
import type { AiSetupFileKind } from './types';

const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_SOURCE_FILES = 16;
const MAX_SOURCE_BYTES = 80 * 1024;
const MAX_SOURCE_CONTEXT_BYTES = 96 * 1024;
const MAX_SUPPORT_FILES = 8;
const MAX_SUPPORT_SUMMARY_BYTES = 24 * 1024;
const MAX_METADATA_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_INPUT_FILES = 48;
const EXCLUDED_DIRECTORIES = new Set([
  'build', 'deriveddata', 'generated', 'node_modules', 'pods', 'test', 'tests',
  'androidtest', 'testfixtures', 'unittest', 'vendor',
]);

type NativeSetupContextPath = {
  path: string;
  kind: Extract<AiSetupFileKind, 'ios_entrypoint' | 'android_entrypoint' | 'native_support'>;
};

const isExcludedDirectory = (name: string) =>
  name.startsWith('.') || EXCLUDED_DIRECTORIES.has(name.toLowerCase()) || name.endsWith('Tests');

const assertSafeContextPath = (file: string) => {
  if (file.length > 512 || file.includes('\\') || /[\t\r\n]/.test(file) || hasUnsafeTerminalControl(file)) {
    throw new Error('A native setup path has unsafe characters. Rename the path and retry.');
  }
};

/**
 * Collect only application-owned source paths and build metadata. The planning
 * service decides which supplied sources own startup after the user's consent.
 */
export function listNativeSetupContext(projectRoot: string): NativeSetupContextPath[] {
  const files = new Map<string, NativeSetupContextPath['kind']>();
  let visited = 0;
  const add = (file: string, kind: NativeSetupContextPath['kind']) => {
    assertSafeContextPath(file);
    files.set(file, kind);
  };
  const addIfPresent = (file: string) => {
    const stat = fs.lstatSync(path.join(projectRoot, file), { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing a non-regular native setup path: ${file}.`);
    }
    add(file, 'native_support');
  };
  const entries = (directory: string) => {
    const children = fs.readdirSync(path.join(projectRoot, directory), { withFileTypes: true });
    visited += children.length;
    if (visited > MAX_DIRECTORY_ENTRIES) {
      throw new Error('Native setup context exceeds the directory inspection limit.');
    }
    return children;
  };
  const walk = (root: string, visit: (file: string, name: string) => void, xcode: boolean) => {
    const pending = [root];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const item of entries(directory)) {
        if (isExcludedDirectory(item.name)) continue;
        const file = path.posix.join(directory, item.name);
        assertSafeContextPath(file);
        if (item.isSymbolicLink()) {
          throw new Error(`Refusing a symlinked native setup path: ${file}.`);
        }
        if (item.isFile()) {
          visit(file, item.name);
        } else if (item.isDirectory()) {
          if (xcode && item.name.endsWith('.xcodeproj')) addIfPresent(file + '/project.pbxproj');
          else if (!item.name.endsWith('.xcworkspace') && !item.name.endsWith('.xcassets')) pending.push(file);
        }
      }
    }
  };

  if (inspectProjectDirectory(projectRoot, 'ios')) {
    walk('ios', (file, name) => {
      const extension = path.posix.extname(name);
      if (['.swift', '.m', '.mm'].includes(extension)) add(file, 'ios_entrypoint');
      if (extension === '.plist') add(file, 'native_support');
    }, true);
  }
  if (inspectProjectDirectory(projectRoot, 'android')) {
    for (const module of entries('android')) {
      if (isExcludedDirectory(module.name)) continue;
      const directory = 'android/' + module.name;
      assertSafeContextPath(directory);
      if (!module.isDirectory() || !inspectProjectDirectory(projectRoot, directory + '/src')) continue;
      addIfPresent(directory + '/build.gradle');
      addIfPresent(directory + '/build.gradle.kts');
      walk(directory + '/src', (file, name) => {
        const extension = path.posix.extname(name);
        if (extension === '.java' || extension === '.kt') add(file, 'android_entrypoint');
        if (name === 'AndroidManifest.xml') add(file, 'native_support');
      }, false);
    }
  }
  if (![...files.values()].some(kind => kind !== 'native_support')) {
    throw new Error('No app-owned native source files were found for Bundle Drop setup.');
  }
  return [...files].map(([file, kind]) => ({ path: file, kind }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

type NativeMetadata = NonNullable<Awaited<ReturnType<typeof projectNativeSetupMetadata>>>;
type MetadataFile = NativeSetupContextPath & { facts: NativeMetadata; originalSha256: string };

const metadataPriority = (file: string) => {
  if (file.endsWith('project.pbxproj') || file.endsWith('/src/main/AndroidManifest.xml')) return 0;
  if (file.endsWith('/Info.plist') || /\/build\.gradle(?:\.kts)?$/.test(file)) return 1;
  return 2;
};

async function readMetadata(projectRoot: string, inventory: NativeSetupContextPath[]) {
  const files = inventory.filter(file => file.kind === 'native_support')
    .sort((left, right) => metadataPriority(left.path) - metadataPriority(right.path))
    .slice(0, MAX_METADATA_INPUT_FILES);
  const metadata: MetadataFile[] = [];
  for (const file of files) {
    const localPath = path.join(projectRoot, file.path);
    if (fs.lstatSync(localPath).size > MAX_METADATA_INPUT_BYTES) continue;
    const original = inspectProjectFile(projectRoot, file.path);
    if (!original.exists) throw new Error(`Native setup file changed during discovery: ${file.path}.`);
    const facts = await projectNativeSetupMetadata(file.path, original.content);
    if (facts) {
      metadata.push({
        ...file,
        facts,
        originalSha256: crypto.createHash('sha256').update(original.content).digest('hex'),
      });
    }
  }
  return metadata;
}

function prioritizeSources(inventory: NativeSetupContextPath[], metadata: MetadataFile[]) {
  const registeredClasses = new Set<string>();
  const appTargetSources = new Set<string>();
  for (const { facts } of metadata) {
    if ('applicationClass' in facts && facts.applicationClass) {
      registeredClasses.add(facts.applicationClass.split('.').pop()!);
    } else if ('sceneDelegateClasses' in facts) {
      for (const name of facts.sceneDelegateClasses) registeredClasses.add(name.split('.').pop()!);
    } else if ('targets' in facts) {
      for (const target of facts.targets) {
        for (const source of target.sourcePaths) appTargetSources.add(source);
      }
    }
  }
  const priority = (file: NativeSetupContextPath) => {
    const name = path.posix.basename(file.path, path.posix.extname(file.path));
    if (registeredClasses.has(name)) return 0;
    if (['MainApplication', 'AppDelegate', 'SceneDelegate', 'main'].includes(name)) return 1;
    if (appTargetSources.has(file.path)) return 2;
    if (/\b(?:delegate|resolver|reacthost|nativehost|factory|startup)|Delegate$|Resolver$|Lifecycle$/i.test(name)) return 3;
    return 4;
  };
  return inventory.filter(file => file.kind !== 'native_support')
    .sort((left, right) => priority(left) - priority(right));
}

export async function collectNativeSetupContext(projectRoot: string) {
  const inventory = listNativeSetupContext(projectRoot);
  const metadata = await readMetadata(projectRoot, inventory);
  const ranked = prioritizeSources(inventory, metadata);
  // Reserve space for each platform before considering additional source files.
  const primary = ['android_entrypoint', 'ios_entrypoint'].flatMap(kind => {
    const file = ranked.find(candidate => candidate.kind === kind);
    return file ? [file] : [];
  });
  const sources: NativeSetupContextPath[] = [];
  let bytes = 0;
  for (const file of [...primary, ...ranked.filter(candidate => !primary.includes(candidate))]) {
    if (sources.length === MAX_SOURCE_FILES) break;
    const size = fs.lstatSync(path.join(projectRoot, file.path)).size;
    if (size > MAX_SOURCE_BYTES || bytes + size > MAX_SOURCE_CONTEXT_BYTES) {
      if (primary.includes(file)) {
        throw new Error(`Native startup source exceeds the AI setup size limit: ${file.path}.`);
      }
      continue;
    }
    bytes += size;
    sources.push(file);
  }

  const selectedPaths = new Set(sources.map(file => file.path));
  const androidModules = new Set(sources.filter(file => file.kind === 'android_entrypoint')
    .map(file => file.path.split('/')[1]));
  const relevantPlists = new Set<string>();
  for (const { facts } of metadata) {
    if (!('targets' in facts)) continue;
    for (const target of facts.targets) {
      if (target.sourcePaths.some(file => selectedPaths.has(file))) {
        for (const plist of target.infoPlistPaths) relevantPlists.add(plist);
      }
    }
  }
  const support = metadata
    .filter(file => !file.path.startsWith('android/') || androidModules.has(file.path.split('/')[1]))
    .filter(({ path: file, facts }) => !('sceneDelegateClasses' in facts) ||
      relevantPlists.has(file) || facts.sceneDelegateClasses.length > 0 || file.endsWith('/Info.plist'))
    .sort((left, right) =>
      Number(relevantPlists.has(right.path)) - Number(relevantPlists.has(left.path)) ||
      metadataPriority(left.path) - metadataPriority(right.path),
    )
    .slice(0, MAX_SUPPORT_FILES)
    .map(({ path: relativePath, facts }) => {
      const summary = 'targets' in facts ? {
        targets: facts.targets.map(target => ({
          ...target,
          sourcePaths: target.sourcePaths.filter(file => selectedPaths.has(file)),
        })),
      } : facts;
      return { path: relativePath, content: JSON.stringify(summary) };
    })
    .filter(file => Buffer.byteLength(file.content) <= MAX_SUPPORT_SUMMARY_BYTES);
  return {
    inventory: inventory.map(file => file.path),
    sources,
    support,
    metadataSnapshot: metadata.map(file => [file.path, file.originalSha256] as const),
  };
}
