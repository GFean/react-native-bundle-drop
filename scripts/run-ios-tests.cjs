#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

const FILE_THRESHOLDS = {
  'ios/BundleDropOtaResolver.swift': 90,
  'ios/BundleDropStartupRecovery.swift': 90,
  'ios/BundleDropFileOps.swift': 75,
  'ios/BundleDropLocator.swift': 60,
  'ios/BundleDropZipExtractor.m': 65,
};

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function ensureTool(command, args, message) {
  const result = run(command, args);
  if (result.error || result.status !== 0) {
    fail(message);
  }
}

if (process.platform !== 'darwin') {
  fail('iOS native tests require macOS with Xcode command line tools.');
}

ensureTool(
  'swift',
  ['--version'],
  'iOS native tests require Swift. Install Xcode command line tools and rerun `corepack yarn test:ios`.',
);
ensureTool(
  'xcrun',
  ['llvm-cov', '--version'],
  'iOS coverage gate requires xcrun llvm-cov. Install Xcode command line tools and rerun `corepack yarn test:ios`.',
);

const testResult = run('swift', ['test', '--enable-code-coverage', '--quiet'], {
  stdio: 'inherit',
});
if (testResult.error) {
  fail(testResult.error.message);
}
if (testResult.status !== 0) {
  process.exit(testResult.status ?? 1);
}

const coveragePathResult = run('swift', ['test', '--show-codecov-path']);
if (coveragePathResult.error || coveragePathResult.status !== 0) {
  fail('Failed to locate SwiftPM coverage JSON. Run `swift test --enable-code-coverage` locally for details.');
}

const coveragePath = coveragePathResult.stdout.trim().split(/\r?\n/).pop();
if (!coveragePath || !fs.existsSync(coveragePath)) {
  fail(`SwiftPM coverage JSON not found at ${coveragePath || '<empty path>'}.`);
}

const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
const files = new Map();
for (const file of coverage.data?.[0]?.files || []) {
  files.set(path.relative(repoRoot, file.filename).split(path.sep).join('/'), file);
}

const failures = [];
for (const [filePath, expected] of Object.entries(FILE_THRESHOLDS)) {
  const entry = files.get(filePath);
  if (!entry) {
    failures.push(`${filePath}: missing from coverage report`);
    continue;
  }

  const actual = entry.summary?.lines?.percent;
  if (typeof actual !== 'number') {
    failures.push(`${filePath}: missing line coverage summary`);
    continue;
  }

  if (actual + Number.EPSILON < expected) {
    failures.push(`${filePath}: ${actual.toFixed(2)}% < ${expected.toFixed(2)}%`);
  }
}

if (failures.length > 0) {
  console.error('iOS coverage thresholds failed:');
  failures.forEach(failure => console.error(`  ${failure}`));
  process.exit(1);
}

console.log(
  `iOS coverage thresholds satisfied for ${Object.keys(FILE_THRESHOLDS).length} files.`,
);
