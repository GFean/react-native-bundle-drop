#!/usr/bin/env node

import { spawnSync, type SpawnSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { BUNDLE_MANIFEST } from '../manifest/bundleManifest';
import { buildCanonicalArtifact } from './canonicalArtifact';
import { findProjectRoot } from './projectRoot';
import { resolveModuleFrom, type ModuleResolver } from './resolveModule';

export { findProjectRoot };

const SENTRY_HERMES_OTA_DOCS_URL =
  'https://bundledrop.app/docs/observability#sentry-and-hermes-ota-builds';
const SENTRY_DEBUG_ID_MARKERS = ['//# debugId=', 'sentry-dbid-'];

type SpawnProcess = typeof spawnSync;

type BundleScriptOptions = {
  platform?: string;
  cwd?: string;
  sourcemap?: boolean;
  packageRoot?: string;
  spawnProcess?: SpawnProcess;
  resolveModule?: ModuleResolver;
};

const runProcess = (
  spawnProcess: SpawnProcess,
  executable: string,
  args: string[],
  options: SpawnSyncOptions,
) => {
  const result = spawnProcess(executable, args, {
    ...options,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(detail || `${path.basename(executable)} exited with status ${result.status}`);
  }
  return result;
};

const assertGeneratedPath = (targetPath: string, outputDir: string): void => {
  const relative = path.relative(path.resolve(outputDir), path.resolve(targetPath));
  const escapesOutput =
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (escapesOutput) {
    throw new Error(`Generated artifact path escaped the package output directory: ${targetPath}`);
  }
};

const readTextIfExists = (filePath: string): string | null => {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
};

const readPlatformSetting = (
  value: unknown,
  platform: string,
): boolean | 'auto' | undefined => {
  if (typeof value === 'boolean' || value === 'auto') return value;
  if (!value || typeof value !== 'object') return undefined;
  const platformValue = (value as Record<string, unknown>)[platform];
  return typeof platformValue === 'boolean' || platformValue === 'auto'
    ? platformValue
    : undefined;
};

const detectBoolean = (
  contents: Array<string | null>,
  truePatterns: RegExp[],
  falsePatterns: RegExp[],
): boolean | undefined => {
  const joined = contents.filter((content): content is string => !!content).join('\n');
  if (!joined) return undefined;
  if (falsePatterns.some(pattern => pattern.test(joined))) return false;
  if (truePatterns.some(pattern => pattern.test(joined))) return true;
  return undefined;
};

const readIosProjectSettings = (projectRoot: string): string | null => {
  const iosDir = path.join(projectRoot, 'ios');
  if (!fs.existsSync(iosDir)) return null;

  const projectFiles = fs
    .readdirSync(iosDir)
    .filter(fileName => fileName.endsWith('.xcodeproj'))
    .map(fileName => path.join(iosDir, fileName, 'project.pbxproj'));

  const contents = projectFiles
    .map(readTextIfExists)
    .filter((content): content is string => Boolean(content));

  return contents.length ? contents.join('\n') : null;
};

const readHermesHelp = (hermescPath: string, spawnProcess: SpawnProcess): string => {
  try {
    const result = runProcess(spawnProcess, hermescPath, ['-help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(result.stdout || '');
  } catch {
    return '';
  }
};

const hermesHelpIncludesFlag = (help: string, flag: string): boolean =>
  new RegExp(`(?:^|\\n)\\s*${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|=)`).test(help);

const buildHermesFlags = (
  hermescPath: string,
  generateSourceMap: boolean,
  spawnProcess: SpawnProcess,
): string[] => {
  const help = readHermesHelp(hermescPath, spawnProcess);
  const flags = ['-emit-binary'];

  if (hermesHelpIncludesFlag(help, '-O')) {
    flags.push('-O');
  }
  if (hermesHelpIncludesFlag(help, '-g0')) {
    flags.push('-g0');
  }
  if (generateSourceMap && hermesHelpIncludesFlag(help, '-output-source-map')) {
    flags.push('-output-source-map');
  }

  return flags;
};

const promoteHermesBytecode = (hbcPath: string, bundlePath: string) => {
  if (!fs.existsSync(hbcPath)) {
    throw new Error(`Hermes compiler did not write bytecode output at ${hbcPath}`);
  }

  fs.copyFileSync(hbcPath, bundlePath);
  fs.unlinkSync(hbcPath);
};

const warnAboutSentryDebugId = (bundlePath: string, hermesEnabled: boolean) => {
  if (!hermesEnabled || !fs.existsSync(bundlePath)) return;

  const bundleSource = fs.readFileSync(bundlePath, 'utf8');
  const hasSentryDebugId = SENTRY_DEBUG_ID_MARKERS.some(marker =>
    bundleSource.includes(marker),
  );
  if (!hasSentryDebugId) return;

  console.warn(
    `⚠️ Sentry Debug ID detected in a Hermes OTA bundle. Content-derived Debug IDs can increase binary patch sizes. Configure the Sentry Metro wrapper for Bundle Drop OTA builds: ${SENTRY_HERMES_OTA_DOCS_URL}`,
  );
};

const detectHermesFromNativeProject = (projectRoot: string, platform: string): boolean | undefined => {
  if (platform === 'android') {
    return detectBoolean(
      [
        readTextIfExists(path.join(projectRoot, 'android', 'gradle.properties')),
        readTextIfExists(path.join(projectRoot, 'android', 'app', 'build.gradle')),
        readTextIfExists(path.join(projectRoot, 'android', 'app', 'build.gradle.kts')),
      ],
      [
        /(?:^|\n)\s*hermesEnabled\s*=\s*true\b/,
        /\bhermesEnabled\s+(?:=|\()\s*true\b/,
        /\benableHermes\s*[:=]\s*true\b/,
      ],
      [
        /(?:^|\n)\s*hermesEnabled\s*=\s*false\b/,
        /\bhermesEnabled\s+(?:=|\()\s*false\b/,
        /\benableHermes\s*[:=]\s*false\b/,
      ],
    );
  }

  return detectBoolean(
    [
      readTextIfExists(path.join(projectRoot, 'ios', 'Podfile')),
      readIosProjectSettings(projectRoot),
    ],
    [
      /:hermes_enabled\s*=>\s*true\b/,
      /\bhermes_enabled\s*:\s*true\b/,
      /\bhermesEnabled\s*[:=]\s*true\b/,
      /\bUSE_HERMES\s*=\s*true\s*;/,
    ],
    [
      /:hermes_enabled\s*=>\s*false\b/,
      /\bhermes_enabled\s*:\s*false\b/,
      /\bhermesEnabled\s*[:=]\s*false\b/,
      /\bUSE_HERMES\s*=\s*false\s*;/,
    ],
  );
};

const shouldCompileHermesBytecode = (
  cfg: Record<string, unknown>,
  platform: string,
  projectRoot: string,
): boolean => {
  const explicit =
    readPlatformSetting(cfg.hermesBytecode, platform) ??
    readPlatformSetting(cfg.hermes, platform);

  if (typeof explicit === 'boolean') return explicit;

  const detected = detectHermesFromNativeProject(projectRoot, platform);
  if (detected !== undefined) return detected;

  if (explicit === 'auto') {
    console.warn(
      `⚠️ Could not detect Hermes for ${platform}; set hermesBytecode.${platform} in bundle.drop.config.js to opt in explicitly.`,
    );
  }
  return false;
};

export function runBundleScript(options: BundleScriptOptions = {}) {
  const packageRoot = options.packageRoot || path.resolve(__dirname, '..', '..');
  const spawnProcess = options.spawnProcess || spawnSync;
  const resolveModule = options.resolveModule || resolveModuleFrom;
  const platform = options?.platform || process.argv[2] || 'ios';
  if (!['ios', 'android'].includes(platform)) {
    console.error('❌ Please provide platform: ios or android');
    process.exit(1);
  }

  const isAndroid = platform === 'android';
  const fileSuffix = isAndroid ? 'android' : 'ios';
  const outputDir = path.resolve(packageRoot, 'dist');
  const assetsDir = path.join(outputDir, 'assets');
  const bundlePath = path.join(outputDir, 'main.jsbundle');
  const metadataPath = path.join(outputDir, `metadata-${fileSuffix}.json`);
  const manifestPath = path.join(outputDir, BUNDLE_MANIFEST);
  const sourceMapPath = path.join(outputDir, 'main.jsbundle.map');
  const zipPath = path.join(outputDir, `bundle-${platform}.zip`);
  const projectRoot = findProjectRoot(options?.cwd || process.cwd());
  const generateSourceMap = options?.sourcemap ?? process.argv.includes('--sourcemap');
  const appVersion = process.env.BUNDLE_DROP_APP_VERSION;

  let runtimeVersion: string | undefined;
  const configPath = path.resolve(projectRoot, 'bundle.drop.config.js');
  if (!fs.existsSync(configPath)) {
    console.error('❌ bundle.drop.config.js not found in project root');
    process.exit(1);
  }

  //eslint-disable-next-line
  const cfg = require(configPath) as Record<string, unknown>;
  runtimeVersion = (cfg?.runtimeVersion as Record<string, string> | undefined)?.[platform];
  if (!runtimeVersion) {
    console.error(
      `❌ Missing runtimeVersion.${platform} in bundle.drop.config.js. Example: runtimeVersion: { ios: "1.0.0", android: "1.0.0" }`,
    );
    process.exit(1);
  }

  if (!appVersion) {
    console.error('❌ BUNDLE_DROP_APP_VERSION is required so bundle-manifest.json can include the app version');
    process.exit(1);
  }

  const hermesEnabled = shouldCompileHermesBytecode(cfg, platform, projectRoot);

  [bundlePath, zipPath, metadataPath, manifestPath, sourceMapPath].forEach(file => {
    assertGeneratedPath(file, outputDir);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  assertGeneratedPath(assetsDir, outputDir);
  if (fs.existsSync(assetsDir)) fs.rmSync(assetsDir, { recursive: true, force: true });

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  console.log(`📦 Bundling React Native code for platform: ${platform}...`);

  const reactNativePackageJson = resolveModule('react-native/package.json', [
    projectRoot,
    packageRoot,
    __dirname,
  ]);
  const reactNativeCli = path.join(path.dirname(reactNativePackageJson), 'cli.js');
  if (!fs.existsSync(reactNativeCli)) {
    throw new Error(`React Native CLI entrypoint is missing: ${reactNativeCli}`);
  }
  const reactNativeArgs = [
    reactNativeCli,
    'bundle',
    '--platform',
    platform,
    '--dev',
    'false',
    '--entry-file',
    'index.js',
    '--bundle-output',
    bundlePath,
    '--assets-dest',
    assetsDir,
    '--reset-cache',
  ];
  if (generateSourceMap) {
    reactNativeArgs.push('--sourcemap-output', sourceMapPath);
  }

  runProcess(
    spawnProcess,
    process.execPath,
    reactNativeArgs,
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        BUNDLE_DROP_OTA_BUILD: '1',
      },
    },
  );

  console.log('✅ Bundle created');
  warnAboutSentryDebugId(bundlePath, hermesEnabled);

  const osBin =
    process.platform === 'darwin'
      ? 'osx-bin'
      : process.platform === 'win32'
        ? 'win64-bin'
        : 'linux64-bin';
  const hermesLocations = [
    path.join(projectRoot, 'node_modules', 'react-native', 'sdks', 'hermesc', osBin, 'hermesc'),
    path.join(projectRoot, 'node_modules', 'hermes-compiler', 'hermesc', osBin, 'hermesc'),
    path.join(projectRoot, 'node_modules', 'hermes-engine', osBin, 'hermesc'),
  ];
  const hermescPath = hermesLocations.find(p => fs.existsSync(p));

  if (hermesEnabled && hermescPath) {
    const hbcPath = bundlePath + '.hbc';
    try {
      console.log(`🔥 Compiling to Hermes bytecode (${platform})...`);
      const hermesFlags = buildHermesFlags(
        hermescPath,
        generateSourceMap,
        spawnProcess,
      );
      runProcess(
        spawnProcess,
        hermescPath,
        [...hermesFlags, '-out', hbcPath, bundlePath],
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
      promoteHermesBytecode(hbcPath, bundlePath);
      console.log('✅ Hermes bytecode compiled');
    } catch (e) {
      console.warn('⚠️ Hermes compilation failed, falling back to plain JS bundle:', (e as Error).message);
    }

    if (generateSourceMap) {
      const hermesMapPath = bundlePath + '.hbc.map';
      if (fs.existsSync(hermesMapPath) && fs.existsSync(sourceMapPath)) {
        const composeScript = path.join(
          projectRoot, 'node_modules', 'react-native', 'scripts', 'compose-source-maps.js',
        );
        if (fs.existsSync(composeScript)) {
          try {
            const composedPath = sourceMapPath + '.composed';
            runProcess(
              spawnProcess,
              process.execPath,
              [composeScript, sourceMapPath, hermesMapPath, '-o', composedPath],
              { stdio: ['ignore', 'ignore', 'ignore'] },
            );
            fs.renameSync(composedPath, sourceMapPath);
            console.log('✅ Source maps composed');
          } catch (composeErr) {
            console.warn('⚠️  Source map composition failed; keeping Metro source map:', (composeErr as Error).message);
          }
        } else {
          console.warn('⚠️  compose-source-maps.js not found; keeping Metro source map as-is');
        }
      }
      if (fs.existsSync(hermesMapPath)) fs.unlinkSync(hermesMapPath);
    }
  } else if (hermesEnabled) {
    console.log('ℹ️  Hermes compiler not found — bundling plain JS');
  } else {
    console.log(`ℹ️  Hermes bytecode disabled for ${platform} — bundling plain JS`);
  }

  const artifact = buildCanonicalArtifact({
    platform: platform as 'ios' | 'android',
    appVersion,
    runtimeVersion,
    bundlePath,
    assetsDir,
    outputDir,
    sourceMapPath: generateSourceMap ? sourceMapPath : undefined,
    assetTraversal: 'legacy-bare',
  });

  return {
    projectRoot,
    ...artifact,
  };
}

/* istanbul ignore next */
if (require.main === module) {
  runBundleScript();
}
