'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertExpoUpdatesDoesNotOwnStartup,
  getExpoUpdatesOwnership,
  getExpoUpdatesState,
} = require('../expoUpdates');

function makeProject(packageJson = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundledrop-plugin-'));
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify(packageJson)}\n`,
  );
  return projectRoot;
}

test('reports absent when expo-updates is not configured or installed', () => {
  const projectRoot = makeProject();

  assert.equal(
    getExpoUpdatesState({}, { projectRoot, packageIsInstalled: false }),
    'absent',
  );
});

test('reports active for string and tuple plugin declarations', () => {
  const projectRoot = makeProject();

  assert.equal(
    getExpoUpdatesState(
      { plugins: ['expo-updates'] },
      { projectRoot, packageIsInstalled: false },
    ),
    'active',
  );
  assert.equal(
    getExpoUpdatesState(
      { plugins: [['expo-updates', { username: 'example' }]] },
      { projectRoot, packageIsInstalled: false },
    ),
    'active',
  );
});

test('reports active when the dependency is declared', () => {
  const projectRoot = makeProject({
    dependencies: { 'expo-updates': '^57.0.0' },
  });

  assert.equal(
    getExpoUpdatesState({}, { projectRoot, packageIsInstalled: false }),
    'active',
  );
});

test('reports a project-local resolvable installation even when it is undeclared', () => {
  const projectRoot = makeProject();
  const installedPackage = path.join(projectRoot, 'node_modules', 'expo-updates');
  fs.mkdirSync(installedPackage, { recursive: true });
  fs.writeFileSync(
    path.join(installedPackage, 'package.json'),
    JSON.stringify({ name: 'expo-updates', version: '57.0.0' }),
  );

  const ownership = getExpoUpdatesOwnership({}, { projectRoot });
  assert.equal(ownership.state, 'active');
  assert.equal(ownership.packageIsInstalled, true);
  assert.equal(ownership.packageIsDeclared, false);

  fs.rmSync(installedPackage, { recursive: true, force: true });
  const removedOwnership = getExpoUpdatesOwnership({}, { projectRoot });
  assert.equal(removedOwnership.state, 'absent');
  assert.equal(removedOwnership.packageIsInstalled, false);
});

test('reports evaluated URL and enabled signals through the same ownership result', () => {
  const projectRoot = makeProject();

  const urlOwnership = getExpoUpdatesOwnership(
    { updates: { url: 'https://u.expo.dev/project' } },
    { projectRoot, packageIsInstalled: false },
  );
  assert.equal(urlOwnership.state, 'active');
  assert.equal(urlOwnership.hasUpdatesUrl, true);

  const enabledOwnership = getExpoUpdatesOwnership(
    { updates: { enabled: true } },
    { projectRoot, packageIsInstalled: false },
  );
  assert.equal(enabledOwnership.state, 'active');
  assert.equal(enabledOwnership.explicitlyEnabled, true);
});

test('permits only explicitly disabled expo-updates', () => {
  const projectRoot = makeProject({
    dependencies: { 'expo-updates': '^57.0.0' },
  });
  const config = { updates: { enabled: false } };

  assert.equal(
    getExpoUpdatesState(config, { projectRoot, packageIsInstalled: false }),
    'disabled',
  );
  assert.equal(
    assertExpoUpdatesDoesNotOwnStartup(config, {
      projectRoot,
      packageIsInstalled: false,
      warn: false,
    }),
    config,
  );
});

test('throws instead of silently changing active expo-updates', () => {
  const projectRoot = makeProject();

  assert.throws(
    () =>
      assertExpoUpdatesDoesNotOwnStartup(
        { updates: { enabled: true } },
        { projectRoot, packageIsInstalled: false, warn: false },
      ),
    /cannot be enabled while expo-updates is active/i,
  );
});
