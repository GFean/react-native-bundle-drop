import path from 'path';
import { ExpoIntegrationError } from './errors';
import { loadExpoDependency } from './localModules';
import { clearDynamicExpoConfigCache } from './configCache';

export type EvaluatedExpoConfig = {
  exp: Record<string, any>;
  pkg: Record<string, any>;
  dynamicConfigPath?: string | null;
  staticConfigPath?: string | null;
};

type ExpoConfigModule = {
  getConfig: (
    projectRoot: string,
    options: { skipSDKVersionRequirement: boolean; isPublicConfig: boolean },
  ) => EvaluatedExpoConfig;
};

export function evaluateExpoConfig(projectRoot: string): EvaluatedExpoConfig {
  const absoluteProjectRoot = path.resolve(projectRoot);
  clearDynamicExpoConfigCache(absoluteProjectRoot);
  let configModule: ExpoConfigModule;
  try {
    configModule = loadExpoDependency<ExpoConfigModule>(absoluteProjectRoot, '@expo/config');
  } catch (error) {
    throw new ExpoIntegrationError(
      `Expo is installed in ${absoluteProjectRoot}, but its project-local @expo/config API is unavailable.`,
      { cause: error },
    );
  }

  if (typeof configModule.getConfig !== 'function') {
    throw new ExpoIntegrationError('The project-local @expo/config package does not export getConfig().');
  }

  try {
    const evaluated = configModule.getConfig(absoluteProjectRoot, {
      skipSDKVersionRequirement: true,
      isPublicConfig: false,
    });
    if (!evaluated || typeof evaluated.exp !== 'object' || evaluated.exp === null) {
      throw new ExpoIntegrationError('The evaluated Expo config did not contain an Expo config object.');
    }
    if (!evaluated.pkg || typeof evaluated.pkg !== 'object') {
      throw new ExpoIntegrationError('The evaluated Expo config did not contain the project package.json.');
    }
    return evaluated;
  } catch (error) {
    if (error instanceof ExpoIntegrationError) {
      throw error;
    }
    throw new ExpoIntegrationError(
      `Expo config evaluation failed for ${absoluteProjectRoot}. Fix the config before Bundle Drop setup continues.`,
      { cause: error },
    );
  }
}
