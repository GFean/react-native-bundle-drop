import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';

import { resolveExpoBuildIdentity } from '../../../expo';
import {
  resolveExpoIntegrationGeneration,
} from '../../../expo/buildReceipt';
import type {
  ExpoBuildIdentityReceipt,
  ExpoBuildPlatformProof,
} from '../../../expo/buildReceipt';
import type { MobilePlatform } from '../../../expo';
import {
  createEmbeddedBuildCandidate,
  IOS_EMBEDDED_BUILD_CANDIDATE,
  readAndroidEmbeddedBuildCandidate,
  readExpoBuildIdentityReceipt,
  serializeEmbeddedBuildCandidate,
} from './build-receipt';

type WriteBuildReceiptOptions = {
  projectRoot: string;
  platform: MobilePlatform;
  artifactPath: string;
  androidSdkRoot?: string;
  officialAppVersion?: string;
  officialNativeBuildVersion?: string;
};

type WriteAndroidBuildCandidateOptions = {
  projectRoot: string;
  outputPath: string;
  officialAppVersion?: string;
  officialNativeBuildVersion?: string;
};

const IOS_RUNTIME_INFO_PLIST_KEY = 'BundleDropRuntimeVersion';

const sha256 = (content: Buffer): string =>
  crypto.createHash('sha256').update(content).digest('hex');

const writeJsonAtomically = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
};

const writeBufferAtomically = (filePath: string, content: Buffer): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content);
  fs.renameSync(temporaryPath, filePath);
};

const runSignatureVerification = (executable: string, args: string[], label: string): void => {
  const result = childProcess.spawnSync(executable, args, { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `${label} rejected the artifact`;
    throw new Error(`Bundle Drop Android artifact signature verification failed: ${detail}`);
  }
};

const findApkSigner = (androidSdkRoot?: string): string => {
  const sdkRoot = androidSdkRoot || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!sdkRoot) {
    throw new Error('Bundle Drop cannot verify an APK signature without the Android SDK path.');
  }
  const buildToolsRoot = path.join(path.resolve(sdkRoot), 'build-tools');
  if (!fs.existsSync(buildToolsRoot)) {
    throw new Error(`Bundle Drop cannot find Android build-tools under ${buildToolsRoot}.`);
  }
  const candidates = fs.readdirSync(buildToolsRoot)
    .map(version => path.join(buildToolsRoot, version, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'))
    .filter(candidate => fs.existsSync(candidate))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  if (!candidates[0]) throw new Error('Bundle Drop cannot find apksigner in Android build-tools.');
  return candidates[0];
};

const verifyAndroidArtifactSignature = (artifactPath: string, androidSdkRoot?: string): void => {
  if (artifactPath.toLowerCase().endsWith('.apk')) {
    runSignatureVerification(findApkSigner(androidSdkRoot), ['verify', artifactPath], 'apksigner');
    return;
  }
  // jarsigner reports an unsigned JAR as a successful verification unless
  // strict mode is enabled. AAB proof must never be issued for that result.
  runSignatureVerification('jarsigner', ['-verify', '-strict', artifactPath], 'jarsigner');
};

const readIosBundleValue = (artifactPath: string, key: string): string => {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Bundle Drop ios artifact does not exist at ${artifactPath}.`);
  }
  if (!fs.statSync(artifactPath).isDirectory() || !artifactPath.endsWith('.app')) {
    throw new Error('Bundle Drop iOS receipt writer requires an exact .app bundle directory.');
  }
  const infoPlistPath = path.join(artifactPath, 'Info.plist');
  if (!fs.existsSync(infoPlistPath) || !fs.statSync(infoPlistPath).isFile()) {
    throw new Error('Bundle Drop iOS receipt writer requires the packaged app Info.plist.');
  }
  const result = childProcess.spawnSync(
    '/usr/bin/plutil',
    ['-extract', key, 'raw', '-o', '-', infoPlistPath],
    { encoding: 'utf8', shell: false },
  );
  const value = result.stdout?.trim();
  if (result.error || result.status !== 0 || !value) {
    const detail = result.error?.message || result.stderr?.trim() || `${key} is empty`;
    throw new Error(`Bundle Drop could not read ${key} from the packaged iOS app: ${detail}`);
  }
  return value;
};

const writeIosRuntimeVersion = (artifactPath: string, runtimeVersion: string): void => {
  const infoPlistPath = path.join(artifactPath, 'Info.plist');
  const replaceResult = childProcess.spawnSync(
    '/usr/bin/plutil',
    ['-replace', IOS_RUNTIME_INFO_PLIST_KEY, '-string', runtimeVersion, infoPlistPath],
    { encoding: 'utf8', shell: false },
  );
  if (!replaceResult.error && replaceResult.status === 0) return;

  const insertResult = childProcess.spawnSync(
    '/usr/bin/plutil',
    ['-insert', IOS_RUNTIME_INFO_PLIST_KEY, '-string', runtimeVersion, infoPlistPath],
    { encoding: 'utf8', shell: false },
  );
  if (insertResult.error || insertResult.status !== 0) {
    const detail = insertResult.error?.message || insertResult.stderr?.trim() ||
      replaceResult.error?.message || replaceResult.stderr?.trim() || 'plutil rejected the value';
    throw new Error(`Bundle Drop could not embed the iOS runtime version: ${detail}`);
  }
};

const resolvePackagedBuildVersions = (
  platform: MobilePlatform,
  artifactPath: string,
  options: Pick<WriteBuildReceiptOptions, 'officialAppVersion' | 'officialNativeBuildVersion'>,
): { officialAppVersion?: string; officialNativeBuildVersion?: string } => {
  if (platform === 'android') {
    return {
      officialAppVersion: options.officialAppVersion,
      officialNativeBuildVersion: options.officialNativeBuildVersion,
    };
  }
  return {
    officialAppVersion: readIosBundleValue(artifactPath, 'CFBundleShortVersionString'),
    officialNativeBuildVersion: readIosBundleValue(artifactPath, 'CFBundleVersion'),
  };
};

const createLocalProof = (params: {
  platform: MobilePlatform;
  artifactPath: string;
  identityHash: string;
  integrationGeneration: string;
  runtimeVersion: string;
  createdAt: string;
  androidSdkRoot?: string;
}): ExpoBuildPlatformProof => {
  const artifactPath = path.resolve(params.artifactPath);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Bundle Drop ${params.platform} artifact does not exist at ${artifactPath}.`);
  }
  if (params.platform === 'android') {
    if (!fs.statSync(artifactPath).isFile() || !/\.(apk|aab)$/i.test(artifactPath)) {
      throw new Error('Bundle Drop Android receipt writer requires an exact APK or AAB file.');
    }
    verifyAndroidArtifactSignature(artifactPath, params.androidSdkRoot);
    const embeddedCandidate = readAndroidEmbeddedBuildCandidate(artifactPath);
    const expectedCandidate = createEmbeddedBuildCandidate({
      platform: 'android',
      identityHash: params.identityHash,
      integrationGeneration: params.integrationGeneration,
      runtimeVersion: params.runtimeVersion,
    });
    try {
      JSON.parse(embeddedCandidate.toString('utf8'));
    } catch {
      throw new Error('Bundle Drop Android embedded build identity candidate is malformed.');
    }
    if (!embeddedCandidate.equals(serializeEmbeddedBuildCandidate(expectedCandidate))) {
      throw new Error('Bundle Drop Android signed artifact contains a different build identity candidate.');
    }
    return {
      createdAt: params.createdAt,
      evidence: 'android-signed-artifact',
      integrationGeneration: params.integrationGeneration,
      artifactPath,
      artifactSha256: sha256(fs.readFileSync(artifactPath)),
      embeddedCandidateSha256: sha256(embeddedCandidate),
    };
  }
  const candidate = {
    ...createEmbeddedBuildCandidate({
      platform: 'ios',
      identityHash: params.identityHash,
      integrationGeneration: params.integrationGeneration,
      runtimeVersion: params.runtimeVersion,
    }),
    createdAt: params.createdAt,
  };
  const candidateContent = Buffer.from(`${JSON.stringify(candidate)}\n`, 'utf8');
  const candidatePath = path.join(artifactPath, IOS_EMBEDDED_BUILD_CANDIDATE);
  fs.writeFileSync(candidatePath, candidateContent);
  return {
    createdAt: params.createdAt,
    evidence: 'ios-signed-app',
    integrationGeneration: params.integrationGeneration,
    artifactPath,
    embeddedCandidateSha256: sha256(candidateContent),
  };
};

/**
 * Creates the deterministic Android asset that Gradle packages before signing.
 * Receipt creation later accepts only the exact candidate extracted from the
 * signed APK/AAB, so changing project config after the build cannot forge proof.
 */
export async function writeAndroidBuildIdentityCandidate(
  options: WriteAndroidBuildCandidateOptions,
): Promise<string> {
  const projectRoot = path.resolve(options.projectRoot);
  const outputPath = path.resolve(options.outputPath);
  const identity = await resolveExpoBuildIdentity(projectRoot, 'android', {
    officialAppVersion: options.officialAppVersion,
    officialNativeBuildVersion: options.officialNativeBuildVersion,
  });
  const candidate = createEmbeddedBuildCandidate({
    platform: 'android',
    identityHash: identity.identityHash,
    integrationGeneration: resolveExpoIntegrationGeneration(),
    runtimeVersion: identity.runtimeVersion,
  });
  writeBufferAtomically(outputPath, serializeEmbeddedBuildCandidate(candidate));
  return outputPath;
}

export async function writeExpoBuildReceipt(options: WriteBuildReceiptOptions): Promise<string> {
  const projectRoot = path.resolve(options.projectRoot);
  const artifactPath = path.resolve(options.artifactPath);
  const integrationGeneration = resolveExpoIntegrationGeneration();
  const packagedVersions = resolvePackagedBuildVersions(options.platform, artifactPath, options);
  const identity = await resolveExpoBuildIdentity(projectRoot, options.platform, {
    officialAppVersion: packagedVersions.officialAppVersion,
    officialNativeBuildVersion: packagedVersions.officialNativeBuildVersion,
  });
  if (options.platform === 'ios') {
    writeIosRuntimeVersion(artifactPath, identity.runtimeVersion);
  }
  const createdAt = new Date().toISOString();
  const proof = createLocalProof({
    platform: options.platform,
    artifactPath,
    identityHash: identity.identityHash,
    integrationGeneration,
    runtimeVersion: identity.runtimeVersion,
    createdAt,
    androidSdkRoot: options.androidSdkRoot,
  });

  const receiptPath = path.join(projectRoot, '.bundle-drop', 'build-identity.json');
  let previousReceipt: ExpoBuildIdentityReceipt | null = null;
  try {
    previousReceipt = readExpoBuildIdentityReceipt(projectRoot);
  } catch {
    previousReceipt = null;
  }
  const identities: ExpoBuildIdentityReceipt['identities'] = {
    [options.platform]: identity,
  };
  const proofs: ExpoBuildIdentityReceipt['proofs'] = {
    [options.platform]: proof,
  };
  const otherPlatform: MobilePlatform = options.platform === 'ios' ? 'android' : 'ios';
  const otherIdentity = previousReceipt?.identities[otherPlatform];
  const otherProof = previousReceipt?.proofs[otherPlatform];
  if (otherIdentity && otherProof) {
    try {
      const currentOtherIdentity = await resolveExpoBuildIdentity(projectRoot, otherPlatform);
      if (
        currentOtherIdentity.identityHash === otherIdentity.identityHash &&
        otherProof.integrationGeneration === integrationGeneration
      ) {
        identities[otherPlatform] = otherIdentity;
        proofs[otherPlatform] = otherProof;
      }
    } catch {
      // A platform is retained only when its current identity and prior proof can be revalidated.
    }
  }

  const receipt: ExpoBuildIdentityReceipt = {
    schemaVersion: 3,
    identities,
    proofs,
  };
  writeJsonAtomically(receiptPath, receipt);
  return receiptPath;
}

export const parseBuildReceiptArguments = (argv: string[]): WriteBuildReceiptOptions => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (![
      '--project-root',
      '--platform',
      '--artifact',
      '--android-sdk',
      '--app-version',
      '--native-build-version',
    ].includes(flag) || !value) {
      throw new Error('Usage: write-build-receipt --project-root <path> --platform ios|android --artifact <path>');
    }
    if (values.has(flag)) throw new Error(`Duplicate argument ${flag}.`);
    values.set(flag, value);
  }
  const projectRoot = values.get('--project-root');
  const platform = values.get('--platform');
  const artifactPath = values.get('--artifact');
  if (!projectRoot || (platform !== 'ios' && platform !== 'android') || !artifactPath) {
    throw new Error('Usage: write-build-receipt --project-root <path> --platform ios|android --artifact <path>');
  }
  return {
    projectRoot,
    platform,
    artifactPath,
    ...(values.get('--android-sdk') ? { androidSdkRoot: values.get('--android-sdk') } : {}),
    ...(values.get('--app-version') ? { officialAppVersion: values.get('--app-version') } : {}),
    ...(values.get('--native-build-version')
      ? { officialNativeBuildVersion: values.get('--native-build-version') }
      : {}),
  };
};

export const parseAndroidBuildCandidateArguments = (
  argv: string[],
): WriteAndroidBuildCandidateOptions => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (![
      '--project-root',
      '--candidate-output',
      '--app-version',
      '--native-build-version',
    ].includes(flag) || !value) {
      throw new Error(
        'Usage: write-build-receipt --project-root <path> --candidate-output <path> ' +
          '--app-version <version> --native-build-version <version>',
      );
    }
    if (values.has(flag)) throw new Error(`Duplicate argument ${flag}.`);
    values.set(flag, value);
  }
  const projectRoot = values.get('--project-root');
  const outputPath = values.get('--candidate-output');
  const officialAppVersion = values.get('--app-version');
  const officialNativeBuildVersion = values.get('--native-build-version');
  if (!projectRoot || !outputPath || !officialAppVersion || !officialNativeBuildVersion) {
    throw new Error(
      'Usage: write-build-receipt --project-root <path> --candidate-output <path> ' +
        '--app-version <version> --native-build-version <version>',
    );
  }
  return {
    projectRoot,
    outputPath,
    officialAppVersion,
    officialNativeBuildVersion,
  };
};

// The child-process test exercises this executable boundary; Jest does not merge
// coverage counters from the spawned Node process back into the parent.
/* istanbul ignore next */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const operation = argv.includes('--candidate-output')
    ? writeAndroidBuildIdentityCandidate(parseAndroidBuildCandidateArguments(argv))
    : writeExpoBuildReceipt(parseBuildReceiptArguments(argv));
  operation.catch(error => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
