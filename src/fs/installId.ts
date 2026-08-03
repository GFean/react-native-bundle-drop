import RNFS from '../native/fs';

import { BUNDLE_DROP_ROOT } from '../context';
import { ensureDir } from './fsUtils';

function getInstallIdPath() {
  return `${BUNDLE_DROP_ROOT}/install-id.txt`;
}

export async function getOrCreateInstallId(): Promise<string> {
  const path = getInstallIdPath();
  try {
    const existing = await RNFS.readFile(path, 'utf8');
    if (existing?.trim()) return existing.trim();
  } catch {
    // ignore and create a new one
  }

  const id =
    `${Date.now().toString(36)}-` +
    `${Math.random().toString(36).slice(2, 10)}-` +
    `${Math.random().toString(36).slice(2, 10)}`;

  await ensureDir(BUNDLE_DROP_ROOT);
  await RNFS.writeFile(path, id, 'utf8');
  return id;
}
