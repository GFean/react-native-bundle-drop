import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { AiPatchPlan } from './types';
import { AiSetupProjectType } from './types';
import {
  hasBareAndroidStartupIntegration,
  hasBareIosStartupIntegration,
  stripCommentsAndStrings,
} from '../native-setup-contract';

const sha256 = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

export const isSafeRelativePath = (value: string) => {
  if (!value || value.startsWith('/') || value.includes('\\')) return false;
  const normalized = value.split('/').filter(Boolean).join('/');
  return normalized === value && !normalized.split('/').includes('..');
};

export const isPatchableNativeEntrypoint = (filePath: string) =>
  /(^|\/)android\/(?:.*\/)?MainApplication\.(kt|java)$/.test(filePath) ||
  /(^|\/)ios\/(?:.*\/)?AppDelegate\.(swift|m|mm)$/.test(filePath);

export const isPatchableExpoConfig = (filePath: string) =>
  filePath === 'app.json' ||
  /^app\.config\.(js|ts|cjs|mjs)$/.test(filePath) ||
  /^metro\.config\.(js|ts|cjs|mjs)$/.test(filePath);

const hasBalancedPairs = (content: string) => {
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  const opens = new Set(Object.values(pairs));
  const stack: string[] = [];

  for (const char of stripCommentsAndStrings(content)) {
    if (opens.has(char)) stack.push(char);
    if (pairs[char] && stack.pop() !== pairs[char]) return false;
  }

  return stack.length === 0;
};

const hasAndroidBundleDropIntegration = (content: string) => {
  return hasBareAndroidStartupIntegration(content);
};

const hasIosBundleDropIntegration = (filePath: string, content: string) => {
  return hasBareIosStartupIntegration(filePath, content);
};

const validateCommonSetupChange = (
  change: AiPatchPlan,
  originals: Map<string, string>,
  seen: Set<string>,
) => {
  if (!isSafeRelativePath(change.file)) {
    throw new Error(`AI setup plan references an unsafe file path: ${change.file}`);
  }
  if (!originals.has(change.file)) {
    throw new Error(`AI setup plan references a file that was not shared: ${change.file}`);
  }
  if (seen.has(change.file)) {
    throw new Error(`AI setup plan contains multiple updates for ${change.file}`);
  }
  seen.add(change.file);
  if (sha256(originals.get(change.file)!) !== change.originalSha256) {
    throw new Error(`AI setup plan hash mismatch for ${change.file}`);
  }
  if (!change.updated.trim()) {
    throw new Error(`AI setup plan returned an empty update for ${change.file}`);
  }
  if (change.updated.includes('TODO_BUNDLEDROP') || change.updated.includes('<TODO')) {
    throw new Error(`AI setup plan returned placeholder text in ${change.file}`);
  }
  if (!hasBalancedPairs(change.updated)) {
    throw new Error(`AI setup plan returned unbalanced braces or brackets in ${change.file}`);
  }
};

export function validateSetupChangesBeforeApply(params: {
  projectType: AiSetupProjectType;
  originals: Map<string, string>;
  changes: AiPatchPlan[];
}) {
  const seen = new Set<string>();
  for (const change of params.changes) {
    validateCommonSetupChange(change, params.originals, seen);
    if (params.projectType === 'expo') {
      if (!isPatchableExpoConfig(change.file)) {
        throw new Error(`AI Expo setup may not modify ${change.file}`);
      }
      if (
        change.file.startsWith('metro.config.') &&
        !change.updated.includes('bundle-drop-config') &&
        !change.updated.includes('withBundleDropExpo')
      ) {
        throw new Error(`AI Expo Metro update is missing the Bundle Drop wrapper: ${change.file}`);
      }
      if (
        (change.file === 'app.json' || change.file.startsWith('app.config.')) &&
        !change.updated.includes('@gfean/react-native-bundle-drop')
      ) {
        throw new Error(`AI Expo config update is missing the Bundle Drop plugin: ${change.file}`);
      }
      continue;
    }

    if (!isPatchableNativeEntrypoint(change.file)) {
      throw new Error(`AI bare setup may not modify ${change.file}`);
    }
    if (change.file.includes('MainApplication.') && !hasAndroidBundleDropIntegration(change.updated)) {
      throw new Error(`AI plan Android update does not contain BundleDrop resolver: ${change.file}`);
    }
    if (
      change.file.includes('AppDelegate.') &&
      !hasIosBundleDropIntegration(change.file, change.updated)
    ) {
      throw new Error(`AI plan iOS update does not contain BundleDrop locator: ${change.file}`);
    }
  }
}

export function validateAppliedSetupChanges(params: {
  projectRoot: string;
  projectType: AiSetupProjectType;
  changes: AiPatchPlan[];
}) {
  const originals = new Map(
    params.changes.map(change => [
      change.file,
      fs.readFileSync(path.join(params.projectRoot, change.file), 'utf8'),
    ]),
  );
  validateSetupChangesBeforeApply({
    projectType: params.projectType,
    originals,
    changes: params.changes.map(change => ({
      ...change,
      originalSha256: sha256(originals.get(change.file)!),
      updated: originals.get(change.file)!,
    })),
  });
}
