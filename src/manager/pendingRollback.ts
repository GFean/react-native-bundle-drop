import { BUNDLE_DROP_ROOT, runtimeVersion } from '../context';
import { readCurrentBundleHash } from '../fs/bundlePointer';
import { atomicWriteJson, ensureDir } from '../fs/fsUtils';
import RNFS from '../native/fs';

const PENDING_ROLLBACK_PATH = `${BUNDLE_DROP_ROOT}/pending-rollback.json`;

export type PendingRollback = {
  schemaVersion: 1;
  channelName: string;
  currentHash: string | null;
  runtimeVersion: string | null;
  reason?: string;
};

export async function readPendingRollback(): Promise<PendingRollback | null> {
  try {
    if (!await RNFS.exists(PENDING_ROLLBACK_PATH)) return null;
    const value = JSON.parse(await RNFS.readFile(PENDING_ROLLBACK_PATH, 'utf8'));
    if (
      value?.schemaVersion !== 1 ||
      typeof value.channelName !== 'string' ||
      !(value.currentHash === null ||
        (typeof value.currentHash === 'string' && /^[a-f0-9]{64}$/.test(value.currentHash))) ||
      !(value.runtimeVersion === null || typeof value.runtimeVersion === 'string') ||
      !(value.reason === undefined || typeof value.reason === 'string')
    ) {
      throw new Error('Invalid pending BundleDrop rollback');
    }
    return value;
  } catch (error) {
    console.warn('⚠️ Ignoring unreadable BundleDrop pending rollback:', error);
    return null;
  }
}

export async function stageRollback(channelName: string, reason?: string): Promise<void> {
  const intent: PendingRollback = {
    schemaVersion: 1,
    channelName,
    currentHash: await readCurrentBundleHash(),
    runtimeVersion: runtimeVersion ?? null,
    reason,
  };
  await ensureDir(BUNDLE_DROP_ROOT);
  await atomicWriteJson(PENDING_ROLLBACK_PATH, intent);
}

export async function clearPendingRollback(): Promise<void> {
  if (await RNFS.exists(PENDING_ROLLBACK_PATH)) await RNFS.unlink(PENDING_ROLLBACK_PATH);
}

export async function isPendingRollbackCurrent(
  intent: PendingRollback,
  channelName: string,
): Promise<boolean> {
  return intent.channelName === channelName &&
    intent.runtimeVersion === (runtimeVersion ?? null) &&
    intent.currentHash === await readCurrentBundleHash();
}
