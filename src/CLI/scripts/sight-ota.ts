import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import plist from 'plist';
import { resolveExpoBuildIdentity } from '../../expo/buildIdentity';
import { validateExpoExportOutput } from '../../expo/exportValidation';
import type { MobilePlatform, ProjectType } from '../../expo';
import { buildCanonicalArtifact } from '../../scripts/canonicalArtifact';
import { buildHermesFlags, shouldCompileHermesBytecode } from '../../scripts/bundle';
import { checkComparisonAbort, runComparisonProcess } from './sight-compare/process';
import type { DependencyProcessOptions } from './sight-compare/dependencies';
import type { SightOtaMeasurement } from './sight-compare/types';
import { collectComparisonAssets } from './sight-compare/assets';

export type MeasureSightOtaOptions = {
  projectRoot: string;
  snapshotRoot?: string;
  projectType: ProjectType;
  platform: MobilePlatform;
  entryFile?: string;
  bundlePath: string;
  sourceMapPath: string;
  assetsDirectory: string;
  /** Existing invocation-owned directory; this helper removes only its nested temporary directory. */
  workDirectory: string;
};

const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const unavailable = (reason: string): SightOtaMeasurement => ({ status: 'unavailable', reason });

function insideSnapshot(options: MeasureSightOtaOptions, candidate: string): string {
  const resolved = fs.realpathSync(candidate);
  if (options.snapshotRoot) {
    const relative = path.relative(fs.realpathSync(options.snapshotRoot), resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('The OTA toolchain resolved outside its isolated snapshot.');
    }
  }
  return resolved;
}

function concreteVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
}

function iosVersion(options: MeasureSightOtaOptions, value: unknown): string | undefined {
  if (concreteVersion(value)) return value;
  const variable = typeof value === 'string' && /^\$\(([A-Za-z_][A-Za-z0-9_]*)\)$/.exec(value)?.[1];
  if (!variable) return undefined;
  const ios = path.join(options.projectRoot, 'ios');
  const values: string[] = [];
  for (const project of fs.readdirSync(ios).filter(name => name.endsWith('.xcodeproj'))) {
    const file = path.join(ios, project, 'project.pbxproj');
    if (!fs.existsSync(file)) continue;
    const contents = fs.readFileSync(insideSnapshot(options, file), 'utf8');
    const pattern = new RegExp(`^\\s*${variable}\\s*=\\s*([^;\\n]+);`, 'gm');
    for (const match of contents.matchAll(pattern)) values.push(match[1].trim().replace(/^"(.*)"$/, '$1'));
  }
  return values.length > 0 && values.every(concreteVersion) && new Set(values).size === 1 ? values[0] : undefined;
}

/** Only literal, unambiguous native versions are used; no native build configuration is executed. */
function bareAppVersion(options: MeasureSightOtaOptions): string | undefined {
  if (options.platform === 'android') {
    const files = ['build.gradle', 'build.gradle.kts'].map(name => path.join(options.projectRoot, 'android', 'app', name)).filter(file => fs.existsSync(file));
    if (files.length !== 1) return undefined;
    const contents = fs.readFileSync(insideSnapshot(options, files[0]), 'utf8');
    const literals = [...contents.matchAll(/^\s*versionName\s*(?:=\s*)?['"]([^'"]+)['"]\s*;?\s*$/gm)].map(match => match[1]);
    if (literals.length !== 1 || !concreteVersion(literals[0])) return undefined;
    return literals[0];
  }
  const ios = path.join(options.projectRoot, 'ios');
  if (!fs.existsSync(ios)) return undefined;
  const candidates = [path.join(ios, 'Info.plist')];
  for (const item of fs.readdirSync(ios, { withFileTypes: true })) {
    if (item.isDirectory() && !['Pods', 'build'].includes(item.name)) candidates.push(path.join(ios, item.name, 'Info.plist'));
  }
  const documents = candidates.filter(file => fs.existsSync(file)).map(file =>
    plist.parse(fs.readFileSync(insideSnapshot(options, file), 'utf8')) as Record<string, unknown>);
  const applications = documents.filter(document => document.CFBundlePackageType === 'APPL');
  // Test bundles and extensions have their own versions, unrelated to the app's OTA identity.
  // Older app plists may omit the package type; use those only when no explicit app exists.
  const appDocuments = applications.length > 0 ? applications : documents.filter(document =>
    document.CFBundlePackageType === undefined && document.NSExtension === undefined);
  const versions = appDocuments.map(document => iosVersion(options, document.CFBundleShortVersionString));
  if (!versions.length || !versions.every(concreteVersion) || new Set(versions).size !== 1) return undefined;
  return versions[0] as string;
}

function compilerPath(options: MeasureSightOtaOptions, expo: boolean): string | undefined {
  const projectRequire = createRequire(path.join(options.projectRoot, 'package.json'));
  const rnManifest = insideSnapshot(options, projectRequire.resolve('react-native/package.json'));
  const rnRoot = path.dirname(rnManifest);
  const osBin = process.platform === 'darwin' ? 'osx-bin' : process.platform === 'win32' ? 'win64-bin' : 'linux64-bin';
  const executable = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';
  const candidates = [path.join(rnRoot, 'sdks', 'hermesc', osBin, executable)];
  for (const moduleId of expo ? ['hermes-compiler'] : ['hermes-compiler', 'hermes-engine']) {
    let manifest: string;
    try {
      manifest = createRequire(rnManifest).resolve(`${moduleId}/package.json`);
    } catch {
      // Older React Native releases ship the compiler inside react-native itself.
      continue;
    }
    const root = path.dirname(insideSnapshot(options, manifest));
    const compiler = path.join(root, ...(moduleId === 'hermes-compiler' ? ['hermesc'] : []), osBin, executable);
    if (expo) candidates.unshift(compiler);
    else candidates.push(compiler);
  }
  if (expo) {
    // Expo's serializer checks source-built and overridden compilers before npm binaries.
    candidates.unshift(path.join(rnRoot, 'ReactAndroid', 'hermes-engine', 'build', 'hermes', 'bin', 'hermesc'));
    if (process.env.REACT_NATIVE_OVERRIDE_HERMES_DIR) {
      candidates.unshift(path.join(process.env.REACT_NATIVE_OVERRIDE_HERMES_DIR, 'build', 'bin', 'hermesc'));
    }
  }
  const selected = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return selected ? insideSnapshot(options, selected) : undefined;
}

/** Executed in a separate process so project configuration and compiler children stay isolated. */
export async function measureInstalledSightOta(options: MeasureSightOtaOptions): Promise<SightOtaMeasurement> {
  let reason = 'The project configuration could not be read for Bundle Drop OTA packaging.';
  try {
    let appVersion: string;
    let runtimeVersion: string;
    let hermes: boolean;
    let expoRequire: NodeRequire | undefined;
    if (options.projectType === 'expo') {
      reason = 'The Expo configuration could not resolve a local app version and runtime version for Bundle Drop OTA packaging.';
      const projectRequire = createRequire(path.join(options.projectRoot, 'package.json'));
      expoRequire = createRequire(insideSnapshot(options, projectRequire.resolve('expo/package.json')));
      const envLoader = expoRequire(insideSnapshot(options, expoRequire.resolve('@expo/cli/build/src/utils/nodeEnv'))) as { loadEnvFiles(root: string): void };
      envLoader.loadEnvFiles(options.projectRoot);
      const identity = await resolveExpoBuildIdentity(options.projectRoot, options.platform);
      appVersion = identity.appVersion;
      runtimeVersion = identity.runtimeVersion;
      hermes = identity.javaScriptEngine === 'hermes';
    } else {
      const configPath = path.join(options.projectRoot, 'bundle.drop.config.js');
      if (!fs.existsSync(configPath)) return unavailable('This project has no bundle.drop.config.js. Configure Bundle Drop to measure its OTA archive.');
      const config = createRequire(path.join(options.projectRoot, 'package.json'))(insideSnapshot(options, configPath)) as Record<string, unknown>;
      const runtime = (config.runtimeVersion as Record<string, unknown> | undefined)?.[options.platform];
      if (typeof runtime !== 'string' || !runtime.trim()) {
        return unavailable(`Bundle Drop has no runtime version configured for ${options.platform}. Set runtimeVersion.${options.platform} in bundle.drop.config.js.`);
      }
      reason = `The native ${options.platform} app version could not be resolved unambiguously for Bundle Drop OTA packaging.`;
      const version = bareAppVersion(options);
      if (!version) return unavailable(reason);
      appVersion = version;
      runtimeVersion = runtime;
      hermes = shouldCompileHermesBytecode(config, options.platform, options.projectRoot);
    }
    const bundlePath = path.join(options.workDirectory, 'main.jsbundle');
    let assetsDirectory = options.assetsDirectory;
    reason = 'The enabled Hermes compiler is unavailable or could not produce valid bytecode for this build.';
    if (hermes) {
      const compiler = compilerPath(options, options.projectType === 'expo');
      if (!compiler) return unavailable(reason);
      if (expoRequire) {
        // Expo changes Metro transforms for --bytecode, so compiling the analysis JavaScript
        // directly would not measure the output of its normal OTA export pipeline.
        const paths = expoRequire(insideSnapshot(options, expoRequire.resolve('@expo/config/paths'))) as {
          resolveEntryPoint(root: string, options: { platform: MobilePlatform }): string | null;
        };
        const entry = options.entryFile ?? paths.resolveEntryPoint(options.projectRoot, { platform: options.platform });
        if (!entry) return unavailable(reason);
        const entryFile = insideSnapshot(options, path.resolve(options.projectRoot, entry));
        const cli = insideSnapshot(options, expoRequire.resolve('@expo/cli'));
        const sourceMapPath = path.join(options.workDirectory, 'main.jsbundle.map');
        assetsDirectory = path.join(options.workDirectory, 'assets');
        fs.mkdirSync(assetsDirectory);
        const compiled = spawnSync(process.execPath, [cli, 'export:embed', '--platform', options.platform,
          '--entry-file', entryFile, '--bundle-output', bundlePath, '--assets-dest', assetsDirectory,
          '--sourcemap-output', sourceMapPath, '--dev', 'false', '--minify', 'true', '--bytecode', '--reset-cache'], {
          cwd: options.projectRoot, env: process.env, stdio: ['ignore', 'ignore', 'inherit'], shell: false,
        });
        if (compiled.error || compiled.status !== 0) {
          console.error('Sight Expo bytecode export failed.', compiled.error ?? compiled.status);
          return unavailable(reason);
        }
        validateExpoExportOutput({ outputDirectory: options.workDirectory, bundlePath, sourceMapPath, assetsDirectory });
        const signal = new AbortController().signal;
        const originalAssets = await collectComparisonAssets(options.assetsDirectory, signal);
        const compiledAssets = await collectComparisonAssets(assetsDirectory, signal);
        if (JSON.stringify(originalAssets) !== JSON.stringify(compiledAssets)) {
          return unavailable('The Expo bytecode export emitted different assets from the JavaScript analysis build.');
        }
      } else {
        const flags = buildHermesFlags(compiler, true, spawnSync);
        const compiled = spawnSync(compiler, [...flags, '-out', bundlePath, options.bundlePath], { cwd: options.projectRoot, env: process.env, stdio: ['ignore', 'ignore', 'inherit'], shell: false });
        if (compiled.error || compiled.status !== 0) {
          console.error('Sight Hermes compilation failed.', compiled.error ?? compiled.status);
          return unavailable(reason);
        }
      }
      const magic = Buffer.alloc(HERMES_MAGIC.length);
      const descriptor = fs.openSync(bundlePath, 'r');
      try { fs.readSync(descriptor, magic, 0, magic.length, 0); }
      finally { fs.closeSync(descriptor); }
      if (!magic.equals(HERMES_MAGIC)) return unavailable(reason);
    } else fs.copyFileSync(options.bundlePath, bundlePath);
    reason = 'The generated files could not be packaged into a valid local Bundle Drop OTA archive.';
    const artifact = buildCanonicalArtifact({
      platform: options.platform, appVersion, runtimeVersion, bundlePath,
      assetsDir: assetsDirectory, outputDir: options.workDirectory,
      // Sight's inventory rejects symlinks; strict canonical traversal preserves that boundary.
      assetTraversal: 'strict',
    });
    return { status: 'available', engine: hermes ? 'hermes' : 'javascript', bundleBytes: fs.statSync(bundlePath).size, zipBytes: fs.statSync(artifact.zipPath).size };
  } catch (error) {
    // Child stderr is retained in the invocation's local diagnostic log, never in browser metadata.
    console.error('Sight local OTA measurement failed.', error);
    return unavailable(reason);
  }
}

const resultMarker = 'BUNDLE_DROP_SIGHT_OTA=';
const childScript = `const helper=require(process.argv[1]);helper.measureInstalledSightOta(JSON.parse(process.argv[2])).then(result=>process.stdout.write('\\n${resultMarker}'+JSON.stringify(result)+'\\n')).catch(error=>{console.error(error);process.exitCode=1;});`;

export async function measureSightOta(options: MeasureSightOtaOptions, processOptions: DependencyProcessOptions = {}): Promise<SightOtaMeasurement> {
  const controller = processOptions.signal ? undefined : new AbortController();
  const signal = processOptions.signal ?? controller!.signal;
  const abort = () => controller!.abort();
  if (controller) {
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
  }
  let directory: string | undefined;
  try {
    checkComparisonAbort(signal);
    directory = fs.mkdtempSync(path.join(options.workDirectory, 'sight-ota-'));
    const result = await runComparisonProcess({
      command: process.execPath, args: ['-e', childScript, __filename, JSON.stringify({ ...options, workDirectory: directory })],
      cwd: options.projectRoot, phase: 'Measure local OTA artifact', signal,
      env: processOptions.env, logPath: processOptions.logPath,
    });
    const line = result.stdout.split('\n').reverse().find(value => value.startsWith(resultMarker));
    if (!line) return unavailable('The local OTA measurement did not return a result.');
    return JSON.parse(line.slice(resultMarker.length)) as SightOtaMeasurement;
  } catch {
    checkComparisonAbort(signal);
    return unavailable('The local OTA measurement could not be completed.');
  } finally {
    if (controller) {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}
