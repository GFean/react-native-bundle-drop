'use strict';

const PHASE_NAME = 'Bundle Drop: Write iOS build identity';

const SHELL_SCRIPT = [
  'set -e',
  'if [ "${ENABLE_TESTABILITY:-NO}" = "YES" ]; then exit 0; fi',
  'BUNDLE_DROP_PROJECT_ROOT="$PROJECT_DIR/.."',
  'BUNDLE_DROP_WRITER="$BUNDLE_DROP_PROJECT_ROOT/node_modules/@gfean/react-native-bundle-drop/lib/CLI/scripts/expo/write-build-receipt.js"',
  '"${NODE_BINARY:-node}" "$BUNDLE_DROP_WRITER" --project-root "$BUNDLE_DROP_PROJECT_ROOT" --platform ios --artifact "$TARGET_BUILD_DIR/$WRAPPER_NAME"',
].join('\n');

function unquote(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^"|"$/g, '');
}

function findPhaseUuid(project) {
  const phases = project.hash?.project?.objects?.PBXShellScriptBuildPhase || {};
  for (const [uuid, phase] of Object.entries(phases)) {
    if (uuid.endsWith('_comment') || !phase || typeof phase !== 'object') continue;
    if (unquote(phase.name) === PHASE_NAME) return uuid;
  }
  return null;
}

function updatePhase(project, phaseUuid) {
  const phase = project.hash.project.objects.PBXShellScriptBuildPhase[phaseUuid];
  phase.name = `"${PHASE_NAME}"`;
  phase.shellPath = '/bin/sh';
  const escapedShellScript = SHELL_SCRIPT.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  phase.shellScript = `"${escapedShellScript}"`;
}

function movePhaseToEnd(target, phaseUuid) {
  const phases = target?.buildPhases;
  if (!Array.isArray(phases)) return;
  const index = phases.findIndex(reference => reference?.value === phaseUuid);
  if (index < 0 || index === phases.length - 1) return;
  const [reference] = phases.splice(index, 1);
  phases.push(reference);
}

function ensureBundleDropBuildPhase(project) {
  const targetResult = project.getFirstTarget();
  const targetUuid = targetResult?.uuid;
  const target = targetResult?.firstTarget;
  if (!targetUuid || !target) {
    throw new Error('Bundle Drop could not find the iOS application target.');
  }

  let phaseUuid = findPhaseUuid(project);
  if (!phaseUuid) {
    project.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      PHASE_NAME,
      targetUuid,
      {
        shellPath: '/bin/sh',
        shellScript: SHELL_SCRIPT,
      },
    );
    phaseUuid = findPhaseUuid(project);
    if (!phaseUuid) {
      throw new Error('Bundle Drop could not add its iOS post-bundle identity phase.');
    }
  }
  updatePhase(project, phaseUuid);
  movePhaseToEnd(target, phaseUuid);
  return project;
}

module.exports = {
  PHASE_NAME,
  SHELL_SCRIPT,
  ensureBundleDropBuildPhase,
};
