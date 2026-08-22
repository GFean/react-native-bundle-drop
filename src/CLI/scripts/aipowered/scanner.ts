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
import { inspectProjectDirectory, inspectProjectFile } from '../safe-file-transaction';
import { findNativeEntrypointAuthorityIssue } from '../native-entrypoint-authority';
import {
  AiSetupPlanFile,
  AiSetupProjectType,
  AiSetupScannerResult,
} from './types';
import { hasUnsafeTerminalControl } from './terminal-safety';
import { findKnownBundleDropCredential } from './credential-safety';

const MAX_UP = 12;
const MAX_FILE_BYTES = 80 * 1024;
const MAX_SUMMARIZED_SOURCE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_NATIVE_SCAN_ENTRIES = 5000;
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
  const bundleDropCredential = findKnownBundleDropCredential(content);
  if (bundleDropCredential) return bundleDropCredential;
  for (const candidate of CREDENTIAL_LITERAL_PATTERNS) {
    if (candidate.pattern.test(content)) return candidate.name;
  }
  return null;
};

const assertSafeAiSetupContent = (relativePath: string, content: string) => {
  if (hasUnsafeTerminalControl(content)) {
    throw new Error(
      `Refusing AI setup because ${relativePath} contains unsafe terminal or bidirectional ` +
        'control characters. Remove them manually, then retry. The file was not shared, ' +
        'and --yes cannot bypass this safety check.',
    );
  }
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
  const runtimeVersionBlock = relativePath.startsWith('bundle.drop.config.')
    ? rawContent.match(/\bruntimeVersion\s*:\s*\{([\s\S]*?)\}/)?.[1] || ''
    : '';
  const runtimeAuthority = runtimeVersionBlock
    ? /\bsource\s*:\s*['"]expo['"]/.test(runtimeVersionBlock)
      ? 'expo_source'
      : [
          /\bios\s*:\s*['"][^'"]+['"]/.test(runtimeVersionBlock) ? 'ios_literal' : '',
          /\bandroid\s*:\s*['"][^'"]+['"]/.test(runtimeVersionBlock) ? 'android_literal' : '',
        ].filter(Boolean).join(',') || 'cli_validated'
    : 'cli_validated';
  const runtimeAuthorityLine = relativePath.startsWith('bundle.drop.config.')
    ? `runtimeVersionAuthority: ${runtimeAuthority}\n`
    : '';

  return [
    `BundleDrop context summary for ${relativePath}`,
    'Full content omitted to reduce setup-planning tokens; this context file is read-only.',
    `sizeBytes: ${sizeBytes}`,
    runtimeAuthorityLine.trimEnd(),
    'signals:',
    signalLines,
    '',
  ].filter(Boolean).join('\n');
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

const loadBundleDropConfig = (configPath: string, content: string) => {
  const moduleLike = { exports: {} as any };
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
  let visitedEntries = 0;

  while (stack.length) {
    const current = stack.pop()!;
    visitedEntries += 1;
    if (visitedEntries > MAX_NATIVE_SCAN_ENTRIES) {
      throw new Error(
        `AI setup native source scan exceeded ${MAX_NATIVE_SCAN_ENTRIES} filesystem entries. ` +
          'Reduce generated/source files or configure native startup manually. ' +
          'No context was shared and no files were changed.',
      );
    }
    const stat = fs.lstatSync(current);
    if (SKIP_DIRS.has(path.basename(current))) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `AI setup cannot safely inspect symbolic-link source path ${toPosix(path.relative(root, current))}. ` +
          'No context was shared and no files were changed.',
      );
    }
    if (stat.isDirectory()) {
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

const isRequiredPatchableSetupFile = (relativePath: string) => {
  const kind = setupFileKind(relativePath);
  return kind === 'android_entrypoint' ||
    kind === 'ios_entrypoint' ||
    relativePath.startsWith('app.config.');
};

const isSummarizedSetupFile = (relativePath: string) => {
  const kind = setupFileKind(relativePath);
  return kind === 'package_manifest' ||
    kind === 'bundle_drop_config' ||
    kind === 'metro_config' ||
    relativePath === 'app.json';
};

const setupContextLimitError = (relativePath: string, reason: string) => new Error(
  `AI setup cannot safely inspect required setup file ${relativePath}: ${reason}. ` +
    'Reduce or split this file, or configure Bundle Drop manually, then retry. ' +
    'No context was shared and no files were changed.',
);

export const authoritativeDynamicExpoConfigFile = (
  projectRoot: string,
  candidate: unknown,
): string | null => {
  if (candidate === undefined || candidate === null || candidate === '') return null;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error('Expo did not identify a usable authoritative dynamic app config path. No files changed.');
  }
  const absolutePath = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
  const relativePath = toPosix(path.relative(projectRoot, absolutePath));
  if (
    relativePath.startsWith('../') ||
    path.isAbsolute(relativePath) ||
    !/^app\.config\.(js|ts|cjs|mjs)$/.test(relativePath)
  ) {
    throw new Error(`Expo reported an unsafe dynamic app config path: ${candidate}. No files changed.`);
  }
  const configFile = inspectProjectFile(projectRoot, relativePath);
  if (!configFile.exists) {
    throw new Error(`Expo authoritative dynamic app config is missing: ${relativePath}. No files changed.`);
  }
  return relativePath;
};

const readSetupFile = (projectRoot: string, relativePath: string): AiSetupPlanFile | null => {
  let inspected;
  try {
    inspected = inspectProjectFile(projectRoot, relativePath);
  } catch {
    throw setupContextLimitError(relativePath, 'the path is not a regular project file');
  }
  if (!inspected.exists) return null;
  const sizeBytes = Buffer.byteLength(inspected.content, 'utf8');
  const summarized = isSummarizedSetupFile(relativePath);
  if (sizeBytes > (summarized ? MAX_SUMMARIZED_SOURCE_BYTES : MAX_FILE_BYTES)) {
    if (isRequiredPatchableSetupFile(relativePath)) {
      throw setupContextLimitError(relativePath, `it exceeds the ${MAX_FILE_BYTES}-byte per-file limit`);
    }
    return null;
  }
  const rawContent = inspected.content;
  const kind = setupFileKind(relativePath);
  if (!summarized) {
    assertSafeAiSetupContent(relativePath, rawContent);
  }
  const content = summarized
    ? summarizeContextContent(relativePath, rawContent, sizeBytes)
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
  dynamicExpoConfigFile: string | null,
): AiSetupPlanFile[] => {
  const relativePaths: string[] = [
    'package.json',
    ...SETUP_CONFIG_FILES.filter(relativePath =>
      projectType === 'expo'
        ? !relativePath.startsWith('app.config.') &&
          (relativePath !== 'app.json' || !dynamicExpoConfigFile)
        : relativePath !== 'app.json' && !relativePath.startsWith('app.config.')
    ),
  ];
  if (projectType === 'expo' && dynamicExpoConfigFile) {
    relativePaths.push(dynamicExpoConfigFile);
  }
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
  for (const relativePath of [...new Set(relativePaths)]) {
    const file = readSetupFile(projectRoot, relativePath);
    if (!file) continue;
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      if (isRequiredPatchableSetupFile(relativePath)) {
        throw setupContextLimitError(
          relativePath,
          `including it would exceed the ${MAX_TOTAL_BYTES}-byte total context limit`,
        );
      }
      continue;
    }
    totalBytes += bytes;
    files.push(file);
  }
  return files;
};

const readPackageSignals = (projectRoot: string) => {
  const packageFile = inspectProjectFile(projectRoot, 'package.json');
  const pkg = packageFile.exists ? JSON.parse(packageFile.content) : {};
  const dependencies = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.optionalDependencies || {}),
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
  const androidEntrypoints = nativeEntrypoints.filter(file => file.kind === 'android_entrypoint');
  const iosEntrypoints = nativeEntrypoints.filter(file => file.kind === 'ios_entrypoint');
  const hasAndroidDirectory = inspectProjectDirectory(projectRoot, 'android');
  const hasIosDirectory = inspectProjectDirectory(projectRoot, 'ios');
  const hasBareNativeIntegration =
    (hasAndroidDirectory || hasIosDirectory) &&
    (!hasAndroidDirectory || androidEntrypoints.length === 1) &&
    (!hasIosDirectory || iosEntrypoints.length === 1) &&
    nativeEntrypoints.every(file =>
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
    hasIosDirectory ? 'iosDirectory' : '',
    hasAndroidDirectory ? 'androidDirectory' : '',
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
    hasNativeDirectories: hasIosDirectory || hasAndroidDirectory,
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
  const configFile = inspectProjectFile(projectRoot, 'bundle.drop.config.js');
  if (!configFile.exists && !virtualConfig) {
    throw new Error('bundle.drop.config.js not found; run `bundle-drop init` first.');
  }

  const config = virtualConfig ? null : loadBundleDropConfig(configPath, configFile.content);
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

  if (projectType === 'expo') {
    for (const relativePath of ['package.json', 'app.json', ...SETUP_CONFIG_FILES.filter(
      file => file.startsWith('app.config.'),
    )]) {
      inspectProjectFile(projectRoot, relativePath);
    }
  }
  const expoEvaluation = projectType === 'expo' ? evaluateExpoConfig(projectRoot) : null;
  const dynamicExpoConfigFile = authoritativeDynamicExpoConfigFile(
    projectRoot,
    expoEvaluation?.dynamicConfigPath,
  );
  const hasDynamicExpoConfigCandidate = projectType === 'expo' &&
    SETUP_CONFIG_FILES.some(relativePath =>
      relativePath.startsWith('app.config.') && inspectProjectFile(projectRoot, relativePath).exists
    );
  if (hasDynamicExpoConfigCandidate && !dynamicExpoConfigFile) {
    throw new Error(
      'Expo config evaluation did not identify the authoritative dynamic app.config.* file. ' +
        'No context was shared and no files were changed.',
    );
  }
  const files = collectSetupFiles(projectRoot, projectType, dynamicExpoConfigFile);
  if (projectType === 'bare') {
    for (const platform of ['android', 'ios'] as const) {
      const kind = platform === 'android' ? 'android_entrypoint' : 'ios_entrypoint';
      const entrypoints = files.filter(file => file.kind === kind).map(file => file.path);
      if (entrypoints.length > 1) continue;
      const authorityIssue = findNativeEntrypointAuthorityIssue(
        projectRoot,
        platform,
        entrypoints,
      );
      if (authorityIssue) {
        throw new Error(
          `AI setup cannot prove the ${platform} application entrypoint: ${authorityIssue} ` +
            'Resolve native startup ownership manually, then retry. ' +
            'No context was shared and no files were changed.',
        );
      }
    }
  }
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
