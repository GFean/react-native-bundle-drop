import crypto from 'crypto';

import { AiPatchPlan, AiSetupProjectType } from './types';
import {
  isPatchableExpoConfig,
  isPatchableNativeEntrypoint,
  isSafeRelativePath,
} from './validate-plan';
import {
  createSafeBackupDirectory,
  inspectProjectFile,
  restoreProjectFile,
  writeBackupFile,
  writeProjectFileAtomically,
} from '../safe-file-transaction';

const sha256 = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

export type SetupApplyResult = {
  projectRoot: string;
  backupDir: string;
  changedFiles: string[];
};

const isAllowedSetupFile = (projectType: AiSetupProjectType, filePath: string) =>
  projectType === 'expo'
    ? isPatchableExpoConfig(filePath)
    : isPatchableNativeEntrypoint(filePath);

export function restoreSetupBackups(result: SetupApplyResult) {
  for (const relativePath of result.changedFiles) {
    restoreProjectFile(result.projectRoot, result.backupDir, relativePath);
  }
}

export function applySetupPatchPlans(params: {
  projectRoot: string;
  projectType: AiSetupProjectType;
  changes: AiPatchPlan[];
}): SetupApplyResult {
  const result: SetupApplyResult = {
    projectRoot: params.projectRoot,
    backupDir: createSafeBackupDirectory(params.projectRoot, 'ai-setup'),
    changedFiles: [],
  };

  try {
    for (const change of params.changes) {
      if (!isSafeRelativePath(change.file) || !isAllowedSetupFile(params.projectType, change.file)) {
        throw new Error(`Refusing to write AI setup plan outside its allowlist: ${change.file}`);
      }
      const target = inspectProjectFile(params.projectRoot, change.file);
      if (!target.exists || sha256(target.content) !== change.originalSha256) {
        throw new Error(`File changed since AI setup scan: ${change.file}`);
      }

      writeBackupFile(
        result.backupDir,
        change.file,
        target.content,
        target.mode,
      );
      result.changedFiles.push(change.file);
      writeProjectFileAtomically(
        params.projectRoot,
        change.file,
        change.updated,
        target.mode,
      );
    }
    return result;
  } catch (error) {
    restoreSetupBackups(result);
    throw error;
  }
}
