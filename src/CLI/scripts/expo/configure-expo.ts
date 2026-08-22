import crypto from 'crypto';
import path from 'path';
import { setBundleDropProjectType } from '../../../expo/projectType';
import { addRuntimeDeliveryBootstrapGitignoreRules } from '../../../runtime-delivery/bootstrapConfig';
import {
  createSafeBackupDirectory,
  inspectProjectFile,
  removeProjectFile,
  restoreProjectFile,
  writeBackupFile,
  writeProjectFileAtomically,
} from '../safe-file-transaction';
import {
  assertCommonJsMetroConfig,
  findSingleMetroConfig,
  hasAuthoritativeMetroWrapper,
  hasExecutableMetroWrapperReference,
  newCommonJsMetroConfigFile,
} from '../metro-config-authority';

export { setBundleDropProjectType } from '../../../expo/projectType';

const PACKAGE_NAME = '@gfean/react-native-bundle-drop';
const EXPO_UPDATES = 'expo-updates';
const TRANSIENT_GRADLE_KOTLIN_FINGERPRINT_PATTERN = '**/*-gradle-plugin/.kotlin/**/*';
const EXPO_RUNTIME_SOURCE_PATTERN =
  /runtimeVersion\s*:\s*\{\s*source\s*:\s*['"]expo['"]\s*\}/;

export type ExpoSetupFileChange = {
  file: string;
  original: string | null;
  updated: string;
  reason: string;
};

export type ExpoSetupApplyResult = {
  projectRoot: string;
  backupDir: string;
  changedFiles: Array<{ file: string; existed: boolean }>;
  buildReceiptInvalidated: boolean;
};

const sha256 = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

const configPluginName = (plugin: unknown): string | null => {
  if (typeof plugin === 'string') return plugin;
  if (Array.isArray(plugin) && typeof plugin[0] === 'string') return plugin[0];
  return null;
};

const updateAppJson = (content: string, migrateExpoUpdates: boolean): string => {
  const parsed = JSON.parse(content) as Record<string, any>;
  const expo = parsed.expo && typeof parsed.expo === 'object' ? parsed.expo : parsed;
  const existingPlugins = Array.isArray(expo.plugins) ? expo.plugins : [];
  const plugins = existingPlugins.filter((plugin: unknown) => {
    const name = configPluginName(plugin);
    return name !== PACKAGE_NAME && (!migrateExpoUpdates || name !== EXPO_UPDATES);
  });
  expo.plugins = [...plugins, PACKAGE_NAME];

  if (migrateExpoUpdates && expo.updates && typeof expo.updates === 'object') {
    const { url: _url, enabled: _enabled, ...remainingUpdates } = expo.updates;
    if (Object.keys(remainingUpdates).length) expo.updates = remainingUpdates;
    else delete expo.updates;
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
};

const updatePackageJson = (content: string): string => {
  const parsed = JSON.parse(content) as Record<string, any>;
  for (const dependencyGroup of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    if (parsed[dependencyGroup] && typeof parsed[dependencyGroup] === 'object') {
      delete parsed[dependencyGroup][EXPO_UPDATES];
    }
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
};

const EXPO_METRO_WRAPPER = `

// Bundle Drop: preserve Expo Metro configuration and embed concrete runtime identity.
const { withBundleDropExpo } = require('@gfean/react-native-bundle-drop/metro');
module.exports = withBundleDropExpo(module.exports, { projectRoot: __dirname });
`;

const NEW_EXPO_METRO_CONFIG = `const { getDefaultConfig } = require('expo/metro-config');
const { withBundleDropExpo } = require('@gfean/react-native-bundle-drop/metro');

module.exports = withBundleDropExpo(getDefaultConfig(__dirname), {
  projectRoot: __dirname,
});
`;

const updateBundleDropConfig = (content: string): string => {
  return setBundleDropProjectType(content, 'expo');
};

const findFirstExisting = (projectRoot: string, candidates: string[]) =>
  candidates.find(candidate => inspectProjectFile(projectRoot, candidate).exists);

export function planExpoProjectConfiguration(params: {
  projectRoot: string;
  migrateExpoUpdates: boolean;
  bundleConfigContent?: string;
}): ExpoSetupFileChange[] {
  const changes: ExpoSetupFileChange[] = [];
  const appConfigFile = findFirstExisting(params.projectRoot, [
    'app.config.js',
    'app.config.ts',
    'app.config.cjs',
    'app.config.mjs',
  ]);
  const appJson = inspectProjectFile(params.projectRoot, 'app.json');

  if (!appConfigFile && appJson.exists) {
    const original = appJson.content;
    const updated = updateAppJson(original, params.migrateExpoUpdates);
    if (updated !== original) {
      changes.push({
        file: 'app.json',
        original,
        updated,
        reason: 'Register the Bundle Drop Expo plugin while preserving the existing app config.',
      });
    }
  }

  const metroFile = findSingleMetroConfig(params.projectRoot);
  if (metroFile) {
    const original = inspectProjectFile(params.projectRoot, metroFile).content;
    if (!hasAuthoritativeMetroWrapper(original, 'withBundleDropExpo')) {
      if (hasExecutableMetroWrapperReference(original, 'withBundleDropExpo')) {
        throw new Error(
          `${metroFile} contains a non-authoritative withBundleDropExpo reference. ` +
            'Remove the dead, aliased, or malformed wrapper before rerunning setup.',
        );
      }
      assertCommonJsMetroConfig(params.projectRoot, metroFile);
      changes.push({
        file: metroFile,
        original,
        updated: `${original.trimEnd()}${EXPO_METRO_WRAPPER}`,
        reason: 'Wrap the existing Expo Metro config without replacing expo/metro-config.',
      });
    }
  } else {
    const newMetroFile = newCommonJsMetroConfigFile(params.projectRoot);
    changes.push({
      file: newMetroFile,
      original: null,
      updated: NEW_EXPO_METRO_CONFIG,
      reason: 'Create an Expo Metro config with the Bundle Drop wrapper.',
    });
  }

  const bundleConfigFile = inspectProjectFile(params.projectRoot, 'bundle.drop.config.js');
  const bundleConfigExists = bundleConfigFile.exists;
  const bundleConfig = bundleConfigExists
    ? bundleConfigFile.content
    : params.bundleConfigContent;
  if (!bundleConfig) {
    throw new Error('bundle.drop.config.js is required before Expo configuration can be planned.');
  }
  const updatedBundleConfig = updateBundleDropConfig(bundleConfig);
  if (!bundleConfigExists || updatedBundleConfig !== bundleConfig) {
    changes.push({
      file: 'bundle.drop.config.js',
      original: bundleConfigExists ? bundleConfig : null,
      updated: updatedBundleConfig,
      reason: 'Persist the Expo project type while preserving Bundle Drop runtime authority.',
    });
  }

  if (params.migrateExpoUpdates) {
    const packageFile = inspectProjectFile(params.projectRoot, 'package.json');
    if (!packageFile.exists) throw new Error('package.json is required for expo-updates migration.');
    const packageJson = packageFile.content;
    const updatedPackageJson = updatePackageJson(packageJson);
    if (updatedPackageJson !== packageJson) {
      changes.push({
        file: 'package.json',
        original: packageJson,
        updated: updatedPackageJson,
        reason: 'Remove the direct expo-updates dependency after explicit migration approval.',
      });
    }
  }

  const fingerprintIgnoreFile = inspectProjectFile(params.projectRoot, '.fingerprintignore');
  const fingerprintIgnore = fingerprintIgnoreFile.exists ? fingerprintIgnoreFile.content : '';
  if (
    EXPO_RUNTIME_SOURCE_PATTERN.test(updatedBundleConfig) &&
    !fingerprintIgnore.split(/\r?\n/).includes(TRANSIENT_GRADLE_KOTLIN_FINGERPRINT_PATTERN)
  ) {
    changes.push({
      file: '.fingerprintignore',
      original: fingerprintIgnoreFile.exists ? fingerprintIgnore : null,
      updated:
        `${fingerprintIgnore.trimEnd()}${fingerprintIgnore.trim() ? '\n' : ''}` +
        `${TRANSIENT_GRADLE_KOTLIN_FINGERPRINT_PATTERN}\n`,
      reason: 'Exclude transient Gradle Kotlin compiler sessions from Expo runtime fingerprints.',
    });
  }

  const gitignoreFile = inspectProjectFile(params.projectRoot, '.gitignore');
  const gitignore = gitignoreFile.exists ? gitignoreFile.content : '';
  const updatedGitignore = addRuntimeDeliveryBootstrapGitignoreRules(gitignore);
  if (updatedGitignore !== gitignore) {
    changes.push({
      file: '.gitignore',
      original: gitignoreFile.exists ? gitignore : null,
      updated: updatedGitignore,
      reason: 'Commit the public trust bootstrap while ignoring generated runtime artifacts.',
    });
  }

  return changes;
}

export function setupChangeHash(change: ExpoSetupFileChange): string {
  return sha256(change.original || '');
}

export function hasDynamicExpoConfig(projectRoot: string): boolean {
  return Boolean(findFirstExisting(projectRoot, [
    'app.config.js',
    'app.config.ts',
    'app.config.cjs',
    'app.config.mjs',
  ]));
}

const assertSetupPathAllowed = (file: string) => {
  const allowed =
    file === 'package.json' ||
    file === '.fingerprintignore' ||
    file === '.gitignore' ||
    file === '.bundle-drop/runtime-delivery.generated.json' ||
    file === 'bundle.drop.config.js' ||
    file === 'app.json' ||
    /^app\.config\.(js|ts|cjs|mjs)$/.test(file) ||
    /^metro\.config\.(js|ts|cjs|mjs)$/.test(file);
  if (!allowed || path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) {
    throw new Error(`Refusing to modify a file outside the Expo setup allowlist: ${file}`);
  }
};

export function restoreExpoConfiguration(result: ExpoSetupApplyResult) {
  for (const changed of [...result.changedFiles].reverse()) {
    if (changed.existed) {
      restoreProjectFile(result.projectRoot, result.backupDir, changed.file);
    } else {
      removeProjectFile(result.projectRoot, changed.file);
    }
  }
  if (result.buildReceiptInvalidated) {
    const receiptFile = path.join('.bundle-drop', 'build-identity.json');
    restoreProjectFile(result.projectRoot, result.backupDir, receiptFile);
  }
}

export function applyExpoConfigurationChanges(params: {
  projectRoot: string;
  changes: ExpoSetupFileChange[];
}): ExpoSetupApplyResult {
  const result: ExpoSetupApplyResult = {
    projectRoot: params.projectRoot,
    backupDir: createSafeBackupDirectory(params.projectRoot, 'expo-setup'),
    changedFiles: [],
    buildReceiptInvalidated: false,
  };

  try {
    const receiptFile = path.join('.bundle-drop', 'build-identity.json');
    const receipt = inspectProjectFile(params.projectRoot, receiptFile);
    if (receipt.exists) {
      writeBackupFile(
        result.backupDir,
        receiptFile,
        receipt.content,
        receipt.mode,
      );
      removeProjectFile(params.projectRoot, receiptFile);
      result.buildReceiptInvalidated = true;
    }
    for (const change of params.changes) {
      assertSetupPathAllowed(change.file);
      const target = inspectProjectFile(params.projectRoot, change.file);
      if (target.exists !== (change.original !== null)) {
        throw new Error(`File existence changed since Expo setup preview: ${change.file}`);
      }
      if (target.exists) {
        if (sha256(target.content) !== sha256(change.original || '')) {
          throw new Error(`File changed since Expo setup preview: ${change.file}`);
        }
        writeBackupFile(
          result.backupDir,
          change.file,
          target.content,
          target.mode,
        );
      }
      result.changedFiles.push({ file: change.file, existed: target.exists });
      writeProjectFileAtomically(
        params.projectRoot,
        change.file,
        change.updated,
        target.mode,
      );
    }
    return result;
  } catch (error) {
    restoreExpoConfiguration(result);
    throw error;
  }
}
