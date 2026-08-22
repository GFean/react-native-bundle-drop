import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  hasBareAndroidStartupIntegration,
  hasBareIosStartupIntegration,
} from './native-setup-contract';

import {
  detectProjectType,
  evaluateExpoConfig,
  inspectExpoUpdatesOwnership,
  resolveBundleDropRuntimeVersionAuthority,
  resolveExpoBuildIdentity,
} from '../../expo';
import type { MobilePlatform, ProjectType } from '../../expo';
import {
  readExpoBuildIdentityReceipt,
  resolveExpoUploadIdentity,
} from './expo/build-receipt';
import { findProjectRoot } from './aipowered/scanner';
import { readGeneratedRuntimeDeliveryBootstrap } from '../../runtime-delivery/bootstrapConfig';
import { findNativeEntrypointAuthorityIssue } from './native-entrypoint-authority';
import {
  findSingleMetroConfig,
  hasAuthoritativeMetroWrapper,
  hasExecutableMetroModuleReference,
} from './metro-config-authority';
import { inspectProjectFile } from './safe-file-transaction';

const PACKAGE_NAME = '@gfean/react-native-bundle-drop';
const ANDROID_MARKER = 'com.bundledrop.EXPO_ENABLED';
const IOS_MARKER = 'BundleDropExpoEnabled';
const IOS_RECEIPT_PHASE = 'Bundle Drop: Write iOS build identity';

export type DoctorCheck = {
  name: string;
  status: 'pass' | 'warning' | 'error';
  message: string;
};

export type DoctorOptions = {
  platform?: MobilePlatform;
  projectType?: ProjectType;
  cwd?: string;
};

const pluginName = (plugin: unknown) =>
  typeof plugin === 'string'
    ? plugin
    : Array.isArray(plugin) && typeof plugin[0] === 'string'
      ? plugin[0]
      : null;

const checkExpoUpdates = (projectRoot: string, exp: Record<string, any>): DoctorCheck => {
  const ownership = inspectExpoUpdatesOwnership(projectRoot, exp);
  if (ownership.state === 'absent') {
    return { name: 'Expo Updates ownership', status: 'pass', message: 'expo-updates is absent.' };
  }
  if (ownership.state === 'disabled') {
    return {
      name: 'Expo Updates ownership',
      status: 'warning',
      message:
        'expo-updates is installed but disabled. Launch support requires generated-native and cold-start proof that it yields startup.',
    };
  }
  return {
    name: 'Expo Updates ownership',
    status: 'error',
    message: 'Active expo-updates can own startup. Migrate it and create a new native binary.',
  };
};

const findFiles = (
  directory: string,
  suffix: string,
  budget = { visitedEntries: 0 },
): string[] => {
  const files: string[] = [];
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      budget.visitedEntries += 1;
      if (budget.visitedEntries > 5000) {
        throw new Error('Native doctor source scan exceeded 5000 filesystem entries.');
      }
      if (entry.name === 'Pods' || entry.name === 'build') continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...findFiles(entryPath, suffix, budget));
      else if (entry.name.endsWith(suffix)) files.push(entryPath);
    }
  }
  return files;
};

const inspectMetroConfig = (projectRoot: string) => {
  try {
    const file = findSingleMetroConfig(projectRoot);
    return file
      ? { file, content: inspectProjectFile(projectRoot, file).content, issue: null }
      : { file: undefined, content: '', issue: 'No Metro config file was found.' };
  } catch (error) {
    return { file: undefined, content: '', issue: (error as Error).message };
  }
};

const runtimeDeliveryBootstrapGitState = (
  projectRoot: string,
): 'ignored' | 'tracked' | 'untracked' | null => {
  const relativePath = path.join('.bundle-drop', 'runtime-delivery.generated.json');
  const runGit = (args: string[]) => spawnSync('git', args, {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  const repository = runGit(['rev-parse', '--is-inside-work-tree']);
  if (repository.error || repository.status !== 0) return null;
  if (runGit(['check-ignore', '--no-index', '-q', '--', relativePath]).status === 0) {
    return 'ignored';
  }
  return runGit(['ls-files', '--error-unmatch', '--', relativePath]).status === 0
    ? 'tracked'
    : 'untracked';
};

const checkRuntimeDeliveryBootstrap = (projectRoot: string): DoctorCheck => {
  const configPath = path.join(projectRoot, 'bundle.drop.config.js');
  if (!fs.existsSync(configPath)) {
    return {
      name: 'Runtime delivery bootstrap',
      status: 'error',
      message: 'bundle.drop.config.js is required before runtime delivery can be validated.',
    };
  }
  try {
    delete require.cache[require.resolve(configPath)];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require(configPath) as {
      serverUrl?: string;
      org?: { slug?: string };
      project?: { slug?: string };
      runtimeDelivery?: unknown;
    };
    if (!config.serverUrl || !config.org?.slug || !config.project?.slug) {
      throw new Error('bundle.drop.config.js is missing serverUrl, org.slug, or project.slug.');
    }
    const bootstrap = readGeneratedRuntimeDeliveryBootstrap({
      projectRoot,
      expectedIdentity: {
        serverUrl: config.serverUrl,
        orgSlug: config.org.slug,
        projectSlug: config.project.slug,
      },
    });
    if (bootstrap) {
      const gitState = runtimeDeliveryBootstrapGitState(projectRoot);
      if (gitState === 'ignored') {
        return {
          name: 'Runtime delivery bootstrap',
          status: 'error',
          message:
            'The runtime delivery bootstrap is ignored by Git and will be missing from clean builds. ' +
            'Run `bundle-drop sync` to repair .gitignore.',
        };
      }
      if (gitState === 'untracked') {
        return {
          name: 'Runtime delivery bootstrap',
          status: 'warning',
          message:
            `Runtime delivery bootstrap is valid with ` +
            `${Object.keys(bootstrap.runtimeDelivery.publicKeys).length} public key(s), ` +
            'but it is not committed yet.',
        };
      }
      return {
        name: 'Runtime delivery bootstrap',
        status: 'pass',
        message: `Runtime delivery bootstrap is pinned with ${Object.keys(bootstrap.runtimeDelivery.publicKeys).length} public key(s).`,
      };
    }
    if (config.runtimeDelivery) {
      return {
        name: 'Runtime delivery bootstrap',
        status: 'warning',
        message:
          'Stale inline runtime delivery config is ignored. Remove runtimeDelivery from ' +
          'bundle.drop.config.js, migrate Metro with `bundle-drop init`, and use `bundle-drop sync` ' +
          'for package-managed trust.',
      };
    }
    return {
      name: 'Runtime delivery bootstrap',
      status: 'warning',
      message: 'No runtime delivery bootstrap is pinned. Run `bundle-drop sync` to create or repair it.',
    };
  } catch (error) {
    return {
      name: 'Runtime delivery bootstrap',
      status: 'error',
      message: `${(error as Error).message} Run \`bundle-drop sync\` to repair it.`,
    };
  }
};

const checkCommittedNativeIntegration = (
  projectRoot: string,
  platform: MobilePlatform,
): DoctorCheck | null => {
  if (platform === 'android') {
    const androidRoot = path.join(projectRoot, 'android');
    if (!fs.existsSync(androidRoot)) return null;
    const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
    const manifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
    const escapedMarker = ANDROID_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const valid = new RegExp(
      `<meta-data\\b(?=[^>]*android:name=["']${escapedMarker}["'])(?=[^>]*android:value=["']true["'])[^>]*>`,
    ).test(manifest);
    return {
      name: 'android generated native integration',
      status: valid ? 'pass' : 'error',
      message: valid
        ? 'Generated Android manifest enables the Bundle Drop Expo startup adapter.'
        : 'Generated Android native files are stale; run the previewed layered prebuild.',
    };
  }

  const iosRoot = path.join(projectRoot, 'ios');
  if (!fs.existsSync(iosRoot)) return null;
  const plistHasMarker = findFiles(iosRoot, '.plist').some(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.includes(`<key>${IOS_MARKER}</key>`) && /<true\s*\/>/.test(content);
  });
  const projectHasReceiptPhase = findFiles(iosRoot, 'project.pbxproj').some(filePath =>
    fs.readFileSync(filePath, 'utf8').includes(IOS_RECEIPT_PHASE),
  );
  const valid = plistHasMarker && projectHasReceiptPhase;
  return {
    name: 'ios generated native integration',
    status: valid ? 'pass' : 'error',
    message: valid
      ? 'Generated iOS marker and exact build-receipt phase are present.'
      : 'Generated iOS native files are stale; run the previewed layered prebuild.',
  };
};

async function inspectExpoProject(
  projectRoot: string,
  platforms: MobilePlatform[],
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(checkRuntimeDeliveryBootstrap(projectRoot));
  const { exp } = evaluateExpoConfig(projectRoot);
  const plugins = (exp.plugins || []).map(pluginName);
  const bundleDropPluginCount = plugins.filter(name => name === PACKAGE_NAME).length;
  checks.push({
    name: 'Expo config plugin',
    status: bundleDropPluginCount === 1 ? 'pass' : 'error',
    message: bundleDropPluginCount === 1
      ? 'Bundle Drop plugin is registered once in evaluated Expo config.'
      : `Bundle Drop plugin must be registered exactly once; found ${bundleDropPluginCount}.`,
  });
  try {
    const packageManifest = require.resolve(`${PACKAGE_NAME}/package.json`, {
      paths: [projectRoot],
    });
    const packageRoot = path.dirname(packageManifest);
    const moduleConfig = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'expo-module.config.json'), 'utf8'),
    );
    const valid =
      moduleConfig.apple?.podspecPath === 'BundleDropExpo.podspec' &&
      moduleConfig.android?.path === 'expo/android' &&
      fs.existsSync(path.join(packageRoot, 'react-native.config.js'));
    checks.push({
      name: 'Expo/native autolinking metadata',
      status: valid ? 'pass' : 'error',
      message: valid
        ? 'Expo adapter and bare core targets have isolated autolinking metadata.'
        : 'Packed Bundle Drop autolinking metadata is incomplete.',
    });
  } catch (error) {
    checks.push({
      name: 'Expo/native autolinking metadata',
      status: 'error',
      message: `Could not validate the installed Bundle Drop package: ${(error as Error).message}`,
    });
  }
  checks.push(checkExpoUpdates(projectRoot, exp));
  for (const platform of platforms) {
    const nativeCheck = checkCommittedNativeIntegration(projectRoot, platform);
    if (nativeCheck) checks.push(nativeCheck);
  }

  const metro = inspectMetroConfig(projectRoot);
  const hasExpoMetroWrapper = !metro.issue &&
    hasAuthoritativeMetroWrapper(metro.content, 'withBundleDropExpo') &&
    hasExecutableMetroModuleReference(metro.content, 'expo/metro-config');
  checks.push({
    name: 'Expo Metro wrapper',
    status: hasExpoMetroWrapper ? 'pass' : 'error',
    message: hasExpoMetroWrapper
      ? 'Existing Expo Metro configuration is preserved through withBundleDropExpo.'
      : metro.issue || 'Metro must export withBundleDropExpo(...) and preserve expo/metro-config.',
  });

  const runtimeAuthorities = new Map(
    platforms.map(platform => [
      platform,
      resolveBundleDropRuntimeVersionAuthority(projectRoot, platform),
    ]),
  );
  const usesExpoRuntimePolicies = [...runtimeAuthorities.values()]
    .some(authority => authority.source === 'expo');
  const identities = new Map<MobilePlatform, Awaited<ReturnType<typeof resolveExpoBuildIdentity>>>();
  for (const platform of platforms) {
    try {
      const identity = await resolveExpoBuildIdentity(projectRoot, platform);
      identities.set(platform, identity);
      checks.push({
        name: `${platform} build identity`,
        status: 'pass',
        message:
          `${runtimeAuthorities.get(platform)?.source === 'expo' ? 'Expo policy' : 'Bundle Drop literal'} ` +
          `resolved to ${identity.runtimeVersion}; ` +
          `${identity.javaScriptEngine}, Expo ${identity.expoSdkVersion}, RN ${identity.reactNativeVersion}.`,
      });
    } catch (error) {
      const awaitingRemoteNativeVersion = /remote EAS app versions/.test((error as Error).message);
      if (!awaitingRemoteNativeVersion) throw error;
      checks.push({
        name: `${platform} build identity`,
        status: 'warning',
        message:
          'nativeVersion is binary-backed and uses the exact packaged version. ' +
          'An authenticated EAS receipt or local release build is required before upload.',
      });
    }
  }

  if (!usesExpoRuntimePolicies) {
    checks.push({
      name: 'Runtime authority',
      status: 'pass',
      message:
        'Bundle Drop config owns runtime versions. Uploads do not require or compare Expo build receipts.',
    });
  } else {
    const receipt = readExpoBuildIdentityReceipt(projectRoot);
    if (!receipt) {
      checks.push({
        name: 'Native build receipt',
        status: 'warning',
        message: 'Expo runtime policies require a native build receipt before upload.',
      });
    }
    for (const platform of platforms) {
      if (!receipt) break;
      const builtIdentity = receipt.identities[platform];
      if (!builtIdentity) {
        checks.push({
          name: `${platform} build/upload parity`,
          status: 'warning',
          message: `No ${platform} identity exists in the current native build receipt.`,
        });
        continue;
      }
      let currentIdentity = identities.get(platform);
      let verificationError: Error | undefined;
      if (!currentIdentity || receipt.proofs[platform]?.evidence === 'eas-official-metadata') {
        try {
          currentIdentity = await resolveExpoUploadIdentity({ projectRoot, platform });
          identities.set(platform, currentIdentity);
        } catch (error) {
          verificationError = error as Error;
        }
      }
      const matches = !verificationError && Boolean(
        builtIdentity && currentIdentity &&
        builtIdentity.identityHash === currentIdentity.identityHash,
      );
      checks.push({
        name: `${platform} build/upload parity`,
        status: matches ? 'pass' : 'error',
        message: matches
          ? 'Current Expo identity matches the most recent native build receipt.'
          : verificationError
            ? `Could not verify the exact EAS build receipt: ${verificationError.message}`
            : 'Current Expo identity differs from the most recent native build receipt.',
      });
    }
  }

  checks.push({
    name: 'Expo Go',
    status: 'warning',
    message: 'Expo Go and standard Debug/development-client builds keep Bundle Drop OTA disabled; use a non-Debug/Release native build to test OTA behavior.',
  });
  return checks;
}

const checkBarePackageMetadata = (projectRoot: string): DoctorCheck => {
  try {
    const packageManifest = require.resolve(`${PACKAGE_NAME}/package.json`, {
      paths: [projectRoot],
    });
    const packageRoot = path.dirname(packageManifest);
    const reactNativeConfigPath = path.join(packageRoot, 'react-native.config.js');
    const reactNativeConfig = fs.existsSync(reactNativeConfigPath)
      ? fs.readFileSync(reactNativeConfigPath, 'utf8')
      : '';
    const valid =
      fs.existsSync(path.join(packageRoot, 'BundleDrop.podspec')) &&
      fs.existsSync(path.join(packageRoot, 'android')) &&
      reactNativeConfig.includes('BundleDropPackage');
    return {
      name: 'Bare/native autolinking metadata',
      status: valid ? 'pass' : 'error',
      message: valid
        ? 'The installed package exposes the BundleDrop pod and Android package to React Native autolinking.'
        : 'The installed Bundle Drop package has incomplete bare React Native autolinking metadata.',
    };
  } catch (error) {
    return {
      name: 'Bare/native autolinking metadata',
      status: 'error',
      message: `Could not validate the installed Bundle Drop package: ${(error as Error).message}`,
    };
  }
};

const checkBareRuntimeIdentity = (
  projectRoot: string,
  platform: MobilePlatform,
): DoctorCheck => {
  if (!fs.existsSync(path.join(projectRoot, 'bundle.drop.config.js'))) {
    return {
      name: `${platform} runtime identity`,
      status: 'error',
      message: `Cannot resolve runtimeVersion.${platform} without bundle.drop.config.js.`,
    };
  }
  try {
    const authority = resolveBundleDropRuntimeVersionAuthority(projectRoot, platform);
    if (authority.source === 'expo') {
      return {
        name: `${platform} runtime identity`,
        status: 'error',
        message: 'Bare projects require a literal Bundle Drop runtime version, not Expo runtime authority.',
      };
    }
    return {
      name: `${platform} runtime identity`,
      status: 'pass',
      message: `Bundle Drop literal resolved to ${authority.runtimeVersion}.`,
    };
  } catch (error) {
    return {
      name: `${platform} runtime identity`,
      status: 'error',
      message: (error as Error).message,
    };
  }
};

const checkBareStartupIntegration = (
  projectRoot: string,
  platform: MobilePlatform,
): DoctorCheck => {
  const nativeRoot = path.join(projectRoot, platform);
  const entrypointNames = platform === 'android'
    ? ['MainApplication.kt', 'MainApplication.java']
    : ['AppDelegate.swift', 'AppDelegate.mm', 'AppDelegate.m'];
  const entrypoints = entrypointNames.flatMap(name => findFiles(nativeRoot, name));
  const relativeEntrypoints = entrypoints.map(filePath =>
    path.relative(projectRoot, filePath).split(path.sep).join('/')
  );
  let authorityIssue: string | null = null;
  try {
    authorityIssue = findNativeEntrypointAuthorityIssue(
      projectRoot,
      platform,
      relativeEntrypoints,
    );
  } catch (error) {
    authorityIssue = (error as Error).message;
  }
  const hasIntegration = entrypoints.length === 1 && entrypoints.every(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    return platform === 'android'
      ? hasBareAndroidStartupIntegration(content)
      : hasBareIosStartupIntegration(filePath, content);
  }) && !authorityIssue;
  return {
    name: `${platform} OTA startup ownership`,
    status: hasIntegration ? 'pass' : 'error',
    message: entrypoints.length > 1
      ? `Multiple ${platform} application entrypoints were found; resolve startup ownership manually.`
      : authorityIssue
        ? `Native application entrypoint authority is ambiguous: ${authorityIssue}`
        : hasIntegration
        ? `The ${platform} application entrypoint asks Bundle Drop for the cold-start bundle.`
        : `The ${platform} application entrypoint does not hand cold-start bundle resolution to Bundle Drop.`,
  };
};

const checkBareNativeAutolinking = (
  projectRoot: string,
  platform: MobilePlatform,
): DoctorCheck => {
  if (platform === 'ios') {
    const podfileLock = path.join(projectRoot, 'ios', 'Podfile.lock');
    if (!fs.existsSync(podfileLock)) {
      return {
        name: 'ios native autolinking',
        status: 'warning',
        message: 'Podfile.lock does not exist yet; run pod install or build iOS to verify native linking.',
      };
    }
    const linked = fs.readFileSync(podfileLock, 'utf8').includes('BundleDrop');
    return {
      name: 'ios native autolinking',
      status: linked ? 'pass' : 'error',
      message: linked
        ? 'Podfile.lock includes the BundleDrop pod.'
        : 'Podfile.lock exists but does not include the BundleDrop pod; run pod install.',
    };
  }

  const candidates = [
    path.join(projectRoot, 'android', 'build', 'generated', 'autolinking', 'autolinking.json'),
    path.join(
      projectRoot,
      'android',
      'app',
      'build',
      'generated',
      'autolinking',
      'src',
      'main',
      'java',
      'com',
      'facebook',
      'react',
      'PackageList.java',
    ),
    path.join(
      projectRoot,
      'android',
      'app',
      'build',
      'generated',
      'rncli',
      'src',
      'main',
      'java',
      'com',
      'facebook',
      'react',
      'PackageList.java',
    ),
  ].filter(fs.existsSync);
  if (!candidates.length) {
    return {
      name: 'android native autolinking',
      status: 'warning',
      message: 'No generated Android autolinking output exists yet; build Android to verify native linking.',
    };
  }
  const linked = candidates.some(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.includes(PACKAGE_NAME) || content.includes('BundleDropPackage');
  });
  return {
    name: 'android native autolinking',
    status: linked ? 'pass' : 'error',
    message: linked
      ? 'Generated Android autolinking includes BundleDropPackage.'
      : 'Generated Android autolinking exists but does not include BundleDropPackage; rebuild Android.',
  };
};

function inspectBareProject(
  projectRoot: string,
  platforms: MobilePlatform[],
): DoctorCheck[] {
  const configPath = path.join(projectRoot, 'bundle.drop.config.js');
  const metro = inspectMetroConfig(projectRoot);
  const hasBareMetroWrapper = !metro.issue &&
    hasAuthoritativeMetroWrapper(metro.content, 'withBundleDrop');
  const checks: DoctorCheck[] = [
    {
      name: 'Bundle Drop config',
      status: fs.existsSync(configPath) ? 'pass' : 'error',
      message: fs.existsSync(configPath)
        ? 'bundle.drop.config.js exists.'
        : 'bundle.drop.config.js is missing.',
    },
    {
      name: 'Bare Metro alias',
      status: hasBareMetroWrapper ? 'pass' : 'error',
      message: hasBareMetroWrapper
        ? 'Metro uses the package-managed Bundle Drop wrapper.'
        : metro.issue || 'Metro must export withBundleDrop(...) so generated trust data is bundled.',
    },
    checkRuntimeDeliveryBootstrap(projectRoot),
    checkBarePackageMetadata(projectRoot),
  ];
  for (const platform of platforms) {
    checks.push(checkBareRuntimeIdentity(projectRoot, platform));
    checks.push(checkBareStartupIntegration(projectRoot, platform));
    checks.push(checkBareNativeAutolinking(projectRoot, platform));
  }
  return checks;
}

export async function inspectProject(options: DoctorOptions = {}): Promise<{
  projectRoot: string;
  projectType: ProjectType;
  checks: DoctorCheck[];
}> {
  const projectRoot = findProjectRoot(options.cwd || process.cwd());
  const projectType = detectProjectType({
    projectRoot,
    explicitType: options.projectType,
  });
  const platforms = options.platform ? [options.platform] : ['ios', 'android'] as MobilePlatform[];
  const checks = projectType === 'expo'
    ? await inspectExpoProject(projectRoot, platforms)
    : inspectBareProject(projectRoot, platforms);
  return { projectRoot, projectType, checks };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  const result = await inspectProject(options);
  console.log(chalk.cyan(`Bundle Drop doctor: ${result.projectType} project`));
  for (const check of result.checks) {
    const symbol = check.status === 'pass' ? '✅' : check.status === 'warning' ? '⚠️' : '❌';
    console.log(`${symbol} ${check.name}: ${check.message}`);
  }
  const errors = result.checks.filter(check => check.status === 'error');
  if (errors.length) {
    throw new Error(`Bundle Drop doctor found ${errors.length} blocking issue(s).`);
  }
}
