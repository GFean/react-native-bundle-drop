import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import type { MobilePlatform, ProjectType } from '../../expo';

const HERMES_BYTECODE_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

export type SightArtifacts = {
  outputDirectory: string;
  bundlePath: string;
  sourceMapPath: string;
  temporary: boolean;
};

export type GenerateSightArtifactsOptions = {
  projectRoot: string;
  projectType: ProjectType;
  platform: MobilePlatform;
  output?: string;
  keep?: boolean;
  entryFile?: string;
};

type SourceMap = {
  version?: unknown;
  file?: unknown;
  sources?: unknown;
  mappings?: unknown;
  debugId?: unknown;
  debug_id?: unknown;
};

function ensureOutputDirectory(
  projectRoot: string,
  requestedOutput: string | undefined,
  keep: boolean,
): { outputDirectory: string; temporary: boolean } {
  if (!requestedOutput && !keep) {
    return {
      outputDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-sight-')),
      temporary: true,
    };
  }

  const outputDirectory = requestedOutput
    ? path.resolve(projectRoot, requestedOutput)
    : path.join(
        projectRoot,
        '.bundle-drop',
        'sight',
        new Date().toISOString().replace(/[:.]/g, '-'),
      );

  if (fs.existsSync(outputDirectory)) {
    const stats = fs.lstatSync(outputDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Sight output must be a real directory: ${outputDirectory}`);
    }
    if (fs.readdirSync(outputDirectory).length > 0) {
      throw new Error(`Sight output directory must be empty: ${outputDirectory}`);
    }
  } else {
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  }

  return { outputDirectory, temporary: false };
}

function resolveProjectModule(projectRoot: string, moduleId: string): string {
  const manifestPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No package.json was found at ${manifestPath}.`);
  }

  try {
    return createRequire(manifestPath).resolve(moduleId);
  } catch {
    throw new Error(
      `Could not resolve ${moduleId} from ${projectRoot}. Install dependencies and try again.`,
    );
  }
}

function resolveExpoModule(projectRoot: string, moduleId: string): string {
  const expoManifest = resolveProjectModule(projectRoot, 'expo/package.json');
  try {
    return createRequire(expoManifest).resolve(moduleId);
  } catch {
    throw new Error(`The project-local Expo installation could not resolve ${moduleId}.`);
  }
}

function resolveBareEntryFile(projectRoot: string, explicitEntryFile?: string): string {
  const candidates = explicitEntryFile
    ? [explicitEntryFile]
    : ['index.js', 'index.ts', 'index.tsx', 'index.jsx'];
  const entryFile = candidates
    .map(candidate => path.resolve(projectRoot, candidate))
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());

  if (!entryFile) {
    throw new Error(
      'Could not find a React Native entry file. Pass it explicitly with --entry-file <path>.',
    );
  }
  return entryFile;
}

function resolveExpoEntryFile(projectRoot: string, platform: MobilePlatform): string {
  type ExpoConfigPaths = {
    resolveEntryPoint?: (
      root: string,
      options: { platform: MobilePlatform },
    ) => string | null;
  };
  const configPathsPath = resolveExpoModule(projectRoot, '@expo/config/paths');
  const configPaths = createRequire(path.join(projectRoot, 'package.json'))(
    configPathsPath,
  ) as ExpoConfigPaths;
  const entryFile = configPaths.resolveEntryPoint?.(projectRoot, { platform });
  if (!entryFile) {
    throw new Error(`Expo could not resolve the ${platform} entrypoint.`);
  }
  return path.isAbsolute(entryFile) ? entryFile : path.resolve(projectRoot, entryFile);
}

function runMetroCommand(
  projectRoot: string,
  cliPath: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Metro bundle generation failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`,
        ),
      );
    });
  });
}

function sourceMapDebugId(sourceMap: SourceMap): string | null {
  const value = sourceMap.debugId ?? sourceMap.debug_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bundleDebugId(bundle: string): string | null {
  return bundle.match(/^\/\/[#@]\s*debugId=([^\s]+)\s*$/m)?.[1] ?? null;
}

export function validateSightArtifacts(
  bundlePath: string,
  sourceMapPath: string,
): void {
  for (const artifactPath of [bundlePath, sourceMapPath]) {
    if (
      !fs.existsSync(artifactPath) ||
      !fs.lstatSync(artifactPath).isFile() ||
      fs.lstatSync(artifactPath).isSymbolicLink()
    ) {
      throw new Error(`Sight generation did not create ${artifactPath}.`);
    }
  }

  const bundleBuffer = fs.readFileSync(bundlePath);
  if (bundleBuffer.length === 0) {
    throw new Error('Sight cannot analyze an empty JavaScript bundle.');
  }
  if (bundleBuffer.subarray(0, HERMES_BYTECODE_MAGIC.length).equals(HERMES_BYTECODE_MAGIC)) {
    throw new Error('Sight requires a JavaScript bundle, but Metro generated Hermes bytecode.');
  }

  let sourceMap: SourceMap;
  try {
    sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, 'utf8')) as SourceMap;
  } catch {
    throw new Error('Metro generated an invalid source-map JSON file.');
  }
  if (
    sourceMap.version !== 3 ||
    !Array.isArray(sourceMap.sources) ||
    typeof sourceMap.mappings !== 'string'
  ) {
    throw new Error('Sight requires a source-map version 3 file with sources and mappings.');
  }

  const bundle = bundleBuffer.toString('utf8');
  const sourceMapReference = bundle.match(/^[/#@\s]*sourceMappingURL=([^\s]+)\s*$/m)?.[1];
  if (sourceMapReference && path.basename(sourceMapReference) !== path.basename(sourceMapPath)) {
    throw new Error('The generated bundle references a different source-map file.');
  }
  if (
    typeof sourceMap.file === 'string' &&
    sourceMap.file.trim() &&
    path.basename(sourceMap.file) !== path.basename(bundlePath)
  ) {
    throw new Error('The generated source map references a different bundle file.');
  }

  const mapDebugId = sourceMapDebugId(sourceMap);
  const generatedBundleDebugId = bundleDebugId(bundle);
  if (mapDebugId && generatedBundleDebugId && mapDebugId !== generatedBundleDebugId) {
    throw new Error('The generated bundle and source map have different debug IDs.');
  }
}

export async function generateSightArtifacts({
  projectRoot,
  projectType,
  platform,
  output,
  keep = false,
  entryFile: explicitEntryFile,
}: GenerateSightArtifactsOptions): Promise<SightArtifacts> {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const { outputDirectory, temporary } = ensureOutputDirectory(
    absoluteProjectRoot,
    output,
    keep,
  );
  const bundlePath = path.join(outputDirectory, `main.${platform}.jsbundle`);
  const sourceMapPath = `${bundlePath}.map`;

  try {
    if (projectType === 'expo') {
      const cliPath = resolveExpoModule(absoluteProjectRoot, '@expo/cli');
      const entryFile = explicitEntryFile
        ? path.resolve(absoluteProjectRoot, explicitEntryFile)
        : resolveExpoEntryFile(absoluteProjectRoot, platform);
      const assetsDirectory = path.join(outputDirectory, 'assets');
      fs.mkdirSync(assetsDirectory, { recursive: true, mode: 0o755 });
      await runMetroCommand(absoluteProjectRoot, cliPath, [
        'export:embed',
        '--platform',
        platform,
        '--entry-file',
        entryFile,
        '--bundle-output',
        bundlePath,
        '--sourcemap-output',
        sourceMapPath,
        '--assets-dest',
        assetsDirectory,
        '--dev',
        'false',
        '--minify',
        'true',
      ]);
    } else {
      const cliPath = resolveProjectModule(absoluteProjectRoot, 'react-native/cli.js');
      const entryFile = resolveBareEntryFile(absoluteProjectRoot, explicitEntryFile);
      await runMetroCommand(absoluteProjectRoot, cliPath, [
        'bundle',
        '--platform',
        platform,
        '--dev',
        'false',
        '--entry-file',
        entryFile,
        '--bundle-output',
        bundlePath,
        '--sourcemap-output',
        sourceMapPath,
      ]);
    }

    validateSightArtifacts(bundlePath, sourceMapPath);
    return { outputDirectory, bundlePath, sourceMapPath, temporary };
  } catch (error) {
    if (temporary) {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
