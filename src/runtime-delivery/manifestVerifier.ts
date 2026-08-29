import RNFS from '../native/fs';
import { syncVerifiedRevokedHashes } from '../manager/rollbackState';
import { decodeBase64UrlBytes, decodeBase64UrlUtf8, utf8ByteLength } from './encoding';
import {
  readVerifiedLaneState,
  recordVerifiedLaneManifest,
} from './manifestState';
import {
  RUNTIME_DELIVERY_ROLLOUT_ALGORITHM,
  RUNTIME_DELIVERY_MANIFEST_JWS_TYPE,
  type RuntimeDeliveryJws,
  type RuntimeDeliveryLaneIdentity,
  type RuntimeDeliveryLaneManifest,
  type RuntimeDeliveryPublicKey,
} from './types';

export const MAX_RUNTIME_MANIFEST_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type RuntimeDeliveryManifestFailureCode =
  | 'body_too_large'
  | 'http_error'
  | 'network_error'
  | 'timeout'
  | 'stream_unavailable'
  | 'invalid_manifest'
  | 'invalid_signature'
  | 'unknown_key'
  | 'lane_mismatch'
  | 'generation_regression'
  | 'generation_equivocation'
  | 'authority_body_too_large'
  | 'authority_http_error'
  | 'authority_network_error'
  | 'authority_timeout'
  | 'authority_stream_unavailable'
  | 'authority_invalid'
  | 'authority_invalid_signature'
  | 'authority_unknown_key'
  | 'authority_expired'
  | 'authority_origin_mismatch'
  | 'authority_disabled';

export class RuntimeDeliveryManifestError extends Error {
  public readonly status?: number;

  constructor(
    public readonly code: RuntimeDeliveryManifestFailureCode,
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message);
    this.name = 'RuntimeDeliveryManifestError';
    this.status = options?.status;
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  name: string,
): void {
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(value).find(key => !allowed.has(key));
  if (unsupported) throw new Error(`${name} contains unsupported field ${unsupported}`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireHash(value: unknown, name: string): string {
  const hash = requireString(value, name);
  if (!SHA256_PATTERN.test(hash)) throw new Error(`${name} must be a lowercase SHA-256 hash`);
  return hash;
}

function requireInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, name: string): number {
  const integer = requireInteger(value, name);
  if (integer < 1) throw new Error(`${name} must be at least 1`);
  return integer;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireString(value, name);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${name} must be an ISO timestamp`);
  return timestamp;
}

function optionalTimestamp(value: unknown, name: string): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return requireTimestamp(value, name);
}

function parseLaneManifest(payload: unknown): RuntimeDeliveryLaneManifest {
  const lane = requireRecord(payload, 'Manifest payload');
  requireExactKeys(lane, [
    'schemaVersion', 'type', 'projectSlug', 'channelName', 'platform', 'runtimeVersion',
    'generation', 'generatedAt', 'resolutionMode', 'dynamicReason',
    'publishingMode', 'rolloutAlgorithm', 'revokedHashes', 'releases',
    'publishedRollouts', 'patchPolicy', 'patchEdges', 'candidateSetComplete',
  ], 'Manifest payload');
  if (lane.schemaVersion !== 3 || lane.type !== 'lane') {
    throw new Error('Unsupported runtime manifest schema or type');
  }
  const resolutionMode = lane.resolutionMode;
  if (resolutionMode !== 'local' && resolutionMode !== 'dynamic') {
    throw new Error('resolutionMode must be local or dynamic');
  }
  const publishingMode = lane.publishingMode;
  if (publishingMode !== 'automatic' && publishingMode !== 'managed') {
    throw new Error('publishingMode must be automatic or managed');
  }
  if (lane.rolloutAlgorithm !== RUNTIME_DELIVERY_ROLLOUT_ALGORITHM) {
    throw new Error('Unsupported rollout algorithm');
  }
  if (typeof lane.candidateSetComplete !== 'boolean') {
    throw new Error('candidateSetComplete must be boolean');
  }

  const releaseValues = Array.isArray(lane.releases) ? lane.releases : null;
  const rolloutValues = Array.isArray(lane.publishedRollouts) ? lane.publishedRollouts : null;
  const patchValues = Array.isArray(lane.patchEdges) ? lane.patchEdges : null;
  const revokedValues = Array.isArray(lane.revokedHashes) ? lane.revokedHashes : null;
  if (!releaseValues || !rolloutValues || !patchValues || !revokedValues) {
    throw new Error('Manifest candidate arrays are required');
  }
  if (releaseValues.length > 21) {
    throw new Error('Runtime manifest may contain at most 21 releases');
  }

  const releases = releaseValues.map((value, index) => {
    const release = requireRecord(value, `releases[${index}]`);
    requireExactKeys(release, [
      'releaseRef', 'bundleHash', 'bundleVersion', 'version', 'runtimeVersion',
      'manifestHash', 'jsBundleHash', 'fullBundleHash', 'fullBundleSizeBytes',
      'available', 'expiresAt',
    ], `releases[${index}]`);
    if (typeof release.available !== 'boolean') {
      throw new Error(`releases[${index}].available must be boolean`);
    }
    return {
      releaseRef: requireString(release.releaseRef, `releases[${index}].releaseRef`),
      bundleHash: requireHash(release.bundleHash, `releases[${index}].bundleHash`),
      bundleVersion: requireInteger(release.bundleVersion, `releases[${index}].bundleVersion`),
      version: release.version === undefined
        ? undefined
        : requireString(release.version, `releases[${index}].version`),
      runtimeVersion: requireString(release.runtimeVersion, `releases[${index}].runtimeVersion`),
      manifestHash: requireHash(release.manifestHash, `releases[${index}].manifestHash`),
      jsBundleHash: requireHash(release.jsBundleHash, `releases[${index}].jsBundleHash`),
      fullBundleHash: requireHash(release.fullBundleHash, `releases[${index}].fullBundleHash`),
      fullBundleSizeBytes: requirePositiveInteger(
        release.fullBundleSizeBytes,
        `releases[${index}].fullBundleSizeBytes`,
      ),
      available: release.available,
      expiresAt: optionalTimestamp(release.expiresAt, `releases[${index}].expiresAt`),
    };
  });

  const publishedRollouts = rolloutValues.map((value, index) => {
    const rollout = requireRecord(value, `publishedRollouts[${index}]`);
    requireExactKeys(
      rollout,
      ['releaseRef', 'rolloutPercentage', 'status'],
      `publishedRollouts[${index}]`,
    );
    const percentage = requireFiniteNumber(
      rollout.rolloutPercentage,
      `publishedRollouts[${index}].rolloutPercentage`,
    );
    if (percentage > 100) throw new Error('rolloutPercentage must be at most 100');
    if (rollout.status !== 'active' && rollout.status !== 'completed') {
      throw new Error(`publishedRollouts[${index}].status is invalid`);
    }
    const status: 'active' | 'completed' = rollout.status;
    return {
      releaseRef: requireString(rollout.releaseRef, `publishedRollouts[${index}].releaseRef`),
      rolloutPercentage: percentage,
      status,
    };
  });

  const patchPolicy = requireRecord(lane.patchPolicy, 'patchPolicy');
  requireExactKeys(patchPolicy, ['enabled', 'maxPatchToFullRatio'], 'patchPolicy');
  if (typeof patchPolicy.enabled !== 'boolean') throw new Error('patchPolicy.enabled must be boolean');
  const maxPatchToFullRatio = requireFiniteNumber(
    patchPolicy.maxPatchToFullRatio,
    'patchPolicy.maxPatchToFullRatio',
  );
  if (maxPatchToFullRatio > 1) throw new Error('maxPatchToFullRatio must be at most 1');

  const patchEdges = patchValues.map((value, index) => {
    const edge = requireRecord(value, `patchEdges[${index}]`);
    requireExactKeys(edge, [
      'baseHash', 'targetHash', 'algorithm', 'patchSetHash', 'patchArtifactRef',
      'patchSizeBytes', 'fullBundleSizeBytes', 'missingAssetsHash', 'expiresAt',
    ], `patchEdges[${index}]`);
    const missingAssetsHash = edge.missingAssetsHash === null
      ? null
      : edge.missingAssetsHash === undefined
        ? undefined
        : requireHash(edge.missingAssetsHash, `patchEdges[${index}].missingAssetsHash`);
    return {
      baseHash: requireHash(edge.baseHash, `patchEdges[${index}].baseHash`),
      targetHash: requireHash(edge.targetHash, `patchEdges[${index}].targetHash`),
      algorithm: requireString(edge.algorithm, `patchEdges[${index}].algorithm`),
      patchSetHash: requireHash(edge.patchSetHash, `patchEdges[${index}].patchSetHash`),
      patchArtifactRef: requireString(edge.patchArtifactRef, `patchEdges[${index}].patchArtifactRef`),
      patchSizeBytes: requirePositiveInteger(edge.patchSizeBytes, `patchEdges[${index}].patchSizeBytes`),
      fullBundleSizeBytes: requirePositiveInteger(
        edge.fullBundleSizeBytes,
        `patchEdges[${index}].fullBundleSizeBytes`,
      ),
      missingAssetsHash,
      expiresAt: optionalTimestamp(edge.expiresAt, `patchEdges[${index}].expiresAt`),
    };
  });

  const generation = requireInteger(lane.generation, 'generation');
  if (generation < 1) throw new Error('generation must be at least 1');
  const manifest: RuntimeDeliveryLaneManifest = {
    schemaVersion: 3,
    type: 'lane',
    projectSlug: requireString(lane.projectSlug, 'projectSlug'),
    channelName: requireString(lane.channelName, 'channelName'),
    platform: requireString(lane.platform, 'platform'),
    runtimeVersion: requireString(lane.runtimeVersion, 'runtimeVersion'),
    generation,
    generatedAt: requireTimestamp(lane.generatedAt, 'generatedAt'),
    resolutionMode,
    dynamicReason: lane.dynamicReason === undefined
      ? undefined
      : requireString(lane.dynamicReason, 'dynamicReason'),
    publishingMode,
    rolloutAlgorithm: RUNTIME_DELIVERY_ROLLOUT_ALGORITHM,
    revokedHashes: revokedValues.map((hash, index) => requireHash(hash, `revokedHashes[${index}]`)),
    releases,
    publishedRollouts,
    patchPolicy: { enabled: patchPolicy.enabled, maxPatchToFullRatio },
    patchEdges,
    candidateSetComplete: lane.candidateSetComplete,
  };
  if (new Set(manifest.revokedHashes).size !== manifest.revokedHashes.length) {
    throw new Error('revokedHashes must contain unique values');
  }
  if (manifest.resolutionMode === 'local') {
    if (!manifest.candidateSetComplete) {
      throw new Error('Local runtime manifests require a complete candidate set');
    }
    if (manifest.releases.some(release => !release.available)) {
      throw new Error('Local runtime manifests require available releases');
    }
  } else if (
    !manifest.dynamicReason ||
    manifest.candidateSetComplete ||
    manifest.releases.length ||
    manifest.publishedRollouts.length ||
    manifest.patchEdges.length
  ) {
    throw new Error('Dynamic runtime manifests require a reason and the safe empty candidate shape');
  }
  validateCandidateConsistency(manifest);
  return manifest;
}

function validateCandidateConsistency(manifest: RuntimeDeliveryLaneManifest): void {
  const releaseRefs = new Set<string>();
  const releaseHashes = new Set<string>();
  const releaseByHash = new Map(manifest.releases.map(release => [release.bundleHash, release]));
  for (const release of manifest.releases) {
    if (release.runtimeVersion !== manifest.runtimeVersion) throw new Error('Release runtime identity mismatch');
    if (releaseRefs.has(release.releaseRef) || releaseHashes.has(release.bundleHash)) {
      throw new Error('Manifest contains duplicate release identity');
    }
    releaseRefs.add(release.releaseRef);
    releaseHashes.add(release.bundleHash);
  }
  const rolloutRefs = new Set<string>();
  for (const rollout of manifest.publishedRollouts) {
    if (!releaseRefs.has(rollout.releaseRef) || rolloutRefs.has(rollout.releaseRef)) {
      throw new Error('Published rollout references an unknown or duplicate release');
    }
    rolloutRefs.add(rollout.releaseRef);
  }
  const patchEdgeIdentities = new Set<string>();
  for (const edge of manifest.patchEdges) {
    const target = releaseByHash.get(edge.targetHash);
    if (!target || edge.fullBundleSizeBytes !== target.fullBundleSizeBytes) {
      throw new Error('Patch edge is inconsistent with its target release');
    }
    const identity = `${edge.baseHash}\0${edge.targetHash}\0${edge.algorithm}`;
    if (patchEdgeIdentities.has(identity)) {
      throw new Error('Manifest contains duplicate patch edge identity');
    }
    patchEdgeIdentities.add(identity);
  }
}

function assertLaneIdentity(
  manifest: RuntimeDeliveryLaneManifest,
  expected: RuntimeDeliveryLaneIdentity,
): void {
  for (const field of ['projectSlug', 'channelName', 'platform', 'runtimeVersion'] as const) {
    if (manifest[field] !== expected[field]) {
      throw new RuntimeDeliveryManifestError(
        'lane_mismatch',
        `Manifest ${field} identity mismatch`,
      );
    }
  }
}

function assertPublicKey(key: RuntimeDeliveryPublicKey | undefined): asserts key is RuntimeDeliveryPublicKey {
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256') {
    throw new RuntimeDeliveryManifestError('unknown_key', 'Unknown or invalid manifest signing key');
  }
  if (decodeBase64UrlBytes(key.x).length !== 32 || decodeBase64UrlBytes(key.y).length !== 32) {
    throw new RuntimeDeliveryManifestError(
      'unknown_key',
      'Manifest signing key coordinates must be 32 bytes',
    );
  }
}

export async function verifyRuntimeDeliveryManifest(
  serializedJws: string,
  expectedIdentity: RuntimeDeliveryLaneIdentity,
  publicKeys: Record<string, RuntimeDeliveryPublicKey>,
): Promise<RuntimeDeliveryLaneManifest> {
  const payloadValue = await verifyRuntimeDeliverySignedPayload(
    serializedJws,
    RUNTIME_DELIVERY_MANIFEST_JWS_TYPE,
    publicKeys,
  );

  const manifest = parseLaneManifest(JSON.parse(decodeBase64UrlUtf8(payloadValue)));
  assertLaneIdentity(manifest, expectedIdentity);
  const payloadSha256 = await RNFS.sha256String(payloadValue);
  const previousState = await readVerifiedLaneState(expectedIdentity);
  if (previousState && manifest.generation < previousState.highestGeneration) {
    throw new RuntimeDeliveryManifestError(
      'generation_regression',
      'Runtime manifest generation regressed',
    );
  }
  if (
    previousState &&
    manifest.generation === previousState.highestGeneration &&
    previousState.payloadSha256 !== payloadSha256
  ) {
    throw new RuntimeDeliveryManifestError(
      'generation_equivocation',
      'Runtime manifest generation equivocation detected',
    );
  }
  await recordVerifiedLaneManifest(
    manifest,
    payloadSha256,
    async runtimeRevokedHashes => {
      const persisted = await syncVerifiedRevokedHashes(runtimeRevokedHashes);
      if (!persisted) {
        throw new Error('Native startup recovery rejected the verified revocation set');
      }
    },
  );
  return manifest;
}

export async function verifyRuntimeDeliverySignedPayload(
  serializedJws: string,
  expectedType: string,
  publicKeys: Record<string, RuntimeDeliveryPublicKey>,
): Promise<string> {
  if (utf8ByteLength(serializedJws) > MAX_RUNTIME_MANIFEST_BYTES) {
    throw new RuntimeDeliveryManifestError(
      'body_too_large',
      'Runtime manifest exceeds the 1 MB safety limit',
    );
  }
  const envelope = requireRecord(JSON.parse(serializedJws), 'JWS envelope') as RuntimeDeliveryJws;
  if (Object.keys(envelope).sort().join(',') !== 'payload,protected,signature') {
    throw new Error('JWS envelope contains unsupported fields');
  }
  const protectedValue = requireString(envelope.protected, 'JWS protected');
  const payloadValue = requireString(envelope.payload, 'JWS payload');
  const signatureValue = requireString(envelope.signature, 'JWS signature');
  if (decodeBase64UrlBytes(signatureValue).length !== 64) {
    throw new RuntimeDeliveryManifestError(
      'invalid_signature',
      'ES256 JWS signature must be 64-byte JOSE R||S',
    );
  }
  const protectedHeader = requireRecord(
    JSON.parse(decodeBase64UrlUtf8(protectedValue)),
    'JWS protected header',
  );
  if (Object.keys(protectedHeader).sort().join(',') !== 'alg,kid,typ') {
    throw new Error('JWS protected header contains unsupported fields');
  }
  if (
    protectedHeader.alg !== 'ES256' ||
    protectedHeader.typ !== expectedType ||
    typeof protectedHeader.kid !== 'string' || !protectedHeader.kid
  ) {
    throw new Error('Unsupported JWS protected header');
  }
  const publicKey = publicKeys[protectedHeader.kid];
  assertPublicKey(publicKey);
  const verified = await RNFS.verifyEs256Signature(
    `${protectedValue}.${payloadValue}`,
    signatureValue,
    publicKey.x,
    publicKey.y,
  );
  if (!verified) {
    throw new RuntimeDeliveryManifestError(
      'invalid_signature',
      'Runtime manifest signature verification failed',
    );
  }

  return payloadValue;
}
