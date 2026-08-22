import { postOtaActiveInstallHeartbeat } from '../api/clientApi';
import type { OtaActiveInstallHeartbeat } from '../api/types';
import { BUNDLE_DROP_ROOT } from '../context';
import { atomicWriteJson } from '../fs/fsUtils';
import RNFS from '../native/fs';

const HEARTBEAT_STATE_PATH = `${BUNDLE_DROP_ROOT}/runtime-delivery-heartbeats.json`;
const STABLE_HEARTBEAT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const inFlight = new Set<string>();
let stateMutation: Promise<void> = Promise.resolve();

type HeartbeatState = {
  schemaVersion: 1;
  reportedAt: Record<string, number>;
  fingerprints: Record<string, string>;
};

async function readState(): Promise<HeartbeatState> {
  try {
    const parsed = JSON.parse(await RNFS.readFile(HEARTBEAT_STATE_PATH, 'utf8')) as HeartbeatState;
    if (parsed.schemaVersion === 1 && parsed.reportedAt && typeof parsed.reportedAt === 'object') {
      return {
        schemaVersion: 1,
        reportedAt: parsed.reportedAt,
        fingerprints:
          parsed.fingerprints && typeof parsed.fingerprints === 'object'
            ? parsed.fingerprints
            : {},
      };
    }
  } catch {
    // A missing heartbeat cache means this install may report once.
  }
  return { schemaVersion: 1, reportedAt: {}, fingerprints: {} };
}

async function heartbeatFingerprint(payload: OtaActiveInstallHeartbeat): Promise<string> {
  const userProperties = payload.userProperties
    ? Object.fromEntries(
        Object.entries(payload.userProperties).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      )
    : null;

  return RNFS.sha256String(JSON.stringify({
    currentHash: payload.currentHash,
    environment: payload.environment ?? null,
    userProperties,
  }));
}

function heartbeatKey(projectSlug: string, payload: OtaActiveInstallHeartbeat): string {
  return [
    projectSlug,
    payload.channelName,
    payload.platform,
    payload.runtimeVersion,
    payload.installId,
  ].map(encodeURIComponent).join('/');
}

export function reportActiveInstallWhenDue(
  projectSlug: string,
  payload: OtaActiveInstallHeartbeat,
): void {
  const key = heartbeatKey(projectSlug, payload);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  void (async () => {
    try {
      const state = await readState();
      const now = Date.now();
      const fingerprint = await heartbeatFingerprint(payload);
      if (
        state.fingerprints[key] === fingerprint &&
        now - (state.reportedAt[key] || 0) < STABLE_HEARTBEAT_INTERVAL_MS
      ) {
        return;
      }
      await postOtaActiveInstallHeartbeat(projectSlug, payload);
      const mutation = stateMutation.then(async () => {
        const latest = await readState();
        latest.reportedAt[key] = now;
        latest.fingerprints[key] = fingerprint;
        await atomicWriteJson(HEARTBEAT_STATE_PATH, latest);
      });
      stateMutation = mutation.then(() => undefined, () => undefined);
      await mutation;
    } catch (error) {
      console.warn('⚠️ BundleDrop active-install heartbeat failed:', error);
    } finally {
      inFlight.delete(key);
    }
  })();
}

export function resetRuntimeDeliveryHeartbeatForTests(): void {
  inFlight.clear();
  stateMutation = Promise.resolve();
}
