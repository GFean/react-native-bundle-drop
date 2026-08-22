import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import prompts from 'prompts';
import { execFileSync, execSync } from 'child_process';

import { detectProjectType, evaluateExpoConfig } from '../../../expo';
import type { ProjectType } from '../../../expo';
import { planBareMetroConfig } from '../bare-metro-config';
import { inspectProject, runDoctor } from '../doctor';
import {
  applyExpoConfigurationChanges,
  hasDynamicExpoConfig,
  planExpoProjectConfiguration,
  restoreExpoConfiguration,
  setBundleDropProjectType,
} from '../expo/configure-expo';
import {
  codePushRemovalCommand,
  detectPackageManager,
  expoUpdatesRemovalCommand,
  removeCodePushWithPackageManager,
  removeExpoUpdatesWithPackageManager,
  restoreDependencyMigration,
} from '../expo/package-manager';
import { applySetupPatchPlans, restoreSetupBackups } from './apply-setup-plan';
import { requestAiSetupPlan } from './backend-client';
import { findCodePushResiduePaths } from './code-push-residue';
import { buildUnifiedDiff, colorizeUnifiedDiff } from './diff-preview';
import { assertSafeProviderPlan, escapeTerminalControls } from './terminal-safety';
import {
  authoritativeDynamicExpoConfigFile,
  findProjectRoot,
  isBundleDropHostedAiPlanningServer,
  scanProjectForAiSetup,
} from './scanner';
import type { AiPatchPlan, AiSetupScannerResult } from './types';
import {
  validateAppliedSetupChanges,
  validateSetupChangesBeforeApply,
} from './validate-plan';
import { startLoadingStatus } from '../../utils/ui';
import {
  createSafeBackupDirectory,
  inspectProjectDirectory,
  inspectProjectFile,
  writeProjectFileAtomically,
} from '../safe-file-transaction';
import {
  addRuntimeDeliveryBootstrapGitignoreRules,
  RUNTIME_DELIVERY_BOOTSTRAP_PATH,
} from '../../../runtime-delivery/bootstrapConfig';

const PACKAGE_NAME = '@gfean/react-native-bundle-drop';
const DOCS_MANUAL_SETUP_URL = 'https://bundledrop.app/docs/manual-setup';
const DOCS_RUNTIME_INITIALIZATION_URL =
  'https://bundledrop.app/docs/installation#initialize-bundle-drop-in-javascript';
const EXPO_RUNTIME_AUTHORITY_PATTERN =
  /runtimeVersion\s*:\s*\{\s*source\s*:\s*['"]expo['"]\s*\}/;

const logRuntimeInitializationNextStep = () => {
  console.log(chalk.cyan(
    'JavaScript entry point: call BundleDrop.init once before rendering your app. ' +
      DOCS_RUNTIME_INITIALIZATION_URL,
  ));
};

export type InitProjectOptions = {
  projectType?: ProjectType;
  dryRun?: boolean;
  migrateCodePush?: boolean;
  migrateExpoUpdates?: boolean;
  prebuild?: boolean;
  yes?: boolean;
  virtualConfig?: {
    content: string;
    serverUrl: string;
    orgSlug: string;
    projectSlug: string;
    authToken: string;
  };
  runtimeDeliveryBootstrap?: {
    content: string;
  };
};

const sha256 = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

const inspectPlanningFile = (projectRoot: string, relativePath: string) => {
  if (!fs.existsSync(projectRoot)) return { exists: false, content: '', mode: 0o666 };
  return inspectProjectFile(projectRoot, relativePath);
};

const planRuntimeDeliveryBootstrap = (
  projectRoot: string,
  bootstrap?: InitProjectOptions['runtimeDeliveryBootstrap'],
) => {
  if (!bootstrap) return null;
  const bootstrapFile = inspectPlanningFile(projectRoot, RUNTIME_DELIVERY_BOOTSTRAP_PATH);
  const original = bootstrapFile.exists ? bootstrapFile.content : null;
  if (original === bootstrap.content) return null;
  return {
    file: RUNTIME_DELIVERY_BOOTSTRAP_PATH,
    original,
    updated: bootstrap.content,
    reason: 'Pin the authenticated runtime delivery bootstrap for this project.',
  };
};

const planRuntimeDeliveryGitignore = (
  projectRoot: string,
  bootstrap?: InitProjectOptions['runtimeDeliveryBootstrap'],
) => {
  if (!bootstrap) return null;
  const file = '.gitignore';
  const gitignoreFile = inspectPlanningFile(projectRoot, file);
  const original = gitignoreFile.exists ? gitignoreFile.content : null;
  const updated = addRuntimeDeliveryBootstrapGitignoreRules(original || '');
  if (updated === original) return null;
  return {
    file,
    original,
    updated,
    reason: 'Keep the pinned runtime delivery bootstrap reproducible in clean builds.',
  };
};

const shouldApplyAiChange = (change: AiPatchPlan) =>
  change.confidence !== 'low' &&
  (change.decisionType === 'safe_auto_patch' || change.decisionType === 'review_only_patch');

const isDynamicExpoConfigChange = (change: AiPatchPlan) =>
  /^app\.config\.(?:js|ts|cjs|mjs)$/.test(change.file);

const reviewOnlyChanges = (changes: AiPatchPlan[]) =>
  changes.filter(change =>
    change.confidence !== 'low' &&
    (change.decisionType === 'review_only_patch' || isDynamicExpoConfigChange(change))
  );

async function confirmReviewOnlyChanges(params: {
  projectRoot: string;
  originals: Map<string, string>;
  changes: AiPatchPlan[];
  yes?: boolean;
  dryRun?: boolean;
}): Promise<boolean> {
  const changesRequiringReview = reviewOnlyChanges(params.changes);
  if (params.dryRun || !changesRequiringReview.length) return true;

  if (params.yes) {
    console.log(chalk.yellow(
      'Review-only AI changes require explicit interactive approval. ' +
        '--yes cannot approve them. No files changed.',
    ));
    return false;
  }

  for (const change of changesRequiringReview) {
    console.log(chalk.yellow(`\nReview-only proposed change: ${change.file}`));
    console.log(colorizeUnifiedDiff(buildUnifiedDiff({
      projectRoot: params.projectRoot,
      originals: params.originals,
      changes: [change],
    })));
    const answer = await prompts({
      type: 'confirm',
      name: 'approve',
      message: `Apply this review-only AI change to ${escapeTerminalControls(change.file)}? ` +
        escapeTerminalControls(change.reason),
      initial: false,
    });
    if (!(answer as { approve?: boolean }).approve) {
      console.log(chalk.gray('Review-only AI change declined. No files changed.'));
      return false;
    }
  }

  return true;
}

const hasCleanGitStatus = (projectRoot: string, command: string): boolean => {
  try {
    const status = execSync(command, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim() === '';
  } catch {
    return false;
  }
};

const usesStrictExpoRuntimeAuthority = (
  projectRoot: string,
  virtualConfig?: InitProjectOptions['virtualConfig'],
): boolean => {
  const configFile = inspectPlanningFile(projectRoot, 'bundle.drop.config.js');
  const configContent = configFile.exists
    ? configFile.content
    : virtualConfig?.content;
  return Boolean(configContent && EXPO_RUNTIME_AUTHORITY_PATTERN.test(configContent));
};

const hasCleanGitWorktree = (projectRoot: string): boolean =>
  hasCleanGitStatus(projectRoot, 'git status --porcelain');

type NativePrebuildBackup = {
  projectRoot: string;
  backupDir: string;
  existingDirectories: string[];
};

const restoreNativePrebuild = (backup: NativePrebuildBackup, reason: string) => {
  const failedRoot = path.join(backup.backupDir, reason);
  fs.mkdirSync(failedRoot);
  for (const directory of ['ios', 'android']) {
    const current = path.join(backup.projectRoot, directory);
    const failed = path.join(failedRoot, directory);
    try {
      fs.lstatSync(current);
      fs.renameSync(current, failed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (backup.existingDirectories.includes(directory)) {
      inspectProjectDirectory(backup.backupDir, directory);
      fs.copySync(path.join(backup.backupDir, directory), current, { preserveTimestamps: true });
    }
  }
};

const runLayeredPrebuild = (projectRoot: string): NativePrebuildBackup => {
  const expoCli = require.resolve('expo/bin/cli', { paths: [projectRoot] });
  const backupDir = createSafeBackupDirectory(projectRoot, 'prebuild');
  const existingDirectories = ['ios', 'android'].filter(directory =>
    inspectProjectDirectory(projectRoot, directory),
  );
  const backup = { projectRoot, backupDir, existingDirectories };
  for (const directory of existingDirectories) {
    fs.copySync(path.join(projectRoot, directory), path.join(backupDir, directory), {
      preserveTimestamps: true,
    });
  }

  try {
    execFileSync(process.execPath, [expoCli, 'prebuild', '--no-install'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, BUNDLE_DROP_PREBUILD: '1' },
    });
  } catch (error) {
    restoreNativePrebuild(backup, 'failed-generated');
    throw new Error(
      `Expo prebuild failed. Original native directories were restored; failed output is in ${backupDir}. ` +
        `${(error as Error).message}`,
    );
  }
  return backup;
};

const hasBundleDropPlugin = (exp: Record<string, any>): boolean => {
  const plugins = (exp.plugins || []).map((plugin: unknown) =>
    typeof plugin === 'string' ? plugin : Array.isArray(plugin) ? plugin[0] : null,
  );
  return plugins.includes(PACKAGE_NAME);
};

const assertBundleDropPluginPresent = (projectRoot: string) => {
  if (!hasBundleDropPlugin(evaluateExpoConfig(projectRoot).exp)) {
    throw new Error(
      'Evaluated Expo config does not include the Bundle Drop plugin. ' +
        'For dynamic config, keep the AI-proposed app.config patch and try again.',
    );
  }
};

const isSummarizedSetupContext = (file: { kind: string; path: string }) =>
  file.kind === 'package_manifest' ||
  file.kind === 'bundle_drop_config' ||
  file.kind === 'metro_config' ||
  file.path === 'app.json';

const describeAiDestination = (serverUrl: string) => {
  const parsed = new URL(serverUrl);
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2'].includes(parsed.hostname);
  const destinationType = isLocal
    ? 'local development AI server'
    : isBundleDropHostedAiPlanningServer(parsed.origin)
      ? 'external Bundle Drop AI service'
      : 'external AI planning server';
  return `${parsed.origin} (${destinationType})`;
};

async function requestContextConsent(
  files: Array<{ path: string; kind: string; content: string }>,
  serverUrl: string,
  yes?: boolean,
) {
  console.log(chalk.gray(`AI setup destination: ${describeAiDestination(serverUrl)}`));
  const contextSize = files.reduce(
    (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
    0,
  );
  console.log(chalk.gray(`Provider context size: ${contextSize} bytes.`));
  console.log(chalk.gray('Files proposed for AI setup planning:'));
  files.forEach(file => {
    const disclosure = isSummarizedSetupContext(file) ? 'summary only' : 'full content';
    console.log(chalk.gray(`  - ${file.path} (${file.kind}, ${disclosure})`));
  });
  if (yes) return true;
  const answer = await prompts({
    type: 'confirm',
    name: 'send',
    message: 'Share the listed full-content and summarized context with this AI destination?',
    initial: true,
  });
  return Boolean((answer as { send?: boolean }).send);
}

const assertSetupOwnershipCompatible = (
  projectType: ProjectType,
  expoUpdatesStatus: 'absent' | 'disabled' | 'active',
) => {
  if (projectType !== 'bare' || expoUpdatesStatus !== 'active') return;
  throw new Error(
    'Active expo-updates was detected in this bare React Native project. ' +
      'Bundle Drop cannot safely choose the native startup authority. Remove or explicitly disable ' +
      'expo-updates, create a new native binary, and retry. No context was shared and no files were changed.',
  );
};

const existingSetupPassesDoctor = async (
  projectRoot: string,
  projectType: ProjectType,
  detected: AiSetupScannerResult['request']['detected'],
) => {
  if (detected.bundleDropStatus !== 'configured') return false;
  if (detected.expoUpdatesStatus === 'active' || detected.codePushDetected) return false;

  try {
    const result = await inspectProject({ cwd: projectRoot, projectType });
    return result.checks.every(check => check.status !== 'error');
  } catch {
    return false;
  }
};

const assertNoCodePushMigrationResidue = (projectRoot: string) => {
  const residuePaths = findCodePushResiduePaths(projectRoot);
  if (!residuePaths.length) return;

  const displayedPaths = residuePaths.slice(0, 20).map(filePath => `  - ${filePath}`);
  if (residuePaths.length > displayedPaths.length) {
    displayedPaths.push(`  - and ${residuePaths.length - displayedPaths.length} more path(s)`);
  }
  throw new Error(
    'CodePush migration cannot continue while local CodePush references remain outside the ' +
      `provider-patched native entrypoints:\n${displayedPaths.join('\n')}\n` +
      'Remove the listed JS wrappers/imports, custom native references, build hooks, and ' +
      'deployment-key configuration manually, then rerun Bundle Drop setup. No files changed.',
  );
};

export async function initProjectConfigAi(options: InitProjectOptions = {}): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const projectType = detectProjectType({ projectRoot, explicitType: options.projectType });
  const scan = scanProjectForAiSetup(projectType, projectRoot, options.virtualConfig);
  const bootstrapChange = planRuntimeDeliveryBootstrap(
    projectRoot,
    options.runtimeDeliveryBootstrap,
  );
  const bootstrapGitignoreChange = planRuntimeDeliveryGitignore(
    projectRoot,
    options.runtimeDeliveryBootstrap,
  );
  assertSetupOwnershipCompatible(projectType, scan.request.detected.expoUpdatesStatus);
  if (
    !bootstrapChange &&
    !bootstrapGitignoreChange &&
    await existingSetupPassesDoctor(projectRoot, projectType, scan.request.detected)
  ) {
    console.log(chalk.green('✅ Bundle Drop setup is already complete. No AI planning is required.'));
    await runDoctor({ projectType, cwd: projectRoot });
    logRuntimeInitializationNextStep();
    return;
  }
  console.log(chalk.cyan(`🧠 Bundle Drop AI setup (${projectType})`));
  if (!(await requestContextConsent(scan.request.files, scan.serverUrl, options.yes))) {
    console.log(chalk.gray('No context sent. No files changed.'));
    return;
  }

  const loading = startLoadingStatus('Requesting typed AI setup plan');
  let plan;
  try {
    plan = await requestAiSetupPlan({
      serverUrl: scan.serverUrl,
      authToken: scan.authToken,
      request: scan.request,
    });
  } finally {
    loading.stop();
  }
  assertSafeProviderPlan(plan);
  console.log(chalk.cyan('\nSetup summary:'));
  console.log(escapeTerminalControls(plan.summary));
  plan.warnings.forEach(warning =>
    console.log(chalk.yellow(`⚠️ ${escapeTerminalControls(warning)}`))
  );
  plan.actions.forEach(action => {
    const confirmation = action.requiresConfirmation ? ' (confirmation required)' : '';
    console.log(chalk.gray(
      `  - ${escapeTerminalControls(action.type)}${confirmation}: ` +
        escapeTerminalControls(action.reason),
    ));
  });

  if (plan.confidence === 'low') {
    if (options.virtualConfig && !options.dryRun) {
      const configFile = inspectProjectFile(projectRoot, 'bundle.drop.config.js');
      if (!configFile.exists) {
        writeProjectFileAtomically(
          projectRoot,
          'bundle.drop.config.js',
          options.virtualConfig.content,
        );
        const configPath = path.join(projectRoot, 'bundle.drop.config.js');
        console.log(chalk.green(`Project config retained at ${configPath}`));
      }
    }
    console.log(chalk.yellow('AI confidence is low. Native and Expo setup files were not changed.'));
    console.log(chalk.gray(`Manual setup: ${DOCS_MANUAL_SETUP_URL}`));
    return;
  }
  if (projectType === 'expo' && scan.request.detected.expoUpdatesStatus === 'active') {
    if (!options.migrateExpoUpdates && !options.yes) {
      const migrationAnswer = await prompts({
        type: 'confirm',
        name: 'migrate',
        message: 'Remove active expo-updates and require a new native binary?',
        initial: false,
      });
      options.migrateExpoUpdates = Boolean((migrationAnswer as { migrate?: boolean }).migrate);
    }
    if (!options.migrateExpoUpdates) {
      throw new Error(
        'Active expo-updates blocks Bundle Drop setup. Re-run with --migrate-expo-updates ' +
          'after reviewing the plan; a new native binary will be required.',
      );
    }
  }
  if (projectType === 'bare' && scan.request.detected.codePushDetected) {
    if (!options.migrateCodePush && !options.yes) {
      const migrationAnswer = await prompts({
        type: 'confirm',
        name: 'migrate',
        message: 'Remove react-native-code-push and migrate native startup ownership to Bundle Drop?',
        initial: false,
      });
      options.migrateCodePush = Boolean((migrationAnswer as { migrate?: boolean }).migrate);
    }
    if (!options.migrateCodePush) {
      throw new Error(
        'CodePush blocks Bundle Drop setup. Re-run with --migrate-code-push after reviewing ' +
          'the plan; a new native binary will be required.',
      );
    }
  }
  const shouldMigrateCodePush =
    projectType === 'bare' &&
    scan.request.detected.codePushDetected &&
    Boolean(options.migrateCodePush);
  if (shouldMigrateCodePush) assertNoCodePushMigrationResidue(projectRoot);

  for (const action of plan.actions.filter(action =>
    action.requiresConfirmation &&
      action.type !== 'migrate_expo_updates' &&
      action.type !== 'migrate_codepush'
  )) {
    if (options.yes) continue;
    const actionAnswer = await prompts({
      type: 'confirm',
      name: 'proceed',
      message: `Proceed with ${escapeTerminalControls(action.type)}? ` +
        escapeTerminalControls(action.reason),
      initial: false,
    });
    if (!(actionAnswer as { proceed?: boolean }).proceed) {
      console.log(chalk.gray('Required setup action declined. No files changed.'));
      return;
    }
  }

  const originals = new Map(scan.request.files.map(file => [file.path, file.content]));
  if (!await confirmReviewOnlyChanges({
    projectRoot,
    originals,
    changes: plan.changes,
    yes: options.yes,
    dryRun: options.dryRun,
  })) {
    return;
  }
  const aiChanges = plan.changes.filter(shouldApplyAiChange);
  validateSetupChangesBeforeApply({
    projectType,
    originals,
    changes: aiChanges,
    migrateExpoUpdates: Boolean(options.migrateExpoUpdates),
  });

  if (projectType === 'bare') {
    const metroChange = planBareMetroConfig(projectRoot);
    const bundleConfigFile = inspectPlanningFile(projectRoot, 'bundle.drop.config.js');
    const bundleConfigExists = bundleConfigFile.exists;
    const bundleConfig = bundleConfigExists
      ? bundleConfigFile.content
      : options.virtualConfig?.content;
    const updatedBundleConfig = bundleConfig
      ? setBundleDropProjectType(bundleConfig, 'bare')
      : null;
    const bundleConfigChange = updatedBundleConfig &&
        (!bundleConfigExists || updatedBundleConfig !== bundleConfig)
      ? {
          file: 'bundle.drop.config.js',
          original: bundleConfigExists ? bundleConfig! : null,
          updated: updatedBundleConfig,
          reason: 'Persist the reviewed bare React Native project type.',
        }
      : null;
    const localChanges = [
      metroChange,
      bundleConfigChange,
      bootstrapChange,
      bootstrapGitignoreChange,
    ].filter(
      (change): change is NonNullable<typeof change> => Boolean(change),
    );
    if (!aiChanges.length && !localChanges.length && !shouldMigrateCodePush) {
      console.log(chalk.gray('No bare native changes are required.'));
      if (!options.dryRun) {
        await runDoctor({ projectType: 'bare', cwd: projectRoot });
        logRuntimeInitializationNextStep();
      }
      return;
    }
    const bareOriginals = new Map(originals);
    const previewChanges = [...aiChanges];
    for (const localChange of localChanges) {
      bareOriginals.set(localChange.file, localChange.original || '');
      previewChanges.push({
        file: localChange.file,
        originalSha256: sha256(localChange.original || ''),
        updated: localChange.updated,
        reason: localChange.reason,
        confidence: 'high',
        decisionType: 'safe_auto_patch',
      });
    }
    console.log(chalk.cyan('\nProposed changes:'));
    console.log(colorizeUnifiedDiff(buildUnifiedDiff({
      projectRoot,
      originals: bareOriginals,
      changes: previewChanges,
    })));
    if (shouldMigrateCodePush) {
      const command = codePushRemovalCommand(detectPackageManager(projectRoot));
      console.log(chalk.yellow(`Dependency migration command: ${command.join(' ')}`));
    }
    if (options.dryRun) {
      console.log(chalk.gray('Dry run complete. No files changed.'));
      return;
    }
    const answer = options.yes ? { apply: true } : await prompts({
      type: 'confirm', name: 'apply', message: 'Apply these setup changes?', initial: true,
    });
    if (!(answer as { apply?: boolean }).apply) {
      console.log(chalk.gray('No files changed.'));
      return;
    }
    let dependencyBackup: ReturnType<typeof removeCodePushWithPackageManager> | undefined;
    let result: ReturnType<typeof applySetupPatchPlans> | undefined;
    let metroResult: ReturnType<typeof applyExpoConfigurationChanges> | undefined;
    try {
      if (shouldMigrateCodePush) {
        dependencyBackup = removeCodePushWithPackageManager(projectRoot);
      }
      result = applySetupPatchPlans({ projectRoot, projectType, changes: aiChanges });
      validateAppliedSetupChanges({
        projectRoot,
        projectType,
        changes: aiChanges,
        migrateExpoUpdates: false,
        originals,
      });
      if (localChanges.length) {
        metroResult = applyExpoConfigurationChanges({
          projectRoot,
          changes: localChanges,
        });
      }
      await runDoctor({ projectType: 'bare', cwd: projectRoot });
    } catch (error) {
      if (metroResult) restoreExpoConfiguration(metroResult);
      if (result) restoreSetupBackups(result);
      if (dependencyBackup) {
        restoreDependencyMigration(dependencyBackup);
        console.log(chalk.yellow(
          'Package files were restored; reinstall dependencies to repair node_modules.',
        ));
      }
      throw error;
    }
    if (!result) throw new Error('Bare setup transaction completed without a backup result.');
    console.log(chalk.green(`✅ Bare React Native setup complete. Backups: ${result.backupDir}`));
    logRuntimeInitializationNextStep();
    return;
  }

  const hasNativeDirectories = scan.request.detected.hasNativeDirectories;
  const usesStrictRuntimeAuthority = usesStrictExpoRuntimeAuthority(
    projectRoot,
    options.virtualConfig,
  );
  if (hasNativeDirectories && usesStrictRuntimeAuthority && !hasCleanGitWorktree(projectRoot)) {
    throw new Error(
      'Strict Expo runtime authority requires a clean Git worktree before layered native prebuild.',
    );
  }
  const deterministic = planExpoProjectConfiguration({
    projectRoot,
    migrateExpoUpdates: Boolean(options.migrateExpoUpdates),
    bundleConfigContent: options.virtualConfig?.content,
  });
  const deterministicPaths = new Set(deterministic.map(change => change.file));
  const unusualAiChanges = aiChanges.filter(change => !deterministicPaths.has(change.file));
  if (hasDynamicExpoConfig(projectRoot)) {
    const evaluatedConfig = evaluateExpoConfig(projectRoot);
    const dynamicConfigFile = authoritativeDynamicExpoConfigFile(
      projectRoot,
      evaluatedConfig.dynamicConfigPath,
    );
    if (!dynamicConfigFile) {
      throw new Error(
        'Expo did not identify the authoritative dynamic app config path. No files changed.',
      );
    }
    if (
      !hasBundleDropPlugin(evaluatedConfig.exp) &&
      !unusualAiChanges.some(change => change.file === dynamicConfigFile)
    ) {
      throw new Error(
        `Dynamic Expo config requires an allowlisted AI patch for its evaluated root config ` +
          `(${dynamicConfigFile}); no safe patch was proposed.`,
      );
    }
  }
  const combinedChanges = [
    ...deterministic,
    ...(bootstrapChange ? [bootstrapChange] : []),
    ...unusualAiChanges.map(change => ({
      file: change.file,
      original: originals.get(change.file) ?? null,
      updated: change.updated,
      reason: change.reason,
    })),
  ];
  const combinedOriginals = new Map(
    combinedChanges.map(change => [change.file, change.original || '']),
  );
  const combinedPatchPlans: AiPatchPlan[] = combinedChanges.map(change => ({
    file: change.file,
    originalSha256: sha256(change.original || ''),
    updated: change.updated,
    reason: change.reason,
    confidence: 'high',
    decisionType: 'safe_auto_patch',
  }));
  console.log(chalk.cyan('\nProposed changes:'));
  console.log(colorizeUnifiedDiff(buildUnifiedDiff({
    projectRoot,
    originals: combinedOriginals,
    changes: combinedPatchPlans,
  })));
  if (options.migrateExpoUpdates) {
    const command = expoUpdatesRemovalCommand(detectPackageManager(projectRoot));
    console.log(chalk.yellow(`Dependency migration command: ${command.join(' ')}`));
  }
  if (hasNativeDirectories) {
    console.log(chalk.yellow(`Layered prebuild command: ${process.execPath} <project-local expo> prebuild --no-install`));
  } else {
    console.log(chalk.gray('Managed/CNG project: native directories will remain absent.'));
  }
  if (options.dryRun) {
    console.log(chalk.gray('Dry run complete. No files changed.'));
    return;
  }

  const applyAnswer = options.yes ? { apply: true } : await prompts({
    type: 'confirm', name: 'apply', message: 'Apply the complete Expo setup plan?', initial: true,
  });
  if (!(applyAnswer as { apply?: boolean }).apply) {
    console.log(chalk.gray('No files changed.'));
    return;
  }
  if (hasNativeDirectories && !options.prebuild) {
    const prebuildAnswer = options.yes ? { prebuild: false } : await prompts({
      type: 'confirm',
      name: 'prebuild',
      message: 'Run the previewed layered Expo prebuild after applying configuration?',
      initial: true,
    });
    if (!(prebuildAnswer as { prebuild?: boolean }).prebuild) {
      console.log(chalk.gray('Prebuild declined. No files changed.'));
      return;
    }
    options.prebuild = true;
  }

  let dependencyBackup: ReturnType<typeof removeExpoUpdatesWithPackageManager> | undefined;
  let applyResult: ReturnType<typeof applyExpoConfigurationChanges> | undefined;
  let prebuildBackup: NativePrebuildBackup | undefined;
  try {
    if (options.migrateExpoUpdates) {
      dependencyBackup = removeExpoUpdatesWithPackageManager(projectRoot);
    }
    applyResult = applyExpoConfigurationChanges({
      projectRoot,
      changes: combinedChanges.filter(change => change.file !== 'package.json'),
    });
    validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: unusualAiChanges,
      migrateExpoUpdates: Boolean(options.migrateExpoUpdates),
      originals,
    });
    assertBundleDropPluginPresent(projectRoot);
    if (hasNativeDirectories && options.prebuild) {
      prebuildBackup = runLayeredPrebuild(projectRoot);
      console.log(chalk.gray(`Native prebuild backup: ${prebuildBackup.backupDir}`));
    }
    await runDoctor({ projectType: 'expo', cwd: projectRoot });
  } catch (error) {
    if (prebuildBackup) restoreNativePrebuild(prebuildBackup, 'failed-validation');
    if (applyResult) restoreExpoConfiguration(applyResult);
    if (dependencyBackup) {
      restoreDependencyMigration(dependencyBackup);
      console.log(chalk.yellow('Package files were restored; reinstall dependencies to repair node_modules.'));
    }
    throw error;
  }
  console.log(chalk.green(`✅ Expo setup complete. Backups: ${applyResult.backupDir}`));
  logRuntimeInitializationNextStep();
  if (!hasNativeDirectories) {
    console.log(chalk.gray('Run expo run:*, explicit prebuild/manual build, or EAS Build to generate native integration.'));
  }
}

export default initProjectConfigAi;
