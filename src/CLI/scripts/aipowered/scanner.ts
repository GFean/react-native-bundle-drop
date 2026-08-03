import crypto from 'crypto';
import fs from 'fs-extra';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { evaluateExpoConfig, inspectExpoUpdatesOwnership } from '../../../expo';
import {
  hasBareAndroidStartupIntegration,
  hasBareIosStartupIntegration,
} from '../native-setup-contract';
import {
  AiSetupPlanFile,
  AiSetupProjectType,
  AiSetupScannerResult,
} from './types';

const MAX_UP = 12;
const MAX_FILE_BYTES = 80 * 1024;
const MAX_TOTAL_BYTES = 350 * 1024;
const TRUSTED_BUNDLE_DROP_AI_HOSTS = new Set(['api.bundledrop.app']);
const LOCAL_AI_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2']);
const SKIP_DIRS = new Set([
  'node_modules',
  'build',
  'Pods',
  '.gradle',
  'DerivedData',
  '.git',
  'lib',
  'dist',
]);

const sha256 = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

const toPosix = (filePath: string) => filePath.split(path.sep).join('/');

const normalizeServerUrl = (url: string) => url.replace(/\/+$/, '');

const readJsonFile = (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const CREDENTIAL_LITERAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'credential-like property',
    pattern:
      /["'`]?(?:api[_-]?key|access[_-]?key|auth[_-]?token|aws[_-]?secret[_-]?access[_-]?key|client[_-]?secret|deployment[_-]?key|password|passwd|private[_-]?key|secret[_-]?access[_-]?key|secret|token)["'`]?(?:\s*:\s*[A-Za-z_$][A-Za-z0-9_$?.<>,\[\] ]+)?\s*(?::|=|\()\s*@?(["'`])[^\r\n"'`]+\1/i,
  },
  {
    name: 'authorization header',
    pattern: /authorization["'`]?\s*(?::|=)\s*@?(["'`])\s*(?:bearer|basic)\s+[^\r\n"'`]+\1/i,
  },
  {
    name: 'credential-bearing URL',
    pattern:
      /https?:\/\/[^\s/@:]+:[^\s/@]+@|[?&](?:api[_-]?key|access[_-]?key|auth[_-]?token|password|secret|token)=[^&\s"'`]+/i,
  },
  {
    name: 'private key',
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  },
  {
    name: 'known access token format',
    pattern: /\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
];

export const findCredentialLikeLiteral = (content: string): string | null => {
  for (const candidate of CREDENTIAL_LITERAL_PATTERNS) {
    if (candidate.pattern.test(content)) return candidate.name;
  }
  return null;
};

const assertSafeAiSetupContent = (relativePath: string, content: string) => {
  const finding = findCredentialLikeLiteral(content);
  if (!finding) return;
  throw new Error(
    `Refusing AI setup because ${relativePath} contains a ${finding}. ` +
      'Move the value to an environment variable or configure this file manually, then retry. ' +
      'The file was not shared, and --yes cannot bypass this safety check.',
  );
};

const CONTEXT_SUMMARY_SIGNALS = [
  'react-native',
  '@gfean/react-native-bundle-drop',
  'react-native-bundle-drop',
  'bundle-drop-config',
  'react-native-code-push',
  'CodePush',
  'codepush.gradle',
  'CodePushDeploymentKey',
  'serverUrl',
  'org',
  'project',
  'getDefaultConfig',
  'mergeConfig',
  'com.android.application',
  'com.facebook.react',
  'react-native-gradle-plugin',
  'pluginManagement',
  'includeBuild',
  'newArchEnabled',
  'hermesEnabled',
  'use_react_native!',
  'use_native_modules!',
];

const summarizeContextContent = (relativePath: string, rawContent: string, sizeBytes: number) => {
  const matchedSignals = CONTEXT_SUMMARY_SIGNALS.filter(signal => rawContent.includes(signal));
  const signalLines = matchedSignals.length
    ? matchedSignals.map(signal => `- ${signal}`).join('\n')
    : '- none detected';

  return [
    `BundleDrop context summary for ${relativePath}`,
    'Full content omitted to reduce setup-planning tokens; this context file is read-only.',
    `sizeBytes: ${sizeBytes}`,
    'signals:',
    signalLines,
    '',
  ].join('\n');
};

export const isTrustedAiPlanningServer = (serverUrl: string) => {
  if (process.env.BUNDLE_DROP_ALLOW_UNTRUSTED_AI_SERVER === '1') return true;

  try {
    const parsed = new URL(serverUrl);
    if (TRUSTED_BUNDLE_DROP_AI_HOSTS.has(parsed.hostname)) return parsed.protocol === 'https:';
    if (LOCAL_AI_HOSTS.has(parsed.hostname)) {
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
  } catch {
    return false;
  }

  return false;
};

export const isBundleDropHostedAiPlanningServer = (serverUrl: string) => {
  try {
    const parsed = new URL(serverUrl);
    return parsed.protocol === 'https:' && TRUSTED_BUNDLE_DROP_AI_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
};

const loadBundleDropConfig = (configPath: string) => {
  const moduleLike = { exports: {} as any };
  const content = fs.readFileSync(configPath, 'utf8');
  const localRequire = createRequire(configPath);
  const load = new Function('module', 'exports', 'require', '__dirname', '__filename', content);
  load(moduleLike, moduleLike.exports, localRequire, path.dirname(configPath), configPath);
  return moduleLike.exports;
};

export function findProjectRoot(startDir = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < MAX_UP; i++) {
    if (fs.existsSync(path.join(dir, 'bundle.drop.config.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

const findFilesByName = (root: string, names: Set<string>): string[] => {
  if (!fs.existsSync(root)) return [];
  const matches: string[] = [];
  const stack = [root];

  while (stack.length) {
    const current = stack.pop()!;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(current))) continue;
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile() && names.has(path.basename(current))) {
      matches.push(current);
    }
  }

  return matches.sort();
};

const readAuthToken = () => {
  const authPath = path.join(os.homedir(), '.bundle-drop', 'auth.json');
  if (!fs.existsSync(authPath)) {
    throw new Error('Not authenticated. Please run `bundle-drop login` before `bundle-drop init`.');
  }

  try {
    const parsed = readJsonFile(authPath);
    if (typeof parsed.token !== 'string' || !parsed.token.trim()) {
      throw new Error('Token missing');
    }
    return parsed.token.trim();
  } catch {
    throw new Error('Failed to read CLI auth session. Please run `bundle-drop login` again.');
  }
};

const SETUP_CONFIG_FILES = [
  'bundle.drop.config.js',
  'bundle.drop.config.cjs',
  'app.json',
  'app.config.js',
  'app.config.ts',
  'app.config.cjs',
  'app.config.mjs',
  'metro.config.js',
  'metro.config.ts',
  'metro.config.cjs',
  'metro.config.mjs',
] as const;

const setupFileKind = (relativePath: string): AiSetupPlanFile['kind'] => {
  if (relativePath === 'package.json') return 'package_manifest';
  if (relativePath.startsWith('bundle.drop.config.')) return 'bundle_drop_config';
  if (relativePath === 'app.json' || relativePath.startsWith('app.config.')) {
    return 'expo_app_config';
  }
  if (relativePath.startsWith('metro.config.')) return 'metro_config';
  if (relativePath.includes('MainApplication.')) return 'android_entrypoint';
  return 'ios_entrypoint';
};

const readSetupFile = (projectRoot: string, relativePath: string): AiSetupPlanFile | null => {
  const filePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null;
  const rawContent = fs.readFileSync(filePath, 'utf8');
  const kind = setupFileKind(relativePath);
  if (kind !== 'package_manifest' && kind !== 'bundle_drop_config') {
    assertSafeAiSetupContent(relativePath, rawContent);
  }
  const content = kind === 'package_manifest' || kind === 'bundle_drop_config'
    ? summarizeContextContent(relativePath, rawContent, stat.size)
    : rawContent;
  return {
    kind,
    path: relativePath,
    content,
    sha256: sha256(content),
  };
};

const collectSetupFiles = (
  projectRoot: string,
  projectType: AiSetupProjectType,
): AiSetupPlanFile[] => {
  const relativePaths = ['package.json', ...SETUP_CONFIG_FILES];
  if (projectType === 'bare') {
    for (const srcDir of ['java', 'kotlin']) {
      relativePaths.push(
        ...findFilesByName(
          path.join(projectRoot, 'android', 'app', 'src', 'main', srcDir),
          new Set(['MainApplication.kt', 'MainApplication.java']),
        ).map(filePath => toPosix(path.relative(projectRoot, filePath))),
      );
    }
    relativePaths.push(
      ...findFilesByName(
        path.join(projectRoot, 'ios'),
        new Set(['AppDelegate.swift', 'AppDelegate.mm', 'AppDelegate.m']),
      ).map(filePath => toPosix(path.relative(projectRoot, filePath))),
    );
  }

  const files: AiSetupPlanFile[] = [];
  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    const file = readSetupFile(projectRoot, relativePath);
    if (!file) continue;
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (totalBytes + bytes > MAX_TOTAL_BYTES) continue;
    totalBytes += bytes;
    files.push(file);
  }
  return files;
};

const readPackageSignals = (projectRoot: string) => {
  const packagePath = path.join(projectRoot, 'package.json');
  const pkg = fs.existsSync(packagePath) ? readJsonFile(packagePath) : {};
  const dependencies = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
  } as Record<string, string>;
  return { pkg, dependencies };
};

const resolveInstalledPackageVersion = (projectRoot: string, packageName: string): string | null => {
  try {
    const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
    const manifest = readJsonFile(projectRequire.resolve(`${packageName}/package.json`));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
};

const detectSetupSignals = (
  projectRoot: string,
  projectType: AiSetupProjectType,
  files: AiSetupPlanFile[],
) => {
  const { pkg, dependencies } = readPackageSignals(projectRoot);
  const content = files.map(file => file.content).join('\n');
  const expoVersion = dependencies.expo || null;
  const hasBundleDropDependency = Boolean(
    dependencies['@gfean/react-native-bundle-drop'] || dependencies['react-native-bundle-drop'],
  );
  const hasBundleDropConfig = files.some(file => file.kind === 'bundle_drop_config');
  const evaluatedExpoConfig = projectType === 'expo'
    ? evaluateExpoConfig(projectRoot).exp
    : {};
  const expoPlugins = (evaluatedExpoConfig.plugins || []).map((plugin: unknown) =>
    typeof plugin === 'string' ? plugin : Array.isArray(plugin) ? plugin[0] : null,
  );
  const hasBundleDropExpoPlugin = expoPlugins.includes('@gfean/react-native-bundle-drop');
  const nativeEntrypoints = files.filter(file =>
    file.kind === 'android_entrypoint' || file.kind === 'ios_entrypoint'
  );
  const hasBareNativeIntegration = nativeEntrypoints.length > 0 && nativeEntrypoints.every(file =>
    file.kind === 'android_entrypoint'
      ? hasBareAndroidStartupIntegration(file.content)
      : hasBareIosStartupIntegration(file.path, file.content),
  );
  const hasBundleDropIntegration = projectType === 'expo'
    ? hasBundleDropExpoPlugin
    : hasBareNativeIntegration;
  const expoUpdatesOwnership = inspectExpoUpdatesOwnership(projectRoot, evaluatedExpoConfig);
  const configuredEngine = /(?:["']jsEngine["']|\bjsEngine)\s*:\s*["']jsc["']/.test(content)
    ? 'jsc' as const
    : /(?:["']jsEngine["']|\bjsEngine)\s*:\s*["']hermes["']/.test(content)
      ? 'hermes' as const
      : 'unknown' as const;
  const signals = [
    projectType === 'expo' ? 'expoProject' : 'bareProject',
    fs.existsSync(path.join(projectRoot, 'ios')) ? 'iosDirectory' : '',
    fs.existsSync(path.join(projectRoot, 'android')) ? 'androidDirectory' : '',
    expoUpdatesOwnership.packageIsInstalled || expoUpdatesOwnership.packageIsDeclared
      ? 'expoUpdatesDependency'
      : '',
    dependencies['react-native-code-push'] ? 'codePushDependency' : '',
    pkg.main === 'expo-router/entry' || dependencies['expo-router'] ? 'expoRouter' : '',
    hasBundleDropExpoPlugin ? 'expoBundleDropPlugin' : '',
  ].filter(Boolean);

  const detected = {
    rnVersion: resolveInstalledPackageVersion(projectRoot, 'react-native') ||
      dependencies['react-native'] || null,
    expoSdkVersion: projectType === 'expo'
      ? resolveInstalledPackageVersion(projectRoot, 'expo') || expoVersion
      : null,
    bundleDropStatus:
      hasBundleDropDependency && hasBundleDropConfig && hasBundleDropIntegration
        ? 'configured' as const
        : 'partial' as const,
    hasNativeDirectories:
      fs.existsSync(path.join(projectRoot, 'ios')) ||
      fs.existsSync(path.join(projectRoot, 'android')),
    usesExpoRouter: Boolean(pkg.main === 'expo-router/entry' || dependencies['expo-router']),
    jsEngine: configuredEngine,
    expoUpdatesStatus: expoUpdatesOwnership.state,
    codePushDetected: Boolean(
      dependencies['react-native-code-push'] || /\bCodePush\b|codepush\.gradle/.test(content),
    ),
    signals,
  };
  if (projectType === 'expo') {
    const exp = evaluatedExpoConfig;
    const iosEngine = exp.ios?.jsEngine ?? exp.jsEngine ?? 'hermes';
    const androidEngine = exp.android?.jsEngine ?? exp.jsEngine ?? 'hermes';
    detected.jsEngine = iosEngine === androidEngine && ['hermes', 'jsc'].includes(iosEngine)
      ? iosEngine
      : 'unknown';
  }
  return detected;
};

export function scanProjectForAiSetup(
  projectType: AiSetupProjectType,
  startDir = process.cwd(),
  virtualConfig?: {
    content: string;
    serverUrl: string;
    orgSlug: string;
    projectSlug: string;
    authToken: string;
  },
): AiSetupScannerResult {
  const projectRoot = findProjectRoot(startDir);
  const configPath = path.join(projectRoot, 'bundle.drop.config.js');
  if (!fs.existsSync(configPath) && !virtualConfig) {
    throw new Error('bundle.drop.config.js not found; run `bundle-drop init` first.');
  }

  const config = virtualConfig ? null : loadBundleDropConfig(configPath);
  const serverUrl = virtualConfig
    ? normalizeServerUrl(virtualConfig.serverUrl)
    : typeof config?.serverUrl === 'string' ? normalizeServerUrl(config.serverUrl) : '';
  const orgSlug = virtualConfig?.orgSlug ||
    (typeof config?.org?.slug === 'string' ? config.org.slug.trim() : '');
  const projectSlug = virtualConfig?.projectSlug ||
    (typeof config?.project?.slug === 'string' ? config.project.slug.trim() : '');
  if (!serverUrl || !orgSlug || !projectSlug) {
    throw new Error('Missing "serverUrl", "org.slug" or "project.slug" in bundle.drop.config.js.');
  }
  if (!isTrustedAiPlanningServer(serverUrl)) {
    throw new Error(`Refusing to send project files to untrusted AI planning server: ${serverUrl}.`);
  }

  const files = collectSetupFiles(projectRoot, projectType);
  if (virtualConfig && !files.some(file => file.kind === 'bundle_drop_config')) {
    const summarizedConfig = summarizeContextContent(
      'bundle.drop.config.js',
      virtualConfig.content,
      Buffer.byteLength(virtualConfig.content, 'utf8'),
    );
    files.push({
      kind: 'bundle_drop_config',
      path: 'bundle.drop.config.js',
      content: summarizedConfig,
      sha256: sha256(summarizedConfig),
    });
  }
  return {
    projectRoot,
    serverUrl,
    orgSlug,
    projectSlug,
    authToken: virtualConfig?.authToken || readAuthToken(),
    request: {
      schemaVersion: 1,
      orgSlug,
      projectSlug,
      projectType,
      detected: detectSetupSignals(projectRoot, projectType, files),
      files,
    },
  };
}
