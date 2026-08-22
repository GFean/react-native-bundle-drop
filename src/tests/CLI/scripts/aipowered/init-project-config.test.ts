import type {
  AiPatchPlan,
  AiSetupPlanResponse,
  AiSetupScannerResult,
} from '../../../../CLI/scripts/aipowered/types';
import fs from 'fs-extra';
import path from 'path';
import { queuePromptResponse } from '../../../mocks/modules/prompts';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

const mockDetectProjectType = jest.fn();
const mockEvaluateExpoConfig = jest.fn();
const mockScanProjectForAiSetup = jest.fn();
const mockRequestAiSetupPlan = jest.fn();
const mockFindCodePushResiduePaths = jest.fn();
const mockValidateSetupChangesBeforeApply = jest.fn();
const mockValidateAppliedSetupChanges = jest.fn();
const mockApplySetupPatchPlans = jest.fn();
const mockRestoreSetupBackups = jest.fn();
const mockPlanBareMetroConfig = jest.fn();
const mockInspectProject = jest.fn();
const mockRunDoctor = jest.fn();
const mockPlanExpoProjectConfiguration = jest.fn();
const mockHasDynamicExpoConfig = jest.fn();
const mockApplyExpoConfigurationChanges = jest.fn();
const mockRestoreExpoConfiguration = jest.fn();
const mockSetBundleDropProjectType = jest.fn((content: string, projectType: string) =>
  content.replace('module.exports = {', `module.exports = {\n  projectType: '${projectType}',`),
);
const mockDetectPackageManager = jest.fn();
const mockCodePushRemovalCommand = jest.fn();
const mockExpoUpdatesRemovalCommand = jest.fn();
const mockRemoveCodePushWithPackageManager = jest.fn();
const mockRemoveExpoUpdatesWithPackageManager = jest.fn();
const mockRestoreDependencyMigration = jest.fn();
const mockExecSync = jest.fn();
const mockExecFileSync = jest.fn();
const mockLoadingStop = jest.fn();

jest.mock('prompts', () => require('../../../mocks/modules/prompts'));
jest.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));
jest.mock('../../../../expo', () => ({
  detectProjectType: (...args: unknown[]) => mockDetectProjectType(...args),
  evaluateExpoConfig: (...args: unknown[]) => mockEvaluateExpoConfig(...args),
}));
jest.mock('../../../../CLI/scripts/aipowered/scanner', () => ({
  authoritativeDynamicExpoConfigFile: (_root: string, candidate: unknown) => {
    if (typeof candidate !== 'string' || !candidate) return null;
    if (candidate.startsWith('../') || candidate.startsWith('/outside')) {
      throw new Error(`Expo reported an unsafe dynamic app config path: ${candidate}. No files changed.`);
    }
    return candidate.replace(/^\/project\//, '');
  },
  findProjectRoot: (startDir: string) => startDir,
  isBundleDropHostedAiPlanningServer: (serverUrl: string) =>
    serverUrl === 'https://api.bundledrop.app',
  scanProjectForAiSetup: (...args: unknown[]) => mockScanProjectForAiSetup(...args),
}));
jest.mock('../../../../CLI/scripts/aipowered/backend-client', () => ({
  requestAiSetupPlan: (...args: unknown[]) => mockRequestAiSetupPlan(...args),
}));
jest.mock('../../../../CLI/scripts/aipowered/code-push-residue', () => ({
  findCodePushResiduePaths: (...args: unknown[]) => mockFindCodePushResiduePaths(...args),
}));
jest.mock('../../../../CLI/scripts/aipowered/validate-plan', () => ({
  validateSetupChangesBeforeApply: (...args: unknown[]) =>
    mockValidateSetupChangesBeforeApply(...args),
  validateAppliedSetupChanges: (...args: unknown[]) =>
    mockValidateAppliedSetupChanges(...args),
}));
jest.mock('../../../../CLI/scripts/aipowered/apply-setup-plan', () => ({
  applySetupPatchPlans: (...args: unknown[]) => mockApplySetupPatchPlans(...args),
  restoreSetupBackups: (...args: unknown[]) => mockRestoreSetupBackups(...args),
}));
jest.mock('../../../../CLI/scripts/bare-metro-config', () => ({
  planBareMetroConfig: (...args: unknown[]) => mockPlanBareMetroConfig(...args),
}));
jest.mock('../../../../CLI/scripts/doctor', () => ({
  inspectProject: (...args: unknown[]) => mockInspectProject(...args),
  runDoctor: (...args: unknown[]) => mockRunDoctor(...args),
}));
jest.mock('../../../../CLI/scripts/expo/configure-expo', () => ({
  planExpoProjectConfiguration: (...args: unknown[]) =>
    mockPlanExpoProjectConfiguration(...args),
  hasDynamicExpoConfig: (...args: unknown[]) => mockHasDynamicExpoConfig(...args),
  applyExpoConfigurationChanges: (...args: unknown[]) =>
    mockApplyExpoConfigurationChanges(...args),
  restoreExpoConfiguration: (...args: unknown[]) => mockRestoreExpoConfiguration(...args),
  setBundleDropProjectType: (...args: [string, string]) =>
    mockSetBundleDropProjectType(...args),
}));
jest.mock('../../../../CLI/scripts/expo/package-manager', () => ({
  codePushRemovalCommand: (...args: unknown[]) => mockCodePushRemovalCommand(...args),
  detectPackageManager: (...args: unknown[]) => mockDetectPackageManager(...args),
  expoUpdatesRemovalCommand: (...args: unknown[]) => mockExpoUpdatesRemovalCommand(...args),
  removeCodePushWithPackageManager: (...args: unknown[]) =>
    mockRemoveCodePushWithPackageManager(...args),
  removeExpoUpdatesWithPackageManager: (...args: unknown[]) =>
    mockRemoveExpoUpdatesWithPackageManager(...args),
  restoreDependencyMigration: (...args: unknown[]) => mockRestoreDependencyMigration(...args),
}));
jest.mock('../../../../CLI/scripts/aipowered/diff-preview', () => ({
  buildUnifiedDiff: jest.fn(() => 'plain diff'),
  colorizeUnifiedDiff: jest.fn(() => 'colored diff'),
}));
jest.mock('../../../../CLI/utils/ui', () => ({
  startLoadingStatus: jest.fn(() => ({ stop: mockLoadingStop })),
}));

import { initProjectConfigAi } from '../../../../CLI/scripts/aipowered/init-project-config';

const projectRoot = '/project';
const bareChange: AiPatchPlan = {
  file: 'android/app/src/main/java/com/demo/MainApplication.kt',
  originalSha256: 'original-hash',
  updated: 'BundleDropModule.resolveJSBundleFile(this, null)',
  reason: 'Configure native resolver',
  confidence: 'high',
  decisionType: 'safe_auto_patch',
};
const dynamicConfigChange: AiPatchPlan = {
  file: 'app.config.ts',
  originalSha256: 'dynamic-hash',
  updated: 'export default ({ config }) => ({ ...config, plugins: ["@gfean/react-native-bundle-drop"] });',
  reason: 'Register plugin in dynamic config',
  confidence: 'high',
  decisionType: 'review_only_patch',
};

const scanner = (
  projectType: 'expo' | 'bare',
  overrides: Partial<AiSetupScannerResult['request']['detected']> = {},
): AiSetupScannerResult => ({
  projectRoot,
  serverUrl: 'https://api.example.com',
  orgSlug: 'alpha-org',
  projectSlug: 'demo-app',
  authToken: 'pat-token',
  request: {
    schemaVersion: 1,
    orgSlug: 'alpha-org',
    projectSlug: 'demo-app',
    projectType,
    detected: {
      rnVersion: '0.86.0',
      expoSdkVersion: projectType === 'expo' ? '57.0.0' : null,
      bundleDropStatus: 'partial',
      hasNativeDirectories: false,
      usesExpoRouter: projectType === 'expo',
      jsEngine: 'hermes',
      expoUpdatesStatus: 'absent',
      codePushDetected: false,
      signals: [],
      ...overrides,
    },
    files: [
      {
        path: bareChange.file,
        kind: 'android_entrypoint',
        content: 'original native source',
        sha256: 'original-hash',
      },
      {
        path: 'app.config.ts',
        kind: 'expo_app_config',
        content: 'original dynamic config',
        sha256: 'dynamic-hash',
      },
    ],
  },
});

const plan = (overrides: Partial<AiSetupPlanResponse> = {}): AiSetupPlanResponse => ({
  confidence: 'high',
  summary: 'Setup is ready',
  actions: [{ type: 'run_doctor', reason: 'Validate integration', requiresConfirmation: false }],
  changes: [],
  warnings: [],
  ...overrides,
});

describe('initProjectConfigAi', () => {
  const temporaryRoots: string[] = [];
  let cwdSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockDetectProjectType.mockReturnValue('bare');
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare'));
    mockRequestAiSetupPlan.mockResolvedValue(plan());
    mockFindCodePushResiduePaths.mockReturnValue([]);
    mockApplySetupPatchPlans.mockReturnValue({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/native',
      changedFiles: [{ file: bareChange.file, existed: true }],
    });
    mockPlanBareMetroConfig.mockReturnValue(null);
    mockInspectProject.mockResolvedValue({
      projectRoot,
      projectType: 'bare',
      checks: [],
    });
    mockRunDoctor.mockResolvedValue(undefined);
    mockExecSync.mockReturnValue('');
    mockPlanExpoProjectConfiguration.mockReturnValue([]);
    mockHasDynamicExpoConfig.mockReturnValue(false);
    mockApplyExpoConfigurationChanges.mockReturnValue({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/expo',
      changedFiles: [],
    });
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: ['@gfean/react-native-bundle-drop'], updates: { enabled: false } },
    });
    mockDetectPackageManager.mockReturnValue('yarn');
    mockCodePushRemovalCommand.mockReturnValue(['yarn', 'remove', 'react-native-code-push']);
    mockExpoUpdatesRemovalCommand.mockReturnValue(['yarn', 'remove', 'expo-updates']);
    mockRemoveCodePushWithPackageManager.mockReturnValue({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/code-push',
      files: ['package.json', 'yarn.lock'],
    });
    mockRemoveExpoUpdatesWithPackageManager.mockReturnValue({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/dependency',
      files: ['package.json', 'yarn.lock'],
    });
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    consoleLogSpy.mockRestore();
    for (const root of temporaryRoots.splice(0)) removeTempDir(root);
  });

  const createCommittedNativeProject = () => {
    const root = createTempProjectDir();
    temporaryRoots.push(root);
    fs.ensureDirSync(path.join(root, 'node_modules/expo/bin'));
    fs.writeFileSync(path.join(root, 'node_modules/expo/bin/cli.js'), 'module.exports = {};\n');
    fs.ensureDirSync(path.join(root, 'ios'));
    fs.ensureDirSync(path.join(root, 'android'));
    fs.writeFileSync(path.join(root, 'ios/Podfile'), 'platform :ios\n');
    fs.writeFileSync(path.join(root, 'android/settings.gradle'), 'rootProject.name = "fixture"\n');
    cwdSpy.mockReturnValue(root);
    return root;
  };

  it('sends allowlisted context only after consent and stops the loading state', async () => {
    queuePromptResponse({ send: true });

    await initProjectConfigAi();

    expect(mockRequestAiSetupPlan).toHaveBeenCalledWith({
      serverUrl: 'https://api.example.com',
      authToken: 'pat-token',
      request: scanner('bare').request,
    });
    expect(mockLoadingStop).toHaveBeenCalledTimes(1);
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://api.example.com (external AI planning server)'),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Provider context size:'),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('MainApplication.kt (android_entrypoint, full content)'),
    );
  });

  it('makes zero provider calls when scanner context exceeds the local prompt budget', async () => {
    mockScanProjectForAiSetup.mockImplementation(() => {
      throw new Error('including it would exceed the 131072-byte total context limit');
    });

    await expect(initProjectConfigAi()).rejects.toThrow('131072-byte total context limit');
    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
  });

  it('rejects provider terminal controls before printing metadata or diffs', async () => {
    queuePromptResponse({ send: true });
    mockRequestAiSetupPlan.mockResolvedValue(plan({
      summary: 'unsafe\x1b[2J summary',
      warnings: ['overwrite\rwarning'],
      actions: [{
        type: 'run_doctor',
        reason: 'bidi\u202Ereason',
        requiresConfirmation: false,
      }],
    }));

    await expect(initProjectConfigAi()).rejects.toThrow('unsafe terminal controls in summary');
    const displayed = consoleLogSpy.mock.calls.flat().map(String).join('\n');
    expect(displayed).not.toContain('\x1b[2J');
    expect(displayed).not.toContain('\u202E');
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it('rejects a provider credential before printing or applying it', async () => {
    const secret = 'bdp_pat_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
    queuePromptResponse({ send: true });
    mockRequestAiSetupPlan.mockResolvedValue(plan({ summary: `Use ${secret}` }));

    await expect(initProjectConfigAi()).rejects.toThrow('private Bundle Drop credential');
    expect(consoleLogSpy.mock.calls.flat().join('\n')).not.toContain(secret);
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it('runs doctor locally and skips consent and AI when setup is already healthy', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', {
      bundleDropStatus: 'configured',
    }));
    mockInspectProject.mockResolvedValue({
      projectRoot,
      projectType: 'expo',
      checks: [
        { name: 'Expo plugin', status: 'pass', message: 'Configured.' },
        { name: 'Expo Go', status: 'warning', message: 'OTA disabled.' },
      ],
    });

    await initProjectConfigAi();

    expect(mockInspectProject).toHaveBeenCalledWith({ cwd: projectRoot, projectType: 'expo' });
    expect(mockRunDoctor).toHaveBeenCalledWith({ projectType: 'expo', cwd: projectRoot });
    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
    expect(mockPlanExpoProjectConfiguration).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('No AI planning is required'),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://bundledrop.app/docs/installation#initialize-bundle-drop-in-javascript',
      ),
    );
  });

  it('skips the AI provider when a migrated bare project rescans as configured', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', {
      bundleDropStatus: 'configured',
      codePushDetected: false,
    }));
    mockInspectProject.mockResolvedValue({
      projectRoot,
      projectType: 'bare',
      checks: [{ name: 'Native startup', status: 'pass', message: 'Configured.' }],
    });

    await initProjectConfigAi();

    expect(mockInspectProject).toHaveBeenCalledWith({ cwd: projectRoot, projectType: 'bare' });
    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
    expect(mockRunDoctor).toHaveBeenCalledWith({ projectType: 'bare', cwd: projectRoot });
  });

  it('continues through setup when doctor finds a blocking issue', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', {
      bundleDropStatus: 'configured',
    }));
    mockInspectProject.mockResolvedValue({
      projectRoot,
      projectType: 'bare',
      checks: [{ name: 'Metro alias', status: 'error', message: 'Missing.' }],
    });
    queuePromptResponse({ send: true });

    await initProjectConfigAi();

    expect(mockRequestAiSetupPlan).toHaveBeenCalledTimes(1);
    expect(mockRunDoctor).toHaveBeenCalledWith({ projectType: 'bare', cwd: projectRoot });
  });

  it('continues through setup when local doctor inspection cannot determine health', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', {
      bundleDropStatus: 'configured',
    }));
    mockInspectProject.mockRejectedValue(new Error('Unable to evaluate native configuration'));
    queuePromptResponse({ send: true });

    await initProjectConfigAi();

    expect(mockRequestAiSetupPlan).toHaveBeenCalledTimes(1);
  });

  it('does not locally skip projects with unresolved migrations', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', {
      bundleDropStatus: 'configured',
      expoUpdatesStatus: 'active',
    }));
    queuePromptResponse({ send: false });

    await initProjectConfigAi();

    expect(mockInspectProject).not.toHaveBeenCalled();
    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
  });

  it('does not call AI or mutate files when context sharing is declined', async () => {
    queuePromptResponse({ send: false });

    await initProjectConfigAi();

    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
  });

  it('identifies the production Bundle Drop AI destination and summarized files before consent', async () => {
    const context = scanner('bare');
    context.serverUrl = 'https://api.bundledrop.app';
    context.request.files[0].kind = 'package_manifest';
    mockScanProjectForAiSetup.mockReturnValue(context);
    queuePromptResponse({ send: false });

    await initProjectConfigAi();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://api.bundledrop.app (external Bundle Drop AI service)',
      ),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('package_manifest, summary only'),
    );
    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
  });

  it('identifies a local development AI destination before consent', async () => {
    const context = scanner('bare');
    context.serverUrl = 'http://127.0.0.1:4040';
    mockScanProjectForAiSetup.mockReturnValue(context);
    queuePromptResponse({ send: false });

    await initProjectConfigAi();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:4040 (local development AI server)'),
    );
    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
  });

  it('stops without validation or mutation when AI confidence is low', async () => {
    mockRequestAiSetupPlan.mockResolvedValue(plan({ confidence: 'low', changes: [bareChange] }));

    await initProjectConfigAi({ yes: true });

    expect(mockValidateSetupChangesBeforeApply).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Manual setup: https://bundledrop.app/docs/manual-setup'),
    );
  });

  it('retains a virtual project config before handing low-confidence setup to the manual guide', async () => {
    const root = createTempProjectDir();
    temporaryRoots.push(root);
    cwdSpy.mockReturnValue(root);
    const configContent = 'module.exports = { projectType: "bare" };\n';
    mockRequestAiSetupPlan.mockResolvedValue(plan({ confidence: 'low', changes: [bareChange] }));

    await initProjectConfigAi({
      yes: true,
      virtualConfig: {
        content: configContent,
        serverUrl: 'https://api.example.com',
        orgSlug: 'alpha-org',
        projectSlug: 'demo-app',
        authToken: 'pat-token',
      },
    });

    expect(fs.readFileSync(path.join(root, 'bundle.drop.config.js'), 'utf8')).toBe(configContent);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Project config retained at ${root}`),
    );
  });

  it('does not follow a virtual-config symlink on the low-confidence retention path', async () => {
    const root = createTempProjectDir();
    const outsideRoot = createTempProjectDir();
    temporaryRoots.push(root, outsideRoot);
    cwdSpy.mockReturnValue(root);
    const outsideConfig = path.join(outsideRoot, 'outside-config.js');
    fs.writeFileSync(outsideConfig, 'outside-safe');
    fs.symlinkSync(outsideConfig, path.join(root, 'bundle.drop.config.js'));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ confidence: 'low', changes: [bareChange] }));

    await expect(initProjectConfigAi({
      yes: true,
      virtualConfig: {
        content: 'module.exports = { projectType: "bare" };\n',
        serverUrl: 'https://api.example.com',
        orgSlug: 'alpha-org',
        projectSlug: 'demo-app',
        authToken: 'pat-token',
      },
    })).rejects.toThrow('symlinked or non-regular');

    expect(fs.readFileSync(outsideConfig, 'utf8')).toBe('outside-safe');
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it('shows summarized context and stops when a required AI action is declined', async () => {
    const context = scanner('bare');
    context.request.files[0].kind = 'package_manifest';
    mockScanProjectForAiSetup.mockReturnValue(context);
    mockRequestAiSetupPlan.mockResolvedValue(plan({
      warnings: ['Review the native rebuild requirement.'],
      actions: [{
        type: 'require_native_rebuild',
        reason: 'The integration changes native startup.',
        requiresConfirmation: true,
      }],
    }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ proceed: false });

    await initProjectConfigAi();

    expect(mockValidateSetupChangesBeforeApply).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Required setup action declined'),
    );
  });

  it('noninteractively accepts required actions while excluding migration from duplicate confirmation', async () => {
    mockRequestAiSetupPlan.mockResolvedValue(plan({
      actions: [
        {
          type: 'require_native_rebuild',
          reason: 'A new native binary is required.',
          requiresConfirmation: true,
        },
        {
          type: 'migrate_expo_updates',
          reason: 'Migration has its own explicit authorization.',
          requiresConfirmation: true,
        },
      ],
    }));

    await initProjectConfigAi({ yes: true });

    expect(mockValidateSetupChangesBeforeApply).toHaveBeenCalled();
  });

  it('requires explicit diff-backed approval before applying a review-only change', async () => {
    const reviewOnlyChange = { ...bareChange, decisionType: 'review_only_patch' as const };
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [reviewOnlyChange] }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ approve: true });
    queuePromptResponse({ apply: true });

    await initProjectConfigAi();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Review-only proposed change: ${reviewOnlyChange.file}`),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('colored diff');
    expect(mockApplySetupPatchPlans).toHaveBeenCalledWith({
      projectRoot,
      projectType: 'bare',
      changes: [reviewOnlyChange],
    });
  });

  it('leaves the whole transaction unchanged when a review-only change is declined', async () => {
    const reviewOnlyChange = { ...bareChange, decisionType: 'review_only_patch' as const };
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange, reviewOnlyChange] }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ approve: false });

    await initProjectConfigAi();

    expect(mockValidateSetupChangesBeforeApply).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Review-only AI change declined'),
    );
  });

  it('does not let --yes approve a review-only change', async () => {
    const reviewOnlyChange = { ...bareChange, decisionType: 'review_only_patch' as const };
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange, reviewOnlyChange] }));

    await initProjectConfigAi({ yes: true });

    expect(mockValidateSetupChangesBeforeApply).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('--yes cannot approve them. No files changed.'),
    );
  });

  it('allows --yes to preview a review-only change during a dry run', async () => {
    const reviewOnlyChange = { ...bareChange, decisionType: 'review_only_patch' as const };
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [reviewOnlyChange] }));

    await initProjectConfigAi({ yes: true, dryRun: true });

    expect(mockValidateSetupChangesBeforeApply).toHaveBeenCalledWith({
      projectType: 'bare',
      originals: expect.any(Map),
      changes: [reviewOnlyChange],
      migrateExpoUpdates: false,
    });
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it('blocks active expo-updates before previewing or applying changes', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { expoUpdatesStatus: 'active' }));

    await expect(initProjectConfigAi({ yes: true })).rejects.toThrow(
      'Active expo-updates blocks Bundle Drop setup',
    );

    expect(mockPlanExpoProjectConfiguration).not.toHaveBeenCalled();
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
  });

  it('rejects active expo-updates in a bare project before consent or provider access', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', { expoUpdatesStatus: 'active' }));

    await expect(initProjectConfigAi({ yes: true })).rejects.toThrow(
      'Active expo-updates was detected in this bare React Native project',
    );

    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it('does not let --yes bypass a scanner secret-safety rejection', async () => {
    mockScanProjectForAiSetup.mockImplementation(() => {
      throw new Error('Refusing AI setup because app.config.js contains a credential-like property.');
    });

    await expect(initProjectConfigAi({ yes: true })).rejects.toThrow('Refusing AI setup');

    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it('does not POST or echo a private Bundle Drop credential rejected by the scanner', async () => {
    const secret = 'bdp_proj_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
    mockScanProjectForAiSetup.mockImplementation(() => {
      throw new Error(
        'Refusing AI setup because app.config.js contains a Bundle Drop project key.',
      );
    });

    await expect(initProjectConfigAi({ yes: true })).rejects.toThrow('Bundle Drop project key');
    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls.flat().join('\n')).not.toContain(secret);
  });

  it('offers explicit expo-updates migration and continues only when accepted', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { expoUpdatesStatus: 'active' }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ migrate: true });
    queuePromptResponse({ apply: false });

    await initProjectConfigAi();

    expect(mockPlanExpoProjectConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      migrateExpoUpdates: true,
    }));
    expect(mockRemoveExpoUpdatesWithPackageManager).not.toHaveBeenCalled();
  });

  it('keeps active expo-updates intact when interactive migration is declined', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { expoUpdatesStatus: 'active' }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ migrate: false });

    await expect(initProjectConfigAi()).rejects.toThrow(
      'Active expo-updates blocks Bundle Drop setup',
    );

    expect(mockRemoveExpoUpdatesWithPackageManager).not.toHaveBeenCalled();
  });

  it('offers one explicit CodePush migration confirmation and applies it transactionally', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', { codePushDetected: true }));
    mockRequestAiSetupPlan.mockResolvedValue(plan({
      actions: [{
        type: 'migrate_codepush',
        reason: 'Move native startup ownership to Bundle Drop.',
        requiresConfirmation: true,
      }],
      changes: [bareChange],
    }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ migrate: true });
    queuePromptResponse({ apply: true });

    await initProjectConfigAi();

    expect(mockRemoveCodePushWithPackageManager).toHaveBeenCalledWith(projectRoot);
    expect(mockApplySetupPatchPlans).toHaveBeenCalledWith({
      projectRoot,
      projectType: 'bare',
      changes: [bareChange],
    });
    expect(mockRunDoctor).toHaveBeenCalledWith({ projectType: 'bare', cwd: projectRoot });
  });

  it('keeps CodePush intact when interactive migration is declined', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', { codePushDetected: true }));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ migrate: false });

    await expect(initProjectConfigAi()).rejects.toThrow('--migrate-code-push');

    expect(mockRemoveCodePushWithPackageManager).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it('does not let --yes silently authorize CodePush removal', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', { codePushDetected: true }));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));

    await expect(initProjectConfigAi({ yes: true })).rejects.toThrow('--migrate-code-push');

    expect(mockRemoveCodePushWithPackageManager).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it.each([
    'src/App.tsx',
    'android/app/build.gradle',
    'ios/Demo/Info.plist',
  ])('blocks CodePush migration before writes when residue remains in %s', async residuePath => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', { codePushDetected: true }));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));
    mockFindCodePushResiduePaths.mockReturnValue([residuePath]);

    await expect(initProjectConfigAi({ yes: true, migrateCodePush: true })).rejects.toThrow(
      residuePath,
    );

    expect(mockValidateSetupChangesBeforeApply).not.toHaveBeenCalled();
    expect(mockRemoveCodePushWithPackageManager).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
  });

  it('accepts the dedicated CodePush migration flag in noninteractive mode', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', { codePushDetected: true }));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));

    await initProjectConfigAi({ yes: true, migrateCodePush: true });

    expect(mockDetectPackageManager).toHaveBeenCalledWith(projectRoot);
    expect(mockCodePushRemovalCommand).toHaveBeenCalledWith('yarn');
    expect(mockRemoveCodePushWithPackageManager).toHaveBeenCalledWith(projectRoot);
  });

  it('does not run CodePush removal when the dedicated flag is unnecessary', async () => {
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));

    await initProjectConfigAi({ yes: true, migrateCodePush: true });

    expect(mockCodePushRemovalCommand).not.toHaveBeenCalled();
    expect(mockRemoveCodePushWithPackageManager).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).toHaveBeenCalled();
  });

  it('previews the CodePush package command without removing the dependency', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', { codePushDetected: true }));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));

    await initProjectConfigAi({ yes: true, migrateCodePush: true, dryRun: true });

    expect(mockCodePushRemovalCommand).toHaveBeenCalledWith('yarn');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('yarn remove react-native-code-push'),
    );
    expect(mockRemoveCodePushWithPackageManager).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it('restores CodePush package files and native patches when validation fails', async () => {
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', { codePushDetected: true }));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));
    mockValidateAppliedSetupChanges.mockImplementationOnce(() => {
      throw new Error('CodePush migration validation failed');
    });

    await expect(initProjectConfigAi({ yes: true, migrateCodePush: true })).rejects.toThrow(
      'CodePush migration validation failed',
    );

    expect(mockRestoreSetupBackups).toHaveBeenCalledWith({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/native',
      changedFiles: [{ file: bareChange.file, existed: true }],
    });
    expect(mockRestoreDependencyMigration).toHaveBeenCalledWith({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/code-push',
      files: ['package.json', 'yarn.lock'],
    });
  });

  it('previews bare changes in dry-run mode without mutation', async () => {
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));

    await initProjectConfigAi({ yes: true, dryRun: true });

    expect(mockValidateSetupChangesBeforeApply).toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(mockPlanBareMetroConfig).toHaveBeenCalledWith(projectRoot);
  });

  it('previews a virtual bare config as a transactional local change', async () => {
    await initProjectConfigAi({
      yes: true,
      dryRun: true,
      virtualConfig: {
        content: 'module.exports = { runtimeVersion: { ios: "1", android: "1" } };',
        serverUrl: 'https://api.example.com',
        orgSlug: 'alpha-org',
        projectSlug: 'demo-app',
        authToken: 'pat-token',
      },
    });

    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
    expect(mockSetBundleDropProjectType).toHaveBeenCalledWith(
      'module.exports = { runtimeVersion: { ios: "1", android: "1" } };',
      'bare',
    );
  });

  it('persists the bare discriminator through the transactional setup path', async () => {
    const root = createTempProjectDir();
    temporaryRoots.push(root);
    cwdSpy.mockReturnValue(root);
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      'module.exports = { runtimeVersion: { ios: "1", android: "1" } };',
    );

    await initProjectConfigAi({ yes: true });

    expect(mockApplyExpoConfigurationChanges).toHaveBeenCalledWith({
      projectRoot: root,
      changes: [expect.objectContaining({
        file: 'bundle.drop.config.js',
        original: 'module.exports = { runtimeVersion: { ios: "1", android: "1" } };',
        updated: expect.stringContaining("projectType: 'bare'"),
      })],
    });
  });

  it('applies the generated bootstrap and commit-safe ignore rules transactionally', async () => {
    const root = createTempProjectDir();
    temporaryRoots.push(root);
    cwdSpy.mockReturnValue(root);
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      "module.exports = { projectType: 'bare' };\n",
    );
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n', 'utf8');

    await initProjectConfigAi({
      yes: true,
      runtimeDeliveryBootstrap: { content: '{"schemaVersion":1}\n' },
    });

    expect(mockApplyExpoConfigurationChanges).toHaveBeenCalledWith({
      projectRoot: root,
      changes: expect.arrayContaining([
        expect.objectContaining({
          file: '.bundle-drop/runtime-delivery.generated.json',
          original: null,
          updated: '{"schemaVersion":1}\n',
        }),
        expect.objectContaining({
          file: '.gitignore',
          original: 'node_modules\n',
          updated: expect.stringContaining('!.bundle-drop/runtime-delivery.generated.json'),
        }),
      ]),
    });
  });

  it('treats an unchanged bootstrap and ignore rule as already configured', async () => {
    const root = createTempProjectDir();
    temporaryRoots.push(root);
    cwdSpy.mockReturnValue(root);
    fs.ensureDirSync(path.join(root, '.bundle-drop'));
    fs.writeFileSync(
      path.join(root, '.bundle-drop/runtime-delivery.generated.json'),
      '{"schemaVersion":1}\n',
    );
    fs.writeFileSync(
      path.join(root, '.gitignore'),
      '!.bundle-drop/runtime-delivery.generated.json\n',
    );
    mockInspectProject.mockResolvedValue({
      projectRoot: root,
      projectType: 'bare',
      checks: [],
    });
    mockScanProjectForAiSetup.mockReturnValue(scanner('bare', {
      bundleDropStatus: 'configured',
    }));

    await initProjectConfigAi({
      yes: true,
      runtimeDeliveryBootstrap: { content: '{"schemaVersion":1}\n' },
    });

    expect(mockRequestAiSetupPlan).not.toHaveBeenCalled();
    expect(mockRunDoctor).toHaveBeenCalledWith({ projectType: 'bare', cwd: root });
  });

  it('leaves bare files unchanged when final confirmation is cancelled', async () => {
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ apply: false });

    await initProjectConfigAi();

    expect(mockApplySetupPatchPlans).not.toHaveBeenCalled();
  });

  it('applies and validates a bare plan, then runs Metro setup and doctor', async () => {
    const metroChange = {
      file: 'metro.config.js' as const,
      original: 'module.exports = {};\n',
      updated: 'module.exports = { resolver: { extraNodeModules: {} } };\n',
      reason: 'Add Metro alias',
    };
    mockPlanBareMetroConfig.mockReturnValue(metroChange);
    mockRequestAiSetupPlan.mockResolvedValue(plan({
      changes: [
        bareChange,
        { ...bareChange, confidence: 'low' },
        { ...bareChange, decisionType: 'manual_fallback' },
      ],
    }));

    await initProjectConfigAi({ yes: true });

    expect(mockApplySetupPatchPlans).toHaveBeenCalledWith({
      projectRoot,
      projectType: 'bare',
      changes: [bareChange],
    });
    expect(mockValidateAppliedSetupChanges).toHaveBeenCalledWith({
      projectRoot,
      projectType: 'bare',
      changes: [bareChange],
      migrateExpoUpdates: false,
      originals: expect.any(Map),
    });
    expect(mockApplyExpoConfigurationChanges).toHaveBeenCalledWith({
      projectRoot,
      changes: [metroChange],
    });
    expect(mockRunDoctor).toHaveBeenCalledWith({ projectType: 'bare', cwd: projectRoot });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('JavaScript entry point: call BundleDrop.init once'),
    );
  });

  it('restores bare backups if post-apply validation fails', async () => {
    mockPlanBareMetroConfig.mockReturnValue({
      file: 'metro.config.js',
      original: null,
      updated: 'module.exports = {};',
      reason: 'Create Metro config',
    });
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [bareChange] }));
    mockRunDoctor.mockRejectedValue(new Error('doctor failed'));

    await expect(initProjectConfigAi({ yes: true })).rejects.toThrow('doctor failed');

    expect(mockRestoreSetupBackups).toHaveBeenCalledWith({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/native',
      changedFiles: [{ file: bareChange.file, existed: true }],
    });
    expect(mockRestoreExpoConfiguration).toHaveBeenCalledWith({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/expo',
      changedFiles: [],
    });
  });

  it('allows dirty native directories in the default Bundle Drop runtime flow', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));
    mockExecSync.mockReturnValue(' M ios/Podfile\n');

    await expect(initProjectConfigAi({ yes: true, dryRun: true })).resolves.toBeUndefined();

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockPlanExpoProjectConfiguration).toHaveBeenCalled();
  });

  it('does not require Git in the default Bundle Drop runtime flow', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));
    mockExecSync.mockImplementation(() => { throw new Error('not a repository'); });

    await expect(initProjectConfigAi({ yes: true, dryRun: true })).resolves.toBeUndefined();

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockPlanExpoProjectConfiguration).toHaveBeenCalled();
  });

  it('requires the whole worktree to be clean for strict Expo runtime authority', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));
    mockExecSync.mockReturnValue(' M src/App.tsx\n');

    await expect(initProjectConfigAi({
      yes: true,
      virtualConfig: {
        content: "module.exports = { runtimeVersion: { source: 'expo' } };",
        serverUrl: 'https://api.example.com',
        orgSlug: 'alpha-org',
        projectSlug: 'demo-app',
        authToken: 'pat-token',
      },
    })).rejects.toThrow('Strict Expo runtime authority requires a clean Git worktree');

    expect(mockExecSync).toHaveBeenCalledWith(
      'git status --porcelain',
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(mockPlanExpoProjectConfiguration).not.toHaveBeenCalled();
  });

  it('fails the strict clean gate when Git status cannot be read', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));
    mockExecSync.mockImplementation(() => { throw new Error('not a repository'); });

    await expect(initProjectConfigAi({
      yes: true,
      virtualConfig: {
        content: "module.exports = { runtimeVersion: { source: 'expo' } };",
        serverUrl: 'https://api.example.com',
        orgSlug: 'alpha-org',
        projectSlug: 'demo-app',
        authToken: 'pat-token',
      },
    })).rejects.toThrow('Strict Expo runtime authority requires a clean Git worktree');
  });

  it('requires an allowlisted AI patch for dynamic Expo config', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockHasDynamicExpoConfig.mockReturnValue(true);
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: [] },
      dynamicConfigPath: '/project/app.config.ts',
    });

    await expect(initProjectConfigAi({ yes: true })).rejects.toThrow(
      'Dynamic Expo config requires an allowlisted AI patch for its evaluated root config',
    );

    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
  });

  it('accepts an idempotent dynamic Expo setup when the plugin is already evaluated', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockHasDynamicExpoConfig.mockReturnValue(true);
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: ['@gfean/react-native-bundle-drop'] },
      dynamicConfigPath: '/project/app.config.ts',
    });

    await expect(initProjectConfigAi({ yes: true })).resolves.toBeUndefined();

    expect(mockApplyExpoConfigurationChanges).toHaveBeenCalledWith({
      projectRoot,
      changes: [],
    });
    expect(mockRunDoctor).toHaveBeenCalledWith({ projectType: 'expo', cwd: projectRoot });
  });

  it('previews managed Expo deterministic and dynamic changes without touching files', async () => {
    const deterministicChange = {
      file: 'metro.config.js',
      original: 'module.exports = expoConfig;',
      updated: 'module.exports = withBundleDropExpo(expoConfig);',
      reason: 'Add Metro wrapper',
    };
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [dynamicConfigChange] }));
    mockHasDynamicExpoConfig.mockReturnValue(true);
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: ['@gfean/react-native-bundle-drop'] },
      dynamicConfigPath: '/project/app.config.ts',
    });
    mockPlanExpoProjectConfiguration.mockReturnValue([deterministicChange]);

    await initProjectConfigAi({ yes: true, dryRun: true });

    expect(mockPlanExpoProjectConfiguration).toHaveBeenCalledWith({
      projectRoot,
      migrateExpoUpdates: false,
      bundleConfigContent: undefined,
    });
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
    expect(mockRemoveExpoUpdatesWithPackageManager).not.toHaveBeenCalled();
    expect(mockRunDoctor).not.toHaveBeenCalled();
  });

  it('does not let --yes approve a provider-authored dynamic Expo config patch', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockRequestAiSetupPlan.mockResolvedValue(plan({
      changes: [{ ...dynamicConfigChange, decisionType: 'safe_auto_patch' }],
    }));

    await initProjectConfigAi({ yes: true });

    expect(mockValidateSetupChangesBeforeApply).not.toHaveBeenCalled();
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('--yes cannot approve them. No files changed.'),
    );
  });

  it('applies a dynamic Expo config only after explicit diff-backed approval', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [dynamicConfigChange] }));
    mockHasDynamicExpoConfig.mockReturnValue(true);
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: ['@gfean/react-native-bundle-drop'] },
      dynamicConfigPath: '/project/app.config.ts',
    });
    queuePromptResponse({ send: true });
    queuePromptResponse({ approve: true });
    queuePromptResponse({ apply: true });

    await initProjectConfigAi();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Review-only proposed change: app.config.ts'),
    );
    expect(mockApplyExpoConfigurationChanges).toHaveBeenCalledWith({
      projectRoot,
      changes: [{
        file: 'app.config.ts',
        original: 'original dynamic config',
        updated: dynamicConfigChange.updated,
        reason: dynamicConfigChange.reason,
      }],
    });
  });

  it('threads approved expo-updates migration through dynamic pre/post validation', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { expoUpdatesStatus: 'active' }));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [dynamicConfigChange] }));
    mockHasDynamicExpoConfig.mockReturnValue(true);
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: ['@gfean/react-native-bundle-drop'] },
      dynamicConfigPath: '/project/app.config.ts',
    });
    queuePromptResponse({ send: true });
    queuePromptResponse({ approve: true });
    queuePromptResponse({ apply: true });

    await initProjectConfigAi({ migrateExpoUpdates: true });

    expect(mockValidateSetupChangesBeforeApply).toHaveBeenCalledWith(expect.objectContaining({
      projectType: 'expo',
      changes: [dynamicConfigChange],
      migrateExpoUpdates: true,
    }));
    expect(mockValidateAppliedSetupChanges).toHaveBeenCalledWith({
      projectRoot,
      projectType: 'expo',
      changes: [dynamicConfigChange],
      migrateExpoUpdates: true,
      originals: expect.any(Map),
    });
    expect(mockRemoveExpoUpdatesWithPackageManager).toHaveBeenCalledWith(projectRoot);
  });

  it('rejects an AI patch aimed at a different dynamic config than Expo evaluated', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [dynamicConfigChange] }));
    mockHasDynamicExpoConfig.mockReturnValue(true);
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: [] },
      dynamicConfigPath: '/project/app.config.js',
    });

    await expect(initProjectConfigAi({ yes: true, dryRun: true })).rejects.toThrow(
      'evaluated root config (app.config.js)',
    );
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
  });

  it('fails closed when Expo does not report its authoritative dynamic config path', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [dynamicConfigChange] }));
    mockHasDynamicExpoConfig.mockReturnValue(true);
    mockEvaluateExpoConfig.mockReturnValue({ exp: { plugins: [] } });

    await expect(initProjectConfigAi({ yes: true, dryRun: true })).rejects.toThrow(
      'Expo did not identify the authoritative dynamic app config path',
    );
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
  });

  it('fails closed when Expo reports a dynamic config path outside the project root', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockRequestAiSetupPlan.mockResolvedValue(plan({ changes: [dynamicConfigChange] }));
    mockHasDynamicExpoConfig.mockReturnValue(true);
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: [] },
      dynamicConfigPath: '/outside/app.config.ts',
    });

    await expect(initProjectConfigAi({ yes: true, dryRun: true })).rejects.toThrow(
      'Expo reported an unsafe dynamic app config path',
    );
    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
  });

  it('cancels the complete managed Expo plan without partial activation', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    queuePromptResponse({ send: true });
    queuePromptResponse({ apply: false });

    await initProjectConfigAi();

    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
    expect(mockRunDoctor).not.toHaveBeenCalled();
  });

  it('does not apply committed-native Expo changes when layered prebuild is declined', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ apply: true });
    queuePromptResponse({ prebuild: false });

    await initProjectConfigAi();

    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('requires an explicit prebuild flag for noninteractive committed-native setup', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));

    await initProjectConfigAi({ yes: true });

    expect(mockApplyExpoConfigurationChanges).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Prebuild declined. No files changed.'),
    );
  });

  it('runs the project-local layered prebuild after its separate confirmation', async () => {
    const root = createCommittedNativeProject();
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));
    queuePromptResponse({ send: true });
    queuePromptResponse({ apply: true });
    queuePromptResponse({ prebuild: true });

    await initProjectConfigAi();

    expect(mockExecFileSync).toHaveBeenCalledWith(
      process.execPath,
      [path.join(fs.realpathSync(root), 'node_modules/expo/bin/cli.js'), 'prebuild', '--no-install'],
      expect.objectContaining({
        cwd: root,
        stdio: 'inherit',
        env: expect.objectContaining({ BUNDLE_DROP_PREBUILD: '1' }),
      }),
    );
    expect(fs.readFileSync(path.join(root, 'ios/Podfile'), 'utf8')).toBe('platform :ios\n');
    expect(mockRunDoctor).toHaveBeenCalledWith({ projectType: 'expo', cwd: root });
  });

  it('restores generated native output when post-prebuild doctor validation fails', async () => {
    const root = createCommittedNativeProject();
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));
    mockRunDoctor.mockRejectedValue(new Error('post-prebuild doctor failed'));

    await expect(initProjectConfigAi({ yes: true, prebuild: true })).rejects.toThrow(
      'post-prebuild doctor failed',
    );

    expect(fs.readFileSync(path.join(root, 'ios/Podfile'), 'utf8')).toBe('platform :ios\n');
    expect(mockRestoreExpoConfiguration).toHaveBeenCalled();
  });

  it('restores native directories and setup files when layered prebuild fails', async () => {
    const root = createCommittedNativeProject();
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));
    mockExecFileSync.mockImplementation(() => {
      fs.writeFileSync(path.join(root, 'ios/Podfile'), 'generated failure\n');
      throw new Error('prebuild command failed');
    });

    await expect(initProjectConfigAi({ yes: true, prebuild: true })).rejects.toThrow(
      'Original native directories were restored',
    );

    expect(fs.readFileSync(path.join(root, 'ios/Podfile'), 'utf8')).toBe('platform :ios\n');
    expect(mockRestoreExpoConfiguration).toHaveBeenCalled();
    expect(mockRunDoctor).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'])('rejects a symlinked %s prebuild directory before execution', async directory => {
    const root = createCommittedNativeProject();
    const outsideRoot = createTempProjectDir();
    temporaryRoots.push(outsideRoot);
    const outsideNative = path.join(outsideRoot, directory);
    fs.ensureDirSync(outsideNative);
    const sentinel = path.join(outsideNative, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside-safe');
    fs.removeSync(path.join(root, directory));
    fs.symlinkSync(outsideNative, path.join(root, directory));
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));

    await expect(initProjectConfigAi({ yes: true, prebuild: true }))
      .rejects.toThrow('symlinked or non-directory');

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside-safe');
  });

  it('restores native directories without following a symlink created by failed prebuild', async () => {
    const root = createCommittedNativeProject();
    const outsideRoot = createTempProjectDir();
    temporaryRoots.push(outsideRoot);
    const sentinel = path.join(outsideRoot, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside-safe');
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { hasNativeDirectories: true }));
    mockExecFileSync.mockImplementation(() => {
      fs.removeSync(path.join(root, 'ios'));
      fs.symlinkSync(outsideRoot, path.join(root, 'ios'));
      throw new Error('prebuild command failed');
    });

    await expect(initProjectConfigAi({ yes: true, prebuild: true }))
      .rejects.toThrow('Original native directories were restored');

    expect(fs.lstatSync(path.join(root, 'ios')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(root, 'ios/Podfile'), 'utf8')).toBe('platform :ios\n');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside-safe');
  });

  it('applies managed Expo setup and validates the evaluated plugin', async () => {
    const metroChange = {
      file: 'metro.config.js',
      original: null,
      updated: 'module.exports = withBundleDropExpo(config);',
      reason: 'Create Metro wrapper',
    };
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockPlanExpoProjectConfiguration.mockReturnValue([metroChange]);

    await initProjectConfigAi({ yes: true });

    expect(mockApplyExpoConfigurationChanges).toHaveBeenCalledWith({
      projectRoot,
      changes: [metroChange],
    });
    expect(mockEvaluateExpoConfig).toHaveBeenCalledWith(projectRoot);
    expect(mockRunDoctor).toHaveBeenCalledWith({ projectType: 'expo', cwd: projectRoot });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('JavaScript entry point: call BundleDrop.init once'),
    );
  });

  it('accepts tuple-form Bundle Drop plugin registration in evaluated Expo config', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockEvaluateExpoConfig.mockReturnValue({
      exp: { plugins: [['@gfean/react-native-bundle-drop', { enabled: true }]] },
    });

    await expect(initProjectConfigAi({ yes: true })).resolves.toBeUndefined();
    expect(mockRunDoctor).toHaveBeenCalled();
  });

  it('ignores malformed Expo plugin entries when Bundle Drop is also registered', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockEvaluateExpoConfig.mockReturnValue({
      exp: {
        plugins: [null, { unexpected: true }, '@gfean/react-native-bundle-drop'],
      },
    });

    await expect(initProjectConfigAi({ yes: true })).resolves.toBeUndefined();
    expect(mockRunDoctor).toHaveBeenCalled();
  });

  it('runs explicit expo-updates migration through the detected package manager', async () => {
    const packageChange = {
      file: 'package.json',
      original: '{"dependencies":{"expo-updates":"1"}}',
      updated: '{"dependencies":{}}',
      reason: 'Remove expo-updates',
    };
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { expoUpdatesStatus: 'active' }));
    mockPlanExpoProjectConfiguration.mockReturnValue([packageChange]);

    await initProjectConfigAi({ yes: true, migrateExpoUpdates: true });

    expect(mockDetectPackageManager).toHaveBeenCalledWith(projectRoot);
    expect(mockExpoUpdatesRemovalCommand).toHaveBeenCalledWith('yarn');
    expect(mockRemoveExpoUpdatesWithPackageManager).toHaveBeenCalledWith(projectRoot);
    expect(mockApplyExpoConfigurationChanges).toHaveBeenCalledWith({ projectRoot, changes: [] });
  });

  it('restores Expo config and dependency migration when validation fails', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo', { expoUpdatesStatus: 'active' }));
    mockRunDoctor.mockRejectedValue(new Error('Expo doctor failed'));

    await expect(initProjectConfigAi({ yes: true, migrateExpoUpdates: true })).rejects.toThrow(
      'Expo doctor failed',
    );

    expect(mockRestoreExpoConfiguration).toHaveBeenCalledWith({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/expo',
      changedFiles: [],
    });
    expect(mockRestoreDependencyMigration).toHaveBeenCalledWith({
      projectRoot,
      backupDir: '/project/.bundledrop-backup/dependency',
      files: ['package.json', 'yarn.lock'],
    });
  });

  it('rolls back applied Expo files when evaluated config omits the plugin', async () => {
    mockDetectProjectType.mockReturnValue('expo');
    mockScanProjectForAiSetup.mockReturnValue(scanner('expo'));
    mockEvaluateExpoConfig.mockReturnValue({ exp: {} });

    await expect(initProjectConfigAi({ yes: true })).rejects.toThrow(
      'Evaluated Expo config does not include the Bundle Drop plugin',
    );

    expect(mockRestoreExpoConfiguration).toHaveBeenCalled();
    expect(mockRunDoctor).not.toHaveBeenCalled();
  });
});
