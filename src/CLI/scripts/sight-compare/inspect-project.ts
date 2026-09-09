import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { detectProjectType } from '../../../expo';
import type { MobilePlatform, ProjectType } from '../../../expo';
import { runComparisonProcess } from './process';
import type { DependencyProcessOptions } from './dependencies';

export type LogicalSightEntry = { kind: 'relative' | 'module'; value: string };
type InstalledSightProject = {
  projectType: ProjectType;
  entry: LogicalSightEntry;
  resolvedEntryFile: string;
  versions: { reactNative: string; expo?: string; metro?: string };
};
type SourceMapContext = {
  sourceMapBase: string;
  sourcePathConvention: 'filesystem' | 'expo-server-root';
};
export type InspectedSightProject = InstalledSightProject & SourceMapContext;
export type InspectSightProjectOptions = {
  snapshotRoot: string;
  projectRoot: string;
  platform: MobilePlatform;
  explicitType?: ProjectType;
  entryFile?: string;
  logicalEntry?: LogicalSightEntry;
};

function requireInsideSnapshot(snapshotRoot: string, resolved: string): string {
  const real = fs.realpathSync(resolved);
  const relative = path.relative(snapshotRoot, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Sight comparison resolved a file outside the repository snapshot: ${resolved}`);
  }
  return real;
}

function logicalEntryForResolvedFile(projectRoot: string, entryFile: string): LogicalSightEntry {
  const relative = path.relative(projectRoot, entryFile).split(path.sep).join('/');
  const marker = '/node_modules/';
  const normalized = entryFile.split(path.sep).join('/');
  const moduleStart = normalized.lastIndexOf(marker);
  if (moduleStart !== -1) {
    return { kind: 'module', value: normalized.slice(moduleStart + marker.length).replace(/\.[cm]?[jt]sx?$/, '') };
  }
  return { kind: 'relative', value: relative };
}

/** Match export:embed's dotenv loading before evaluating dynamic app configuration. */
export function prepareProjectEnvironment(options: InspectSightProjectOptions): void {
  if (options.explicitType === 'bare') return;
  const snapshotRoot = fs.realpathSync(options.snapshotRoot);
  const projectRoot = requireInsideSnapshot(snapshotRoot, options.projectRoot);
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  let expoManifest: string;
  try {
    expoManifest = projectRequire.resolve('expo/package.json');
  } catch {
    return;
  }
  const expoRequire = createRequire(requireInsideSnapshot(snapshotRoot, expoManifest));
  let loaderPath: string | undefined;
  try {
    loaderPath = expoRequire.resolve('@expo/cli/build/src/utils/nodeEnv');
  } catch {
    // Bare apps may have Expo modules without the export CLI installed.
  }
  const loader = loaderPath ? expoRequire(requireInsideSnapshot(snapshotRoot, loaderPath)) as {
    loadEnvFiles?: (root: string) => unknown;
  } : undefined;
  if (typeof loader?.loadEnvFiles !== 'function') {
    if (detectProjectType({ projectRoot, explicitType: options.explicitType }) === 'bare') return;
    throw new Error('This Expo CLI does not expose its environment loader. Sight cannot reproduce export:embed configuration for this version.');
  }
  // The installed loader owns dotenv precedence and EXPO_NO_DOTENV behavior.
  loader.loadEnvFiles(projectRoot);
}

/** Runs only in the disposable snapshot child process; exported for fixture tests. */
export function inspectInstalledProject(options: InspectSightProjectOptions): InstalledSightProject {
  const snapshotRoot = fs.realpathSync(options.snapshotRoot);
  const projectRoot = requireInsideSnapshot(snapshotRoot, options.projectRoot);
  const manifestPath = requireInsideSnapshot(snapshotRoot, path.join(projectRoot, 'package.json'));
  const projectRequire = createRequire(manifestPath);
  const projectType = detectProjectType({ projectRoot, explicitType: options.explicitType });
  const resolve = (specifier: string) => requireInsideSnapshot(snapshotRoot, projectRequire.resolve(specifier));
  const reactNativeManifest = resolve('react-native/package.json');
  const versions: InspectedSightProject['versions'] = {
    reactNative: JSON.parse(fs.readFileSync(reactNativeManifest, 'utf8')).version,
  };
  let expoRequire: NodeRequire | undefined;
  if (projectType === 'expo') {
    const expoManifest = resolve('expo/package.json');
    versions.expo = JSON.parse(fs.readFileSync(expoManifest, 'utf8')).version;
    expoRequire = createRequire(expoManifest);
  }
  const moduleResolvers = [projectRequire, createRequire(reactNativeManifest)];
  if (expoRequire) moduleResolvers.push(expoRequire);
  for (const resolver of moduleResolvers) {
    let metroManifest: string;
    try {
      metroManifest = resolver.resolve('metro/package.json');
    } catch {
      continue;
    }
    versions.metro = JSON.parse(fs.readFileSync(requireInsideSnapshot(snapshotRoot, metroManifest), 'utf8')).version;
    break;
  }
  let resolvedEntryFile: string;
  let logicalEntry = options.logicalEntry;
  if (logicalEntry) {
    resolvedEntryFile = logicalEntry.kind === 'module'
      ? resolve(logicalEntry.value)
      : path.resolve(projectRoot, logicalEntry.value);
  } else if (options.entryFile) {
    if (path.isAbsolute(options.entryFile)) {
      throw new Error('Comparison --entry-file must be relative to the app directory.');
    }
    resolvedEntryFile = path.resolve(projectRoot, options.entryFile);
  } else if (expoRequire) {
    const configPaths = expoRequire(requireInsideSnapshot(snapshotRoot, expoRequire.resolve('@expo/config/paths'))) as {
      resolveEntryPoint(root: string, options: { platform: MobilePlatform }): string | null;
    };
    const entry = configPaths.resolveEntryPoint(projectRoot, { platform: options.platform });
    if (!entry) throw new Error(`Expo could not resolve the ${options.platform} entrypoint.`);
    resolvedEntryFile = path.resolve(projectRoot, entry);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { main?: string };
    if (manifest.main && !manifest.main.startsWith('.') && !path.isAbsolute(manifest.main)) {
      try {
        if (resolve(manifest.main) === fs.realpathSync(resolvedEntryFile)) {
          logicalEntry = { kind: 'module', value: manifest.main };
        }
      } catch {
        // A file such as index.js is a valid main field but not a module specifier.
      }
    }
  } else {
    const entry = ['index.js', 'index.ts', 'index.tsx', 'index.jsx'].find(file => {
      const candidate = path.join(projectRoot, file);
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    });
    if (!entry) throw new Error('Could not find a React Native entry file. Pass --entry-file <relative-path>.');
    resolvedEntryFile = path.join(projectRoot, entry);
  }
  logicalEntry = logicalEntry || logicalEntryForResolvedFile(projectRoot, resolvedEntryFile);
  resolvedEntryFile = requireInsideSnapshot(snapshotRoot, resolvedEntryFile);
  if (!fs.statSync(resolvedEntryFile).isFile()) throw new Error('The comparison entrypoint must be a file.');
  return { projectType, entry: logicalEntry, resolvedEntryFile, versions };
}

/** Use the same config loader as export:embed; custom Metro roots must be honored. */
export async function inspectSourceMapContext(
  options: InspectSightProjectOptions,
  projectType: ProjectType,
): Promise<SourceMapContext> {
  const snapshotRoot = fs.realpathSync(options.snapshotRoot);
  if (projectType === 'bare') return { sourceMapBase: snapshotRoot, sourcePathConvention: 'filesystem' };
  const projectRoot = requireInsideSnapshot(snapshotRoot, options.projectRoot);
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  const expoManifest = requireInsideSnapshot(snapshotRoot, projectRequire.resolve('expo/package.json'));
  const expoRequire = createRequire(expoManifest);
  let loaderPath: string;
  try {
    loaderPath = requireInsideSnapshot(snapshotRoot, expoRequire.resolve('@expo/cli/build/src/start/server/metro/instantiateMetro'));
  } catch {
    throw new Error('This Expo CLI does not expose its Metro configuration loader. Sight cannot establish source-map paths for this version.');
  }
  const loader = expoRequire(loaderPath) as {
    loadMetroConfigAsync?: (root: string, options: Record<string, never>, context: { exp: Record<string, unknown>; isExporting: true }) => Promise<{
      config: { projectRoot: string; server?: { unstable_serverRoot?: string } };
    }>;
  };
  if (typeof loader.loadMetroConfigAsync !== 'function') {
    throw new Error('This Expo CLI does not expose loadMetroConfigAsync. Sight cannot establish source-map paths for this version.');
  }
  const expoConfig = expoRequire(requireInsideSnapshot(snapshotRoot, expoRequire.resolve('@expo/config'))) as {
    getConfig(root: string, options: { skipSDKVersionRequirement: true }): { exp: Record<string, unknown> };
  };
  const { exp } = expoConfig.getConfig(projectRoot, { skipSDKVersionRequirement: true });
  const { config } = await loader.loadMetroConfigAsync(projectRoot, {}, { exp, isExporting: true });
  const sourceMapBase = requireInsideSnapshot(snapshotRoot, config.server?.unstable_serverRoot ?? config.projectRoot);
  return { sourceMapBase, sourcePathConvention: 'expo-server-root' };
}

const resultMarker = 'BUNDLE_DROP_SIGHT_PROJECT=';
const childScript = `const helper = require(process.argv[1]);
void (async () => {
  const options = JSON.parse(process.argv[2]);
  helper.prepareProjectEnvironment(options);
  const result = helper.inspectInstalledProject(options);
  const context = await helper.inspectSourceMapContext(options, result.projectType);
  process.stdout.write('\\n${resultMarker}' + JSON.stringify({ ...result, ...context }) + '\\n');
})().catch(error => { console.error(error); process.exitCode = 1; });`;

export async function inspectSightProject(
  options: InspectSightProjectOptions,
  processOptions: DependencyProcessOptions = {},
): Promise<InspectedSightProject> {
  const result = await runComparisonProcess({
    command: process.execPath,
    args: ['-e', childScript, __filename, JSON.stringify(options)],
    cwd: options.projectRoot,
    phase: 'Inspect comparison project',
    signal: processOptions.signal,
    env: { ...(processOptions.env || process.env), NODE_ENV: 'production' },
    logPath: processOptions.logPath,
  });
  const line = result.stdout.split('\n').reverse().find(value => value.startsWith(resultMarker));
  if (!line) throw new Error('Project inspection did not return comparison metadata. See the inspection log.');
  return JSON.parse(line.slice(resultMarker.length)) as InspectedSightProject;
}
