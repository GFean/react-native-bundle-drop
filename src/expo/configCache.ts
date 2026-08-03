import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const dynamicExpoConfigExtensions = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'];

export function clearDynamicExpoConfigCache(projectRoot: string): void {
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  for (const extension of dynamicExpoConfigExtensions) {
    const configPath = path.join(projectRoot, `app.config.${extension}`);
    delete projectRequire.cache[configPath];
    if (fs.existsSync(configPath)) {
      delete projectRequire.cache[fs.realpathSync(configPath)];
    }
  }
}
