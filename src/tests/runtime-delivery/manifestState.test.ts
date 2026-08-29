jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));

import {
  readVerifiedLaneState,
  readVerifiedRuntimeRevokedHashes,
  recordVerifiedLaneManifest,
} from '../../runtime-delivery/manifestState';
import type { RuntimeDeliveryLaneManifest } from '../../runtime-delivery/types';
import {
  mockReadFile,
  resetNativeFsMocks,
  setMockFile,
} from '../mocks/native/fs';

const identity = {
  projectSlug: 'project',
  channelName: 'General / beta',
  platform: 'android',
  runtimeVersion: '1.0.0/native',
};

const manifest = (generation: number): RuntimeDeliveryLaneManifest => ({
  ...identity,
  schemaVersion: 3,
  type: 'lane',
  generation,
  generatedAt: '2026-08-17T00:00:00.000Z',
  resolutionMode: 'local',
  publishingMode: 'automatic',
  rolloutAlgorithm: 'sha256-install-id-uint32be-mod100-v1',
  revokedHashes: ['a'.repeat(64)],
  releases: [],
  publishedRollouts: [],
  patchPolicy: { enabled: false, maxPatchToFullRatio: 0 },
  patchEdges: [],
  candidateSetComplete: true,
});

describe('runtime-delivery/manifestState', () => {
  beforeEach(resetNativeFsMocks);

  it('initializes empty only when state is genuinely absent', async () => {
    await expect(readVerifiedLaneState(identity)).resolves.toBeNull();
  });

  it('fails closed for malformed, unsupported, or unreadable existing state', async () => {
    setMockFile('/mock/doc/bundle-drop/runtime-delivery-state.json', '{');
    await expect(readVerifiedLaneState(identity)).rejects.toThrow('malformed or unsupported');

    const invalidStates: unknown[] = [
      null,
      [],
      { schemaVersion: 1, lanes: {}, extra: true },
      { schemaVersion: 3, lanes: {} },
      { schemaVersion: 1, lanes: null },
      { schemaVersion: 1, lanes: { '': {} } },
      { schemaVersion: 1, lanes: { lane: null } },
      { schemaVersion: 1, lanes: { lane: { extra: true } } },
      { schemaVersion: 1, lanes: { lane: {
        highestGeneration: 0,
        payloadSha256: 'a'.repeat(64),
        revokedHashes: [],
        verifiedAt: '2026-08-17T00:00:00.000Z',
      } } },
      { schemaVersion: 1, lanes: { lane: {
        highestGeneration: 1,
        payloadSha256: 'bad',
        revokedHashes: [],
        verifiedAt: '2026-08-17T00:00:00.000Z',
      } } },
      { schemaVersion: 1, lanes: { lane: {
        highestGeneration: 1,
        payloadSha256: 'a'.repeat(64),
        revokedHashes: 'bad',
        verifiedAt: '2026-08-17T00:00:00.000Z',
      } } },
      { schemaVersion: 1, lanes: { lane: {
        highestGeneration: 1,
        payloadSha256: 'a'.repeat(64),
        revokedHashes: ['bad'],
        verifiedAt: '2026-08-17T00:00:00.000Z',
      } } },
      { schemaVersion: 1, lanes: { lane: {
        highestGeneration: 1,
        payloadSha256: 'a'.repeat(64),
        revokedHashes: ['b'.repeat(64), 'b'.repeat(64)],
        verifiedAt: '2026-08-17T00:00:00.000Z',
      } } },
      { schemaVersion: 1, lanes: { lane: {
        highestGeneration: 1,
        payloadSha256: 'a'.repeat(64),
        revokedHashes: [],
        verifiedAt: 'not-a-date',
      } } },
    ];
    for (const state of invalidStates) {
      setMockFile('/mock/doc/bundle-drop/runtime-delivery-state.json', JSON.stringify(state));
      await expect(readVerifiedLaneState(identity)).rejects.toThrow('malformed or unsupported');
    }

    setMockFile('/mock/doc/bundle-drop/runtime-delivery-state.json', '{}');
    mockReadFile.mockRejectedValueOnce(new Error('EIO'));
    await expect(readVerifiedLaneState(identity)).rejects.toThrow('Unable to read existing');
  });

  it('persists and reads lane state, while allowing same-payload and newer generations', async () => {
    await recordVerifiedLaneManifest(manifest(1), '1'.repeat(64));
    await expect(readVerifiedLaneState(identity)).resolves.toEqual(expect.objectContaining({
      highestGeneration: 1,
      payloadSha256: '1'.repeat(64),
      revokedHashes: ['a'.repeat(64)],
    }));
    await recordVerifiedLaneManifest(manifest(1), '1'.repeat(64));
    await recordVerifiedLaneManifest(manifest(2), '2'.repeat(64));
    await expect(readVerifiedLaneState(identity)).resolves.toEqual(expect.objectContaining({
      highestGeneration: 2,
      payloadSha256: '2'.repeat(64),
    }));
  });

  it('rejects regressed and equivocated mutations, then releases the mutation queue', async () => {
    await recordVerifiedLaneManifest(manifest(2), '2'.repeat(64));
    await expect(recordVerifiedLaneManifest(manifest(1), '1'.repeat(64)))
      .rejects.toThrow('generation regressed');
    await expect(recordVerifiedLaneManifest(manifest(2), '3'.repeat(64)))
      .rejects.toThrow('equivocation');
    await expect(recordVerifiedLaneManifest(manifest(3), '4'.repeat(64))).resolves.toBeUndefined();
  });

  it('unions revocations across channels for the same project, platform, and runtime', async () => {
    const otherChannelManifest = {
      ...manifest(1),
      channelName: 'Production',
      revokedHashes: ['b'.repeat(64)],
    };
    const otherRuntimeManifest = {
      ...manifest(1),
      runtimeVersion: '2.0.0',
      revokedHashes: ['c'.repeat(64)],
    };

    await recordVerifiedLaneManifest(manifest(1), '1'.repeat(64));
    await recordVerifiedLaneManifest(otherChannelManifest, '2'.repeat(64));
    await recordVerifiedLaneManifest(otherRuntimeManifest, '3'.repeat(64));

    await expect(readVerifiedRuntimeRevokedHashes(identity)).resolves.toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
  });

  it('persists the prospective runtime revocation set before committing lane state', async () => {
    let laneVisibleDuringNativePersistence: unknown = 'not-checked';
    const persistRuntimeRevocations = jest.fn(async (hashes: string[]) => {
      laneVisibleDuringNativePersistence = await readVerifiedLaneState(identity);
      expect(hashes).toEqual(['a'.repeat(64)]);
    });

    await recordVerifiedLaneManifest(
      manifest(1),
      '1'.repeat(64),
      persistRuntimeRevocations,
    );

    expect(laneVisibleDuringNativePersistence).toBeNull();
    await expect(readVerifiedLaneState(identity)).resolves.toEqual(expect.objectContaining({
      highestGeneration: 1,
    }));
  });

  it('does not commit a lane generation when native revocation persistence fails', async () => {
    const persistRuntimeRevocations = jest.fn(async () => {
      throw new Error('interrupted native persistence');
    });

    await expect(recordVerifiedLaneManifest(
      manifest(1),
      '1'.repeat(64),
      persistRuntimeRevocations,
    )).rejects.toThrow('interrupted native persistence');
    await expect(readVerifiedLaneState(identity)).resolves.toBeNull();

    await expect(recordVerifiedLaneManifest(manifest(1), '1'.repeat(64)))
      .resolves.toBeUndefined();
  });

  it('serializes native revocation persistence and supplies the full prospective union', async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const firstRelease = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const calls: string[][] = [];
    const otherChannel = {
      ...manifest(1),
      channelName: 'Production',
      revokedHashes: ['b'.repeat(64)],
    };

    const first = recordVerifiedLaneManifest(
      manifest(1),
      '1'.repeat(64),
      async hashes => {
        calls.push(hashes);
        markFirstStarted();
        await firstRelease;
      },
    );
    const second = recordVerifiedLaneManifest(
      otherChannel,
      '2'.repeat(64),
      async hashes => {
        calls.push(hashes);
      },
    );

    await firstStarted;
    expect(calls).toEqual([['a'.repeat(64)]]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toEqual([
      ['a'.repeat(64)],
      ['a'.repeat(64), 'b'.repeat(64)],
    ]);
  });
});
