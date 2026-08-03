import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { setBundleDropProjectType } from '../../../expo/projectType';

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
  candidates.find(candidate => fs.existsSync(path.join(projectRoot, candidate)));

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
  const appJsonPath = path.join(params.projectRoot, 'app.json');

  if (!appConfigFile && fs.existsSync(appJsonPath)) {
    const original = fs.readFileSync(appJsonPath, 'utf8');
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

  const metroFile = findFirstExisting(params.projectRoot, [
    'metro.config.js',
    'metro.config.ts',
    'metro.config.cjs',
    'metro.config.mjs',
  ]);
  if (metroFile) {
    const original = fs.readFileSync(path.join(params.projectRoot, metroFile), 'utf8');
    if (!original.includes('withBundleDropExpo')) {
      changes.push({
        file: metroFile,
        original,
        updated: `${original.trimEnd()}${EXPO_METRO_WRAPPER}`,
        reason: 'Wrap the existing Expo Metro config without replacing expo/metro-config.',
      });
    }
  } else {
    changes.push({
      file: 'metro.config.js',
      original: null,
      updated: NEW_EXPO_METRO_CONFIG,
      reason: 'Create an Expo Metro config with the Bundle Drop wrapper.',
    });
  }

  const bundleConfigPath = path.join(params.projectRoot, 'bundle.drop.config.js');
  const bundleConfigExists = fs.existsSync(bundleConfigPath);
  const bundleConfig = bundleConfigExists
    ? fs.readFileSync(bundleConfigPath, 'utf8')
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
    const packagePath = path.join(params.projectRoot, 'package.json');
    const packageJson = fs.readFileSync(packagePath, 'utf8');
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

  const fingerprintIgnorePath = path.join(params.projectRoot, '.fingerprintignore');
  const fingerprintIgnore = fs.existsSync(fingerprintIgnorePath)
    ? fs.readFileSync(fingerprintIgnorePath, 'utf8')
    : '';
  if (
    EXPO_RUNTIME_SOURCE_PATTERN.test(updatedBundleConfig) &&
    !fingerprintIgnore.split(/\r?\n/).includes(TRANSIENT_GRADLE_KOTLIN_FINGERPRINT_PATTERN)
  ) {
    changes.push({
      file: '.fingerprintignore',
      original: fs.existsSync(fingerprintIgnorePath) ? fingerprintIgnore : null,
      updated:
        `${fingerprintIgnore.trimEnd()}${fingerprintIgnore.trim() ? '\n' : ''}` +
        `${TRANSIENT_GRADLE_KOTLIN_FINGERPRINT_PATTERN}\n`,
      reason: 'Exclude transient Gradle Kotlin compiler sessions from Expo runtime fingerprints.',
    });
  }

  const gitignorePath = path.join(params.projectRoot, '.gitignore');
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  if (!gitignore.split(/\r?\n/).includes('.bundle-drop/')) {
    changes.push({
      file: '.gitignore',
      original: fs.existsSync(gitignorePath) ? gitignore : null,
      updated: `${gitignore.trimEnd()}${gitignore.trim() ? '\n' : ''}.bundle-drop/\n`,
      reason: 'Ignore generated build identity and Metro configuration artifacts.',
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
    const targetPath = path.join(result.projectRoot, changed.file);
    const backupPath = path.join(result.backupDir, changed.file);
    if (changed.existed) {
      fs.copyFileSync(backupPath, targetPath);
    } else if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  }
  if (result.buildReceiptInvalidated) {
    const receiptFile = path.join('.bundle-drop', 'build-identity.json');
    const targetPath = path.join(result.projectRoot, receiptFile);
    const backupPath = path.join(result.backupDir, receiptFile);
    fs.ensureDirSync(path.dirname(targetPath));
    fs.copyFileSync(backupPath, targetPath);
  }
}

export function applyExpoConfigurationChanges(params: {
  projectRoot: string;
  changes: ExpoSetupFileChange[];
}): ExpoSetupApplyResult {
  const result: ExpoSetupApplyResult = {
    projectRoot: params.projectRoot,
    backupDir: path.join(
      params.projectRoot,
      '.bundledrop-backup',
      new Date().toISOString().replace(/[:.]/g, '-'),
    ),
    changedFiles: [],
    buildReceiptInvalidated: false,
  };

  try {
    const receiptFile = path.join('.bundle-drop', 'build-identity.json');
    const receiptPath = path.join(params.projectRoot, receiptFile);
    if (fs.existsSync(receiptPath)) {
      const backupPath = path.join(result.backupDir, receiptFile);
      fs.ensureDirSync(path.dirname(backupPath));
      fs.copyFileSync(receiptPath, backupPath);
      fs.unlinkSync(receiptPath);
      result.buildReceiptInvalidated = true;
    }
    for (const change of params.changes) {
      assertSetupPathAllowed(change.file);
      const targetPath = path.join(params.projectRoot, change.file);
      const exists = fs.existsSync(targetPath);
      if (exists !== (change.original !== null)) {
        throw new Error(`File existence changed since Expo setup preview: ${change.file}`);
      }
      if (exists) {
        const current = fs.readFileSync(targetPath, 'utf8');
        if (sha256(current) !== sha256(change.original || '')) {
          throw new Error(`File changed since Expo setup preview: ${change.file}`);
        }
        const backupPath = path.join(result.backupDir, change.file);
        fs.ensureDirSync(path.dirname(backupPath));
        fs.copyFileSync(targetPath, backupPath);
      }
      result.changedFiles.push({ file: change.file, existed: exists });
      fs.ensureDirSync(path.dirname(targetPath));
      const temporaryPath = `${targetPath}.bundledrop-tmp`;
      fs.writeFileSync(temporaryPath, change.updated, 'utf8');
      fs.renameSync(temporaryPath, targetPath);
    }
    return result;
  } catch (error) {
    restoreExpoConfiguration(result);
    throw error;
  }
}
