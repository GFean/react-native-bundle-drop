export type AiSetupConfidence = 'high' | 'medium' | 'low';
export type AiSetupDecisionType =
  | 'safe_auto_patch'
  | 'review_only_patch'
  | 'manual_fallback'
  | 'skip';

export type AiPatchPlan = {
  file: string;
  originalSha256: string;
  updated: string;
  reason: string;
  confidence: AiSetupConfidence;
  decisionType: AiSetupDecisionType;
};

export type AiSetupProjectType = 'expo' | 'bare';
export type AiSetupFileKind =
  | 'package_manifest'
  | 'bundle_drop_config'
  | 'expo_app_config'
  | 'metro_config'
  | 'android_entrypoint'
  | 'ios_entrypoint';

export type AiSetupDetected = {
  rnVersion: string | null;
  expoSdkVersion: string | null;
  bundleDropStatus: 'absent' | 'partial' | 'configured';
  hasNativeDirectories: boolean;
  usesExpoRouter: boolean;
  jsEngine: 'hermes' | 'jsc' | 'unknown';
  expoUpdatesStatus: 'absent' | 'disabled' | 'active';
  codePushDetected: boolean;
  signals: string[];
};

export type AiSetupPlanFile = {
  path: string;
  content: string;
  sha256: string;
  kind: AiSetupFileKind;
};

export type AiSetupPlanRequest = {
  schemaVersion: 1;
  orgSlug: string;
  projectSlug: string;
  projectType: AiSetupProjectType;
  detected: AiSetupDetected;
  files: AiSetupPlanFile[];
};

export type AiSetupActionType =
  | 'register_expo_plugin'
  | 'configure_bundle_drop'
  | 'preserve_expo_metro'
  | 'migrate_expo_updates'
  | 'configure_bare_native'
  | 'migrate_codepush'
  | 'require_native_rebuild'
  | 'run_doctor';

export type AiSetupPlanResponse = {
  confidence: AiSetupConfidence;
  summary: string;
  actions: Array<{
    type: AiSetupActionType;
    reason: string;
    requiresConfirmation: boolean;
  }>;
  changes: AiPatchPlan[];
  warnings: string[];
};

export type AiSetupScannerResult = {
  projectRoot: string;
  serverUrl: string;
  orgSlug: string;
  projectSlug: string;
  authToken: string;
  request: AiSetupPlanRequest;
};
