import * as fs from 'fs';
import * as path from 'path';

export function findProjectRoot(startDir: string) {
  let dir = path.resolve(startDir);
  const MAX_UP = 12;

  for (let i = 0; i < MAX_UP; i++) {
    const iosDir = path.join(dir, 'ios');
    const androidDir = path.join(dir, 'android');
    if (fs.existsSync(iosDir) && fs.existsSync(androidDir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}
