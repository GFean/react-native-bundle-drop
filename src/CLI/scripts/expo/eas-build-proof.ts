import childProcess from 'child_process';

import {
  evaluateExpoConfig,
  resolveExpoBuildIdentity,
  resolveExpoProjectFingerprint,
} from '../../../expo';
import type {
  ExpoBuildIdentity,
  MobilePlatform,
} from '../../../expo';
import type { ExpoEasBuildProof } from '../../../expo/buildReceipt';

type EasBuildMetadata = {
  id?: unknown;
  status?: unknown;
  platform?: unknown;
  project?: { id?: unknown };
  artifacts?: {
    buildUrl?: unknown;
    applicationArchiveUrl?: unknown;
  };
  fingerprint?: { hash?: unknown };
  sdkVersion?: unknown;
  appVersion?: unknown;
  appBuildVersion?: unknown;
  runtimeVersion?: unknown;
  gitCommitHash?: unknown;
};

const EAS_BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const run = (command: string, args: string[], cwd: string) =>
  childProcess.spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Official EAS build metadata is missing ${field}.`);
  }
  return value;
};

const readOfficialBuild = (projectRoot: string, buildId: string): EasBuildMetadata => {
  if (!EAS_BUILD_ID.test(buildId)) {
    throw new Error('Bundle Drop EAS build proof contains an invalid build ID.');
  }
  const result = run('eas', ['build:view', buildId, '--json'], projectRoot);
  if (result.error || result.status !== 0) {
    throw new Error(
      `Bundle Drop could not authenticate and verify EAS build ${buildId}. ` +
        'Run `eas whoami` and retry from the exact build project. EAS output was omitted to protect credentials.',
    );
  }
  try {
    const value = JSON.parse(result.stdout || '') as EasBuildMetadata;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch (error) {
    throw new Error(`Official EAS build metadata is malformed: ${(error as Error).message}`);
  }
};

const assertExactProjectCommit = (
  projectRoot: string,
  officialGitCommitHash: string,
): void => {
  const head = run('git', ['rev-parse', 'HEAD'], projectRoot);
  if (head.error || head.status !== 0 || head.stdout.trim() !== officialGitCommitHash) {
    throw new Error(
      'The EAS build was not created from the current project commit. ' +
        'Check out the exact build commit before uploading.',
    );
  }
  const status = run('git', ['status', '--porcelain'], projectRoot);
  if (status.error || status.status !== 0 || status.stdout.trim()) {
    throw new Error('EAS-proven uploads require a clean worktree at the exact build commit.');
  }
};

const sdkMajor = (value: string): string => value.split('.')[0];

export type ResolvedOfficialEasBuild = {
  buildId: string;
  identity: ExpoBuildIdentity;
};

/**
 * Resolves a concrete identity from authenticated official EAS metadata and
 * the exact clean source commit. This proof does not claim to inspect or embed
 * data in the remote application artifact.
 */
export async function resolveOfficialEasBuild(params: {
  projectRoot: string;
  platform: MobilePlatform;
  easBuildId: string;
}): Promise<ResolvedOfficialEasBuild> {
  const build = readOfficialBuild(params.projectRoot, params.easBuildId);
  const buildId = requiredString(build.id, 'id');
  const status = requiredString(build.status, 'status');
  const platform = requiredString(build.platform, 'platform').toLowerCase();
  const projectId = requiredString(build.project?.id, 'project.id');
  const sdkVersion = requiredString(build.sdkVersion, 'sdkVersion');
  const appVersion = requiredString(build.appVersion, 'appVersion');
  const appBuildVersion = requiredString(build.appBuildVersion, 'appBuildVersion');
  const runtimeVersion = requiredString(build.runtimeVersion, 'runtimeVersion');
  const gitCommitHash = requiredString(build.gitCommitHash, 'gitCommitHash');
  const fingerprintHash = requiredString(build.fingerprint?.hash, 'fingerprint.hash');
  const artifactUrl = build.artifacts?.applicationArchiveUrl || build.artifacts?.buildUrl;

  if (buildId !== params.easBuildId || status !== 'FINISHED') {
    throw new Error('Bundle Drop accepts only the exact, finished EAS build requested by ID.');
  }
  if (platform !== params.platform) {
    throw new Error(`EAS build ${buildId} is for ${platform}, not ${params.platform}.`);
  }
  if (typeof artifactUrl !== 'string' || !artifactUrl.trim()) {
    throw new Error('The finished EAS build does not expose an application artifact.');
  }

  const localProjectId = evaluateExpoConfig(params.projectRoot).exp.extra?.eas?.projectId;
  if (typeof localProjectId !== 'string' || projectId !== localProjectId) {
    throw new Error('The EAS build belongs to a different Expo project.');
  }
  assertExactProjectCommit(params.projectRoot, gitCommitHash);

  const identity = await resolveExpoBuildIdentity(params.projectRoot, params.platform, {
    officialAppVersion: appVersion,
    officialNativeBuildVersion: appBuildVersion,
  });
  if (
    identity.appVersion !== appVersion ||
    identity.nativeVersion !== `${appVersion}(${appBuildVersion})` ||
    identity.runtimeVersion !== runtimeVersion ||
    sdkMajor(identity.expoSdkVersion) !== sdkMajor(sdkVersion)
  ) {
    throw new Error(
      'The official EAS build metadata does not match the current Expo project identity.',
    );
  }
  if (identity.runtimeVersionPolicy === 'fingerprint') {
    const currentFingerprint = await resolveExpoProjectFingerprint(
      params.projectRoot,
      params.platform,
    );
    if (currentFingerprint !== fingerprintHash) {
      throw new Error('The official EAS build fingerprint does not match the current project.');
    }
    if (fingerprintHash !== identity.runtimeVersion) {
      throw new Error('The official EAS build fingerprint does not match the Expo runtime identity.');
    }
  }
  return { buildId, identity };
}

export async function resolveOfficialEasBuildIdentity(params: {
  projectRoot: string;
  platform: MobilePlatform;
  receiptIdentity: ExpoBuildIdentity;
  proof: ExpoEasBuildProof;
}): Promise<ExpoBuildIdentity> {
  const resolved = await resolveOfficialEasBuild({
    projectRoot: params.projectRoot,
    platform: params.platform,
    easBuildId: params.proof.easBuildId,
  });
  if (resolved.identity.identityHash !== params.receiptIdentity.identityHash) {
    throw new Error(
      'The official EAS build metadata does not match the receipt and current Expo project identity.',
    );
  }
  return resolved.identity;
}
