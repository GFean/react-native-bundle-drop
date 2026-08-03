import RNFS from '../native/fs';

import { BUNDLE_DROP_ROOT } from '../context';
import { atomicWriteJson, ensureDir } from './fsUtils';

export type BundlePointer = {
  hash: string;
  bundlePath: string;
  updatedAt: string;
};

const CURRENT_POINTER_PATH = `${BUNDLE_DROP_ROOT}/current.json`;
const PREVIOUS_POINTER_PATH = `${BUNDLE_DROP_ROOT}/previous.json`;
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/;

const bundlePathForHash = (hash: string) => `${BUNDLE_DROP_ROOT}/bundles/${hash}/main.jsbundle`;

async function readPointer(path: string): Promise<BundlePointer | null> {
  try {
    if (!(await RNFS.exists(path))) return null;
    const raw = await RNFS.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!BUNDLE_HASH_PATTERN.test(parsed?.hash ?? '')) return null;
    return {
      hash: parsed.hash,
      bundlePath: bundlePathForHash(parsed.hash),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export async function readCurrentBundlePointer(): Promise<BundlePointer | null> {
  return readPointer(CURRENT_POINTER_PATH);
}

export async function readPreviousBundlePointer(): Promise<BundlePointer | null> {
  return readPointer(PREVIOUS_POINTER_PATH);
}

export async function writeCurrentBundlePointer(pointer: BundlePointer): Promise<void> {
  assertCanonicalPointerHash(pointer.hash);
  const root = BUNDLE_DROP_ROOT;
  await ensureDir(root);
  await atomicWriteJson(CURRENT_POINTER_PATH, pointerJson(pointer));
}

export async function writePreviousBundlePointer(pointer: BundlePointer): Promise<void> {
  assertCanonicalPointerHash(pointer.hash);
  const root = BUNDLE_DROP_ROOT;
  await ensureDir(root);
  await atomicWriteJson(PREVIOUS_POINTER_PATH, pointerJson(pointer));
}

export async function restorePreviousBundlePointer(pointer: BundlePointer | null): Promise<void> {
  if (pointer) {
    await writePreviousBundlePointer({ ...pointer, updatedAt: new Date().toISOString() });
    return;
  }

  await deletePreviousBundlePointer();
}

export async function setCurrentBundlePointer(
  _bundlePath: string,
  hash: string,
  options?: { setPrevious?: boolean },
) {
  assertCanonicalPointerHash(hash);
  const root = BUNDLE_DROP_ROOT;
  await ensureDir(root);

  const current = await readCurrentBundlePointer();
  if (options?.setPrevious !== false && current?.hash && current?.bundlePath) {
    await writePreviousBundlePointer({ ...current, updatedAt: new Date().toISOString() });
  }

  await writeCurrentBundlePointer({
    hash,
    bundlePath: bundlePathForHash(hash),
    updatedAt: new Date().toISOString(),
  });
}

function pointerJson(pointer: BundlePointer) {
  return {
    hash: pointer.hash,
    updatedAt: pointer.updatedAt,
  };
}

function assertCanonicalPointerHash(hash: string) {
  if (!BUNDLE_HASH_PATTERN.test(hash)) {
    throw new Error('Bundle pointer hash must be a canonical 64-character lowercase SHA-256 hash');
  }
}

export async function rollbackToPreviousPointer(): Promise<BundlePointer | null> {
  const previous = await readPreviousBundlePointer();
  if (!previous) return null;
  await writeCurrentBundlePointer({ ...previous, updatedAt: new Date().toISOString() });
  return previous;
}

export async function deleteCurrentBundlePointer(): Promise<void> {
  if (await RNFS.exists(CURRENT_POINTER_PATH)) {
    await RNFS.unlink(CURRENT_POINTER_PATH);
  }
}

export async function deletePreviousBundlePointer(): Promise<void> {
  if (await RNFS.exists(PREVIOUS_POINTER_PATH)) {
    await RNFS.unlink(PREVIOUS_POINTER_PATH);
  }
}

export async function clearCurrentBundlePointer(): Promise<void> {
  try {
    await deleteCurrentBundlePointer();
  } catch {
    // Best-effort cleanup for callers that do not need strict rollback semantics.
  }
}
