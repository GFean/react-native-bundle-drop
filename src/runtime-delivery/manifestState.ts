import { BUNDLE_DROP_ROOT } from '../context';
import { atomicWriteJson } from '../fs/fsUtils';
import RNFS from '../native/fs';
import type { RuntimeDeliveryLaneIdentity, RuntimeDeliveryLaneManifest } from './types';

const STATE_PATH = `${BUNDLE_DROP_ROOT}/runtime-delivery-state.json`;
let stateMutation: Promise<void> = Promise.resolve();

export type VerifiedLaneState = {
  highestGeneration: number;
  payloadSha256: string;
  revokedHashes: string[];
  verifiedAt: string;
};

export type PersistVerifiedRuntimeRevocations = (
  revokedHashes: string[],
) => Promise<void>;

type RuntimeDeliveryState = {
  schemaVersion: 1;
  lanes: Record<string, VerifiedLaneState>;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalidState(): never {
  throw new Error('Runtime delivery state is malformed or unsupported');
}

function parseState(raw: string): RuntimeDeliveryState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidState();
  }
  if (!isRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'lanes,schemaVersion') {
    return invalidState();
  }
  if (parsed.schemaVersion !== 1 || !isRecord(parsed.lanes)) return invalidState();

  for (const [key, lane] of Object.entries(parsed.lanes)) {
    if (!key || !isRecord(lane)) return invalidState();
    if (
      Object.keys(lane).sort().join(',') !==
      'highestGeneration,payloadSha256,revokedHashes,verifiedAt'
    ) {
      return invalidState();
    }
    if (!Number.isSafeInteger(lane.highestGeneration) || (lane.highestGeneration as number) < 1) {
      return invalidState();
    }
    if (typeof lane.payloadSha256 !== 'string' || !SHA256_PATTERN.test(lane.payloadSha256)) {
      return invalidState();
    }
    if (
      !Array.isArray(lane.revokedHashes) ||
      lane.revokedHashes.some(hash => typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) ||
      new Set(lane.revokedHashes).size !== lane.revokedHashes.length
    ) {
      return invalidState();
    }
    if (typeof lane.verifiedAt !== 'string' || !Number.isFinite(Date.parse(lane.verifiedAt))) {
      return invalidState();
    }
  }
  return parsed as RuntimeDeliveryState;
}

function laneStateKey(identity: RuntimeDeliveryLaneIdentity): string {
  return [identity.projectSlug, identity.channelName, identity.platform, identity.runtimeVersion]
    .map(value => encodeURIComponent(value))
    .join('/');
}

function belongsToRuntime(
  laneKey: string,
  identity: RuntimeDeliveryLaneIdentity,
): boolean {
  const parts = laneKey.split('/');
  return parts.length === 4 &&
    parts[0] === encodeURIComponent(identity.projectSlug) &&
    parts[2] === encodeURIComponent(identity.platform) &&
    parts[3] === encodeURIComponent(identity.runtimeVersion);
}

function verifiedRuntimeRevokedHashes(
  state: RuntimeDeliveryState,
  identity: RuntimeDeliveryLaneIdentity,
): string[] {
  const revokedHashes = Object.entries(state.lanes)
    .filter(([key]) => belongsToRuntime(key, identity))
    .flatMap(([, lane]) => lane.revokedHashes);
  return Array.from(new Set(revokedHashes)).sort();
}

async function readState(): Promise<RuntimeDeliveryState> {
  if (!await RNFS.exists(STATE_PATH)) return { schemaVersion: 1, lanes: {} };
  let raw: string;
  try {
    raw = await RNFS.readFile(STATE_PATH, 'utf8');
  } catch {
    throw new Error('Unable to read existing runtime delivery state');
  }
  return parseState(raw);
}

export async function readVerifiedLaneState(
  identity: RuntimeDeliveryLaneIdentity,
): Promise<VerifiedLaneState | null> {
  const state = await readState();
  return state.lanes[laneStateKey(identity)] || null;
}

export async function readVerifiedRuntimeRevokedHashes(
  identity: RuntimeDeliveryLaneIdentity,
): Promise<string[]> {
  const state = await readState();
  return verifiedRuntimeRevokedHashes(state, identity);
}

export async function recordVerifiedLaneManifest(
  manifest: RuntimeDeliveryLaneManifest,
  payloadSha256: string,
  persistRuntimeRevocations?: PersistVerifiedRuntimeRevocations,
): Promise<void> {
  const mutation = stateMutation.then(async () => {
    const identity: RuntimeDeliveryLaneIdentity = manifest;
    const key = laneStateKey(identity);
    const state = await readState();
    const existing = state.lanes[key];
    if (existing && existing.highestGeneration > manifest.generation) {
      throw new Error('Manifest generation regressed while persisting verified state');
    }
    if (
      existing &&
      existing.highestGeneration === manifest.generation &&
      existing.payloadSha256 !== payloadSha256
    ) {
      throw new Error('Manifest generation equivocation detected');
    }
    state.lanes[key] = {
      highestGeneration: manifest.generation,
      payloadSha256,
      revokedHashes: [...manifest.revokedHashes],
      verifiedAt: new Date().toISOString(),
    };
    if (persistRuntimeRevocations) {
      await persistRuntimeRevocations(verifiedRuntimeRevokedHashes(state, identity));
    }
    await atomicWriteJson(STATE_PATH, state);
  });
  stateMutation = mutation.then(() => undefined, () => undefined);
  return mutation;
}
