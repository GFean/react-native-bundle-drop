import crypto from 'node:crypto';

import { inspectProjectFile } from '../safe-file-transaction';
import { listNativeSetupContext } from './native-setup-context';
import { findCredentialLikeLiteral, MAX_SETUP_FILE_BYTES } from './scanner';
import type { AiPatchPlan, AiSetupPlanResponse, AiSetupScannerResultV2 } from './types';

const PLAN_KEYS = ['confidence', 'summary', 'actions', 'changes', 'warnings'];

export function verifyNativeSetupPlan(
  scan: AiSetupScannerResultV2,
  plan: AiSetupPlanResponse,
): Set<string> {
  if (Object.keys(plan).length !== PLAN_KEYS.length ||
      !PLAN_KEYS.every(key => Object.prototype.hasOwnProperty.call(plan, key)) ||
      (plan.confidence === 'low' && plan.changes.length)) {
    throw new Error('AI setup returned an invalid native plan. No files changed.');
  }

  const eligible = new Set(scan.request.nativeEditPaths);
  const originals = new Map(scan.request.files.map(file => [file.path, file]));
  const writes = new Set<string>();
  for (const change of plan.changes) {
    const original = originals.get(change.file);
    if (!eligible.has(change.file) || !original || writes.has(change.file) ||
        change.originalSha256 !== original.sha256 ||
        change.decisionType !== 'review_only_patch' || change.confidence === 'low' ||
        change.updated === original.content || Buffer.byteLength(change.updated, 'utf8') > MAX_SETUP_FILE_BYTES ||
        findCredentialLikeLiteral(change.updated)) {
      throw new Error('AI setup returned a native edit outside the consented files or with invalid content. No files changed.');
    }
    writes.add(change.file);
  }
  return writes;
}

const sha256 = (contents: string) => crypto.createHash('sha256').update(contents).digest('hex');

export function assertNativeSetupSnapshot(
  scan: AiSetupScannerResultV2,
  changes: AiPatchPlan[] = [],
  packageWasMigrated = false,
) {
  const { projectRoot, snapshot, nativeInventory: expectedNative } = scan;
  const currentNative = listNativeSetupContext(projectRoot).map(file => file.path);
  if (expectedNative.length !== currentNative.length ||
      currentNative.some((file, index) => file !== expectedNative[index])) {
    throw new Error('Native setup files changed during review. Rerun setup with the current project.');
  }

  const updates = new Map(changes.map(change => [change.file, sha256(change.updated)]));
  for (const [file, originalHash] of snapshot) {
    if (file === 'package.json' && packageWasMigrated) continue;
    const current = inspectProjectFile(projectRoot, file);
    const currentHash = current.exists ? sha256(current.content) : null;
    if (currentHash !== (updates.get(file) ?? originalHash)) {
      throw new Error(`AI setup file changed during the transaction: ${file}. Rerun setup with the current project.`);
    }
  }
}
