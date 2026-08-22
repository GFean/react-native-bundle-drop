import RNFS from '../native/fs';
import type {
  RuntimeDeliveryLaneManifest,
  RuntimeDeliveryPatchEdge,
  RuntimeDeliveryRelease,
} from './types';

export type LocalResolution =
  | { action: 'NOOP'; reason: string }
  | { action: 'ROLLBACK'; reason: string }
  | {
      action: 'INSTALL';
      target: RuntimeDeliveryRelease;
      mode: 'full' | 'patch';
      patchEdge?: RuntimeDeliveryPatchEdge;
    };

export type LocalResolutionInput = {
  currentHash: string | null;
  rejectedHashes: string[];
  installId: string;
  patchAlgorithms: string[];
  supportsContentAddressedAssets: boolean;
  now?: number;
};

function isUnexpired(expiresAt: string | null | undefined, now: number): boolean {
  return !expiresAt || Date.parse(expiresAt) > now;
}

export async function rolloutBucket(installId: string): Promise<number> {
  const digest = await RNFS.sha256String(installId);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Native SHA-256 returned an invalid digest');
  return Number.parseInt(digest.slice(0, 8), 16) % 100;
}

function selectPatchEdge(
  manifest: RuntimeDeliveryLaneManifest,
  input: LocalResolutionInput,
  target: RuntimeDeliveryRelease,
  now: number,
): RuntimeDeliveryPatchEdge | undefined {
  if (!manifest.patchPolicy.enabled || !input.currentHash) return undefined;
  if (input.rejectedHashes.includes(input.currentHash)) return undefined;
  return manifest.patchEdges.find(edge =>
    edge.baseHash === input.currentHash &&
    edge.targetHash === target.bundleHash &&
    input.patchAlgorithms.includes(edge.algorithm) &&
    (!edge.missingAssetsHash || input.supportsContentAddressedAssets) &&
    isUnexpired(edge.expiresAt, now) &&
    edge.patchSizeBytes <= edge.fullBundleSizeBytes * manifest.patchPolicy.maxPatchToFullRatio
  );
}

export async function resolveRuntimeDeliveryLane(
  manifest: RuntimeDeliveryLaneManifest,
  input: LocalResolutionInput,
): Promise<LocalResolution> {
  if (manifest.resolutionMode !== 'local') throw new Error('Dynamic lanes require server resolution');
  if (!manifest.candidateSetComplete) throw new Error('Incomplete candidate sets cannot resolve locally');

  const now = input.now ?? Date.now();
  const rejected = new Set(input.rejectedHashes);
  const revoked = new Set(manifest.revokedHashes);
  const currentRevoked = !!input.currentHash && revoked.has(input.currentHash);
  const releasesByRef = new Map(manifest.releases.map(release => [release.releaseRef, release]));
  const isSafe = (release: RuntimeDeliveryRelease) =>
    release.available &&
    !rejected.has(release.bundleHash) &&
    !revoked.has(release.bundleHash) &&
    isUnexpired(release.expiresAt, now);

  let selected: RuntimeDeliveryRelease | undefined;
  let noCandidateReason = 'NO_PUBLISHED_BUNDLE';
  if (manifest.publishingMode === 'automatic') {
    selected = manifest.releases.find(isSafe);
    noCandidateReason = 'NO_COMPATIBLE_BUNDLE';
  } else {
    const bucket = await rolloutBucket(input.installId);
    for (const rollout of manifest.publishedRollouts) {
      const release = releasesByRef.get(rollout.releaseRef)!;
      if (!isSafe(release)) continue;
      const eligible = rollout.rolloutPercentage >= 100 || bucket < rollout.rolloutPercentage;
      if (eligible) {
        selected = release;
        break;
      }
      noCandidateReason = 'ROLLOUT_NOT_ELIGIBLE';
    }
  }

  if (!selected) {
    return currentRevoked
      ? { action: 'ROLLBACK', reason: 'CURRENT_REVOKED_NO_COMPATIBLE_TARGET' }
      : { action: 'NOOP', reason: noCandidateReason };
  }
  if (selected.bundleHash === input.currentHash) {
    return currentRevoked
      ? { action: 'ROLLBACK', reason: 'CURRENT_REVOKED_NO_COMPATIBLE_TARGET' }
      : { action: 'NOOP', reason: 'UP_TO_DATE' };
  }
  const patchEdge = currentRevoked ? undefined : selectPatchEdge(manifest, input, selected, now);
  return {
    action: 'INSTALL',
    target: selected,
    mode: patchEdge ? 'patch' : 'full',
    patchEdge,
  };
}
