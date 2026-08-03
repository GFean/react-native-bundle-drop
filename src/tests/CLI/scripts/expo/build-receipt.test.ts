import childProcess from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

import * as expo from '../../../../expo';
import type { ExpoBuildIdentity } from '../../../../expo';
import {
  ANDROID_AAB_EMBEDDED_BUILD_CANDIDATE,
  ANDROID_APK_EMBEDDED_BUILD_CANDIDATE,
  assertExpoUploadMatchesBuild,
  createEmbeddedBuildCandidate,
  IOS_EMBEDDED_BUILD_CANDIDATE,
  readAndroidEmbeddedBuildCandidate,
  readExpoBuildIdentityReceipt,
  resolveExpoUploadIdentity,
} from '../../../../CLI/scripts/expo/build-receipt';
import {
  parseAndroidBuildCandidateArguments,
  parseBuildReceiptArguments,
  writeAndroidBuildIdentityCandidate,
  writeExpoBuildReceipt,
} from '../../../../CLI/scripts/expo/write-build-receipt';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

const packageRoot = path.resolve(__dirname, '../../../../..');
const integrationFixtureEntries = [
  'app.plugin.js',
  'expo-module.config.json',
  'react-native.config.js',
  'BundleDrop.podspec',
  'BundleDropExpo.podspec',
  'package.json',
  'plugin',
  'android/build.gradle',
  'android/gradle.properties',
  'android/src/main',
  'expo/android/build.gradle',
  'expo/android/src/main',
  'expo/bundle-drop-expo-gradle-plugin/build.gradle',
  'expo/bundle-drop-expo-gradle-plugin/src/main',
  'expo/ios/Sources',
  'ios',
  'third_party/xdelta',
  'lib/CLI/scripts/expo',
  'lib/expo',
  'lib/index.js',
  'README.md',
] as const;

const integrationGenerationMutationCases = [
  ['core iOS source', 'ios/BundleDropOtaResolver.swift'],
  ['core Android source', 'android/src/main/java/com/bundledrop/BundleDropOtaResolver.kt'],
  [
    'Expo Gradle proof plugin',
    'expo/bundle-drop-expo-gradle-plugin/src/main/groovy/com/bundledrop/gradle/BundleDropExpoPlugin.groovy',
  ],
  ['build-proof runtime', 'lib/CLI/scripts/expo/write-build-receipt.js'],
  ['xdelta wrapper source', 'third_party/xdelta/bundle_drop_xdelta.c'],
  ['xdelta wrapper header', 'third_party/xdelta/bundle_drop_xdelta.h'],
  ['xdelta configuration header', 'third_party/xdelta/xdelta3/config.h'],
  ['xdelta implementation', 'third_party/xdelta/xdelta3/xdelta3.c'],
  ['xdelta public header', 'third_party/xdelta/xdelta3/xdelta3.h'],
  ['xdelta internal header', 'third_party/xdelta/xdelta3/xdelta3-internal.h'],
  ['xdelta list header', 'third_party/xdelta/xdelta3/xdelta3-list.h'],
  ['xdelta hash header', 'third_party/xdelta/xdelta3/xdelta3-hash.h'],
  ['xdelta configuration flags header', 'third_party/xdelta/xdelta3/xdelta3-cfgs.h'],
  ['xdelta decoder header', 'third_party/xdelta/xdelta3/xdelta3-decode.h'],
] as const;

const createIntegrationGenerationFixture = (reverseCreationOrder = false) => {
  const fixtureRoot = createTempProjectDir();
  const entries = reverseCreationOrder
    ? [...integrationFixtureEntries].reverse()
    : integrationFixtureEntries;
  for (const relativePath of entries) {
    const source = path.join(packageRoot, relativePath);
    const destination = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
  return fixtureRoot;
};

const makeIdentity = (platform: 'ios' | 'android', runtimeVersion = 'runtime-1'): ExpoBuildIdentity => {
  const value: Omit<ExpoBuildIdentity, 'identityHash'> = {
    platform,
    runtimeVersion,
    runtimeVersionPolicy: 'literal',
    expoSdkVersion: '57.0.0',
    reactNativeVersion: '0.86.0',
    javaScriptEngine: 'hermes',
    appVersion: '1.2.3',
    nativeVersion: platform === 'ios' ? '1.2.3(7)' : '1.2.3(8)',
  };
  return { ...value, identityHash: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') };
};

describe('artifact-bound Expo build receipts', () => {
  const easBuildIds = {
    ios: '11111111-1111-4111-8111-111111111111',
    android: '22222222-2222-4222-8222-222222222222',
  } as const;
  let root = '';
  let resolveSpy: jest.SpyInstance;
  let fingerprintSpy: jest.SpyInstance;
  let spawnSpy: jest.SpyInstance;
  let androidSdk = '';

  beforeEach(() => {
    root = createTempProjectDir();
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      "module.exports = { projectType: 'expo', runtimeVersion: { source: 'expo' } };\n",
    );
    androidSdk = path.join(root, 'android-sdk');
    const apksigner = path.join(androidSdk, 'build-tools', '35.0.0', 'apksigner');
    fs.mkdirSync(path.dirname(apksigner), { recursive: true });
    fs.writeFileSync(apksigner, 'tool');
    resolveSpy = jest.spyOn(expo, 'resolveExpoBuildIdentity').mockImplementation(
      async (_root, platform) => makeIdentity(platform),
    );
    fingerprintSpy = jest.spyOn(expo, 'resolveExpoProjectFingerprint')
      .mockResolvedValue('not-used-for-literal');
    spawnSpy = jest.spyOn(childProcess, 'spawnSync').mockImplementation((_executable, args) => ({
      pid: 1,
      output: [],
      stdout: args?.[1] === 'CFBundleShortVersionString'
        ? '1.2.3\n'
        : args?.[1] === 'CFBundleVersion'
          ? '7\n'
          : '',
      stderr: '',
      status: 0,
      signal: null,
    }));
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    resolveSpy.mockRestore();
    fingerprintSpy.mockRestore();
    jest.restoreAllMocks();
    removeTempDir(root);
  });

  const writeArtifact = (relative: string, content = 'signed-binary') => {
    const artifact = path.join(root, relative);
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, content);
    return artifact;
  };

  const createIosApp = (relative: string) => {
    const app = path.join(root, relative);
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'Info.plist'), 'packaged plist');
    return app;
  };

  const writeAndroidArtifact = (
    relative: string,
    candidate = createEmbeddedBuildCandidate({
      platform: 'android',
      identityHash: makeIdentity('android').identityHash,
      integrationGeneration: expo.resolveExpoIntegrationGeneration(),
      runtimeVersion: 'runtime-1',
    }),
  ) => {
    const artifact = path.join(root, relative);
    const zip = new AdmZip();
    const entry = relative.endsWith('.aab')
      ? ANDROID_AAB_EMBEDDED_BUILD_CANDIDATE
      : ANDROID_APK_EMBEDDED_BUILD_CANDIDATE;
    zip.addFile(entry, Buffer.from(`${JSON.stringify(candidate)}\n`, 'utf8'));
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    zip.writeZip(artifact);
    return artifact;
  };

  const writeReceipt = (value: unknown, relative = '.bundle-drop/build-identity.json') => {
    const receiptPath = path.join(root, relative);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify(value));
    return receiptPath;
  };

  const easReceipt = (platform: 'ios' | 'android') => ({
    schemaVersion: 3 as const,
    identities: { [platform]: makeIdentity(platform) },
    proofs: {
      [platform]: {
        createdAt: '2026-08-01T00:00:00.000Z',
        evidence: 'eas-official-metadata' as const,
        integrationGeneration: expo.resolveExpoIntegrationGeneration(),
        easBuildId: easBuildIds[platform],
      },
    },
  });

  it('writes Android proof only after signature verification and binds the exact artifact hash', async () => {
    const artifact = writeAndroidArtifact('android/app/build/outputs/apk/release/app-release.apk');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: artifact, androidSdkRoot: androidSdk });

    const receipt = readExpoBuildIdentityReceipt(root, undefined, 'android')!;
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt.proofs.android).toEqual(expect.objectContaining({
      evidence: 'android-signed-artifact',
      artifactPath: artifact,
      artifactSha256: crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'),
      embeddedCandidateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(spawnSpy).toHaveBeenCalledWith(
      expect.stringContaining('apksigner'), ['verify', artifact], { encoding: 'utf8', shell: false },
    );

    fs.writeFileSync(artifact, 'mutated');
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'android')).toThrow('changed after');
    fs.rmSync(artifact);
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'android')).toThrow('no longer exists');
  });

  it('generates a deterministic Android candidate for Gradle to package before signing', async () => {
    const outputPath = path.join(root, 'build/generated/assets/bundle-drop/build-identity.json');
    await expect(writeAndroidBuildIdentityCandidate({
      projectRoot: root,
      outputPath,
      officialAppVersion: '1.2.3',
      officialNativeBuildVersion: '8',
    })).resolves.toBe(outputPath);
    const firstContent = fs.readFileSync(outputPath);
    expect(JSON.parse(firstContent.toString('utf8'))).toEqual(createEmbeddedBuildCandidate({
      platform: 'android',
      identityHash: makeIdentity('android').identityHash,
      integrationGeneration: expo.resolveExpoIntegrationGeneration(),
      runtimeVersion: 'runtime-1',
    }));
    expect(resolveSpy).toHaveBeenCalledWith(root, 'android', {
      officialAppVersion: '1.2.3',
      officialNativeBuildVersion: '8',
    });

    await writeAndroidBuildIdentityCandidate({
      projectRoot: root,
      outputPath,
      officialAppVersion: '1.2.3',
      officialNativeBuildVersion: '8',
    });
    expect(fs.readFileSync(outputPath)).toEqual(firstContent);
    expect(parseAndroidBuildCandidateArguments([
      '--project-root', root,
      '--candidate-output', outputPath,
      '--app-version', '1.2.3',
      '--native-build-version', '8',
    ])).toEqual({
      projectRoot: root,
      outputPath,
      officialAppVersion: '1.2.3',
      officialNativeBuildVersion: '8',
    });
    expect(() => parseAndroidBuildCandidateArguments(['--candidate-output', outputPath]))
      .toThrow('Usage');
    expect(() => parseAndroidBuildCandidateArguments(['--unknown', 'value']))
      .toThrow('Usage');
    expect(() => parseAndroidBuildCandidateArguments([
      '--project-root', root,
      '--project-root', root,
    ])).toThrow('Duplicate argument --project-root');
  });

  it('rejects a signed Android artifact whose embedded identity differs from the build', async () => {
    const artifact = writeAndroidArtifact('wrong-identity.apk', createEmbeddedBuildCandidate({
      platform: 'android',
      identityHash: 'f'.repeat(64),
      integrationGeneration: expo.resolveExpoIntegrationGeneration(),
      runtimeVersion: 'runtime-1',
    }));
    await expect(writeExpoBuildReceipt({
      projectRoot: root,
      platform: 'android',
      artifactPath: artifact,
      androidSdkRoot: androidSdk,
    })).rejects.toThrow('contains a different build identity candidate');
  });

  it('fails closed for missing, malformed, and unbound Android archive candidates', async () => {
    const plainArtifact = writeArtifact('plain.apk');
    await expect(writeExpoBuildReceipt({
      projectRoot: root,
      platform: 'android',
      artifactPath: plainArtifact,
      androidSdkRoot: androidSdk,
    })).rejects.toThrow('not a readable APK/AAB archive');

    const missingCandidate = path.join(root, 'missing-candidate.apk');
    const missingZip = new AdmZip();
    missingZip.addFile('assets/unrelated.txt', Buffer.from('unrelated'));
    missingZip.writeZip(missingCandidate);
    await expect(writeExpoBuildReceipt({
      projectRoot: root,
      platform: 'android',
      artifactPath: missingCandidate,
      androidSdkRoot: androidSdk,
    })).rejects.toThrow('exactly one signed identity candidate');

    const malformedCandidate = path.join(root, 'malformed-candidate.apk');
    const malformedZip = new AdmZip();
    malformedZip.addFile(ANDROID_APK_EMBEDDED_BUILD_CANDIDATE, Buffer.from('{malformed'));
    malformedZip.writeZip(malformedCandidate);
    await expect(writeExpoBuildReceipt({
      projectRoot: root,
      platform: 'android',
      artifactPath: malformedCandidate,
      androidSdkRoot: androidSdk,
    })).rejects.toThrow('candidate is malformed');

    const wrongCandidate = fs.readFileSync(malformedCandidate);
    writeReceipt({
      schemaVersion: 3,
      identities: { android: makeIdentity('android') },
      proofs: { android: {
        createdAt: '2026-08-01T00:00:00.000Z',
        evidence: 'android-signed-artifact',
        integrationGeneration: expo.resolveExpoIntegrationGeneration(),
        artifactPath: malformedCandidate,
        artifactSha256: crypto.createHash('sha256').update(wrongCandidate).digest('hex'),
        embeddedCandidateSha256: crypto.createHash('sha256').update('{malformed').digest('hex'),
      } },
    });
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'android'))
      .toThrow('candidate is malformed');

    const unboundArtifact = writeAndroidArtifact('unbound-receipt.apk', createEmbeddedBuildCandidate({
      platform: 'android',
      identityHash: 'e'.repeat(64),
      integrationGeneration: expo.resolveExpoIntegrationGeneration(),
      runtimeVersion: 'runtime-1',
    }));
    const unboundContent = new AdmZip(unboundArtifact)
      .getEntry(ANDROID_APK_EMBEDDED_BUILD_CANDIDATE)!
      .getData();
    writeReceipt({
      schemaVersion: 3,
      identities: { android: makeIdentity('android') },
      proofs: { android: {
        createdAt: '2026-08-01T00:00:00.000Z',
        evidence: 'android-signed-artifact',
        integrationGeneration: expo.resolveExpoIntegrationGeneration(),
        artifactPath: unboundArtifact,
        artifactSha256: crypto.createHash('sha256').update(fs.readFileSync(unboundArtifact)).digest('hex'),
        embeddedCandidateSha256: crypto.createHash('sha256').update(unboundContent).digest('hex'),
      } },
    });
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'android'))
      .toThrow('candidate is not bound to this build proof');
  });

  it('rejects invalid Android candidate sizes', () => {
    const emptyCandidateArtifact = path.join(root, 'empty-candidate.apk');
    const emptyCandidateZip = new AdmZip();
    emptyCandidateZip.addFile(ANDROID_APK_EMBEDDED_BUILD_CANDIDATE, Buffer.alloc(0));
    emptyCandidateZip.writeZip(emptyCandidateArtifact);
    expect(() => readAndroidEmbeddedBuildCandidate(emptyCandidateArtifact))
      .toThrow('candidate has an invalid size');

    jest.isolateModules(() => {
      jest.doMock('adm-zip', () => jest.fn(() => ({
        getEntries: () => [{
          entryName: ANDROID_APK_EMBEDDED_BUILD_CANDIDATE,
          isDirectory: false,
          header: { size: 2 },
          getData: () => Buffer.from('x'),
        }],
      })));
      const isolatedModule = require('../../../../CLI/scripts/expo/build-receipt') as
        typeof import('../../../../CLI/scripts/expo/build-receipt');
      expect(() => isolatedModule.readAndroidEmbeddedBuildCandidate('mismatched-size.apk'))
        .toThrow('candidate has an invalid size');
    });
    jest.dontMock('adm-zip');
  });

  it('rejects an Android candidate hash that differs from its receipt', () => {
    const artifact = writeAndroidArtifact('wrong-candidate-hash.apk');
    const artifactContent = fs.readFileSync(artifact);
    writeReceipt({
      schemaVersion: 3,
      identities: { android: makeIdentity('android') },
      proofs: { android: {
        createdAt: '2026-08-01T00:00:00.000Z',
        evidence: 'android-signed-artifact',
        integrationGeneration: expo.resolveExpoIntegrationGeneration(),
        artifactPath: artifact,
        artifactSha256: crypto.createHash('sha256').update(artifactContent).digest('hex'),
        embeddedCandidateSha256: '0'.repeat(64),
      } },
    });
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'android'))
      .toThrow('candidate does not match its receipt');
  });

  it('rejects an Android artifact when signature verification fails', async () => {
    spawnSpy.mockReturnValue({ pid: 1, output: [], stdout: '', stderr: 'unsigned', status: 1, signal: null });
    const artifact = writeAndroidArtifact('app-release.aab');
    await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: artifact }))
      .rejects.toThrow('signature verification failed');
    expect(fs.existsSync(path.join(root, '.bundle-drop/build-identity.json'))).toBe(false);
  });

  it('requires strict jarsigner verification for AAB proof', async () => {
    const artifact = writeAndroidArtifact('app-release.aab');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: artifact });
    expect(spawnSpy).toHaveBeenCalledWith(
      'jarsigner', ['-verify', '-strict', artifact], { encoding: 'utf8', shell: false },
    );
  });

  it('embeds an iOS candidate and accepts it only after exact codesign succeeds', async () => {
    const app = createIosApp('build/Example.app');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: app });

    const candidate = JSON.parse(fs.readFileSync(path.join(app, IOS_EMBEDDED_BUILD_CANDIDATE), 'utf8'));
    expect(candidate).toEqual(expect.objectContaining({ platform: 'ios', identityHash: makeIdentity('ios').identityHash }));
    expect(resolveSpy).toHaveBeenCalledWith(root, 'ios', {
      officialAppVersion: '1.2.3',
      officialNativeBuildVersion: '7',
    });
    expect(spawnSpy).toHaveBeenCalledWith(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Info.plist')],
      { encoding: 'utf8', shell: false },
    );
    expect(spawnSpy).toHaveBeenCalledWith(
      '/usr/bin/plutil',
      ['-replace', 'BundleDropRuntimeVersion', '-string', 'runtime-1', path.join(app, 'Info.plist')],
      { encoding: 'utf8', shell: false },
    );
    expect(readExpoBuildIdentityReceipt(root, undefined, 'ios')?.proofs.ios?.evidence).toBe('ios-signed-app');
    expect(spawnSpy).toHaveBeenLastCalledWith(
      '/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8', shell: false },
    );

    spawnSpy.mockReturnValue({ pid: 1, output: [], stdout: '', stderr: 'bad signature', status: 1, signal: null });
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'ios')).toThrow('signature verification failed');
  });

  it('inserts the iOS runtime identity when the packaged plist has no existing key', async () => {
    const app = createIosApp('MissingRuntimeKey.app');
    spawnSpy.mockImplementation((_executable, args) => ({
      pid: 1,
      output: [],
      stdout: args?.[1] === 'CFBundleShortVersionString'
        ? '1.2.3\n'
        : args?.[1] === 'CFBundleVersion'
          ? '7\n'
          : '',
      stderr: args?.[0] === '-replace' ? 'key does not exist' : '',
      status: args?.[0] === '-replace' ? 1 : 0,
      signal: null,
    }));

    await expect(writeExpoBuildReceipt({
      projectRoot: root,
      platform: 'ios',
      artifactPath: app,
    })).resolves.toBeDefined();
    expect(spawnSpy).toHaveBeenCalledWith(
      '/usr/bin/plutil',
      ['-insert', 'BundleDropRuntimeVersion', '-string', 'runtime-1', path.join(app, 'Info.plist')],
      { encoding: 'utf8', shell: false },
    );
  });

  it('fails closed when the iOS runtime identity cannot be replaced or inserted', async () => {
    const app = createIosApp('UnwritableRuntimeKey.app');
    spawnSpy.mockImplementation((_executable, args) => ({
      pid: 1,
      output: [],
      stdout: args?.[1] === 'CFBundleShortVersionString'
        ? '1.2.3\n'
        : args?.[1] === 'CFBundleVersion'
          ? '7\n'
          : '',
      stderr: args?.[0] === '-insert' ? 'plist is read-only' : '',
      status: args?.[0] === '-replace' || args?.[0] === '-insert' ? 1 : 0,
      signal: null,
    }));

    await expect(writeExpoBuildReceipt({
      projectRoot: root,
      platform: 'ios',
      artifactPath: app,
    })).rejects.toThrow('could not embed the iOS runtime version: plist is read-only');
  });

  it('rejects a missing or changed iOS embedded candidate', async () => {
    const app = createIosApp('Example.app');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: app });
    const candidate = path.join(app, IOS_EMBEDDED_BUILD_CANDIDATE);
    fs.writeFileSync(candidate, '{}');
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'ios')).toThrow('does not match');
    fs.rmSync(candidate);
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'ios')).toThrow('does not contain');
  });

  it('isolates platform acceptance and drops stale other-platform proof on merge', async () => {
    const android = writeAndroidArtifact('app.apk');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: android, androidSdkRoot: androidSdk });
    const app = createIosApp('Example.app');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: app });
    fs.rmSync(android);

    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'ios')).not.toThrow();
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'android')).toThrow('no longer exists');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: app });
    expect(readExpoBuildIdentityReceipt(root, undefined, 'ios')?.identities.android).toBeUndefined();
  });

  it('rejects legacy receipts and accepts an exact platform-bound EAS build ID', async () => {
    const receiptPath = path.join(root, '.bundle-drop/build-identity.json');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 2, identities: {}, proofs: {} }));
    expect(() => readExpoBuildIdentityReceipt(root)).toThrow('incomplete or unsupported');

    const identity = makeIdentity('ios');
    fs.writeFileSync(receiptPath, JSON.stringify({
      schemaVersion: 3,
      identities: { ios: identity },
      proofs: { ios: {
        createdAt: new Date().toISOString(),
        evidence: 'eas-official-metadata',
        integrationGeneration: expo.resolveExpoIntegrationGeneration(),
        easBuildId: easBuildIds.ios,
      } },
    }));
    expect(readExpoBuildIdentityReceipt(root, undefined, 'ios')?.proofs.ios).toEqual(expect.objectContaining({ easBuildId: easBuildIds.ios }));
    jest.spyOn(expo, 'evaluateExpoConfig').mockReturnValue({
      exp: { extra: { eas: { projectId: 'project-id' } } },
    } as any);
    spawnSpy.mockImplementation((command: string, args: string[]) => {
      if (command === 'eas') {
        return {
          pid: 1, output: [], stderr: '', status: 0, signal: null,
          stdout: JSON.stringify({
            id: easBuildIds.ios,
            status: 'FINISHED',
            platform: 'IOS',
            project: { id: 'project-id' },
            artifacts: { applicationArchiveUrl: 'https://example.test/app.ipa' },
            fingerprint: { hash: 'not-used-for-literal' },
            sdkVersion: '57.0.0',
            appVersion: '1.2.3',
            appBuildVersion: '7',
            runtimeVersion: 'runtime-1',
            gitCommitHash: 'abc123',
          }),
        };
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return { pid: 1, output: [], stdout: 'abc123\n', stderr: '', status: 0, signal: null };
      }
      return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null };
    });
    await expect(resolveExpoUploadIdentity({ projectRoot: root, platform: 'ios' })).resolves.toEqual(identity);
    expect(resolveSpy).toHaveBeenCalledWith(root, 'ios', {
      officialAppVersion: '1.2.3',
      officialNativeBuildVersion: '7',
    });
  });

  it('enforces identity parity and parses shell-safe fixed argv only', async () => {
    const artifact = writeAndroidArtifact('app.apk');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: artifact, androidSdkRoot: androidSdk });
    expect(() => assertExpoUploadMatchesBuild({ projectRoot: root, platform: 'android', uploadIdentity: makeIdentity('android', 'other') }))
      .toThrow('build/upload identity mismatch');
    expect(parseBuildReceiptArguments(['--project-root', root, '--platform', 'ios', '--artifact', '/tmp/X.app']))
      .toEqual({ projectRoot: root, platform: 'ios', artifactPath: '/tmp/X.app' });
    expect(() => parseBuildReceiptArguments(['--command', 'rm -rf /'])).toThrow('Usage');
    expect(() => parseBuildReceiptArguments(['--platform', 'ios', '--platform', 'android'])).toThrow();
  });

  it('uses an artifact-bound local receipt for remote nativeVersion projects', async () => {
    const app = createIosApp('Remote.app');
    const builtIdentity = makeIdentity('ios');
    resolveSpy.mockResolvedValue(builtIdentity);
    await writeExpoBuildReceipt({
      projectRoot: root,
      platform: 'ios',
      artifactPath: app,
      officialAppVersion: '1.2.3',
      officialNativeBuildVersion: '7',
    });

    resolveSpy.mockRejectedValueOnce(
      new Error('The nativeVersion runtime policy uses remote EAS app versions.'),
    ).mockResolvedValueOnce(builtIdentity);
    await expect(resolveExpoUploadIdentity({ projectRoot: root, platform: 'ios' }))
      .resolves.toEqual(builtIdentity);
    expect(resolveSpy).toHaveBeenLastCalledWith(root, 'ios', {
      officialAppVersion: '1.2.3',
      officialNativeBuildVersion: '7',
    });

    const invalidIdentity = { ...builtIdentity, nativeVersion: 'invalid' };
    invalidIdentity.identityHash = crypto.createHash('sha256').update(JSON.stringify(
      Object.fromEntries(Object.entries(invalidIdentity).filter(([key]) => key !== 'identityHash')),
    )).digest('hex');
    const receipt = readExpoBuildIdentityReceipt(root, undefined, 'ios')!;
    const candidate = JSON.parse(fs.readFileSync(path.join(app, IOS_EMBEDDED_BUILD_CANDIDATE), 'utf8'));
    candidate.identityHash = invalidIdentity.identityHash;
    const candidateContent = Buffer.from(`${JSON.stringify(candidate)}\n`);
    fs.writeFileSync(path.join(app, IOS_EMBEDDED_BUILD_CANDIDATE), candidateContent);
    receipt.identities.ios = invalidIdentity;
    (receipt.proofs.ios as any).embeddedCandidateSha256 = crypto.createHash('sha256')
      .update(candidateContent)
      .digest('hex');
    writeReceipt(receipt);
    resolveSpy.mockRejectedValueOnce(
      new Error('The nativeVersion runtime policy uses remote EAS app versions.'),
    );
    await expect(resolveExpoUploadIdentity({ projectRoot: root, platform: 'ios' }))
      .rejects.toThrow('invalid Expo native version');
  });

  it.each(integrationGenerationMutationCases)(
    'changes integration generation when %s changes',
    (_label, relativePath) => {
      const fixtureRoot = createIntegrationGenerationFixture();
      try {
        const generation = expo.resolveExpoIntegrationGeneration(fixtureRoot);
        const mutatedPath = path.join(fixtureRoot, relativePath);
        fs.mkdirSync(path.dirname(mutatedPath), { recursive: true });
        fs.appendFileSync(mutatedPath, '\n// generation mutation\n');
        expect(expo.resolveExpoIntegrationGeneration(fixtureRoot)).not.toBe(generation);
      } finally {
        removeTempDir(fixtureRoot);
      }
    },
  );

  it('uses nativeVersion, with package version as the explicit fallback discriminator', () => {
    const fixtureRoot = createIntegrationGenerationFixture();
    try {
      const packageJsonPath = path.join(fixtureRoot, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const generation = expo.resolveExpoIntegrationGeneration(fixtureRoot);

      packageJson.nativeVersion = '99.0.0-native';
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson));
      expect(expo.resolveExpoIntegrationGeneration(fixtureRoot)).not.toBe(generation);

      delete packageJson.nativeVersion;
      packageJson.version = '99.0.0-fallback';
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson));
      const firstFallbackGeneration = expo.resolveExpoIntegrationGeneration(fixtureRoot);
      packageJson.version = '99.0.1-fallback';
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson));
      expect(expo.resolveExpoIntegrationGeneration(fixtureRoot)).not.toBe(firstFallbackGeneration);
    } finally {
      removeTempDir(fixtureRoot);
    }
  });

  it('ignores unrelated packed JavaScript and documentation', () => {
    const fixtureRoot = createIntegrationGenerationFixture();
    try {
      const generation = expo.resolveExpoIntegrationGeneration(fixtureRoot);
      fs.appendFileSync(path.join(fixtureRoot, 'lib/index.js'), '\n// unrelated public JS\n');
      fs.appendFileSync(path.join(fixtureRoot, 'README.md'), '\nunrelated documentation\n');
      fs.appendFileSync(
        path.join(fixtureRoot, 'third_party/xdelta/xdelta3/xdelta3-second.h'),
        '\n/* source-only xdelta header */\n',
      );
      const nestedIosSource = path.join(fixtureRoot, 'ios/Nested/SourceOnly.swift');
      fs.mkdirSync(path.dirname(nestedIosSource), { recursive: true });
      fs.writeFileSync(nestedIosSource, 'let sourceOnly = true\n');
      expect(expo.resolveExpoIntegrationGeneration(fixtureRoot)).toBe(generation);
    } finally {
      removeTempDir(fixtureRoot);
    }
  });

  it('matches the installed package after npm-excluded native sources are removed', () => {
    const sourceRoot = createIntegrationGenerationFixture();
    const installedRoot = createIntegrationGenerationFixture();
    const npmExcludedSources = [
      'third_party/xdelta/xdelta3/xdelta3-blkcache.h',
      'third_party/xdelta/xdelta3/xdelta3-djw.h',
      'third_party/xdelta/xdelta3/xdelta3-fgk.h',
      'third_party/xdelta/xdelta3/xdelta3-lzma.h',
      'third_party/xdelta/xdelta3/xdelta3-main.h',
      'third_party/xdelta/xdelta3/xdelta3-merge.h',
      'third_party/xdelta/xdelta3/xdelta3-second.h',
      'third_party/xdelta/xdelta3/xdelta3-test.h',
    ];
    try {
      const nestedIosSource = path.join(sourceRoot, 'ios/Nested/SourceOnly.swift');
      fs.mkdirSync(path.dirname(nestedIosSource), { recursive: true });
      fs.writeFileSync(nestedIosSource, 'let sourceOnly = true\n');
      for (const relativePath of npmExcludedSources) {
        fs.rmSync(path.join(installedRoot, relativePath));
      }

      expect(expo.resolveExpoIntegrationGeneration(sourceRoot))
        .toBe(expo.resolveExpoIntegrationGeneration(installedRoot));
    } finally {
      removeTempDir(sourceRoot);
      removeTempDir(installedRoot);
    }
  });

  it('is independent of filesystem creation and traversal order', () => {
    const firstRoot = createIntegrationGenerationFixture();
    const secondRoot = createIntegrationGenerationFixture(true);
    const additionalFiles = [
      ['android/src/main/assets/z-last.txt', 'last'],
      ['android/src/main/assets/a-first.txt', 'first'],
    ] as const;
    try {
      for (const [relativePath, content] of additionalFiles) {
        const absolutePath = path.join(firstRoot, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
      }
      for (const [relativePath, content] of [...additionalFiles].reverse()) {
        const absolutePath = path.join(secondRoot, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
      }
      expect(expo.resolveExpoIntegrationGeneration(firstRoot))
        .toBe(expo.resolveExpoIntegrationGeneration(secondRoot));
    } finally {
      removeTempDir(firstRoot);
      removeTempDir(secondRoot);
    }
  });

  it('fails closed for missing packed roots and unsupported source entries', () => {
    const missingRootFixture = createIntegrationGenerationFixture();
    const unsupportedEntryFixture = createIntegrationGenerationFixture();
    try {
      fs.rmSync(path.join(missingRootFixture, 'android/src/main'), { recursive: true });
      expect(() => expo.resolveExpoIntegrationGeneration(missingRootFixture))
        .toThrow('missing android/src/main');

      fs.symlinkSync(
        path.join(unsupportedEntryFixture, 'README.md'),
        path.join(unsupportedEntryFixture, 'android/src/main/unsupported-link'),
      );
      expect(() => expo.resolveExpoIntegrationGeneration(unsupportedEntryFixture))
        .toThrow('unsupported entry at android/src/main/unsupported-link');
    } finally {
      removeTempDir(missingRootFixture);
      removeTempDir(unsupportedEntryFixture);
    }
  });

  it('fails closed for unreadable and malformed integration-generation inputs', () => {
    const expectFixtureFailure = (
      mutate: (fixtureRoot: string) => void,
      expectedMessage: string | Error,
    ) => {
      const fixtureRoot = createIntegrationGenerationFixture();
      try {
        mutate(fixtureRoot);
        expect(() => expo.resolveExpoIntegrationGeneration(fixtureRoot)).toThrow(expectedMessage);
      } finally {
        removeTempDir(fixtureRoot);
        jest.restoreAllMocks();
      }
    };

    expectFixtureFailure(fixtureRoot => {
      const originalLstat = fs.lstatSync.bind(fs);
      jest.spyOn(fs, 'lstatSync').mockImplementation(((entryPath: fs.PathLike) => {
        if (entryPath === path.join(fixtureRoot, 'app.plugin.js')) {
          const error = new Error('packed file is unreadable') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalLstat(entryPath);
      }) as typeof fs.lstatSync);
    }, new Error('packed file is unreadable'));

    expectFixtureFailure(fixtureRoot => {
      const originalLstat = fs.lstatSync.bind(fs);
      jest.spyOn(fs, 'lstatSync').mockImplementation(((entryPath: fs.PathLike) => {
        if (entryPath === path.join(fixtureRoot, 'plugin')) {
          const error = new Error('packed directory is unreadable') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalLstat(entryPath);
      }) as typeof fs.lstatSync);
    }, new Error('packed directory is unreadable'));

    expectFixtureFailure(fixtureRoot => {
      const requiredFile = path.join(fixtureRoot, 'app.plugin.js');
      fs.rmSync(requiredFile);
      fs.mkdirSync(requiredFile);
    }, 'unsupported entry at app.plugin.js');

    expectFixtureFailure(fixtureRoot => {
      const requiredDirectory = path.join(fixtureRoot, 'plugin');
      fs.rmSync(requiredDirectory, { recursive: true });
      fs.writeFileSync(requiredDirectory, 'not a directory');
    }, 'unsupported entry at plugin');

    expectFixtureFailure(fixtureRoot => {
      const originalReaddir = fs.readdirSync.bind(fs);
      jest.spyOn(fs, 'readdirSync').mockImplementation(((directoryPath: fs.PathLike) => {
        if (directoryPath === path.join(fixtureRoot, 'plugin')) {
          return [{
            name: 'unsupported-entry',
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => false,
          }];
        }
        return originalReaddir(directoryPath, { withFileTypes: true });
      }) as typeof fs.readdirSync);
    }, 'unsupported entry at plugin/unsupported-entry');

    expectFixtureFailure(fixtureRoot => {
      const pluginDirectory = path.join(fixtureRoot, 'plugin');
      for (const entry of fs.readdirSync(pluginDirectory)) {
        fs.rmSync(path.join(pluginDirectory, entry), { recursive: true });
      }
      fs.writeFileSync(path.join(pluginDirectory, 'ignored.txt'), 'not packed');
    }, 'has no packed files under plugin');

    for (const [packageJson, expectedMessage] of [
      ['{malformed', 'package.json is malformed'],
      [JSON.stringify({ name: 'not-bundle-drop', version: '1.0.0' }), 'must identify @gfean/react-native-bundle-drop'],
      [JSON.stringify({ name: '@gfean/react-native-bundle-drop', version: ' ' }), 'has no package version'],
      [JSON.stringify({
        name: '@gfean/react-native-bundle-drop',
        version: '1.0.0',
        nativeVersion: '',
      }), 'has no native version discriminator'],
    ] as const) {
      expectFixtureFailure(fixtureRoot => {
        fs.writeFileSync(path.join(fixtureRoot, 'package.json'), packageJson);
      }, expectedMessage);
    }
  });

  it('validates every artifact-bound proof shape before accepting a receipt', () => {
    const generation = expo.resolveExpoIntegrationGeneration();
    const ios = makeIdentity('ios');
    const android = makeIdentity('android');
    const base = {
      schemaVersion: 3,
      identities: { ios },
      proofs: { ios: {
        createdAt: '2026-08-01T00:00:00.000Z',
        evidence: 'ios-signed-app',
        integrationGeneration: generation,
        artifactPath: '/tmp/Example.app',
        embeddedCandidateSha256: 'a'.repeat(64),
      } },
    };
    const parse = (receipt: unknown) => expo.parseExpoBuildIdentityReceipt(receipt, generation);

    expect(() => expo.resolveExpoIntegrationGeneration(root)).toThrow('missing app.plugin.js');
    expect(() => parse({ ...base, identities: { ios: null } })).toThrow('invalid ios identity');
    expect(() => parse({ ...base, identities: { ios: { ...ios, identityHash: 'tampered' } } }))
      .toThrow('invalid ios identity hash');
    expect(() => parse({ ...base, proofs: { ios: null } })).toThrow('has no ios build proof');
    expect(() => parse({ ...base, proofs: { ios: { ...base.proofs.ios, createdAt: 'invalid' } } }))
      .toThrow('invalid ios proof date');
    expect(() => parse({ ...base, proofs: { ios: { ...base.proofs.ios, evidence: 'android-signed-artifact' } } }))
      .toThrow('invalid ios evidence');
    expect(() => parse({ ...base, proofs: { ios: { ...base.proofs.ios, integrationGeneration: 'old' } } }))
      .toThrow('different Expo integration generation');
    expect(() => parse({ ...easReceipt('ios'), proofs: { ios: { ...easReceipt('ios').proofs.ios, easBuildId: '' } } }))
      .toThrow('must include its exact easBuildId');
    expect(() => parse({ ...easReceipt('ios'), proofs: { ios: { ...easReceipt('ios').proofs.ios, artifactPath: '/tmp/X.app' } } }))
      .toThrow('cannot include local artifact fields');
    expect(() => parse({ ...base, proofs: { ios: { ...base.proofs.ios, easBuildId: easBuildIds.ios } } }))
      .toThrow('local ios build proof cannot include an easBuildId');
    expect(() => parse({ ...base, proofs: { ios: { ...base.proofs.ios, artifactPath: 'relative.app' } } }))
      .toThrow('requires an absolute artifactPath');

    const androidProof = {
      createdAt: '2026-08-01T00:00:00.000Z',
      evidence: 'android-signed-artifact',
      integrationGeneration: generation,
      artifactPath: '/tmp/app.apk',
      artifactSha256: 'b'.repeat(64),
      embeddedCandidateSha256: 'c'.repeat(64),
    };
    const androidBase = { schemaVersion: 3, identities: { android }, proofs: { android: androidProof } };
    expect(() => parse({ ...androidBase, proofs: { android: { ...androidProof, artifactSha256: 'bad' } } }))
      .toThrow('invalid artifact SHA-256');
    expect(() => parse({ ...androidBase, proofs: { android: { ...androidProof, embeddedCandidateSha256: 'bad' } } }))
      .toThrow('invalid embedded candidate SHA-256');
    expect(() => parse({ ...base, proofs: { ios: { ...base.proofs.ios, embeddedCandidateSha256: 'bad' } } }))
      .toThrow('invalid embedded candidate SHA-256');
    expect(() => parse({ ...base, proofs: { ios: { ...base.proofs.ios, artifactSha256: 'd'.repeat(64) } } }))
      .toThrow('cannot include an Android artifact hash');
    expect(() => parse({ ...base, proofs: {} })).toThrow('incomplete ios build proof');
    expect(() => parse({ schemaVersion: 3, identities: {}, proofs: {} })).toThrow('incomplete or unsupported');
    expect(expo.parseExpoBuildIdentityReceipt(easReceipt('ios'))).toEqual(easReceipt('ios'));
    expect(expo.assertExpoUpdatesDoesNotOwnStartup(root, { plugins: [], updates: {} }).state).toBe('absent');
  });

  it('verifies local artifact types, candidate JSON binding, and explicit receipt paths', async () => {
    const androidDirectory = path.join(root, 'directory.apk');
    fs.mkdirSync(androidDirectory);
    writeReceipt({
      schemaVersion: 3,
      identities: { android: makeIdentity('android') },
      proofs: { android: {
        createdAt: '2026-08-01T00:00:00.000Z',
        evidence: 'android-signed-artifact',
        integrationGeneration: expo.resolveExpoIntegrationGeneration(),
        artifactPath: androidDirectory,
        artifactSha256: 'a'.repeat(64),
        embeddedCandidateSha256: 'b'.repeat(64),
      } },
    });
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'android')).toThrow('does not reference an APK/AAB file');

    const wrongExtension = writeArtifact('signed.bin');
    writeReceipt({
      schemaVersion: 3,
      identities: { android: makeIdentity('android') },
      proofs: { android: {
        createdAt: '2026-08-01T00:00:00.000Z', evidence: 'android-signed-artifact',
        integrationGeneration: expo.resolveExpoIntegrationGeneration(), artifactPath: wrongExtension,
        artifactSha256: crypto.createHash('sha256').update('signed-binary').digest('hex'),
        embeddedCandidateSha256: 'b'.repeat(64),
      } },
    }, 'receipts/android.json');
    expect(() => readExpoBuildIdentityReceipt(root, 'receipts/android.json', 'android')).toThrow('must reference an APK or AAB');

    const app = path.join(root, 'File.app');
    fs.writeFileSync(app, 'not-a-directory');
    const iosProof = {
      createdAt: '2026-08-01T00:00:00.000Z', evidence: 'ios-signed-app',
      integrationGeneration: expo.resolveExpoIntegrationGeneration(), artifactPath: app,
      embeddedCandidateSha256: 'a'.repeat(64),
    };
    writeReceipt({ schemaVersion: 3, identities: { ios: makeIdentity('ios') }, proofs: { ios: iosProof } });
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'ios')).toThrow('does not reference an app bundle');

    fs.rmSync(app);
    fs.mkdirSync(app);
    const candidatePath = path.join(app, IOS_EMBEDDED_BUILD_CANDIDATE);
    fs.writeFileSync(candidatePath, '{malformed');
    iosProof.embeddedCandidateSha256 = crypto.createHash('sha256').update('{malformed').digest('hex');
    writeReceipt({ schemaVersion: 3, identities: { ios: makeIdentity('ios') }, proofs: { ios: iosProof } });
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'ios')).toThrow('candidate is malformed');

    const wrongCandidate = JSON.stringify({ schemaVersion: 1, platform: 'ios', identityHash: 'wrong' });
    fs.writeFileSync(candidatePath, wrongCandidate);
    iosProof.embeddedCandidateSha256 = crypto.createHash('sha256').update(wrongCandidate).digest('hex');
    writeReceipt({ schemaVersion: 3, identities: { ios: makeIdentity('ios') }, proofs: { ios: iosProof } });
    expect(() => readExpoBuildIdentityReceipt(root, undefined, 'ios')).toThrow('not bound to this build proof');
  });

  it('covers optional receipt behavior and all upload identity outcomes', async () => {
    expect(() => assertExpoUploadMatchesBuild({
      projectRoot: root, platform: 'ios', uploadIdentity: makeIdentity('ios'),
    })).not.toThrow();
    expect(() => assertExpoUploadMatchesBuild({
      projectRoot: root, platform: 'ios', uploadIdentity: makeIdentity('ios'), requireReceipt: true,
    })).toThrow('No native build identity receipt');
    await expect(resolveExpoUploadIdentity({ projectRoot: root, platform: 'ios' }))
      .rejects.toThrow('requires an exact native build identity receipt');

    writeReceipt(easReceipt('android'));
    expect(() => assertExpoUploadMatchesBuild({
      projectRoot: root, platform: 'ios', uploadIdentity: makeIdentity('ios'),
    })).toThrow('does not contain ios');
    await expect(resolveExpoUploadIdentity({ projectRoot: root, platform: 'ios' }))
      .rejects.toThrow('does not contain ios');

    const app = createIosApp('Outcome.app');
    resolveSpy.mockResolvedValue(makeIdentity('ios'));
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: app });
    await expect(resolveExpoUploadIdentity({ projectRoot: root, platform: 'ios' }))
      .resolves.toEqual(makeIdentity('ios'));
    resolveSpy.mockRejectedValue(new Error('ordinary config error'));
    await expect(resolveExpoUploadIdentity({ projectRoot: root, platform: 'ios' }))
      .rejects.toThrow('ordinary config error');
  });

  it('uses Bundle Drop literals without requiring or comparing a native receipt', async () => {
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      "module.exports = { projectType: 'expo', runtimeVersion: { ios: 'runtime-1', android: 'runtime-2' } };\n",
    );
    resolveSpy.mockResolvedValue(makeIdentity('ios'));

    await expect(resolveExpoUploadIdentity({ projectRoot: root, platform: 'ios' }))
      .resolves.toEqual(makeIdentity('ios'));
    expect(resolveSpy).toHaveBeenCalledWith(root, 'ios');
    expect(() => readExpoBuildIdentityReceipt(root)).not.toThrow();
  });

  it('rejects malformed receipt JSON with a stable CLI error', () => {
    writeReceipt('{not-json');
    const receiptPath = path.join(root, '.bundle-drop/build-identity.json');
    fs.writeFileSync(receiptPath, '{not-json');
    expect(() => readExpoBuildIdentityReceipt(root)).toThrow('receipt is malformed');
  });

  it('fails closed across receipt-writer artifact and SDK discovery errors', async () => {
    const originalSdkRoot = process.env.ANDROID_SDK_ROOT;
    const originalAndroidHome = process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    delete process.env.ANDROID_HOME;
    try {
      await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: '/missing.apk' }))
        .rejects.toThrow('artifact does not exist');
      await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: '/missing.app' }))
        .rejects.toThrow('ios artifact does not exist');

      const invalidAndroid = writeArtifact('artifact.txt');
      await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: invalidAndroid, androidSdkRoot: androidSdk }))
        .rejects.toThrow('requires an exact APK or AAB');
      const invalidIos = writeArtifact('NotAnApp.txt');
      await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: invalidIos }))
        .rejects.toThrow('requires an exact .app bundle');
      const wrongExtensionDirectory = path.join(root, 'NotAnApp.bundle');
      fs.mkdirSync(wrongExtensionDirectory);
      await expect(writeExpoBuildReceipt({
        projectRoot: root,
        platform: 'ios',
        artifactPath: wrongExtensionDirectory,
      })).rejects.toThrow('requires an exact .app bundle');
      const missingPlistApp = path.join(root, 'MissingPlist.app');
      fs.mkdirSync(missingPlistApp);
      await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: missingPlistApp }))
        .rejects.toThrow('requires the packaged app Info.plist');
      const plistDirectoryApp = path.join(root, 'PlistDirectory.app');
      fs.mkdirSync(path.join(plistDirectoryApp, 'Info.plist'), { recursive: true });
      await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: plistDirectoryApp }))
        .rejects.toThrow('requires the packaged app Info.plist');
      const unreadablePlistApp = createIosApp('UnreadablePlist.app');
      spawnSpy.mockReturnValueOnce({
        pid: 1, output: [], stdout: '', stderr: 'invalid plist', status: 1, signal: null,
      });
      await expect(writeExpoBuildReceipt({
        projectRoot: root,
        platform: 'ios',
        artifactPath: unreadablePlistApp,
      })).rejects.toThrow('could not read CFBundleShortVersionString');
      const plistToolErrorApp = createIosApp('PlistToolError.app');
      spawnSpy.mockReturnValueOnce({
        pid: 1,
        output: [],
        stdout: '',
        stderr: '',
        status: null,
        signal: null,
        error: new Error('plutil unavailable'),
      });
      await expect(writeExpoBuildReceipt({
        projectRoot: root,
        platform: 'ios',
        artifactPath: plistToolErrorApp,
      })).rejects.toThrow('plutil unavailable');
      const emptyPlistValueApp = createIosApp('EmptyPlistValue.app');
      spawnSpy.mockReturnValueOnce({
        pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null,
      });
      await expect(writeExpoBuildReceipt({
        projectRoot: root,
        platform: 'ios',
        artifactPath: emptyPlistValueApp,
      })).rejects.toThrow('CFBundleShortVersionString is empty');

      const apk = writeArtifact('needs-sdk.apk');
      await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: apk }))
        .rejects.toThrow('without the Android SDK path');
      const missingTools = path.join(root, 'missing-sdk');
      await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: apk, androidSdkRoot: missingTools }))
        .rejects.toThrow('cannot find Android build-tools');
      const emptySdk = path.join(root, 'empty-sdk');
      fs.mkdirSync(path.join(emptySdk, 'build-tools'), { recursive: true });
      await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: apk, androidSdkRoot: emptySdk }))
        .rejects.toThrow('cannot find apksigner');
    } finally {
      if (originalSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
      else process.env.ANDROID_SDK_ROOT = originalSdkRoot;
      if (originalAndroidHome === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = originalAndroidHome;
    }
  });

  it('uses the newest signer, reports signature tool failures, and parses Android SDK argv', async () => {
    const older = path.join(androidSdk, 'build-tools', '34.0.0', 'apksigner');
    fs.mkdirSync(path.dirname(older), { recursive: true });
    fs.writeFileSync(older, 'older');
    const apk = writeAndroidArtifact('newest.apk');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: apk, androidSdkRoot: androidSdk });
    expect(spawnSpy).toHaveBeenCalledWith(
      path.join(androidSdk, 'build-tools', '35.0.0', 'apksigner'),
      ['verify', apk],
      expect.any(Object),
    );

    const originalPlatform = process.platform;
    const windowsSigner = path.join(androidSdk, 'build-tools', '35.0.0', 'apksigner.bat');
    fs.writeFileSync(windowsSigner, 'windows signer');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await writeExpoBuildReceipt({
        projectRoot: root,
        platform: 'android',
        artifactPath: apk,
        androidSdkRoot: androidSdk,
      });
      expect(spawnSpy).toHaveBeenCalledWith(
        windowsSigner,
        ['verify', apk],
        expect.any(Object),
      );
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }

    spawnSpy.mockReturnValue({ pid: 1, output: [], stdout: '', stderr: '', status: 1, signal: null });
    await expect(writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: apk, androidSdkRoot: androidSdk }))
      .rejects.toThrow('apksigner rejected the artifact');
    expect(parseBuildReceiptArguments([
      '--project-root', root,
      '--platform', 'android',
      '--artifact', apk,
      '--android-sdk', androidSdk,
      '--app-version', '2.3.4',
      '--native-build-version', '99',
    ])).toEqual({
      projectRoot: root,
      platform: 'android',
      artifactPath: apk,
      androidSdkRoot: androidSdk,
      officialAppVersion: '2.3.4',
      officialNativeBuildVersion: '99',
    });
    expect(() => parseBuildReceiptArguments(['--project-root', root, '--platform', 'web', '--artifact', apk]))
      .toThrow('Usage');
  });

  it('drops a prior platform when current identity revalidation fails', async () => {
    const apk = writeAndroidArtifact('merge.apk');
    await writeExpoBuildReceipt({ projectRoot: root, platform: 'android', artifactPath: apk, androidSdkRoot: androidSdk });
    const app = createIosApp('Merge.app');
    resolveSpy.mockImplementation(async (_projectRoot, platform) => {
      if (platform === 'android') throw new Error('Android config unavailable');
      return makeIdentity(platform);
    });

    await writeExpoBuildReceipt({ projectRoot: root, platform: 'ios', artifactPath: app });
    expect(readExpoBuildIdentityReceipt(root, undefined, 'ios')?.identities.android).toBeUndefined();
  });

  it('runs the guarded receipt-writer entrypoint and reports its rejection', () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const sourcePath = path.join(projectRoot, 'src/CLI/scripts/expo/write-build-receipt.ts');
    spawnSpy.mockRestore();
    const result = childProcess.spawnSync(
      process.execPath,
      [
        '-r', require.resolve('ts-node/register'), sourcePath,
        '--project-root', '/missing-project',
        '--platform', 'ios',
        '--artifact', '/missing.app',
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ios artifact does not exist');
  }, 30_000);
});
