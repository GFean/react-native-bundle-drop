import fs from 'fs';
import os from 'os';
import path from 'path';

export const createTempProjectDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-tests-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
  return dir;
};

export const removeTempDir = (dir: string) => {
  fs.rmSync(dir, { recursive: true, force: true });
};
