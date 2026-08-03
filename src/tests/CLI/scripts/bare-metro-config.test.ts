import fs from 'fs';
import path from 'path';

import { planBareMetroConfig } from '../../../CLI/scripts/bare-metro-config';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

describe('CLI/scripts/bare-metro-config', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = createTempProjectDir();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('plans a complete Metro config when none exists', () => {
    const change = planBareMetroConfig(projectRoot);

    expect(change).toEqual(expect.objectContaining({
      file: 'metro.config.js',
      original: null,
    }));
    expect(change?.updated).toContain(
      "'bundle-drop-config': path.resolve(__dirname, 'bundle.drop.config.js')",
    );
    expect(change?.updated).toContain('getDefaultConfig');
  });

  it('plans the alias without replacing an existing Metro config', () => {
    const metroPath = path.join(projectRoot, 'metro.config.js');
    const original = "module.exports = { resolver: { sourceExts: ['js', 'ts'] } };\n";
    fs.writeFileSync(metroPath, original);

    const change = planBareMetroConfig(projectRoot);

    expect(change?.original).toBe(original);
    expect(change?.updated).toContain("sourceExts: ['js', 'ts']");
    expect(change?.updated).toContain(
      "'bundle-drop-config': path.resolve(__dirname, 'bundle.drop.config.js')",
    );
  });

  it('does not plan a duplicate alias', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'metro.config.js'),
      "module.exports = { resolver: { extraNodeModules: { 'bundle-drop-config': true } } };\n",
    );

    expect(planBareMetroConfig(projectRoot)).toBeNull();
  });
});
