jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));

import { resolveRuntimeDeliveryLane, rolloutBucket } from '../../runtime-delivery/localResolver';
import type { RuntimeDeliveryLaneManifest } from '../../runtime-delivery/types';
import { mockSha256String, resetNativeFsMocks } from '../mocks/native/fs';

const hash = (character: string) => character.repeat(64);

const release = (releaseRef: string, bundleHash: string, bundleVersion: number) => ({
  releaseRef,
  bundleHash,
  bundleVersion,
  runtimeVersion: '1.0.0',
  manifestHash: hash('b'),
  jsBundleHash: hash('c'),
  fullBundleHash: hash('d'),
  fullBundleSizeBytes: 1000,
  available: true,
  expiresAt: null,
});

const automaticManifest = (): RuntimeDeliveryLaneManifest => ({
  schemaVersion: 3,
  type: 'lane',
  projectSlug: 'project',
  channelName: 'General',
  platform: 'android',
  runtimeVersion: '1.0.0',
  generation: 1,
  generatedAt: '2026-08-17T00:00:00.000Z',
  resolutionMode: 'local',
  publishingMode: 'automatic',
  rolloutAlgorithm: 'sha256-install-id-uint32be-mod100-v1',
  revokedHashes: [],
  releases: [release('new', hash('1'), 2), release('old', hash('2'), 1)],
  publishedRollouts: [],
  patchPolicy: { enabled: true, maxPatchToFullRatio: 0.7 },
  patchEdges: [],
  candidateSetComplete: true,
});

describe('runtime-delivery/localResolver', () => {
  beforeEach(resetNativeFsMocks);

  it.each([
    ['install-1', 30],
    ['install-2', 52],
    ['device-a', 89],
    ['device-b', 14],
    ['00000000-0000-0000-0000-000000000000', 52],
    ['alpha', 17],
    ['beta', 43],
    ['test-install-id', 76],
    ['a', 10],
  ])('matches the backend SHA-256 rollout bucket for %s', async (installId, expected) => {
    await expect(rolloutBucket(installId)).resolves.toBe(expected);
  });

  it('uses ordered automatic candidates and falls through rejected or unavailable releases', async () => {
    const manifest = automaticManifest();
    manifest.releases[0].available = false;
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual(expect.objectContaining({
      action: 'INSTALL',
      target: expect.objectContaining({ releaseRef: 'old' }),
      mode: 'full',
    }));

    manifest.releases[0].available = true;
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [hash('1')],
      installId: 'install-1',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual(expect.objectContaining({
      action: 'INSTALL',
      target: expect.objectContaining({ releaseRef: 'old' }),
    }));
  });

  it('returns up-to-date for the selected current bundle and rejects invalid native digests', async () => {
    const manifest = automaticManifest();
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: hash('1'),
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual({ action: 'NOOP', reason: 'UP_TO_DATE' });

    mockSha256String.mockResolvedValueOnce('not-a-digest');
    await expect(rolloutBucket('install-1')).rejects.toThrow('invalid digest');
  });

  it('preserves fractional managed-rollout membership using integerBucket < percentage', async () => {
    const manifest = automaticManifest();
    manifest.publishingMode = 'managed';
    manifest.publishedRollouts = [{ releaseRef: 'new', rolloutPercentage: 14.5, status: 'active' }];
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [],
      installId: 'device-b',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual(expect.objectContaining({ action: 'INSTALL' }));

    manifest.publishedRollouts[0].rolloutPercentage = 14;
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [],
      installId: 'device-b',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual({ action: 'NOOP', reason: 'ROLLOUT_NOT_ELIGIBLE' });

    manifest.publishedRollouts[0] = {
      releaseRef: 'new',
      rolloutPercentage: 14,
      status: 'completed',
    };
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [],
      installId: 'device-b',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual({ action: 'NOOP', reason: 'ROLLOUT_NOT_ELIGIBLE' });
  });

  it('rolls back a revoked current bundle only when no safe different target exists', async () => {
    const manifest = automaticManifest();
    manifest.revokedHashes = [hash('1'), hash('2')];
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: hash('1'),
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: ['xdelta3-vcdiff'],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual({
      action: 'ROLLBACK',
      reason: 'CURRENT_REVOKED_NO_COMPATIBLE_TARGET',
    });

    manifest.revokedHashes = [hash('2')];
    manifest.patchEdges = [{
      baseHash: hash('2'),
      targetHash: hash('1'),
      algorithm: 'xdelta3-vcdiff',
      patchSetHash: hash('e'),
      patchArtifactRef: 'patch',
      patchSizeBytes: 100,
      fullBundleSizeBytes: 1000,
    }];
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: hash('2'),
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: ['xdelta3-vcdiff'],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual(expect.objectContaining({ action: 'INSTALL', mode: 'full' }));
  });

  it('selects an eligible ordered patch edge and otherwise preserves full fallback', async () => {
    const manifest = automaticManifest();
    manifest.patchEdges = [{
      baseHash: hash('2'),
      targetHash: hash('1'),
      algorithm: 'xdelta3-vcdiff',
      patchSetHash: hash('e'),
      patchArtifactRef: 'patch',
      patchSizeBytes: 700,
      fullBundleSizeBytes: 1000,
    }];
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: hash('2'),
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: ['xdelta3-vcdiff'],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual(expect.objectContaining({ action: 'INSTALL', mode: 'patch' }));

    manifest.patchEdges[0].patchSizeBytes = 701;
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: hash('2'),
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: ['xdelta3-vcdiff'],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual(expect.objectContaining({ action: 'INSTALL', mode: 'full' }));
  });

  it('rejects disabled, unsupported, expired, wrong-base, and wrong-target patch edges', async () => {
    const manifest = automaticManifest();
    const edge = {
      baseHash: hash('2'),
      targetHash: hash('1'),
      algorithm: 'xdelta3-vcdiff',
      patchSetHash: hash('e'),
      patchArtifactRef: 'patch',
      patchSizeBytes: 100,
      fullBundleSizeBytes: 1000,
      expiresAt: null,
    };
    manifest.patchEdges = [edge];
    const input = {
      currentHash: hash('2'),
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: ['xdelta3-vcdiff'],
      supportsContentAddressedAssets: true,
      now: Date.parse('2026-08-17T00:00:00.000Z'),
    };

    manifest.patchPolicy.enabled = false;
    await expect(resolveRuntimeDeliveryLane(manifest, input))
      .resolves.toEqual(expect.objectContaining({ mode: 'full' }));
    manifest.patchPolicy.enabled = true;
    await expect(resolveRuntimeDeliveryLane(manifest, { ...input, currentHash: null }))
      .resolves.toEqual(expect.objectContaining({ mode: 'full' }));
    edge.baseHash = hash('3');
    await expect(resolveRuntimeDeliveryLane(manifest, input))
      .resolves.toEqual(expect.objectContaining({ mode: 'full' }));
    edge.baseHash = hash('2');
    edge.targetHash = hash('3');
    await expect(resolveRuntimeDeliveryLane(manifest, input))
      .resolves.toEqual(expect.objectContaining({ mode: 'full' }));
    edge.targetHash = hash('1');
    await expect(resolveRuntimeDeliveryLane(manifest, { ...input, patchAlgorithms: [] }))
      .resolves.toEqual(expect.objectContaining({ mode: 'full' }));
    edge.expiresAt = '2026-08-16T00:00:00.000Z';
    await expect(resolveRuntimeDeliveryLane(manifest, input))
      .resolves.toEqual(expect.objectContaining({ mode: 'full' }));
    edge.expiresAt = '2026-08-18T00:00:00.000Z';
    await expect(resolveRuntimeDeliveryLane(manifest, input))
      .resolves.toEqual(expect.objectContaining({ mode: 'patch' }));
  });

  it('skips expired, rejected, and revoked managed candidates before a 100-percent rollout', async () => {
    const manifest = automaticManifest();
    manifest.publishingMode = 'managed';
    manifest.releases = [
      { ...release('expired', hash('3'), 3), expiresAt: '2026-08-16T00:00:00.000Z' },
      release('rejected', hash('4'), 2),
      release('revoked', hash('5'), 1),
      release('safe', hash('6'), 0),
    ];
    manifest.revokedHashes = [hash('5')];
    manifest.publishedRollouts = manifest.releases.map(item => ({
      releaseRef: item.releaseRef,
      rolloutPercentage: 100,
      status: 'completed' as const,
    }));
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [hash('4')],
      installId: 'device-a',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
      now: Date.parse('2026-08-17T00:00:00.000Z'),
    })).resolves.toEqual(expect.objectContaining({
      action: 'INSTALL',
      target: expect.objectContaining({ releaseRef: 'safe' }),
    }));
  });

  it('rejects patches from quarantined bases and any patch with missing assets without asset capability', async () => {
    const manifest = automaticManifest();
    manifest.patchEdges = [{
      baseHash: hash('2'),
      targetHash: hash('1'),
      algorithm: 'asset-only-v1',
      patchSetHash: hash('e'),
      patchArtifactRef: 'asset-patch',
      patchSizeBytes: 100,
      fullBundleSizeBytes: 1000,
      missingAssetsHash: hash('f'),
    }];
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: hash('2'),
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: ['asset-only-v1'],
      supportsContentAddressedAssets: false,
    })).resolves.toEqual(expect.objectContaining({ mode: 'full' }));
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: hash('2'),
      rejectedHashes: [hash('2')],
      installId: 'install-1',
      patchAlgorithms: ['asset-only-v1'],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual(expect.objectContaining({ mode: 'full' }));

    manifest.patchEdges[0].algorithm = 'xdelta3-vcdiff';
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: hash('2'),
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: ['xdelta3-vcdiff'],
      supportsContentAddressedAssets: false,
    })).resolves.toEqual(expect.objectContaining({ mode: 'full' }));

    delete manifest.patchEdges[0].missingAssetsHash;
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: hash('2'),
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: ['xdelta3-vcdiff'],
      supportsContentAddressedAssets: false,
    })).resolves.toEqual(expect.objectContaining({ mode: 'patch' }));
  });

  it('uses production no-candidate reasons for automatic and managed lanes', async () => {
    const manifest = automaticManifest();
    manifest.releases = [];
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual({ action: 'NOOP', reason: 'NO_COMPATIBLE_BUNDLE' });
    manifest.publishingMode = 'managed';
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).resolves.toEqual({ action: 'NOOP', reason: 'NO_PUBLISHED_BUNDLE' });
  });

  it('rejects dynamic and incomplete lanes instead of installing from them', async () => {
    const manifest = automaticManifest();
    manifest.candidateSetComplete = false;
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).rejects.toThrow('Incomplete candidate sets');
    manifest.candidateSetComplete = true;
    manifest.resolutionMode = 'dynamic';
    await expect(resolveRuntimeDeliveryLane(manifest, {
      currentHash: null,
      rejectedHashes: [],
      installId: 'install-1',
      patchAlgorithms: [],
      supportsContentAddressedAssets: true,
    })).rejects.toThrow('Dynamic lanes');
  });
});
