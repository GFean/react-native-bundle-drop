import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { ExpoBuildIdentity, MobilePlatform } from './types';

type PackedDirectoryBoundary = {
  relativePath: string;
  recursive: boolean;
  includeFile: (relativePath: string) => boolean;
};

const PACKED_INTEGRATION_FILES = [
  'app.plugin.js',
  'expo-module.config.json',
  'react-native.config.js',
  'BundleDrop.podspec',
  'BundleDropExpo.podspec',
  'android/build.gradle',
  'android/gradle.properties',
  'expo/android/build.gradle',
  'expo/bundle-drop-expo-gradle-plugin/build.gradle',
  'lib/CLI/scripts/expo/build-receipt.js',
  'lib/CLI/scripts/expo/eas-build-proof.js',
  'lib/CLI/scripts/expo/write-build-receipt.js',
  'lib/CLI/scripts/expo/write-eas-build-receipt.js',
  'lib/expo/buildIdentity.js',
  'lib/expo/buildReceipt.js',
  'lib/expo/config.js',
  'lib/expo/configCache.js',
  'lib/expo/errors.js',
  'lib/expo/index.js',
  'lib/expo/localModules.js',
  'lib/expo/runtimeVersion.js',
  'third_party/xdelta/bundle_drop_xdelta.c',
  'third_party/xdelta/bundle_drop_xdelta.h',
  'third_party/xdelta/xdelta3/config.h',
  'third_party/xdelta/xdelta3/xdelta3-cfgs.h',
  'third_party/xdelta/xdelta3/xdelta3-decode.h',
  'third_party/xdelta/xdelta3/xdelta3-hash.h',
  'third_party/xdelta/xdelta3/xdelta3-internal.h',
  'third_party/xdelta/xdelta3/xdelta3-list.h',
  'third_party/xdelta/xdelta3/xdelta3.c',
  'third_party/xdelta/xdelta3/xdelta3.h',
] as const;

const PACKED_INTEGRATION_DIRECTORIES: readonly PackedDirectoryBoundary[] = [
  {
    relativePath: 'plugin',
    recursive: false,
    includeFile: relativePath => !relativePath.includes('/') && relativePath.endsWith('.js'),
  },
  {
    relativePath: 'expo/android/src/main',
    recursive: true,
    includeFile: () => true,
  },
  {
    relativePath: 'expo/bundle-drop-expo-gradle-plugin/src/main',
    recursive: true,
    includeFile: () => true,
  },
  {
    relativePath: 'expo/ios/Sources',
    recursive: true,
    includeFile: () => true,
  },
  {
    relativePath: 'android/src/main',
    recursive: true,
    includeFile: () => true,
  },
  {
    relativePath: 'ios',
    recursive: false,
    includeFile: relativePath =>
      !relativePath.includes('/') && /\.(?:h|m|mm|swift)$/.test(relativePath),
  },
];

const PACKAGE_DISCRIMINATOR_PATH = 'package.json#native-version';
const EXPECTED_PACKAGE_NAME = '@gfean/react-native-bundle-drop';

export type ExpoBuildProofEvidence =
  | 'ios-signed-app'
  | 'android-signed-artifact'
  | 'eas-official-metadata';

type ExpoBuildProofBase = {
  createdAt: string;
  evidence: ExpoBuildProofEvidence;
  integrationGeneration: string;
};

export type ExpoIosLocalBuildProof = ExpoBuildProofBase & {
  evidence: 'ios-signed-app';
  artifactPath: string;
  embeddedCandidateSha256: string;
};

export type ExpoAndroidLocalBuildProof = ExpoBuildProofBase & {
  evidence: 'android-signed-artifact';
  artifactPath: string;
  artifactSha256: string;
  embeddedCandidateSha256: string;
};

export type ExpoEasBuildProof = ExpoBuildProofBase & {
  evidence: 'eas-official-metadata';
  easBuildId: string;
};

export type ExpoBuildPlatformProof =
  | ExpoIosLocalBuildProof
  | ExpoAndroidLocalBuildProof
  | ExpoEasBuildProof;

export type ExpoBuildIdentityReceipt = {
  schemaVersion: 3;
  identities: {
    ios?: ExpoBuildIdentity;
    android?: ExpoBuildIdentity;
  };
  proofs: {
    ios?: ExpoBuildPlatformProof;
    android?: ExpoBuildPlatformProof;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sha256 = (content: string) => crypto.createHash('sha256').update(content).digest('hex');
const EAS_BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const defaultPackageRoot = () => path.resolve(__dirname, '..', '..');

type PackedIntegrationInput = {
  relativePath: string;
  content: Buffer;
};

const toPortablePath = (value: string) => value.split(path.sep).join('/');
const comparePortablePaths = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const readRequiredPackedFile = (
  packageRoot: string,
  relativePath: string,
): PackedIntegrationInput => {
  const absolutePath = path.join(packageRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Packed Bundle Drop Expo integration is missing ${relativePath}.`);
  }
  const fileStat = fs.lstatSync(absolutePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Packed Bundle Drop Expo integration has an unsupported entry at ${relativePath}.`);
  }
  return { relativePath, content: fs.readFileSync(absolutePath) };
};

const collectPackedDirectoryFiles = (
  packageRoot: string,
  boundary: PackedDirectoryBoundary,
): PackedIntegrationInput[] => {
  const directoryPath = path.join(packageRoot, boundary.relativePath);
  if (!fs.existsSync(directoryPath)) {
    throw new Error(`Packed Bundle Drop Expo integration is missing ${boundary.relativePath}.`);
  }
  const directoryStat = fs.lstatSync(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(
      `Packed Bundle Drop Expo integration has an unsupported entry at ${boundary.relativePath}.`,
    );
  }

  const files: PackedIntegrationInput[] = [];
  const visit = (absoluteDirectory: string, relativeDirectory: string) => {
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => comparePortablePaths(left.name, right.name));
    for (const entry of entries) {
      const relativeToBoundary = toPortablePath(path.join(relativeDirectory, entry.name));
      const relativeToPackage = toPortablePath(
        path.join(boundary.relativePath, relativeToBoundary),
      );
      const absoluteEntry = path.join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Packed Bundle Drop Expo integration has an unsupported entry at ${relativeToPackage}.`,
        );
      }
      if (entry.isDirectory()) {
        if (boundary.recursive) visit(absoluteEntry, relativeToBoundary);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Packed Bundle Drop Expo integration has an unsupported entry at ${relativeToPackage}.`,
        );
      }
      if (boundary.includeFile(relativeToBoundary)) {
        files.push({ relativePath: relativeToPackage, content: fs.readFileSync(absoluteEntry) });
      }
    }
  };
  visit(directoryPath, '');
  if (files.length === 0) {
    throw new Error(
      `Packed Bundle Drop Expo integration has no packed files under ${boundary.relativePath}.`,
    );
  }
  return files;
};

const readPackageNativeVersionDiscriminator = (packageRoot: string): PackedIntegrationInput => {
  const packageJson = readRequiredPackedFile(packageRoot, 'package.json');
  let value: unknown;
  try {
    value = JSON.parse(packageJson.content.toString('utf8'));
  } catch {
    throw new Error('Packed Bundle Drop package.json is malformed.');
  }
  if (!isRecord(value) || value.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`Packed Bundle Drop package.json must identify ${EXPECTED_PACKAGE_NAME}.`);
  }
  if (typeof value.version !== 'string' || !value.version.trim()) {
    throw new Error('Packed Bundle Drop package.json has no package version.');
  }
  const nativeVersion = value.nativeVersion === undefined ? value.version : value.nativeVersion;
  if (typeof nativeVersion !== 'string' || !nativeVersion.trim()) {
    throw new Error('Packed Bundle Drop package.json has no native version discriminator.');
  }
  return {
    relativePath: PACKAGE_DISCRIMINATOR_PATH,
    content: Buffer.from(JSON.stringify({ name: value.name, nativeVersion }), 'utf8'),
  };
};

const collectPackedIntegrationInputs = (packageRoot: string): PackedIntegrationInput[] => {
  const inputs = PACKED_INTEGRATION_FILES.map(relativePath =>
    readRequiredPackedFile(packageRoot, relativePath));
  for (const boundary of PACKED_INTEGRATION_DIRECTORIES) {
    inputs.push(...collectPackedDirectoryFiles(packageRoot, boundary));
  }
  inputs.push(readPackageNativeVersionDiscriminator(packageRoot));
  return inputs.sort((left, right) =>
    comparePortablePaths(left.relativePath, right.relativePath));
};

/**
 * Hashes the packed source, build, configuration, and proof inputs that can
 * alter the Expo native integration or its signed build evidence.
 * A receipt from a different adapter generation must not authorize an upload.
 */
export function resolveExpoIntegrationGeneration(packageRoot = defaultPackageRoot()): string {
  const digest = crypto.createHash('sha256');
  digest.update('bundle-drop-expo-integration-generation-v2');
  digest.update('\0');
  for (const input of collectPackedIntegrationInputs(packageRoot)) {
    digest.update(input.relativePath);
    digest.update('\0');
    digest.update(String(input.content.length));
    digest.update('\0');
    digest.update(input.content);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

const assertIdentity = (platform: MobilePlatform, value: unknown): ExpoBuildIdentity => {
  if (!isRecord(value) || value.platform !== platform || typeof value.identityHash !== 'string') {
    throw new Error(`Bundle Drop build identity receipt has an invalid ${platform} identity.`);
  }
  const { identityHash, ...identityWithoutHash } = value;
  if (sha256(JSON.stringify(identityWithoutHash)) !== identityHash) {
    throw new Error(`Bundle Drop build identity receipt has an invalid ${platform} identity hash.`);
  }
  return value as unknown as ExpoBuildIdentity;
};

const assertProof = (params: {
  platform: MobilePlatform;
  value: unknown;
  expectedIntegrationGeneration: string;
}): ExpoBuildPlatformProof => {
  if (!isRecord(params.value)) {
    throw new Error(`Bundle Drop build identity receipt has no ${params.platform} build proof.`);
  }
  const {
    createdAt,
    evidence,
    integrationGeneration,
    easBuildId,
    artifactPath,
    artifactSha256,
    embeddedCandidateSha256,
  } = params.value;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`Bundle Drop build identity receipt has an invalid ${params.platform} proof date.`);
  }
  const localEvidence = params.platform === 'ios'
    ? 'ios-signed-app'
    : 'android-signed-artifact';
  if (evidence !== localEvidence && evidence !== 'eas-official-metadata') {
    throw new Error(`Bundle Drop build identity receipt has invalid ${params.platform} evidence.`);
  }
  if (integrationGeneration !== params.expectedIntegrationGeneration) {
    throw new Error(
      `Bundle Drop ${params.platform} build proof belongs to a different Expo integration generation. ` +
        'Create a new native build before uploading.',
    );
  }
  if (evidence === 'eas-official-metadata') {
    if (typeof easBuildId !== 'string' || !EAS_BUILD_ID.test(easBuildId)) {
      throw new Error(`Bundle Drop ${params.platform} EAS build proof must include its exact easBuildId.`);
    }
    if (artifactPath !== undefined || artifactSha256 !== undefined || embeddedCandidateSha256 !== undefined) {
      throw new Error(`Bundle Drop ${params.platform} EAS build proof cannot include local artifact fields.`);
    }
  } else {
    if (easBuildId !== undefined) {
      throw new Error(`Bundle Drop local ${params.platform} build proof cannot include an easBuildId.`);
    }
    if (typeof artifactPath !== 'string' || !path.isAbsolute(artifactPath)) {
      throw new Error(`Bundle Drop local ${params.platform} build proof requires an absolute artifactPath.`);
    }
    if (params.platform === 'android') {
      if (typeof artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifactSha256)) {
        throw new Error('Bundle Drop Android build proof has an invalid artifact SHA-256.');
      }
      if (typeof embeddedCandidateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(embeddedCandidateSha256)) {
        throw new Error('Bundle Drop Android build proof has an invalid embedded candidate SHA-256.');
      }
    } else {
      if (typeof embeddedCandidateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(embeddedCandidateSha256)) {
        throw new Error('Bundle Drop iOS build proof has an invalid embedded candidate SHA-256.');
      }
      if (artifactSha256 !== undefined) {
        throw new Error('Bundle Drop iOS build proof cannot include an Android artifact hash.');
      }
    }
  }
  return params.value as ExpoBuildPlatformProof;
};

export function parseExpoBuildIdentityReceipt(
  value: unknown,
  expectedIntegrationGeneration = resolveExpoIntegrationGeneration(),
): ExpoBuildIdentityReceipt {
  if (!isRecord(value) || value.schemaVersion !== 3 || !isRecord(value.identities) || !isRecord(value.proofs)) {
    throw new Error('Bundle Drop build identity receipt is incomplete or unsupported.');
  }

  const identities: ExpoBuildIdentityReceipt['identities'] = {};
  const proofs: ExpoBuildIdentityReceipt['proofs'] = {};
  for (const platform of ['ios', 'android'] as const) {
    const identityValue = value.identities[platform];
    const proofValue = value.proofs[platform];
    if (identityValue === undefined && proofValue === undefined) continue;
    if (identityValue === undefined || proofValue === undefined) {
      throw new Error(`Bundle Drop build identity receipt has incomplete ${platform} build proof.`);
    }
    identities[platform] = assertIdentity(platform, identityValue);
    proofs[platform] = assertProof({
      platform,
      value: proofValue,
      expectedIntegrationGeneration,
    });
  }
  if (!identities.ios && !identities.android) {
    throw new Error('Bundle Drop build identity receipt is incomplete or unsupported.');
  }
  return { schemaVersion: 3, identities, proofs };
}
