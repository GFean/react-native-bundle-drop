jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));

import { verifyRuntimeDeliveryManifest } from '../../runtime-delivery/manifestVerifier';
import { NativeModules } from 'react-native';
import type { RuntimeDeliveryJws } from '../../runtime-delivery/types';
import { mockVerifyEs256Signature, readMockJson, resetNativeFsMocks } from '../mocks/native/fs';

const PROTECTED = 'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3Qta2V5LTIwMjYtMDgiLCJ0eXAiOiJidW5kbGVkcm9wLW1hbmlmZXN0K2p3cyJ9';
const PAYLOAD = 'eyJzY2hlbWFWZXJzaW9uIjozLCJ0eXBlIjoibGFuZSIsInByb2plY3RTbHVnIjoiZ29sZGVuLXByb2plY3QiLCJjaGFubmVsTmFtZSI6IlByb2R1Y3Rpb24gLyDOsiIsInBsYXRmb3JtIjoiaW9zIiwicnVudGltZVZlcnNpb24iOiIxLjIuMytuYXRpdmUvNDIiLCJnZW5lcmF0aW9uIjo3LCJnZW5lcmF0ZWRBdCI6IjIwMjYtMDgtMTdUMDA6MDA6MDAuMDAwWiIsInJlc29sdXRpb25Nb2RlIjoibG9jYWwiLCJwdWJsaXNoaW5nTW9kZSI6ImF1dG9tYXRpYyIsInJvbGxvdXRBbGdvcml0aG0iOiJzaGEyNTYtaW5zdGFsbC1pZC11aW50MzJiZS1tb2QxMDAtdjEiLCJyZXZva2VkSGFzaGVzIjpbXSwicmVsZWFzZXMiOlt7InJlbGVhc2VSZWYiOiJyZWxfZ29sZGVuIiwiYnVuZGxlSGFzaCI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJidW5kbGVWZXJzaW9uIjo3LCJ2ZXJzaW9uIjoiMS4wLjciLCJydW50aW1lVmVyc2lvbiI6IjEuMi4zK25hdGl2ZS80MiIsIm1hbmlmZXN0SGFzaCI6ImJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIiLCJqc0J1bmRsZUhhc2giOiJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjIiwiZnVsbEJ1bmRsZUhhc2giOiJkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkIiwiZnVsbEJ1bmRsZVNpemVCeXRlcyI6MTIzNDU2LCJhdmFpbGFibGUiOnRydWUsImV4cGlyZXNBdCI6bnVsbH1dLCJwdWJsaXNoZWRSb2xsb3V0cyI6W10sInBhdGNoUG9saWN5Ijp7ImVuYWJsZWQiOnRydWUsIm1heFBhdGNoVG9GdWxsUmF0aW8iOjAuN30sInBhdGNoRWRnZXMiOltdLCJjYW5kaWRhdGVTZXRDb21wbGV0ZSI6dHJ1ZX0';
const SIGNATURE = 'jN-so6BGfybKPcO7FM7_RTJxIkgJFGb-ZewrYvw0tWedaydN7He5mmujM0HRDUKqCvD6k5jIwhkTVICGx6vCzQ';
const KEY = {
  kty: 'EC' as const,
  crv: 'P-256' as const,
  x: 'd-g4y_28QdARnFF6HO0T00laLEfHhVFXTmuWHqBWmfM',
  y: '_Z_xWbhjDp3IVMtLA_rN3guVyprP34OvBikPWpVQfUI',
};
const IDENTITY = {
  projectSlug: 'golden-project',
  channelName: 'Production / β',
  platform: 'ios',
  runtimeVersion: '1.2.3+native/42',
};

const serialize = (overrides?: Partial<RuntimeDeliveryJws>) => JSON.stringify({
  protected: PROTECTED,
  payload: PAYLOAD,
  signature: SIGNATURE,
  ...overrides,
});
const basePayload = (): Record<string, any> =>
  JSON.parse(Buffer.from(PAYLOAD, 'base64url').toString('utf8'));
const encodedPayload = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload)).toString('base64url');

describe('runtime-delivery/manifestVerifier', () => {
  beforeEach(() => {
    resetNativeFsMocks();
    NativeModules.BundleDrop.setStartupRecoveryRevokedHashes.mockClear();
  });

  it('verifies the shared cross-repository ES256 golden vector', async () => {
    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      IDENTITY,
      { 'test-key-2026-08': KEY },
    )).resolves.toEqual(expect.objectContaining({
      schemaVersion: 3,
      generation: 7,
      channelName: 'Production / β',
      candidateSetComplete: true,
    }));
    expect(NativeModules.BundleDrop.setStartupRecoveryRevokedHashes).toHaveBeenCalledWith([]);
  });

  it('keeps revocations from other verified channels in the same runtime', async () => {
    const verifySignature = mockVerifyEs256Signature.getMockImplementation();
    mockVerifyEs256Signature.mockResolvedValue(true);
    const firstPayload = basePayload();
    firstPayload.revokedHashes = ['a'.repeat(64)];
    const secondPayload = {
      ...basePayload(),
      channelName: 'Beta',
      revokedHashes: ['b'.repeat(64)],
    };

    try {
      await verifyRuntimeDeliveryManifest(
        serialize({ payload: encodedPayload(firstPayload) }),
        IDENTITY,
        { 'test-key-2026-08': KEY },
      );
      await verifyRuntimeDeliveryManifest(
        serialize({ payload: encodedPayload(secondPayload) }),
        { ...IDENTITY, channelName: 'Beta' },
        { 'test-key-2026-08': KEY },
      );

      expect(NativeModules.BundleDrop.setStartupRecoveryRevokedHashes).toHaveBeenNthCalledWith(
        1,
        ['a'.repeat(64)],
      );
      expect(NativeModules.BundleDrop.setStartupRecoveryRevokedHashes).toHaveBeenNthCalledWith(
        2,
        ['a'.repeat(64), 'b'.repeat(64)],
      );
    } finally {
      if (verifySignature) {
        mockVerifyEs256Signature.mockImplementation(verifySignature);
      }
    }
  });

  it('does not commit the verified generation when native rejects revocation persistence', async () => {
    NativeModules.BundleDrop.setStartupRecoveryRevokedHashes.mockResolvedValueOnce(false);

    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      IDENTITY,
      { 'test-key-2026-08': KEY },
    )).rejects.toThrow('rejected the verified revocation set');

    expect(readMockJson('/mock/doc/bundle-drop/runtime-delivery-state.json')).toBeNull();
  });

  it('rejects unknown keys, tampered payloads, malformed signatures, and wrong lanes', async () => {
    await expect(verifyRuntimeDeliveryManifest(serialize(), IDENTITY, {}))
      .rejects.toThrow('Unknown or invalid');
    await expect(verifyRuntimeDeliveryManifest(
      serialize({ payload: `${PAYLOAD.slice(0, -1)}1` }),
      IDENTITY,
      { 'test-key-2026-08': KEY },
    )).rejects.toThrow('signature verification failed');
    await expect(verifyRuntimeDeliveryManifest(
      serialize({ signature: 'AA' }),
      IDENTITY,
      { 'test-key-2026-08': KEY },
    )).rejects.toThrow('64-byte');
    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      { ...IDENTITY, channelName: 'Other' },
      { 'test-key-2026-08': KEY },
    )).rejects.toThrow('identity mismatch');
  });

  it('supports key rotation by selecting only the protected kid', async () => {
    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      IDENTITY,
      {
        old: { ...KEY, x: 'A'.repeat(43) },
        'test-key-2026-08': KEY,
      },
    )).resolves.toEqual(expect.objectContaining({ generation: 7 }));
  });

  it('rejects generation regression after persisting a higher verified generation', async () => {
    await verifyRuntimeDeliveryManifest(serialize(), IDENTITY, { 'test-key-2026-08': KEY });
    const statePath = '/mock/doc/bundle-drop/runtime-delivery-state.json';
    const { setMockFile } = require('../mocks/native/fs') as typeof import('../mocks/native/fs');
    setMockFile(statePath, JSON.stringify({
      schemaVersion: 1,
      lanes: {
        'golden-project/Production%20%2F%20%CE%B2/ios/1.2.3%2Bnative%2F42': {
          highestGeneration: 8,
          payloadSha256: 'e'.repeat(64),
          revokedHashes: [],
          verifiedAt: '2026-08-17T00:00:00.000Z',
        },
      },
    }));
    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      IDENTITY,
      { 'test-key-2026-08': KEY },
    )).rejects.toThrow('generation regressed');
  });

  it('rejects equal-generation payload equivocation without replacing last-known revocations', async () => {
    await verifyRuntimeDeliveryManifest(serialize(), IDENTITY, { 'test-key-2026-08': KEY });
    mockVerifyEs256Signature.mockResolvedValue(true);
    const changedPayload = JSON.parse(Buffer.from(PAYLOAD, 'base64url').toString('utf8'));
    changedPayload.revokedHashes = ['f'.repeat(64)];

    await expect(verifyRuntimeDeliveryManifest(
      serialize({
        payload: Buffer.from(JSON.stringify(changedPayload)).toString('base64url'),
      }),
      IDENTITY,
      { 'test-key-2026-08': KEY },
    )).rejects.toThrow('generation equivocation');

    const persisted = readMockJson<{ lanes: Record<string, { revokedHashes: string[] }> }>(
      '/mock/doc/bundle-drop/runtime-delivery-state.json',
    );
    const lane = Object.values(persisted?.lanes || {})[0];
    expect(lane.revokedHashes).toEqual([]);
  });

  it('rejects oversized envelopes before native signature verification', async () => {
    await expect(verifyRuntimeDeliveryManifest(
      `${serialize()}${' '.repeat(1024 * 1024)}`,
      IDENTITY,
      { 'test-key-2026-08': KEY },
    )).rejects.toThrow('1 MB');
  });

  it('enforces closed JWS metadata and positive complete local generations', async () => {
    mockVerifyEs256Signature.mockResolvedValue(true);
    const publicKeys = { 'test-key-2026-08': KEY };
    await expect(verifyRuntimeDeliveryManifest(
      JSON.stringify({
        protected: PROTECTED,
        payload: PAYLOAD,
        signature: SIGNATURE,
        unprotected: { ignored: true },
      }),
      IDENTITY,
      publicKeys,
    )).rejects.toThrow('unsupported fields');

    const protectedWithExtra = Buffer.from(JSON.stringify({
      alg: 'ES256',
      kid: 'test-key-2026-08',
      typ: 'bundledrop-manifest+jws',
      crit: [],
    })).toString('base64url');
    await expect(verifyRuntimeDeliveryManifest(
      serialize({ protected: protectedWithExtra }),
      IDENTITY,
      publicKeys,
    )).rejects.toThrow('protected header contains unsupported fields');

    const payload = JSON.parse(Buffer.from(PAYLOAD, 'base64url').toString('utf8'));
    await expect(verifyRuntimeDeliveryManifest(
      serialize({
        payload: Buffer.from(JSON.stringify({ ...payload, generation: 0 })).toString('base64url'),
      }),
      IDENTITY,
      publicKeys,
    )).rejects.toThrow('generation must be at least 1');
    await expect(verifyRuntimeDeliveryManifest(
      serialize({
        payload: Buffer.from(JSON.stringify({
          ...payload,
          resolutionMode: 'local',
          candidateSetComplete: false,
        })).toString('base64url'),
      }),
      IDENTITY,
      publicKeys,
    )).rejects.toThrow('complete candidate set');
  });

  it('strictly validates the protected header and public P-256 JWK', async () => {
    mockVerifyEs256Signature.mockResolvedValue(true);
    const header = (value: unknown) => serialize({
      protected: Buffer.from(JSON.stringify(value)).toString('base64url'),
    });
    for (const invalid of [
      null,
      { alg: 'RS256', kid: 'test-key-2026-08', typ: 'bundledrop-manifest+jws' },
      { alg: 'ES256', kid: 'test-key-2026-08', typ: 'wrong' },
      { alg: 'ES256', kid: '', typ: 'bundledrop-manifest+jws' },
      { alg: 'ES256', kid: 7, typ: 'bundledrop-manifest+jws' },
    ]) {
      await expect(verifyRuntimeDeliveryManifest(
        header(invalid),
        IDENTITY,
        { 'test-key-2026-08': KEY },
      )).rejects.toThrow();
    }

    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      IDENTITY,
      { 'test-key-2026-08': { ...KEY, kty: 'RSA' } as never },
    )).rejects.toThrow('Unknown or invalid');
    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      IDENTITY,
      { 'test-key-2026-08': { ...KEY, crv: 'P-384' } as never },
    )).rejects.toThrow('Unknown or invalid');
    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      IDENTITY,
      { 'test-key-2026-08': { ...KEY, x: 'AA' } },
    )).rejects.toThrow('coordinates');
    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      IDENTITY,
      { 'test-key-2026-08': { ...KEY, y: '*' } },
    )).rejects.toThrow('base64url');
  });

  it('rejects malformed envelope values and mismatched lane identities', async () => {
    mockVerifyEs256Signature.mockResolvedValue(true);
    for (const serialized of [
      JSON.stringify(null),
      JSON.stringify([]),
      JSON.stringify({ protected: 1, payload: PAYLOAD, signature: SIGNATURE }),
      JSON.stringify({ protected: PROTECTED, payload: '', signature: SIGNATURE }),
      JSON.stringify({ protected: PROTECTED, payload: PAYLOAD, signature: null }),
    ]) {
      await expect(verifyRuntimeDeliveryManifest(
        serialized,
        IDENTITY,
        { 'test-key-2026-08': KEY },
      )).rejects.toThrow();
    }

    for (const [field, value] of [
      ['projectSlug', 'other-project'],
      ['channelName', 'Other'],
      ['platform', 'android'],
      ['runtimeVersion', 'other-runtime'],
    ] as const) {
      await expect(verifyRuntimeDeliveryManifest(
        serialize(),
        { ...IDENTITY, [field]: value },
        { 'test-key-2026-08': KEY },
      )).rejects.toThrow(`${field} identity mismatch`);
    }
  });

  it('rejects every unsafe lane, release, rollout, policy, and patch shape', async () => {
    mockVerifyEs256Signature.mockResolvedValue(true);
    const verifyMutation = (mutate: (payload: Record<string, any>) => unknown) => {
      const payload = basePayload();
      const result = mutate(payload);
      return verifyRuntimeDeliveryManifest(
        serialize({ payload: encodedPayload(result === undefined ? payload : result) }),
        IDENTITY,
        { 'test-key-2026-08': KEY },
      );
    };
    const patch = () => ({
      baseHash: '0'.repeat(64),
      targetHash: 'a'.repeat(64),
      algorithm: 'xdelta3-vcdiff',
      patchSetHash: 'e'.repeat(64),
      patchArtifactRef: 'patch-7',
      patchSizeBytes: 100,
      fullBundleSizeBytes: 123456,
    });
    const rollout = () => ({ releaseRef: 'rel_golden', rolloutPercentage: 50, status: 'active' });

    const cases: Array<[string, (payload: Record<string, any>) => unknown]> = [
      ['object', () => null],
      ['unsupported field', payload => { payload.extra = true; }],
      ['schema', payload => { payload.schemaVersion = 2; }],
      ['schema', payload => { payload.type = 'project'; }],
      ['resolutionMode', payload => { payload.resolutionMode = 'other'; }],
      ['publishingMode', payload => { payload.publishingMode = 'other'; }],
      ['rollout algorithm', payload => { payload.rolloutAlgorithm = 'other'; }],
      ['candidateSetComplete', payload => { payload.candidateSetComplete = 'yes'; }],
      ['candidate arrays', payload => { payload.releases = null; }],
      ['candidate arrays', payload => { payload.publishedRollouts = null; }],
      ['candidate arrays', payload => { payload.patchEdges = null; }],
      ['candidate arrays', payload => { payload.revokedHashes = null; }],
      ['at most 21 releases', payload => { payload.releases = Array(22).fill(payload.releases[0]); }],
      ['releases[0]', payload => { payload.releases = [null]; }],
      ['unsupported field', payload => { payload.releases[0].extra = true; }],
      ['available', payload => { payload.releases[0].available = 'yes'; }],
      ['non-empty string', payload => { payload.releases[0].releaseRef = ''; }],
      ['SHA-256', payload => { payload.releases[0].bundleHash = 'BAD'; }],
      ['safe integer', payload => { payload.releases[0].bundleVersion = 1.5; }],
      ['safe integer', payload => { payload.releases[0].bundleVersion = -1; }],
      ['non-empty string', payload => { payload.releases[0].version = ''; }],
      ['at least 1', payload => { payload.releases[0].fullBundleSizeBytes = 0; }],
      ['ISO timestamp', payload => { payload.releases[0].expiresAt = 'tomorrow'; }],
      ['publishedRollouts[0]', payload => { payload.publishedRollouts = [null]; }],
      ['unsupported field', payload => { payload.publishedRollouts = [{ ...rollout(), extra: 1 }]; }],
      ['finite number', payload => { payload.publishedRollouts = [{ ...rollout(), rolloutPercentage: '50' }]; }],
      ['finite number', payload => { payload.publishedRollouts = [{ ...rollout(), rolloutPercentage: -1 }]; }],
      ['at most 100', payload => { payload.publishedRollouts = [{ ...rollout(), rolloutPercentage: 101 }]; }],
      ['status is invalid', payload => { payload.publishedRollouts = [{ ...rollout(), status: 'paused' }]; }],
      ['non-empty string', payload => { payload.publishedRollouts = [{ ...rollout(), releaseRef: '' }]; }],
      ['patchPolicy', payload => { payload.patchPolicy = null; }],
      ['unsupported field', payload => { payload.patchPolicy.extra = true; }],
      ['enabled', payload => { payload.patchPolicy.enabled = 'yes'; }],
      ['finite number', payload => { payload.patchPolicy.maxPatchToFullRatio = -1; }],
      ['at most 1', payload => { payload.patchPolicy.maxPatchToFullRatio = 1.1; }],
      ['patchEdges[0]', payload => { payload.patchEdges = [null]; }],
      ['unsupported field', payload => { payload.patchEdges = [{ ...patch(), extra: 1 }]; }],
      ['SHA-256', payload => { payload.patchEdges = [{ ...patch(), missingAssetsHash: 'bad' }]; }],
      ['non-empty string', payload => { payload.patchEdges = [{ ...patch(), patchArtifactRef: '' }]; }],
      ['at least 1', payload => { payload.patchEdges = [{ ...patch(), patchSizeBytes: 0 }]; }],
      ['at least 1', payload => { payload.patchEdges = [{ ...patch(), fullBundleSizeBytes: 0 }]; }],
      ['ISO timestamp', payload => { payload.patchEdges = [{ ...patch(), expiresAt: 'later' }]; }],
      ['safe integer', payload => { payload.generation = -1; }],
      ['non-empty string', payload => { payload.projectSlug = ''; }],
      ['ISO timestamp', payload => { payload.generatedAt = 'today'; }],
      ['non-empty string', payload => { payload.dynamicReason = ''; }],
      ['unique values', payload => { payload.revokedHashes = ['f'.repeat(64), 'f'.repeat(64)]; }],
      ['complete candidate set', payload => { payload.candidateSetComplete = false; }],
      ['available releases', payload => { payload.releases[0].available = false; }],
      ['safe empty candidate shape', payload => {
        payload.resolutionMode = 'dynamic';
        payload.dynamicReason = 'private_targeting';
        payload.candidateSetComplete = false;
      }],
      ['reason and the safe empty candidate shape', payload => {
        payload.resolutionMode = 'dynamic';
        delete payload.dynamicReason;
        payload.candidateSetComplete = false;
        payload.releases = [];
        payload.publishedRollouts = [];
        payload.patchEdges = [];
      }],
      ['runtime identity', payload => { payload.releases[0].runtimeVersion = '2.0.0'; }],
      ['duplicate release', payload => { payload.releases.push({ ...payload.releases[0] }); }],
      ['duplicate release', payload => {
        payload.releases.push({
          ...payload.releases[0],
          releaseRef: 'other',
        });
      }],
      ['unknown or duplicate release', payload => {
        payload.publishedRollouts = [{ ...rollout(), releaseRef: 'unknown' }];
      }],
      ['unknown or duplicate release', payload => {
        payload.publishedRollouts = [rollout(), rollout()];
      }],
      ['inconsistent', payload => {
        payload.patchEdges = [{ ...patch(), targetHash: 'f'.repeat(64) }];
      }],
      ['inconsistent', payload => {
        payload.patchEdges = [{ ...patch(), fullBundleSizeBytes: 123455 }];
      }],
      ['duplicate patch edge', payload => {
        payload.patchEdges = [patch(), patch()];
      }],
    ];

    for (const [expected, mutate] of cases) {
      await expect(verifyMutation(mutate)).rejects.toThrow(expected);
    }
  });

  it('accepts optional and nullable wire fields on a complete local candidate projection', async () => {
    mockVerifyEs256Signature.mockResolvedValue(true);
    const payload = basePayload();
    delete payload.releases[0].version;
    delete payload.releases[0].expiresAt;
    payload.publishedRollouts = [{
      releaseRef: 'rel_golden',
      rolloutPercentage: 100,
      status: 'completed',
    }];
    const edge = {
      baseHash: '0'.repeat(64),
      targetHash: 'a'.repeat(64),
      algorithm: 'xdelta3-vcdiff',
      patchSetHash: 'e'.repeat(64),
      patchArtifactRef: 'patch-7',
      patchSizeBytes: 100,
      fullBundleSizeBytes: 123456,
    };
    payload.patchEdges = [{ ...edge, missingAssetsHash: null, expiresAt: null }];

    await expect(verifyRuntimeDeliveryManifest(
      serialize({ payload: encodedPayload(payload) }),
      IDENTITY,
      { 'test-key-2026-08': KEY },
    )).resolves.toEqual(expect.objectContaining({
      resolutionMode: 'local',
      candidateSetComplete: true,
      releases: [expect.objectContaining({ version: undefined, expiresAt: undefined })],
      patchEdges: [expect.objectContaining({ missingAssetsHash: null, expiresAt: null })],
    }));
  });

  it('accepts an identical payload at the persisted generation', async () => {
    await verifyRuntimeDeliveryManifest(serialize(), IDENTITY, { 'test-key-2026-08': KEY });
    await expect(verifyRuntimeDeliveryManifest(
      serialize(),
      IDENTITY,
      { 'test-key-2026-08': KEY },
    )).resolves.toEqual(expect.objectContaining({ generation: 7 }));
  });

  it('serializes concurrent lane-state mutations without losing either lane', async () => {
    mockVerifyEs256Signature.mockResolvedValue(true);
    const basePayload = JSON.parse(Buffer.from(PAYLOAD, 'base64url').toString('utf8'));
    const lane = (channelName: string) => ({
      serialized: serialize({
        payload: Buffer.from(JSON.stringify({ ...basePayload, channelName })).toString('base64url'),
      }),
      identity: { ...IDENTITY, channelName },
    });
    const first = lane('First');
    const second = lane('Second');
    await Promise.all([
      verifyRuntimeDeliveryManifest(first.serialized, first.identity, { 'test-key-2026-08': KEY }),
      verifyRuntimeDeliveryManifest(second.serialized, second.identity, { 'test-key-2026-08': KEY }),
    ]);
    const persisted = readMockJson<{ lanes: Record<string, unknown> }>(
      '/mock/doc/bundle-drop/runtime-delivery-state.json',
    );
    expect(Object.keys(persisted?.lanes || {})).toHaveLength(2);
  });
});
