'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PHASE_NAME,
  SHELL_SCRIPT,
  ensureBundleDropBuildPhase,
} = require('../xcodeBuildPhase');

function makeProject() {
  const target = { buildPhases: [{ value: 'EXISTING_PHASE' }] };
  const phases = {};
  return {
    target,
    hash: { project: { objects: { PBXShellScriptBuildPhase: phases } } },
    getFirstTarget() {
      return { uuid: 'TARGET', firstTarget: target };
    },
    addBuildPhase(_files, type, name, targetUuid, options) {
      assert.equal(type, 'PBXShellScriptBuildPhase');
      assert.equal(targetUuid, 'TARGET');
      phases.BUNDLE_DROP_PHASE = { name: `"${name}"`, ...options };
      target.buildPhases.push({ value: 'BUNDLE_DROP_PHASE' });
    },
  };
}

test('adds the iOS receipt phase exactly once and leaves it last', () => {
  const project = makeProject();
  ensureBundleDropBuildPhase(project);
  project.hash.project.objects.PBXShellScriptBuildPhase.BUNDLE_DROP_PHASE.shellScript = 'stale';
  project.target.buildPhases.push({ value: 'LATER_PHASE' });
  ensureBundleDropBuildPhase(project);

  assert.deepEqual(project.target.buildPhases.map(phase => phase.value), [
    'EXISTING_PHASE',
    'LATER_PHASE',
    'BUNDLE_DROP_PHASE',
  ]);
  const phases = project.hash.project.objects.PBXShellScriptBuildPhase;
  assert.equal(Object.keys(phases).length, 1);
  assert.equal(phases.BUNDLE_DROP_PHASE.name, `"${PHASE_NAME}"`);
  assert.equal(
    phases.BUNDLE_DROP_PHASE.shellScript,
    `"${SHELL_SCRIPT.replace(/"/g, '\\"')}"`,
  );
});

test('uses quoted Xcode paths and never patches generated application sources', () => {
  assert.match(SHELL_SCRIPT, /ENABLE_TESTABILITY/);
  assert.match(SHELL_SCRIPT, /"\$PROJECT_DIR\/\.\."/);
  assert.match(SHELL_SCRIPT, /"\$TARGET_BUILD_DIR\/\$WRAPPER_NAME"/);
  assert.doesNotMatch(SHELL_SCRIPT, /MARKETING_VERSION|CURRENT_PROJECT_VERSION/);
  assert.doesNotMatch(SHELL_SCRIPT, /AppDelegate|MainApplication/);
});

test('Expo Android target embeds identity before signing and proves the packaged artifact afterward', () => {
  const gradle = fs.readFileSync(
    path.join(__dirname, '..', '..', 'expo', 'android', 'build.gradle'),
    'utf8',
  );
  const appPlugin = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      'expo',
      'bundle-drop-expo-gradle-plugin',
      'src',
      'main',
      'groovy',
      'com',
      'bundledrop',
      'gradle',
      'BundleDropExpoPlugin.groovy',
    ),
    'utf8',
  );

  assert.match(appPlugin, /generateBundleDrop\$\{capitalizedVariant\}BuildIdentity/);
  assert.match(appPlugin, /variant\.sources\.assets\.addGeneratedSourceDirectory/);
  assert.match(appPlugin, /selector\(\)\.withBuildType\('release'\)/);
  assert.match(gradle, /plugins\.withId\("com\.android\.application"\)/);
  assert.match(gradle, /task\.doLast/);
  assert.match(gradle, /\(package\|bundle\)\.\*release/);
  assert.match(gradle, /artifact\.path/);
  assert.match(gradle, /--android-sdk/);
  assert.match(gradle, /--app-version/);
  assert.match(gradle, /output\.versionNameOverride/);
  assert.match(gradle, /output\.versionCodeOverride/);
  assert.doesNotMatch(gradle, /assets\.srcDir/);
  assert.doesNotMatch(gradle, /candidateTask/);
  assert.doesNotMatch(gradle, /mergeAssetsTask\.dependsOn/);
  assert.doesNotMatch(gradle, /MainApplication/);
});
