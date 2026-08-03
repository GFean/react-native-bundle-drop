import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';

import { AiPatchPlan, AiSetupProjectType } from './types';
import {
  isPatchableExpoConfig,
  isPatchableNativeEntrypoint,
  isSafeRelativePath,
} from './validate-plan';

const sha256 = (content: string) => crypto.createHash('sha256').update(content).digest('hex');
const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

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
    const backupPath = path.join(result.backupDir, relativePath);
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, path.join(result.projectRoot, relativePath));
    }
  }
}

export function applySetupPatchPlans(params: {
  projectRoot: string;
  projectType: AiSetupProjectType;
  changes: AiPatchPlan[];
}): SetupApplyResult {
  const result: SetupApplyResult = {
    projectRoot: params.projectRoot,
    backupDir: path.join(params.projectRoot, '.bundledrop-backup', timestamp()),
    changedFiles: [],
  };

  try {
    for (const change of params.changes) {
      if (!isSafeRelativePath(change.file) || !isAllowedSetupFile(params.projectType, change.file)) {
        throw new Error(`Refusing to write AI setup plan outside its allowlist: ${change.file}`);
      }
      const targetPath = path.join(params.projectRoot, change.file);
      const original = fs.readFileSync(targetPath, 'utf8');
      if (sha256(original) !== change.originalSha256) {
        throw new Error(`File changed since AI setup scan: ${change.file}`);
      }

      const backupPath = path.join(result.backupDir, change.file);
      fs.ensureDirSync(path.dirname(backupPath));
      fs.copyFileSync(targetPath, backupPath);
      result.changedFiles.push(change.file);

      const temporaryPath = `${targetPath}.bundledrop-tmp`;
      fs.writeFileSync(temporaryPath, change.updated, 'utf8');
      fs.renameSync(temporaryPath, targetPath);
    }
    return result;
  } catch (error) {
    restoreSetupBackups(result);
    throw error;
  }
}
