#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = process.cwd();
const npmCache = path.join(os.tmpdir(), 'bundle-drop-npm-pack-cache');

const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_ignore_scripts: 'true',
  },
});

if (pack.error) {
  console.error(pack.error.message);
  process.exit(1);
}

if (pack.status !== 0) {
  process.stdout.write(pack.stdout || '');
  process.stderr.write(pack.stderr || '');
  process.exit(pack.status ?? 1);
}

let packResult;
try {
  const jsonStart = pack.stdout.indexOf('[');
  const jsonEnd = pack.stdout.lastIndexOf(']');
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error('npm pack did not print a JSON array.');
  }
  packResult = JSON.parse(pack.stdout.slice(jsonStart, jsonEnd + 1))[0];
} catch (error) {
  console.error('Failed to parse npm pack --dry-run output.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const packedEntries = packResult.files || [];
const packedFiles = new Map(packedEntries.map(file => [file.path, file]));

const blockedPathPatterns = [
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.bundle-drop(\/|$)/,
  /(^|\/)\.bundledrop-backup(\/|$)/,
  /(^|\/)\.env(?:\.[^/]*)?$/,
  /(^|\/)\.harness(\/|$)/,
  /(^|\/)\.husky(\/|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)android\/src\/(?:androidTest|test)(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)evidence(\/|$)/,
  /(^|\/)examples(\/|$)/,
  /(^|\/)fixtures(\/|$)/,
  /(^|\/)ios-tests(\/|$)/,
  /(^|\/)lib\/CLI\/scripts\/aipowered\/(?:apply-plan|init-native-config)\.(?:js|d\.ts)\/?$/,
  /(^|\/)lib\/CLI\/scripts\/init-metro-config\.(?:js|d\.ts)\/?$/,
  /(^|\/)scripts\/harness(\/|$)/,
  /(^|\/)src\/tests(\/|$)/,
  /\.tgz$/,
];

const blockedFiles = packedEntries
  .map(file => file.path)
  .filter(filePath => blockedPathPatterns.some(pattern => pattern.test(filePath)));

if (blockedFiles.length > 0) {
  console.error('Blocked files would be published:');
  blockedFiles.forEach(filePath => console.error(`  ${filePath}`));
  process.exit(1);
}

const requiredFiles = [
  'README.md',
  'app.plugin.js',
  'BundleDrop.podspec',
  'BundleDropExpo.podspec',
  'expo-module.config.json',
  'react-native.config.js',
  'android/build.gradle',
  'android/src/main/AndroidManifest.xml',
  'android/src/main/java/com/bundledrop/BundleDropModule.kt',
  'ios/BundleDropModule.swift',
  'plugin/index.js',
  'plugin/xcodeBuildPhase.js',
  'expo/android/build.gradle',
  'expo/android/src/main/AndroidManifest.xml',
  'expo/android/src/main/java/com/bundledrop/expo/BundleDropExpoConfiguration.kt',
  'expo/android/src/main/java/com/bundledrop/expo/BundleDropExpoIdentityModule.kt',
  'expo/android/src/main/java/com/bundledrop/expo/BundleDropExpoPackage.kt',
  'expo/android/src/main/java/com/bundledrop/expo/BundleDropExpoReactNativeHostHandler.kt',
  'expo/bundle-drop-expo-gradle-plugin/build.gradle',
  'expo/bundle-drop-expo-gradle-plugin/src/main/groovy/com/bundledrop/gradle/BundleDropExpoPlugin.groovy',
  'expo/ios/Sources/BundleDropExpoIdentity.m',
  'expo/ios/Sources/BundleDropExpoReactDelegateHandler.swift',
  'lib/index.d.ts',
  'lib/index.js',
  'lib/metro.d.ts',
  'lib/metro.js',
  'lib/CLI/cli.js',
  'lib/CLI/scripts/sight-artifacts.js',
  'lib/CLI/scripts/sight-cli.js',
  'lib/CLI/scripts/sight-session.js',
  'lib/CLI/scripts/expo/write-build-receipt.js',
  'lib/CLI/scripts/expo/write-eas-build-receipt.js',
  'third_party/xdelta/NOTICE',
  'third_party/xdelta/PROVENANCE.md',
  'third_party/xdelta/xdelta3/LICENSE',
];

const missingFiles = requiredFiles.filter(filePath => !packedFiles.has(filePath));
if (missingFiles.length > 0) {
  console.error('Required package files are missing:');
  missingFiles.forEach(filePath => console.error(`  ${filePath}`));
  process.exit(1);
}

const cliEntry = packedFiles.get('lib/CLI/cli.js');
if (!cliEntry || (cliEntry.mode & 0o111) === 0) {
  console.error('The bundle-drop CLI must be executable in the npm package.');
  process.exit(1);
}

const cliContents = fs.readFileSync(path.join(projectRoot, 'lib/CLI/cli.js'), 'utf8');
if (!cliContents.includes('Ship OTA Updates with Confidence')) {
  console.error('The bundle-drop CLI must use the public marketing headline.');
  process.exit(1);
}
if (/\.command\(['"]init-(?:native|metro)['"]\)/.test(cliContents)) {
  console.error('Legacy setup commands must not ship in the bundle-drop CLI.');
  process.exit(1);
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
);
const expectedExports = {
  '.': {
    types: './lib/index.d.ts',
    default: './lib/index.js',
  },
  './metro': {
    types: './lib/metro.d.ts',
    default: './lib/metro.js',
  },
  './app.plugin.js': './app.plugin.js',
  './package.json': './package.json',
};
const expectedScripts = new Set([
  'clean',
  'build',
  'test',
  'test:coverage',
  'coverage:check',
  'coverage:gate',
  'test:android',
  'test:android:device',
  'test:ios',
  'test:expo:plugin',
  'package:check',
  'audit:production',
  'verify:quick',
  'verify:native',
  'verify:release',
  'prepack',
  'prepublishOnly',
]);

const metadataErrors = [];
const stableVersionPattern = /^\d+\.\d+\.\d+$/;
if (!stableVersionPattern.test(packageJson.version)) {
  metadataErrors.push('version must be a stable semantic version.');
}
if (!stableVersionPattern.test(packageJson.nativeVersion)) {
  metadataErrors.push('nativeVersion must be a stable semantic version.');
}
if (packageJson.publishConfig?.access !== 'public') {
  metadataErrors.push('publishConfig.access must be public.');
}
if (JSON.stringify(packageJson.exports) !== JSON.stringify(expectedExports)) {
  metadataErrors.push('package exports do not match the supported public contract.');
}
if (packageJson.scripts?.prepack !== 'npm run build') {
  metadataErrors.push('prepack must run npm run build.');
}
if (packageJson.scripts?.prepublishOnly !== 'npm run verify:release') {
  metadataErrors.push('prepublishOnly must run the complete release verification.');
}
if (packageJson.husky || packageJson.devDependencies?.husky || packageJson.scripts?.prepare) {
  metadataErrors.push('Husky must not run or ship as part of the public package lifecycle.');
}
if (packageJson['create-react-native-library']) {
  metadataErrors.push('Unused package scaffold metadata must be removed.');
}

const actualScripts = Object.keys(packageJson.scripts || {});
const unexpectedScripts = actualScripts.filter(script => !expectedScripts.has(script));
const missingScripts = [...expectedScripts].filter(script => !actualScripts.includes(script));
if (unexpectedScripts.length > 0) {
  metadataErrors.push(`unexpected package scripts: ${unexpectedScripts.join(', ')}`);
}
if (missingScripts.length > 0) {
  metadataErrors.push(`missing package scripts: ${missingScripts.join(', ')}`);
}

if (metadataErrors.length > 0) {
  console.error('Public package metadata validation failed:');
  metadataErrors.forEach(error => console.error(`  ${error}`));
  process.exit(1);
}

const blockedContentPatterns = [
  { label: 'staging hostname', pattern: /api-staging\.bundledrop\.app/i },
  { label: 'macOS absolute user path', pattern: /\/Users\/[^/\s]+\// },
  { label: 'Linux absolute home path', pattern: /\/home\/[^/\s]+\// },
  { label: 'Windows absolute user path', pattern: /[A-Z]:\\Users\\[^\\\s]+\\/i },
  { label: 'private key', pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/ },
  { label: 'npm authentication token', pattern: /(?:npm_[A-Za-z0-9]{20,}|_authToken\s*=)/ },
  { label: 'GitHub authentication token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { label: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { label: 'restricted npm access', pattern: /(?:access["']?\s*:\s*["']restricted|--access[= ]restricted)/i },
  { label: 'internal harness reference', pattern: /(?:\.harness\/|scripts\/harness\/|harness:)/i },
  { label: 'internal certification reference', pattern: /(?:EXPO_PRELAUNCH|live-backend-smoke|install-restricted-package|prepare-eas-certification|build-and-publish|yalc publish)/i },
  { label: 'legacy CLI marketing line', pattern: /A blazing-fast OTA delivery system for React Native by GFean\./i },
];

const contentLeaks = [];
for (const filePath of packedFiles.keys()) {
  const absolutePath = path.join(projectRoot, filePath);
  const contents = fs.readFileSync(absolutePath);
  if (contents.includes(0)) {
    continue;
  }

  const text = contents.toString('utf8');
  for (const { label, pattern } of blockedContentPatterns) {
    if (pattern.test(text)) {
      contentLeaks.push(`${filePath}: ${label}`);
    }
  }
}

if (contentLeaks.length > 0) {
  console.error('Blocked content would be published:');
  contentLeaks.forEach(leak => console.error(`  ${leak}`));
  process.exit(1);
}

console.log(
  `npm package check passed: ${packResult.entryCount} files, ${packResult.unpackedSize} unpacked bytes.`,
);
