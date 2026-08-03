import childProcess from 'child_process';
import crypto from 'crypto';

import * as expo from '../../../../expo';
import type { ExpoBuildIdentity } from '../../../../expo';
import type { ExpoEasBuildProof } from '../../../../expo/buildReceipt';
import {
  resolveOfficialEasBuild,
  resolveOfficialEasBuildIdentity,
} from '../../../../CLI/scripts/expo/eas-build-proof';

const buildId = '11111111-1111-4111-8111-111111111111';
const commit = '0123456789abcdef';

const identity = (
  overrides: Partial<Omit<ExpoBuildIdentity, 'identityHash'>> = {},
): ExpoBuildIdentity => {
  const value: Omit<ExpoBuildIdentity, 'identityHash'> = {
    platform: 'ios',
    runtimeVersion: 'runtime-1',
    runtimeVersionPolicy: 'literal',
    expoSdkVersion: '57.0.3',
    reactNativeVersion: '0.86.0',
    javaScriptEngine: 'hermes',
    appVersion: '1.2.3',
    nativeVersion: '1.2.3(7)',
    ...overrides,
  };
  return {
    ...value,
    identityHash: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  };
};

const proof: ExpoEasBuildProof = {
  createdAt: '2026-08-01T00:00:00.000Z',
  evidence: 'eas-official-metadata',
  integrationGeneration: 'sha256:generation',
  easBuildId: buildId,
};

const metadata = () => ({
  id: buildId,
  status: 'FINISHED',
  platform: 'IOS',
  project: { id: 'project-id' },
  artifacts: { applicationArchiveUrl: 'https://example.test/app.ipa' },
  fingerprint: { hash: 'project-fingerprint' },
  sdkVersion: '57.0.0',
  appVersion: '1.2.3',
  appBuildVersion: '7',
  runtimeVersion: 'runtime-1',
  gitCommitHash: commit,
});

describe('official EAS build proof', () => {
  let spawnSpy: jest.SpyInstance;
  let evaluateSpy: jest.SpyInstance;
  let resolveSpy: jest.SpyInstance;
  let fingerprintSpy: jest.SpyInstance;
  let build: ReturnType<typeof metadata>;
  let easFailure: { error?: Error; status?: number; stderr?: string } | undefined;
  let easStdout: string | undefined;
  let gitHead = commit;
  let gitStatus = '';

  beforeEach(() => {
    build = metadata();
    easFailure = undefined;
    easStdout = undefined;
    gitHead = commit;
    gitStatus = '';
    evaluateSpy = jest.spyOn(expo, 'evaluateExpoConfig').mockReturnValue({
      exp: { extra: { eas: { projectId: 'project-id' } } },
    } as any);
    resolveSpy = jest.spyOn(expo, 'resolveExpoBuildIdentity').mockResolvedValue(identity());
    fingerprintSpy = jest.spyOn(expo, 'resolveExpoProjectFingerprint')
      .mockResolvedValue('project-fingerprint');
    spawnSpy = jest.spyOn(childProcess, 'spawnSync').mockImplementation(
      (command: string, args: string[]) => {
        if (command === 'eas') {
          return {
            pid: 1,
            output: [],
            stdout: easStdout ?? JSON.stringify(build),
            stderr: easFailure?.stderr ?? '',
            status: easFailure?.status ?? (easFailure?.error ? null : 0),
            signal: null,
            ...(easFailure?.error ? { error: easFailure.error } : {}),
          } as any;
        }
        if (args[0] === 'rev-parse') {
          return { pid: 1, output: [], stdout: `${gitHead}\n`, stderr: '', status: 0, signal: null };
        }
        return { pid: 1, output: [], stdout: gitStatus, stderr: '', status: 0, signal: null };
      },
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const resolve = (receiptIdentity = identity(), buildProof = proof) =>
    resolveOfficialEasBuildIdentity({
      projectRoot: '/project',
      platform: 'ios',
      receiptIdentity,
      proof: buildProof,
    });

  it('authenticates with EAS and binds metadata, project, commit, and identity', async () => {
    await expect(resolve()).resolves.toEqual(identity());
    expect(spawnSpy).toHaveBeenCalledWith(
      'eas', ['build:view', buildId, '--json'],
      { cwd: '/project', encoding: 'utf8', shell: false },
    );
    expect(resolveSpy).toHaveBeenCalledWith('/project', 'ios', {
      officialAppVersion: '1.2.3',
      officialNativeBuildVersion: '7',
    });
    expect(fingerprintSpy).not.toHaveBeenCalled();
  });

  it('derives an identity from official metadata without a receipt identity', async () => {
    await expect(resolveOfficialEasBuild({
      projectRoot: '/project',
      platform: 'ios',
      easBuildId: buildId,
    })).resolves.toEqual({ buildId, identity: identity() });
  });

  it('also verifies a fingerprint identity', async () => {
    const fingerprintIdentity = identity({ runtimeVersionPolicy: 'fingerprint' });
    resolveSpy.mockResolvedValue(fingerprintIdentity);
    fingerprintSpy.mockResolvedValue('runtime-1');
    build.fingerprint.hash = 'runtime-1';
    await expect(resolve(fingerprintIdentity)).resolves.toEqual(fingerprintIdentity);
  });

  it('rejects invalid IDs and failed or malformed EAS lookups', async () => {
    await expect(resolve(identity(), { ...proof, easBuildId: 'not-a-build-id' }))
      .rejects.toThrow('invalid build ID');

    easFailure = { error: new Error('not installed with secret-token') };
    await expect(resolve()).rejects.toThrow('could not authenticate and verify');
    await expect(resolve()).rejects.not.toThrow('secret-token');
    easFailure = { status: 1, stderr: 'not authenticated with secret-token' };
    await expect(resolve()).rejects.toThrow('could not authenticate and verify');
    await expect(resolve()).rejects.not.toThrow('secret-token');
    easFailure = undefined;
    easStdout = 'not-json';
    await expect(resolve()).rejects.toThrow('metadata is malformed');
    easStdout = '[]';
    await expect(resolve()).rejects.toThrow('not an object');
  });

  it.each([
    ['id', () => { build.id = '22222222-2222-4222-8222-222222222222'; }, 'exact, finished'],
    ['status', () => { build.status = 'IN_PROGRESS'; }, 'exact, finished'],
    ['platform', () => { build.platform = 'ANDROID'; }, 'for android, not ios'],
    ['artifact', () => { build.artifacts = {} as any; }, 'does not expose'],
    ['project', () => { build.project.id = 'other-project'; }, 'different Expo project'],
    ['runtime', () => { build.runtimeVersion = ''; }, 'missing runtimeVersion'],
  ])('rejects mismatched official %s metadata', async (_name, mutate, message) => {
    mutate();
    await expect(resolve()).rejects.toThrow(message);
  });

  it('requires the exact clean source commit', async () => {
    gitHead = 'different';
    await expect(resolve()).rejects.toThrow('exact build commit');
    gitHead = commit;
    gitStatus = ' M app.json\n';
    await expect(resolve()).rejects.toThrow('clean worktree');
  });

  it('rejects identity and fingerprint mismatches', async () => {
    resolveSpy.mockResolvedValue(identity({ runtimeVersion: 'other' }));
    await expect(resolve()).rejects.toThrow('does not match the current Expo project identity');

    resolveSpy.mockResolvedValue(identity());
    await expect(resolve(identity({ reactNativeVersion: '0.86.1' })))
      .rejects.toThrow('does not match the receipt');

    const fingerprintIdentity = identity({ runtimeVersionPolicy: 'fingerprint' });
    resolveSpy.mockResolvedValue(fingerprintIdentity);
    fingerprintSpy.mockResolvedValue('other-fingerprint');
    build.fingerprint.hash = 'other-fingerprint';
    await expect(resolve(fingerprintIdentity)).rejects.toThrow('fingerprint does not match');
  });

  it('rejects a project fingerprint that differs from the official build', async () => {
    const fingerprintIdentity = identity({ runtimeVersionPolicy: 'fingerprint' });
    resolveSpy.mockResolvedValue(fingerprintIdentity);
    fingerprintSpy.mockResolvedValue('different-project');
    await expect(resolve(fingerprintIdentity)).rejects.toThrow('does not match the current project');
  });
});
