import RNFS from '../native/fs';

import { BUNDLE_DROP_ROOT } from '../context';

const CURRENT_POINTER_PATH = `${BUNDLE_DROP_ROOT}/current.json`;
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/;

async function readPointerHash(path: string): Promise<string | null> {
  try {
    if (!(await RNFS.exists(path))) return null;
    const raw = await RNFS.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!BUNDLE_HASH_PATTERN.test(parsed?.hash ?? '')) return null;
    return parsed.hash;
  } catch {
    return null;
  }
}

export async function readCurrentBundleHash(): Promise<string | null> {
  return readPointerHash(CURRENT_POINTER_PATH);
}
