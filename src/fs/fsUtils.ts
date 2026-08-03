import RNFS from '../native/fs';

export async function cleanOrphanedTempZips(bundlesDir: string): Promise<number> {
  try {
    const entries = await RNFS.readDir(bundlesDir);
    const temps = entries.filter(n =>
      n.startsWith('_tmp_') ||
      n.startsWith('_patch_') ||
      n.startsWith('_patch_target_') ||
      n.startsWith('_patch_assets_')
    );
    await Promise.all(temps.map(name => RNFS.unlink(`${bundlesDir}/${name}`)));
    return temps.length;
  } catch {
    return 0;
  }
}

export async function ensureDir(dir: string) {
  if (!(await RNFS.exists(dir))) {
    await RNFS.mkdir(dir);
  }
}

export async function atomicWriteJson(path: string, data: any) {
  const tmp = `${path}.${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await RNFS.writeFile(tmp, JSON.stringify(data), 'utf8');
    try { await RNFS.unlink(path); } catch { /* already removed by concurrent writer */ }
    await RNFS.moveFile(tmp, path);
  } catch {
    // Atomic rename failed (concurrent writer moved/removed our tmp); fall back to direct write.
    await RNFS.writeFile(path, JSON.stringify(data), 'utf8');
    try { await RNFS.unlink(tmp); } catch { /* clean up orphaned tmp if it exists */ }
  }
}
