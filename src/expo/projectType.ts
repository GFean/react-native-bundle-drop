import fs from 'fs';
import path from 'path';
import { evaluateExpoConfig } from './config';
import { ExpoIntegrationError } from './errors';
import { resolveProjectModule } from './localModules';
import type { ProjectType } from './types';

const BUNDLE_DROP_PACKAGE_NAME = '@gfean/react-native-bundle-drop';
const EXPO_RUNTIME_SOURCE_PATTERN =
  /runtimeVersion\s*:\s*\{\s*source\s*:\s*['"]expo['"]\s*\}/;
const RUNTIME_VERSION_BLOCK_PATTERN = /runtimeVersion\s*:\s*\{([\s\S]*?)\}/;
const IOS_LITERAL_RUNTIME_PATTERN = /(?:^|[,\s])['"]?ios['"]?\s*:\s*['"`][^'"`\r\n]+['"`]/;
const ANDROID_LITERAL_RUNTIME_PATTERN =
  /(?:^|[,\s])['"]?android['"]?\s*:\s*['"`][^'"`\r\n]+['"`]/;
const PROJECT_TYPE_MARKER_PATTERN =
  /(?:^|[,{])\s*projectType\s*:\s*['"]([^'"]+)['"]/g;

export type DetectProjectTypeOptions = {
  projectRoot: string;
  explicitType?: ProjectType;
};

const isProjectType = (value: unknown): value is ProjectType =>
  value === 'bare' || value === 'expo';

function canResolve(projectRoot: string, moduleId: string): boolean {
  try {
    resolveProjectModule(projectRoot, moduleId);
    return true;
  } catch {
    return false;
  }
}

function declaresDependency(projectRoot: string, dependencyName: string): boolean {
  const manifestPath = path.join(projectRoot, 'package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    const declaresRegularDependency = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ].some(dependencyGroup => typeof manifest[dependencyGroup]?.[dependencyName] === 'string');
    const declaresRequiredPeer =
      typeof manifest.peerDependencies?.[dependencyName] === 'string' &&
      manifest.peerDependenciesMeta?.[dependencyName]?.optional !== true;
    return declaresRegularDependency || declaresRequiredPeer;
  } catch {
    return false;
  }
}

function isBundleDropExpoPlugin(plugin: unknown): boolean {
  if (typeof plugin === 'string') {
    return plugin === BUNDLE_DROP_PACKAGE_NAME;
  }
  return Array.isArray(plugin) && plugin[0] === BUNDLE_DROP_PACKAGE_NAME;
}

type BundleDropRuntimeSignals = {
  bare: boolean;
  expo: boolean;
  persistedProjectType: ProjectType | null;
};

function readBundleDropRuntimeSignals(projectRoot: string): BundleDropRuntimeSignals {
  const configPath = path.join(projectRoot, 'bundle.drop.config.js');
  try {
    const config = fs.readFileSync(configPath, 'utf8');
    const runtimeBlock = config.match(RUNTIME_VERSION_BLOCK_PATTERN)?.[1] ?? '';
    const persistedProjectTypes = [...config.matchAll(PROJECT_TYPE_MARKER_PATTERN)]
      .map(match => match[1]);
    if (persistedProjectTypes.length > 1) {
      throw new ExpoIntegrationError(
        'bundle.drop.config.js contains multiple projectType markers. Keep exactly one marker.',
      );
    }
    const persistedProjectTypeValue = persistedProjectTypes[0] ?? null;
    if (persistedProjectTypeValue !== null && !isProjectType(persistedProjectTypeValue)) {
      throw new ExpoIntegrationError(
        `Unsupported bundle.drop.config.js projectType marker: ${persistedProjectTypeValue}.`,
      );
    }
    const persistedProjectType = isProjectType(persistedProjectTypeValue)
      ? persistedProjectTypeValue
      : null;
    return {
      bare:
        IOS_LITERAL_RUNTIME_PATTERN.test(runtimeBlock) &&
        ANDROID_LITERAL_RUNTIME_PATTERN.test(runtimeBlock),
      expo: EXPO_RUNTIME_SOURCE_PATTERN.test(config),
      persistedProjectType,
    };
  } catch (error) {
    if (error instanceof ExpoIntegrationError) throw error;
    return { bare: false, expo: false, persistedProjectType: null };
  }
}

export function setBundleDropProjectType(content: string, projectType: ProjectType): string {
  const markerMatches = [...content.matchAll(PROJECT_TYPE_MARKER_PATTERN)];
  if (markerMatches.length > 1) {
    throw new ExpoIntegrationError(
      'bundle.drop.config.js contains multiple projectType markers. Keep exactly one marker.',
    );
  }
  if (markerMatches.length === 1) {
    const currentType = markerMatches[0][1];
    if (currentType !== 'bare' && currentType !== 'expo') {
      throw new ExpoIntegrationError(
        `Unsupported bundle.drop.config.js projectType marker: ${currentType}.`,
      );
    }
    if (currentType === projectType) return content;
    return content.replace(
      /(projectType\s*:\s*)['"](?:bare|expo)['"]/,
      `$1'${projectType}'`,
    );
  }

  const moduleExportsOpening = /module\.exports\s*=\s*\{/;
  if (!moduleExportsOpening.test(content)) {
    throw new ExpoIntegrationError(
      'Could not safely persist projectType in bundle.drop.config.js. ' +
        'Restore a standard CommonJS Bundle Drop config shape and run init again.',
    );
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return content.replace(
    moduleExportsOpening,
    opening => `${opening}${newline}  projectType: '${projectType}',`,
  );
}

function hasExplicitStaticExpoConfig(staticConfigPath: unknown): boolean {
  if (typeof staticConfigPath !== 'string' || !staticConfigPath.trim()) {
    return false;
  }
  try {
    const staticConfig = JSON.parse(fs.readFileSync(staticConfigPath, 'utf8')) as Record<
      string,
      unknown
    >;
    return typeof staticConfig.expo === 'object' && staticConfig.expo !== null;
  } catch {
    return false;
  }
}

function hasExplicitExpoProjectSignal(
  evaluatedConfig: ReturnType<typeof evaluateExpoConfig>,
  hasExpoRuntimeSource: boolean,
): boolean {
  const hasDynamicExpoConfig =
    typeof evaluatedConfig.dynamicConfigPath === 'string' &&
    evaluatedConfig.dynamicConfigPath.trim().length > 0;
  const hasStaticExpoConfig = hasExplicitStaticExpoConfig(evaluatedConfig.staticConfigPath);
  const hasBundleDropPlugin = Array.isArray(evaluatedConfig.exp.plugins) &&
    evaluatedConfig.exp.plugins.some(isBundleDropExpoPlugin);

  return hasDynamicExpoConfig || hasStaticExpoConfig || hasBundleDropPlugin ||
    hasExpoRuntimeSource;
}

export function detectProjectType({
  projectRoot,
  explicitType,
}: DetectProjectTypeOptions): ProjectType {
  const absoluteProjectRoot = path.resolve(projectRoot);
  if (explicitType !== undefined) {
    if (explicitType !== 'expo' && explicitType !== 'bare') {
      throw new ExpoIntegrationError(`Unsupported explicit project type: ${String(explicitType)}.`);
    }

    if (explicitType === 'expo') {
      if (!canResolve(absoluteProjectRoot, 'expo/package.json')) {
        throw new ExpoIntegrationError(
          'The explicit Expo project type requires a project-local Expo installation.',
        );
      }
      try {
        evaluateExpoConfig(absoluteProjectRoot);
      } catch (error) {
        throw new ExpoIntegrationError(
          'The explicit Expo project type requires an Expo config that can be evaluated.',
          { cause: error },
        );
      }
      return 'expo';
    }

    if (!canResolve(absoluteProjectRoot, 'react-native/package.json')) {
      throw new ExpoIntegrationError(
        'The explicit bare project type requires a project-local React Native installation.',
      );
    }
    return explicitType;
  }

  const runtimeSignals = readBundleDropRuntimeSignals(absoluteProjectRoot);
  if (runtimeSignals.persistedProjectType === 'bare') {
    if (!canResolve(absoluteProjectRoot, 'react-native/package.json')) {
      throw new ExpoIntegrationError(
        'The persisted bare project type requires a project-local React Native installation.',
      );
    }
    return 'bare';
  }
  if (runtimeSignals.persistedProjectType === 'expo') {
    if (!canResolve(absoluteProjectRoot, 'expo/package.json')) {
      throw new ExpoIntegrationError(
        'The persisted Expo project type requires a project-local Expo installation.',
      );
    }
    try {
      evaluateExpoConfig(absoluteProjectRoot);
    } catch (error) {
      throw new ExpoIntegrationError(
        'The persisted Expo project type requires an Expo config that can be evaluated.',
        { cause: error },
      );
    }
    return 'expo';
  }

  if (canResolve(absoluteProjectRoot, 'expo/package.json')) {
    let evaluatedConfig: ReturnType<typeof evaluateExpoConfig>;
    try {
      evaluatedConfig = evaluateExpoConfig(absoluteProjectRoot);
    } catch (error) {
      throw new ExpoIntegrationError(
        'Expo is resolvable, but its app config cannot be evaluated. ' +
          'Bundle Drop will not guess that this is a bare project.',
        { cause: error },
      );
    }
    const hasExpoSignal = hasExplicitExpoProjectSignal(
      evaluatedConfig,
      runtimeSignals.expo,
    );
    if (hasExpoSignal && runtimeSignals.bare) {
      throw new ExpoIntegrationError(
        'The project has conflicting Expo and bare Bundle Drop configuration signals. ' +
          'Pass --project-type expo or --project-type bare explicitly after reviewing the config.',
      );
    }
    if (hasExpoSignal) {
      return 'expo';
    }
    if (runtimeSignals.bare) {
      return 'bare';
    }
    throw new ExpoIntegrationError(
      'Expo is resolvable, but the project has no explicit Expo app config, Bundle Drop Expo ' +
        'plugin, or Expo runtime source. This is ambiguous because bare React Native apps may ' +
        'install Expo modules. Pass --project-type expo or --project-type bare explicitly.',
    );
  }

  if (declaresDependency(absoluteProjectRoot, 'expo')) {
    throw new ExpoIntegrationError(
      'package.json declares Expo, but the project-local Expo package is not resolvable. ' +
        'Install dependencies before Bundle Drop decides how to configure the project.',
    );
  }

  if (canResolve(absoluteProjectRoot, 'react-native/package.json')) {
    return 'bare';
  }

  throw new ExpoIntegrationError(
    'Could not determine the project type. Neither a usable Expo installation nor React Native was resolvable. ' +
      'Install project dependencies or pass --project-type explicitly.',
  );
}
