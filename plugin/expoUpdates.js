'use strict';

const fs = require('fs');
const path = require('path');

const EXPO_UPDATES_PACKAGE = 'expo-updates';
const EXPO_UPDATES_DISABLED_WARNING =
  'Bundle Drop: expo-updates is installed but explicitly disabled. ' +
  'Launch support still requires generated-native and cold-start proof that expo-updates yields startup.';

function getProjectRoot(config) {
  return config?._internal?.projectRoot || process.cwd();
}

function getPluginName(plugin) {
  if (typeof plugin === 'string') {
    return plugin;
  }

  if (Array.isArray(plugin) && typeof plugin[0] === 'string') {
    return plugin[0];
  }

  return null;
}

function configReferencesExpoUpdates(config) {
  return (config.plugins || []).some(
    (plugin) => getPluginName(plugin) === EXPO_UPDATES_PACKAGE,
  );
}

function packageJsonReferencesExpoUpdates(projectRoot) {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    );

    return [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.optionalDependencies,
      packageJson.peerDependencies,
    ].some((dependencies) => Boolean(dependencies?.[EXPO_UPDATES_PACKAGE]));
  } catch {
    return false;
  }
}

function canResolveExpoUpdates(projectRoot) {
  try {
    const packagePath = require.resolve(`${EXPO_UPDATES_PACKAGE}/package.json`, {
      paths: [projectRoot],
    });
    return fs.existsSync(packagePath);
  } catch {
    try {
      const modulePath = require.resolve(EXPO_UPDATES_PACKAGE, { paths: [projectRoot] });
      return fs.existsSync(modulePath);
    } catch {
      return false;
    }
  }
}

function getExpoUpdatesState(config, options = {}) {
  return getExpoUpdatesOwnership(config, options).state;
}

function getExpoUpdatesOwnership(config, options = {}) {
  const projectRoot = options.projectRoot || getProjectRoot(config);
  const packageIsInstalled = options.packageIsInstalled ?? canResolveExpoUpdates(projectRoot);
  const packageIsDeclared = packageJsonReferencesExpoUpdates(projectRoot);
  const pluginIsDeclared = configReferencesExpoUpdates(config);
  const updatesConfig = config.updates || {};
  const hasUpdatesUrl = typeof updatesConfig.url === 'string';
  const explicitlyEnabled = updatesConfig.enabled === true;
  const explicitlyDisabled = updatesConfig.enabled === false;
  const isPresent =
    packageIsInstalled || packageIsDeclared || pluginIsDeclared || hasUpdatesUrl || explicitlyEnabled;

  if (!isPresent) {
    return {
      state: 'absent',
      packageIsInstalled,
      packageIsDeclared,
      pluginIsDeclared,
      hasUpdatesUrl,
      explicitlyEnabled,
      explicitlyDisabled,
    };
  }

  return {
    state: explicitlyDisabled ? 'disabled' : 'active',
    packageIsInstalled,
    packageIsDeclared,
    pluginIsDeclared,
    hasUpdatesUrl,
    explicitlyEnabled,
    explicitlyDisabled,
  };
}

function assertExpoUpdatesDoesNotOwnStartup(config, options = {}) {
  const state = getExpoUpdatesState(config, options);

  if (state === 'active') {
    throw new Error(
      'Bundle Drop cannot be enabled while expo-updates is active. ' +
        'Disable or migrate expo-updates, create a new native build, and run setup again. ' +
        'Bundle Drop will never disable expo-updates silently.',
    );
  }

  if (state === 'disabled' && options.warn !== false) {
    console.warn(EXPO_UPDATES_DISABLED_WARNING);
  }

  return config;
}

module.exports = {
  EXPO_UPDATES_DISABLED_WARNING,
  assertExpoUpdatesDoesNotOwnStartup,
  configReferencesExpoUpdates,
  getExpoUpdatesOwnership,
  getExpoUpdatesState,
  getPluginName,
  packageJsonReferencesExpoUpdates,
};
