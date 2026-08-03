import fs from 'fs';
import crypto from 'crypto';
import childProcess from 'child_process';
import path from 'path';
import AdmZip from 'adm-zip';

import {
  resolveBundleDropRuntimeVersionAuthority,
  resolveExpoBuildIdentity,
} from '../../../expo';
import {
  parseExpoBuildIdentityReceipt,
  resolveExpoIntegrationGeneration,
} from '../../../expo/buildReceipt';
import type { ExpoBuildIdentity, MobilePlatform } from '../../../expo';
import type { ExpoBuildIdentityReceipt } from '../../../metro';
import { resolveOfficialEasBuildIdentity } from './eas-build-proof';

export const IOS_EMBEDDED_BUILD_CANDIDATE = '.bundle-drop-build-identity.json';
export const ANDROID_APK_EMBEDDED_BUILD_CANDIDATE = 'assets/bundle-drop/build-identity.json';
export const ANDROID_AAB_EMBEDDED_BUILD_CANDIDATE = 'base/assets/bundle-drop/build-identity.json';

export const createEmbeddedBuildCandidate = (params: {
  platform: MobilePlatform;
  identityHash: string;
  integrationGeneration: string;
  runtimeVersion: string;
}): Record<string, unknown> => ({
  schemaVersion: 1,
  platform: params.platform,
  identityHash: params.identityHash,
  integrationGeneration: params.integrationGeneration,
  runtimeVersion: params.runtimeVersion,
});

export const serializeEmbeddedBuildCandidate = (candidate: Record<string, unknown>): Buffer =>
  Buffer.from(`${JSON.stringify(candidate)}\n`, 'utf8');

const sha256File = (filePath: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

export const readAndroidEmbeddedBuildCandidate = (artifactPath: string): Buffer => {
  let archive: AdmZip;
  try {
    archive = new AdmZip(artifactPath);
  } catch {
    throw new Error('Bundle Drop Android build artifact is not a readable APK/AAB archive.');
  }
  const expectedPath = artifactPath.toLowerCase().endsWith('.aab')
    ? ANDROID_AAB_EMBEDDED_BUILD_CANDIDATE
    : ANDROID_APK_EMBEDDED_BUILD_CANDIDATE;
  const candidates = archive.getEntries().filter(entry => entry.entryName === expectedPath && !entry.isDirectory);
  if (candidates.length !== 1) {
    throw new Error(
      `Bundle Drop Android build artifact must contain exactly one signed identity candidate at ${expectedPath}.`,
    );
  }
  const candidateEntry = candidates[0];
  if (candidateEntry.header.size === 0 || candidateEntry.header.size > 64 * 1024) {
    throw new Error('Bundle Drop Android embedded build identity candidate has an invalid size.');
  }
  const content = candidateEntry.getData();
  if (content.length !== candidateEntry.header.size) {
    throw new Error('Bundle Drop Android embedded build identity candidate has an invalid size.');
  }
  return content;
};

const parseEmbeddedCandidate = (platform: MobilePlatform, content: Buffer): unknown => {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error(`Bundle Drop ${platform} embedded build identity candidate is malformed.`);
  }
};

const verifyLocalBuildProof = (
  platform: MobilePlatform,
  identity: ExpoBuildIdentity,
  proof: ExpoBuildIdentityReceipt['proofs'][MobilePlatform],
): void => {
  if (!proof || proof.evidence === 'eas-official-metadata') return;
  if (!fs.existsSync(proof.artifactPath)) {
    throw new Error(`Bundle Drop ${platform} build artifact no longer exists at ${proof.artifactPath}.`);
  }
  if (platform === 'android') {
    if (proof.evidence !== 'android-signed-artifact' || !fs.statSync(proof.artifactPath).isFile()) {
      throw new Error('Bundle Drop Android build proof does not reference an APK/AAB file.');
    }
    if (!/\.(apk|aab)$/i.test(proof.artifactPath)) {
      throw new Error('Bundle Drop Android build proof must reference an APK or AAB.');
    }
    if (sha256File(proof.artifactPath) !== proof.artifactSha256) {
      throw new Error('Bundle Drop Android build artifact changed after its receipt was created.');
    }
    const candidateContent = readAndroidEmbeddedBuildCandidate(proof.artifactPath);
    if (crypto.createHash('sha256').update(candidateContent).digest('hex') !== proof.embeddedCandidateSha256) {
      throw new Error('Bundle Drop Android embedded build identity candidate does not match its receipt.');
    }
    const expectedCandidate = createEmbeddedBuildCandidate({
      platform: 'android',
      identityHash: identity.identityHash,
      integrationGeneration: proof.integrationGeneration,
      runtimeVersion: identity.runtimeVersion,
    });
    parseEmbeddedCandidate('android', candidateContent);
    if (!candidateContent.equals(serializeEmbeddedBuildCandidate(expectedCandidate))) {
      throw new Error('Bundle Drop Android embedded build identity candidate is not bound to this build proof.');
    }
    return;
  }
  if (proof.evidence !== 'ios-signed-app' || !fs.statSync(proof.artifactPath).isDirectory()) {
    throw new Error('Bundle Drop iOS build proof does not reference an app bundle.');
  }
  const candidatePath = path.join(proof.artifactPath, IOS_EMBEDDED_BUILD_CANDIDATE);
  if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
    throw new Error('Bundle Drop iOS app does not contain its embedded build identity candidate.');
  }
  const candidateContent = fs.readFileSync(candidatePath);
  if (crypto.createHash('sha256').update(candidateContent).digest('hex') !== proof.embeddedCandidateSha256) {
    throw new Error('Bundle Drop iOS embedded build identity candidate does not match its receipt.');
  }
  const candidate = parseEmbeddedCandidate('ios', candidateContent);
  const expectedCandidate = {
    ...createEmbeddedBuildCandidate({
      platform: 'ios',
      identityHash: identity.identityHash,
      integrationGeneration: proof.integrationGeneration,
      runtimeVersion: identity.runtimeVersion,
    }),
    createdAt: proof.createdAt,
  };
  if (JSON.stringify(candidate) !== JSON.stringify(expectedCandidate)) {
    throw new Error('Bundle Drop iOS embedded build identity candidate is not bound to this build proof.');
  }
  const verification = childProcess.spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', proof.artifactPath],
    { encoding: 'utf8', shell: false },
  );
  if (verification.error || verification.status !== 0) {
    const detail = verification.error?.message || verification.stderr?.trim() || 'codesign rejected the app';
    throw new Error(`Bundle Drop iOS app signature verification failed: ${detail}`);
  }
};

export function readExpoBuildIdentityReceipt(
  projectRoot: string,
  receiptFile?: string,
  validationPlatform?: MobilePlatform,
): ExpoBuildIdentityReceipt | null {
  const receiptPath = receiptFile
    ? path.resolve(projectRoot, receiptFile)
    : path.join(projectRoot, '.bundle-drop', 'build-identity.json');
  if (!fs.existsSync(receiptPath)) return null;
  let receipt: ExpoBuildIdentityReceipt;
  try {
    receipt = parseExpoBuildIdentityReceipt(
      JSON.parse(fs.readFileSync(receiptPath, 'utf8')),
      resolveExpoIntegrationGeneration(),
    );
  } catch (error) {
    const reason = error instanceof SyntaxError
      ? `Bundle Drop build identity receipt is malformed: ${error.message}`
      : (error as Error).message;
    throw new Error(reason);
  }
  const platforms = validationPlatform
    ? [validationPlatform]
    : ['ios', 'android'] as const;
  for (const platform of platforms) {
    const identity = receipt.identities[platform];
    const proof = receipt.proofs[platform];
    if (identity && proof) verifyLocalBuildProof(platform, identity, proof);
  }
  return receipt;
}

export function assertExpoUploadMatchesBuild(params: {
  projectRoot: string;
  platform: MobilePlatform;
  uploadIdentity: ExpoBuildIdentity;
  requireReceipt?: boolean;
  receiptFile?: string;
}): void {
  const receipt = readExpoBuildIdentityReceipt(
    params.projectRoot,
    params.receiptFile,
    params.platform,
  );
  if (!receipt) {
    if (params.requireReceipt) {
      throw new Error(
        'No native build identity receipt is available. Build the app locally first, or provide an ' +
          'exact user-controlled EAS build receipt; Bundle Drop will not guess runtime identity.',
      );
    }
    return;
  }
  const buildIdentity = receipt.identities[params.platform];
  if (!buildIdentity) {
    throw new Error(`Build identity receipt does not contain ${params.platform}.`);
  }
  if (buildIdentity.identityHash !== params.uploadIdentity.identityHash) {
    throw new Error(
      `Expo ${params.platform} build/upload identity mismatch. ` +
        `Built ${buildIdentity.runtimeVersion}, upload resolved ${params.uploadIdentity.runtimeVersion}. ` +
        'Create a new native build or restore the exact build configuration before uploading.',
    );
  }
}

export async function resolveExpoUploadIdentity(params: {
  projectRoot: string;
  platform: MobilePlatform;
  receiptFile?: string;
}): Promise<ExpoBuildIdentity> {
  const runtimeAuthority = resolveBundleDropRuntimeVersionAuthority(
    params.projectRoot,
    params.platform,
  );
  if (runtimeAuthority.source === 'bundle-drop' && !params.receiptFile) {
    return resolveExpoBuildIdentity(params.projectRoot, params.platform);
  }

  const receipt = readExpoBuildIdentityReceipt(
    params.projectRoot,
    params.receiptFile,
    params.platform,
  );
  if (!receipt) {
    throw new Error(
      'Expo upload requires an exact native build identity receipt. Build locally first, or pass ' +
        '--build-receipt with an officially resolved EAS build receipt.',
    );
  }
  const buildIdentity = receipt.identities[params.platform];
  if (!buildIdentity) {
    throw new Error(`Build identity receipt does not contain ${params.platform}.`);
  }
  const proof = receipt.proofs[params.platform];
  if (proof?.evidence === 'eas-official-metadata') {
    return resolveOfficialEasBuildIdentity({
      projectRoot: params.projectRoot,
      platform: params.platform,
      receiptIdentity: buildIdentity,
      proof,
    });
  }
  let uploadIdentity: ExpoBuildIdentity;
  try {
    uploadIdentity = await resolveExpoBuildIdentity(params.projectRoot, params.platform);
  } catch (error) {
    if (!/remote EAS app versions/.test((error as Error).message)) throw error;
    const nativePrefix = `${buildIdentity.appVersion}(`;
    if (!buildIdentity.nativeVersion.startsWith(nativePrefix) ||
      !buildIdentity.nativeVersion.endsWith(')')) {
      throw new Error('The local build receipt has an invalid Expo native version.');
    }
    const officialNativeBuildVersion = buildIdentity.nativeVersion.slice(
      nativePrefix.length,
      -1,
    );
    uploadIdentity = await resolveExpoBuildIdentity(params.projectRoot, params.platform, {
      officialAppVersion: buildIdentity.appVersion,
      officialNativeBuildVersion,
    });
  }
  assertExpoUploadMatchesBuild({
    projectRoot: params.projectRoot,
    platform: params.platform,
    uploadIdentity,
    requireReceipt: true,
    receiptFile: params.receiptFile,
  });
  return uploadIdentity;
}
