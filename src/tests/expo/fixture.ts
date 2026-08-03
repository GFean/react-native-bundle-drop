import fs from 'fs';
import os from 'os';
import path from 'path';

export type ExpoFixtureOptions = {
  expoVersion?: string;
  reactNativeVersion?: string;
  config?: Record<string, unknown>;
  omitExpoConfig?: boolean;
  bundleDropRuntimeVersion?:
    | { ios: string; android: string }
    | { source: 'expo' };
};

function writeModule(projectRoot: string, moduleId: string, source: string): void {
  const moduleDirectory = path.join(projectRoot, 'node_modules', ...moduleId.split('/'));
  fs.mkdirSync(moduleDirectory, { recursive: true });
  fs.writeFileSync(path.join(moduleDirectory, 'index.js'), source);
  fs.writeFileSync(
    path.join(moduleDirectory, 'package.json'),
    JSON.stringify({ name: moduleId, main: 'index.js', version: '1.0.0' }),
  );
}

function writeNestedExpoModule(projectRoot: string, moduleId: string, source: string): void {
  const moduleDirectory = path.join(
    projectRoot,
    'node_modules',
    'expo',
    'node_modules',
    ...moduleId.split('/'),
  );
  fs.mkdirSync(moduleDirectory, { recursive: true });
  fs.writeFileSync(path.join(moduleDirectory, 'index.js'), source);
  fs.writeFileSync(
    path.join(moduleDirectory, 'package.json'),
    JSON.stringify({ name: moduleId, main: 'index.js', version: '1.0.0' }),
  );
}

export function writeExpoConfigModule(projectRoot: string, source: string): void {
  writeNestedExpoModule(projectRoot, '@expo/config', source);
}

export function createExpoFixture(options: ExpoFixtureOptions = {}): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-expo-test-'));
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', main: 'src/custom-entry.js' }),
  );
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'custom-entry.js'), 'module.exports = {};');

  const expoDirectory = path.join(projectRoot, 'node_modules', 'expo');
  fs.mkdirSync(expoDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(expoDirectory, 'package.json'),
    JSON.stringify({ name: 'expo', version: options.expoVersion ?? '55.0.0' }),
  );
  fs.writeFileSync(path.join(expoDirectory, 'index.js'), 'module.exports = {};');

  writeModule(
    projectRoot,
    'react-native',
    `module.exports = ${JSON.stringify({})};`,
  );
  fs.writeFileSync(
    path.join(projectRoot, 'node_modules', 'react-native', 'package.json'),
    JSON.stringify({
      name: 'react-native',
      main: 'index.js',
      version: options.reactNativeVersion ?? '0.83.0',
    }),
  );

  const config = options.config ?? {
    name: 'Fixture',
    slug: 'fixture',
    version: '2.3.4',
    runtimeVersion: 'runtime-literal',
    ios: { buildNumber: '7' },
    android: { versionCode: 8 },
  };
  fs.writeFileSync(path.join(projectRoot, 'expo.config.fixture.json'), JSON.stringify(config));
  fs.writeFileSync(
    path.join(projectRoot, 'bundle.drop.config.js'),
    `module.exports = ${JSON.stringify({
      projectType: 'expo',
      runtimeVersion: options.bundleDropRuntimeVersion ?? { source: 'expo' },
    })};\n`,
  );

  if (!options.omitExpoConfig) {
    writeExpoConfigModule(
      projectRoot,
      `const fs = require('fs'); const path = require('path');
       exports.getConfig = root => ({
         exp: JSON.parse(fs.readFileSync(path.join(root, 'expo.config.fixture.json'), 'utf8')),
         pkg: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
         dynamicConfigPath: path.join(root, 'app.config.js'),
         staticConfigPath: null
       });`,
    );
  }

  const pathsDirectory = path.join(
    projectRoot,
    'node_modules',
    'expo',
    'node_modules',
    '@expo',
    'config',
  );
  fs.mkdirSync(path.join(pathsDirectory, 'paths'), { recursive: true });
  if (!fs.existsSync(path.join(pathsDirectory, 'package.json'))) {
    fs.writeFileSync(
      path.join(pathsDirectory, 'package.json'),
      JSON.stringify({ name: '@expo/config', version: '1.0.0' }),
    );
  }
  fs.writeFileSync(
    path.join(pathsDirectory, 'paths', 'index.js'),
    `const path = require('path'); exports.resolveEntryPoint = root => path.join(root, 'src/custom-entry.js');`,
  );
  const configPackage = JSON.parse(
    fs.readFileSync(path.join(pathsDirectory, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  configPackage.exports = { '.': './index.js', './paths': './paths/index.js' };
  fs.writeFileSync(path.join(pathsDirectory, 'package.json'), JSON.stringify(configPackage));

  const updatesDirectory = path.join(
    projectRoot,
    'node_modules',
    'expo',
    'node_modules',
    '@expo',
    'config-plugins',
    'build',
    'utils',
  );
  fs.mkdirSync(updatesDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(updatesDirectory, 'Updates.js'),
    `exports.FINGERPRINT_RUNTIME_VERSION_SENTINEL = 'file:fingerprint';
     const selected = (config, platform) => (config[platform] && config[platform].runtimeVersion) || config.runtimeVersion;
     exports.getAppVersion = (config, platform) => (config[platform] && config[platform].version) || config.version || '1.0.0';
     exports.getNativeVersion = (config, platform) => {
       const version = exports.getAppVersion(config, platform);
       const build = platform === 'ios' ? ((config.ios && config.ios.buildNumber) || '1') : ((config.android && config.android.versionCode) || 1);
       return version + '(' + build + ')';
     };
     exports.getRuntimeVersionAsync = async (root, config, platform) => {
       const value = selected(config, platform);
       if (typeof value === 'string') return value;
       if (!value || !value.policy) return null;
       if (value.policy === 'appVersion') return exports.getAppVersion(config, platform);
       if (value.policy === 'nativeVersion') return exports.getNativeVersion(config, platform);
       if (value.policy === 'sdkVersion') return config.sdkVersion ? 'exposdk:' + config.sdkVersion : null;
       if (value.policy === 'fingerprint') return 'file:fingerprint';
       return null;
     };`,
  );
  const configPluginsDirectory = path.dirname(path.dirname(updatesDirectory));
  fs.writeFileSync(
    path.join(configPluginsDirectory, 'package.json'),
    JSON.stringify({ name: '@expo/config-plugins', version: '55.0.0' }),
  );

  writeNestedExpoModule(
    projectRoot,
    '@expo/fingerprint',
    `exports.createFingerprintAsync = async (root, options) => ({ hash: 'fingerprint-' + options.platforms[0] });`,
  );

  writeNestedExpoModule(
    projectRoot,
    '@expo/cli',
    `const fs = require('fs'); const path = require('path');
     const args = process.argv.slice(2);
     const value = flag => args[args.indexOf(flag) + 1];
     if (fs.existsSync(path.join(process.cwd(), 'fail-cli'))) process.exit(2);
     if (process.env.BUNDLE_DROP_OTA_BUILD !== '1') process.exit(3);
     const output = value('--bundle-output');
     const map = value('--sourcemap-output');
     const assets = value('--assets-dest');
     fs.mkdirSync(path.dirname(output), { recursive: true });
     fs.mkdirSync(assets, { recursive: true });
     fs.writeFileSync(output, args.includes('--bytecode') ? 'opaque-hermes-bytecode' : 'jsc-javascript');
     fs.writeFileSync(map, JSON.stringify({ version: 3, sources: [], names: [], mappings: '', debugId: 'debug-123' }));
     fs.writeFileSync(path.join(assets, 'icon.png'), 'png');
     fs.writeFileSync(path.join(path.dirname(output), 'argv.json'), JSON.stringify(args));`,
  );

  return projectRoot;
}

export function removeFixture(projectRoot: string): void {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
