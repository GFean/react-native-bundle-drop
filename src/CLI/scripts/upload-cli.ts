import axios from 'axios';
import { spawnSync } from 'child_process';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
import * as plist from 'plist';

import { log, startLoadingStatus } from '../utils/ui';
import { resolveIosPlistVersion } from '../../scripts/resolve-ios-version';
import {
  assertExpoUpdatesDoesNotOwnStartup,
  detectProjectType,
  evaluateExpoConfig,
  resolveBundleDropRuntimeVersionAuthority,
} from '../../expo';
import { resolveModuleFrom, type ModuleResolver } from '../../scripts/resolveModule';
import { assertMatchingServerOrigin } from '../serverUrl';

const DOCS_INSTALLATION_URL = 'https://bundledrop.app/docs/installation';
const DOCS_UPLOADING_URL = 'https://bundledrop.app/docs/uploading';
const DOCS_CI_CD_URL = 'https://bundledrop.app/docs/ci-cd';
const DOCS_RUNTIME_VERSION_URL = 'https://bundledrop.app/docs/runtime-version';
const BUNDLE_DROP_ARTIFACT_FILES = [
  'main.jsbundle',
  'main.jsbundle.map',
  'bundle-drop-result.json',
];

type UploadOptions = {
  plistFile?: string;
  version?: string;
  channel?: string;
  buildGradlePath?: string;
  releaseNotes?: string;
  token?: string;
  author?: string;
  sourcemap?: boolean;
  artifactDir?: string;
  buildReceipt?: string;
};

type UploadDependencies = {
  packageRoot: string;
  spawnProcess: typeof spawnSync;
  resolveModule: ModuleResolver;
};

const defaultUploadDependencies = (): UploadDependencies => ({
  packageRoot: path.resolve(__dirname, '..', '..', '..'),
  spawnProcess: spawnSync,
  resolveModule: resolveModuleFrom,
});

const assertPathInside = (targetPath: string, parentPath: string, label: string) => {
  const resolvedParent = path.resolve(parentPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedParent, resolvedTarget);
  const escapesParent =
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (!escapesParent) {
    return;
  }
  throw new Error(`${label} escaped its generated output directory: ${resolvedTarget}`);
};

const readPackageVersion = (packageRoot: string): string | undefined => {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'),
    );
    return typeof packageJson.version === 'string' && packageJson.version.trim()
      ? packageJson.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
};

const readManifestRuntimeVersion = (manifestPath: string): string => {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    throw new Error(`bundle-manifest.json is required and must be valid JSON: ${(error as Error).message}`);
  }

  if (manifest.manifestVersion !== 1) {
    throw new Error('bundle-manifest.json must use manifestVersion 1');
  }
  if (typeof manifest.runtimeVersion !== 'string' || !manifest.runtimeVersion) {
    throw new Error('bundle-manifest.json is missing runtimeVersion');
  }
  return manifest.runtimeVersion;
};

const prepareArtifactDirForRun = (artifactDir?: string) => {
  if (!artifactDir) return;
  fs.mkdirSync(artifactDir, { recursive: true });
  for (const fileName of BUNDLE_DROP_ARTIFACT_FILES) {
    const filePath = path.join(artifactDir, fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
};

const writeArtifactResult = (artifactDir: string | undefined, result: Record<string, unknown>) => {
  if (!artifactDir) return;
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, 'bundle-drop-result.json'),
    JSON.stringify(result, null, 2),
  );
};

const stringifyUploadError = (err: any) => {
  const raw = err?.response?.data || err.message;
  return typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw);
};

type UploadArtifactPaths = {
  outputDir: string;
  bundlePath: string;
  sourceMapPath?: string;
  metadataPath: string;
  manifestPath: string;
  zipPath: string;
  expoExportDirectory?: string;
};

const bareArtifactPaths = (
  packageRoot: string,
  platform: string,
): UploadArtifactPaths => {
  const outputDir = path.join(packageRoot, 'dist');
  return {
    outputDir,
    bundlePath: path.join(outputDir, 'main.jsbundle'),
    sourceMapPath: path.join(outputDir, 'main.jsbundle.map'),
    metadataPath: path.join(outputDir, `metadata-${platform}.json`),
    manifestPath: path.join(outputDir, 'bundle-manifest.json'),
    zipPath: path.join(outputDir, `bundle-${platform}.zip`),
  };
};

export async function runUpload(
  platform: string,
  options: UploadOptions,
  dependencies: UploadDependencies = defaultUploadDependencies(),
) {
  console.log(); // blank line
  log.info('🚀 React Native OTA Upload Initialized');

  const projectRoot = process.cwd();
  const artifactDir = options.artifactDir ? path.resolve(options.artifactDir) : undefined;
  prepareArtifactDirForRun(artifactDir);
  const configPath = path.resolve(projectRoot, 'bundle.drop.config.js');
  //eslint-disable-next-line
  const authPath = path.join(require('os').homedir(), '.bundle-drop', 'auth.json');

  // Validate config
  if (!fs.existsSync(configPath)) {
    log.error(`❌ bundle.drop.config.js not found in project root\nSee ${DOCS_INSTALLATION_URL}`);
    process.exit(1);
  }

  //eslint-disable-next-line
  const config = require(configPath);
  const serverUrl = config.serverUrl;
  const orgSlug = config.org?.slug;
  const projectSlug = config.project?.slug;
  let detectedProjectType: import('../../expo').ProjectType;
  try {
    detectedProjectType = detectProjectType({ projectRoot });
    const usesExpoRuntimePolicy = config.runtimeVersion?.source === 'expo';
    if (detectedProjectType === 'bare' && usesExpoRuntimePolicy) {
      throw new Error(
        'Bare React Native was detected, but bundle.drop.config.js contains a stale Expo runtime marker.',
      );
    }
    if (detectedProjectType === 'expo') {
      resolveBundleDropRuntimeVersionAuthority(projectRoot, 'ios');
      resolveBundleDropRuntimeVersionAuthority(projectRoot, 'android');
      const { exp } = evaluateExpoConfig(projectRoot);
      assertExpoUpdatesDoesNotOwnStartup(projectRoot, exp);
    }
  } catch (error) {
    log.error(`❌ Project type validation failed: ${(error as Error).message}`);
    process.exit(1);
  }
  const isExpoProject = detectedProjectType === 'expo';

  if (!serverUrl || !projectSlug || !orgSlug) {
    log.error(
      `❌ Missing "serverUrl", "org.slug" or "project.slug" in config\nSee ${DOCS_INSTALLATION_URL}`,
    );
    process.exit(1);
  }

  // Resolve auth token: --token flag takes priority over auth.json
  let token = options.token;
  if (!token) {
    if (!fs.existsSync(authPath)) {
      log.error(
        `❌ Not authenticated. Please run \`bundle-drop login\` or pass --token.\n` +
          `Local setup: ${DOCS_INSTALLATION_URL}\n` +
          `CI/CD tokens: ${DOCS_CI_CD_URL}`,
      );
      process.exit(1);
    }
    let storedAuth: { token?: string; serverUrl?: string; baseUrl?: string };
    try {
      storedAuth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    } catch {
      log.error('❌ Failed to read CLI auth session. Run `bundle-drop login` again or pass --token.');
      process.exit(1);
    }
    if (!storedAuth?.token) {
      log.error('❌ CLI auth session is missing a token. Run `bundle-drop login` again or pass --token.');
      process.exit(1);
    }
    try {
      assertMatchingServerOrigin(serverUrl, storedAuth.serverUrl || storedAuth.baseUrl);
    } catch (error) {
      log.error(`❌ ${(error as Error).message}`);
      process.exit(1);
    }
    token = storedAuth.token;
  }

  // Validate channel
  const channel = options.channel;
  if (!channel) {
    log.error('❌ Missing required --channel argument');
    process.exit(1);
  }
  log.label('Platform', platform);
  log.label('Org', orgSlug);
  log.label('Project', projectSlug);
  log.label('Channel', channel);

  let version: string | undefined = options.version;
  let expoBuildIdentity: import('../../expo').ExpoBuildIdentity | undefined;
  const buildGradlePath = options.buildGradlePath || (options as any).buildgradlePath;
  let releaseNotes = options.releaseNotes;
  const MAX_NOTES = 2000;
  if (releaseNotes && releaseNotes.length > MAX_NOTES) {
    log.warn(`Release notes too long (${releaseNotes.length}); truncating to ${MAX_NOTES} chars.`);
    releaseNotes = releaseNotes.slice(0, MAX_NOTES);
  }

  const parseAndroidVersionFromGradle = (filePath: string) => {
    if (!fs.existsSync(filePath)) {
      log.error(`❌ build.gradle not found at ${filePath}`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/versionName\s+['"]([^'"]+)['"]/);
    if (!match) {
      log.error('❌ Could not parse versionName from build.gradle');
      process.exit(1);
    }
    return match[1];
  };

  if (isExpoProject) {
    if (platform !== 'ios' && platform !== 'android') {
      log.error('❌ Expo uploads require platform ios or android');
      process.exit(1);
    }
    try {
      expoBuildIdentity = await require('./expo/build-receipt').resolveExpoUploadIdentity({
        projectRoot,
        platform,
        receiptFile: options.buildReceipt,
      });
      if (version && version !== expoBuildIdentity.appVersion) {
        throw new Error(
          `--version ${version} does not match the proven Expo build version ${expoBuildIdentity.appVersion}.`,
        );
      }
      version = expoBuildIdentity.appVersion;
    } catch (error) {
      log.error(`❌ ${(error as Error).message}\nSee ${DOCS_RUNTIME_VERSION_URL}`);
      process.exit(1);
    }
  } else if (platform === 'ios') {
    if (!version) {
        if (!options.plistFile) {
        log.error(`❌ Provide --version or --plist-file for iOS\nSee ${DOCS_UPLOADING_URL}`);
        process.exit(1);
      }

      try {
        const plistContent = fs.readFileSync(options.plistFile, 'utf-8');
        const parsed = plist.parse(plistContent) as any;
        const rawVersion: string | undefined = parsed.CFBundleShortVersionString;
        if (!rawVersion) {
          log.error('❌ Could not find CFBundleShortVersionString in plist');
          process.exit(1);
        }
        const resolved = resolveIosPlistVersion(rawVersion, projectRoot);
        if (!resolved) {
          process.exit(1);
        }
        version = resolved;
      } catch (err) {
        log.error(`❌ Failed to parse Info.plist: ${(err as Error).message}`);
        process.exit(1);
      }
    }
  } else {
    if (!version) {
      if (buildGradlePath) {
        version = parseAndroidVersionFromGradle(path.resolve(projectRoot, buildGradlePath));
      } else {
        const defaultPath = path.join(projectRoot, 'android', 'app', 'build.gradle');
        if (fs.existsSync(defaultPath)) {
          version = parseAndroidVersionFromGradle(defaultPath);
        } else {
          log.error(`❌ Provide --version or --buildgradle-path for Android\nSee ${DOCS_UPLOADING_URL}`);
          process.exit(1);
        }
      }
    }
  }

  /* istanbul ignore if -- exhaustive guard; all branches above either set version or exit */
  if (!version) {
    log.error('❌ Version could not be determined');
    process.exit(1);
  }

  log.label('App Version', version);
  console.log();

  log.arrow(`Bundling ${platform} app...`);
  const packageRoot = dependencies.packageRoot;
  const packageVersion = readPackageVersion(packageRoot);
  const compiledBundleScript = path.join(packageRoot, 'lib', 'scripts', 'bundle.js');
  const tsBundleScript = path.join(packageRoot, 'src', 'scripts', 'bundle.ts');
  let artifact = bareArtifactPaths(packageRoot, platform);
  try {
    if (isExpoProject) {
      artifact = await require('../../scripts/exportProject').exportProjectArtifact({
        projectRoot,
        platform,
        appVersion: version,
        generateSourceMap: Boolean(options.sourcemap),
        projectType: detectedProjectType,
        buildReceipt: options.buildReceipt,
        buildIdentity: expoBuildIdentity,
      });
    } else {
      const useCompiledScript = fs.existsSync(compiledBundleScript);
      const script = useCompiledScript
        ? compiledBundleScript
        : dependencies.resolveModule('ts-node/dist/bin.js', [packageRoot, __dirname]);
      const args = [
        script,
        ...(useCompiledScript ? [] : [tsBundleScript]),
        platform,
      ];
      if (options.sourcemap) args.push('--sourcemap');
      const result = dependencies.spawnProcess(process.execPath, args, {
        stdio: 'inherit',
        shell: false,
        env: {
          ...process.env,
          BUNDLE_DROP_APP_VERSION: version,
        },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Bundle process exited with status ${result.status}`);
      }
    }
  } catch (error) {
    log.error(
      isExpoProject
        ? `❌ Expo export failed: ${(error as Error).message}`
        : '❌ Bundling failed',
    );
    process.exit(1);
  }

  let runtimeVersion: string | undefined;
  try {
    runtimeVersion = readManifestRuntimeVersion(artifact.manifestPath);
    log.label('Runtime Version', runtimeVersion);
  } catch (error) {
    log.error(`❌ ${(error as Error).message}\nSee ${DOCS_RUNTIME_VERSION_URL}`);
    process.exit(1);
  }
  if (!fs.existsSync(artifact.zipPath)) {
    log.error(`❌ Bundle ZIP not found at: ${artifact.zipPath}`);
    process.exit(1);
  }

  // Build form data
  const form = new FormData();
  form.append('orgSlug', orgSlug);
  form.append('projectSlug', projectSlug);
  form.append('platform', platform);
  form.append('version', version);
  form.append('channelName', channel);
  form.append('runtimeVersion', runtimeVersion);
  if (packageVersion) {
    form.append('packageVersion', packageVersion);
  }
  if (releaseNotes) {
    form.append('releaseNotes', releaseNotes);
  }
  if (options.author) {
    form.append('author', options.author);
  }
  form.append('file', fs.createReadStream(artifact.zipPath));

  const uploadLoader = startLoadingStatus('Uploading bundle to server');
  let uploadSucceeded = false;
  try {
    const res = await axios.post(`${serverUrl}/bundle/upload`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const hasSourceMap = options.sourcemap && artifact.sourceMapPath &&
      fs.existsSync(artifact.sourceMapPath);
    const result: Record<string, unknown> = {
      platform,
      appVersion: version,
      channel,
      orgSlug,
      projectSlug,
      runtimeVersion: res.data?.runtimeVersion ?? runtimeVersion ?? null,
      packageVersion: res.data?.packageVersion ?? packageVersion ?? null,
      bundleId: res.data?.bundleId ?? null,
      bundleVersion: res.data?.bundleVersion ?? null,
      bundleVersionLabel: res.data?.bundleVersionLabel ?? null,
      hash: res.data?.hash ?? null,
      releaseNotes: releaseNotes ?? null,
      author: options.author ?? null,
    };

    if (artifactDir) {
      try {
        fs.mkdirSync(artifactDir, { recursive: true });
        if (fs.existsSync(artifact.bundlePath)) {
          fs.copyFileSync(artifact.bundlePath, path.join(artifactDir, 'main.jsbundle'));
          result.bundlePath = path.join(artifactDir, 'main.jsbundle');
        }
        if (hasSourceMap && artifact.sourceMapPath) {
          fs.copyFileSync(artifact.sourceMapPath, path.join(artifactDir, 'main.jsbundle.map'));
          result.sourceMapPath = path.join(artifactDir, 'main.jsbundle.map');
        }
      } catch (copyErr: any) {
        log.warn(`Upload succeeded but artifact copy failed: ${copyErr.message}`);
      }
    }

    uploadLoader.stop();
    log.success(`✅ Upload complete`);
    if (result.bundleVersion != null) log.label('Bundle Version', `${result.bundleVersion}`);
    if (result.bundleVersionLabel) log.label('Bundle Label', `${result.bundleVersionLabel}`);
    if (result.hash) log.label('Hash', `${result.hash}`);

    const resultDir = artifactDir ?? artifact.outputDir;
    if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
    const resultPath = path.join(resultDir, 'bundle-drop-result.json');
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    log.label('Result file', resultPath);

    if (artifactDir) {
      log.label('Artifact dir', artifactDir);
    }
    uploadSucceeded = true;
  } catch (err: any) {
    uploadLoader.stop();
    const uploadError = stringifyUploadError(err);
    writeArtifactResult(artifactDir, {
      success: false,
      status: 'failed',
      error: uploadError,
      platform,
      appVersion: version,
      channel,
      orgSlug,
      projectSlug,
      runtimeVersion,
      packageVersion: packageVersion ?? null,
      releaseNotes: releaseNotes ?? null,
      author: options.author ?? null,
    });
    log.error(`Upload failed: ${uploadError}`);
    process.exitCode = 1;
    return;
  } finally {
    try {
      const generatedRoot = isExpoProject
        ? path.join(projectRoot, '.bundle-drop', 'artifacts')
        : path.join(packageRoot, 'dist');
      assertPathInside(artifact.outputDir, generatedRoot, 'Artifact output');
      const cleanupFiles = [
        artifact.zipPath,
        artifact.metadataPath,
        artifact.manifestPath,
        artifact.bundlePath,
        artifact.sourceMapPath,
      ];
      const assetsPath = path.join(artifact.outputDir, 'assets');
      const expoExportDirectory = artifact.expoExportDirectory ??
        path.join(packageRoot, 'dist', `expo-export-${platform}`);

      for (const file of cleanupFiles) {
        if (file) {
          assertPathInside(file, artifact.outputDir, 'Artifact file');
          if (fs.existsSync(file)) fs.unlinkSync(file);
        }
      }
      assertPathInside(assetsPath, artifact.outputDir, 'Artifact assets');
      if (fs.existsSync(assetsPath)) {
        fs.rmSync(assetsPath, { recursive: true, force: true });
      }
      assertPathInside(expoExportDirectory, generatedRoot, 'Expo export');
      if (fs.existsSync(expoExportDirectory)) {
        fs.rmSync(expoExportDirectory, { recursive: true, force: true });
      }

      if (uploadSucceeded) {
        console.log();
        log.success('🎉 Done! Bundle uploaded and cleaned.');
        console.log();
      }
    } catch (cleanupErr: any) {
      log.warn(`Cleanup failed: ${cleanupErr.message}`);
    }
  }
}

export default function upload(platform: string, options: UploadOptions) {
  return runUpload(platform, options);
}
