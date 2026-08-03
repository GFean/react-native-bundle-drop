import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { evaluateExpoConfig } from './config';
import { resolveExpoBuildIdentity } from './buildIdentity';
import { ExpoIntegrationError } from './errors';
import { loadExpoDependency, resolveExpoDependency } from './localModules';
import type { ExpoBuildIdentity, MobilePlatform } from './types';
import { validateExpoExportOutput } from './exportValidation';

const execFile = promisify(childProcess.execFile);

type ExpoConfigPathsModule = {
  resolveEntryPoint: (
    projectRoot: string,
    options: { platform: MobilePlatform },
  ) => string | null;
};

export type ExpoExportOptions = {
  projectRoot: string;
  platform: MobilePlatform;
  outputDirectory: string;
  resetCache?: boolean;
  buildIdentity?: ExpoBuildIdentity;
};

export type ExpoExportResult = {
  projectRoot: string;
  platform: MobilePlatform;
  outputDirectory: string;
  entryFile: string;
  bundlePath: string;
  sourceMapPath: string;
  assetsDirectory: string;
  sourceMapDebugId?: string;
  files: string[];
  buildIdentity: ExpoBuildIdentity;
};

function ensureEmptyOutputDirectory(outputDirectory: string): void {
  if (fs.existsSync(outputDirectory)) {
    const stats = fs.lstatSync(outputDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ExpoIntegrationError('Expo export output must be a real directory.');
    }
    if (fs.readdirSync(outputDirectory).length > 0) {
      throw new ExpoIntegrationError('Expo export output directory must be empty.');
    }
    return;
  }
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
}

function resolveExpoEntryFile(projectRoot: string, platform: MobilePlatform): string {
  const configPaths = loadExpoDependency<ExpoConfigPathsModule>(
    projectRoot,
    '@expo/config/paths',
  );
  if (typeof configPaths.resolveEntryPoint !== 'function') {
    throw new ExpoIntegrationError(
      'The project-local @expo/config/paths package does not export resolveEntryPoint().',
    );
  }
  const entryFile = configPaths.resolveEntryPoint(projectRoot, { platform });
  if (!entryFile) {
    throw new ExpoIntegrationError(
      `Expo could not resolve the ${platform} entrypoint. Check package.json main and Router configuration.`,
    );
  }
  return path.isAbsolute(entryFile) ? entryFile : path.resolve(projectRoot, entryFile);
}

function buildExpoExportArguments(options: {
  cliPath: string;
  platform: MobilePlatform;
  entryFile: string;
  bundlePath: string;
  sourceMapPath: string;
  assetsDirectory: string;
  useHermesBytecode: boolean;
  resetCache: boolean;
}): string[] {
  const argumentsList = [
    options.cliPath,
    'export:embed',
    '--platform',
    options.platform,
    '--entry-file',
    options.entryFile,
    '--bundle-output',
    options.bundlePath,
    '--assets-dest',
    options.assetsDirectory,
    '--sourcemap-output',
    options.sourceMapPath,
    '--dev',
    'false',
    '--minify',
    'true',
  ];
  if (options.useHermesBytecode) {
    argumentsList.push('--bytecode');
  }
  if (options.resetCache) {
    argumentsList.push('--reset-cache');
  }
  return argumentsList;
}

export async function exportExpoProject({
  projectRoot,
  platform,
  outputDirectory,
  resetCache = false,
  buildIdentity: suppliedBuildIdentity,
}: ExpoExportOptions): Promise<ExpoExportResult> {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const absoluteOutputDirectory = path.resolve(outputDirectory);
  evaluateExpoConfig(absoluteProjectRoot);
  ensureEmptyOutputDirectory(absoluteOutputDirectory);

  if (suppliedBuildIdentity && suppliedBuildIdentity.platform !== platform) {
    throw new ExpoIntegrationError(
      `The supplied Expo build identity is for ${suppliedBuildIdentity.platform}, not ${platform}.`,
    );
  }
  const buildIdentity =
    suppliedBuildIdentity ??
    (await resolveExpoBuildIdentity(absoluteProjectRoot, platform));
  const entryFile = resolveExpoEntryFile(absoluteProjectRoot, platform);
  const bundlePath = path.join(absoluteOutputDirectory, 'main.jsbundle');
  const sourceMapPath = path.join(absoluteOutputDirectory, 'main.jsbundle.map');
  const assetsDirectory = path.join(absoluteOutputDirectory, 'assets');
  fs.mkdirSync(assetsDirectory, { recursive: true, mode: 0o755 });

  const cliPath = resolveExpoDependency(absoluteProjectRoot, '@expo/cli');
  const argumentsList = buildExpoExportArguments({
    cliPath,
    platform,
    entryFile,
    bundlePath,
    sourceMapPath,
    assetsDirectory,
    useHermesBytecode: buildIdentity.javaScriptEngine === 'hermes',
    resetCache,
  });

  try {
    await execFile(process.execPath, argumentsList, {
      cwd: absoluteProjectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        BUNDLE_DROP_OTA_BUILD: '1',
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new ExpoIntegrationError(
      `Expo export:embed failed for ${platform}. No Bundle Drop artifact was created.`,
      { cause: error },
    );
  }

  const validatedOutput = validateExpoExportOutput({
    outputDirectory: absoluteOutputDirectory,
    bundlePath,
    sourceMapPath,
    assetsDirectory,
  });

  return {
    projectRoot: absoluteProjectRoot,
    platform,
    outputDirectory: absoluteOutputDirectory,
    entryFile,
    bundlePath,
    sourceMapPath,
    assetsDirectory,
    ...validatedOutput,
    buildIdentity,
  };
}
