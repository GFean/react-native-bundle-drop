#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(message) {
  console.error(`Package tarball inspection failed: ${message}`);
  process.exit(1);
}

function runTar(args, encoding = 'utf8') {
  const result = spawnSync('tar', args, {
    encoding,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    fail(`tar exited with status ${result.status}.`);
  }

  return result.stdout;
}

const artifactArgument = process.argv[2];
if (!artifactArgument) {
  fail('provide the npm tarball path as the only argument.');
}

const artifactPath = path.resolve(artifactArgument);
if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
  fail(`${artifactArgument} is not a regular file.`);
}

const entries = runTar(['-tzf', artifactPath])
  .split('\n')
  .filter(Boolean);

if (entries.length === 0) {
  fail('the archive is empty.');
}

const duplicateEntries = entries.filter(
  (entry, index) => entries.indexOf(entry) !== index,
);
if (duplicateEntries.length > 0) {
  fail(`duplicate archive entries: ${[...new Set(duplicateEntries)].join(', ')}`);
}

const unsafeEntries = entries.filter(entry => {
  const normalizedEntry = entry.replaceAll('\\', '/');
  return (
    normalizedEntry.startsWith('/') ||
    !normalizedEntry.startsWith('package/') ||
    normalizedEntry.split('/').includes('..')
  );
});
if (unsafeEntries.length > 0) {
  fail(`unsafe archive paths: ${unsafeEntries.join(', ')}`);
}

const blockedPathPatterns = [
  /(^|\/)\.env(?:\.[^/]*)?$/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.release-artifacts(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)ios-tests(\/|$)/,
  /(^|\/)src\/tests(\/|$)/,
  /\.(?:jks|key|keystore|mobileprovision|p12|pem|tgz)$/,
];
const blockedEntries = entries.filter(entry =>
  blockedPathPatterns.some(pattern => pattern.test(entry)),
);
if (blockedEntries.length > 0) {
  fail(`blocked files are present: ${blockedEntries.join(', ')}`);
}

const verboseEntries = runTar(['-tvzf', artifactPath])
  .split('\n')
  .filter(Boolean);
const specialEntries = verboseEntries.filter(line => !['-', 'd'].includes(line[0]));
if (specialEntries.length > 0) {
  fail('the archive contains symbolic links or other special entries.');
}

const packageJsonContents = runTar(
  ['-xOzf', artifactPath, 'package/package.json'],
  'utf8',
);

let packageJson;
try {
  packageJson = JSON.parse(packageJsonContents);
} catch (error) {
  fail(`package/package.json is invalid: ${error.message}`);
}

const stableVersionPattern = /^\d+\.\d+\.\d+$/;
if (packageJson.name !== '@gfean/react-native-bundle-drop') {
  fail(`unexpected package name ${packageJson.name}.`);
}
if (!stableVersionPattern.test(packageJson.version)) {
  fail(`package version ${packageJson.version} is not stable semantic versioning.`);
}
if (!stableVersionPattern.test(packageJson.nativeVersion)) {
  fail(`nativeVersion ${packageJson.nativeVersion} is not stable semantic versioning.`);
}

const expectedFilename = `gfean-react-native-bundle-drop-${packageJson.version}.tgz`;
if (path.basename(artifactPath) !== expectedFilename) {
  fail(`expected filename ${expectedFilename}, received ${path.basename(artifactPath)}.`);
}
if (packageJson.license !== 'ISC') {
  fail(`unexpected license ${packageJson.license}.`);
}
if (packageJson.publishConfig?.access !== 'public') {
  fail('publishConfig.access must be public.');
}
if (packageJson.main !== 'lib/index.js' || packageJson.types !== 'lib/index.d.ts') {
  fail('package entry points do not match the supported public contract.');
}
if (packageJson.bin?.['bundle-drop'] !== 'lib/CLI/cli.js') {
  fail('the bundle-drop CLI entry point is missing.');
}

const sha256 = crypto
  .createHash('sha256')
  .update(fs.readFileSync(artifactPath))
  .digest('hex');

console.log(
  `Package tarball inspection passed: ${packageJson.name}@${packageJson.version}, ` +
    `${entries.length} entries, SHA-256 ${sha256}.`,
);
