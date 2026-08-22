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
    expect(change?.updated).toContain("require('@gfean/react-native-bundle-drop/metro')");
    expect(change?.updated).toContain('withBundleDrop(config, { projectRoot: __dirname })');
    expect(change?.updated).toContain('getDefaultConfig');
  });

  it('plans the alias without replacing an existing Metro config', () => {
    const metroPath = path.join(projectRoot, 'metro.config.js');
    const original = "module.exports = { resolver: { sourceExts: ['js', 'ts'] } };\n";
    fs.writeFileSync(metroPath, original);

    const change = planBareMetroConfig(projectRoot);

    expect(change?.original).toBe(original);
    expect(change?.updated).toContain("sourceExts: ['js', 'ts']");
    expect(change?.updated).toContain('withBundleDrop(module.exports || {}');
  });

  it('migrates a legacy direct alias', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'metro.config.js'),
      "module.exports = { resolver: { extraNodeModules: { 'bundle-drop-config': true } } };\n",
    );

    const change = planBareMetroConfig(projectRoot);
    expect(change?.reason).toContain('Migrate the legacy');
    expect(change?.updated).toContain('withBundleDrop(module.exports || {}');
  });

  it('does not plan a duplicate package wrapper', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'metro.config.js'),
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\nmodule.exports = withBundleDrop({});\n",
      'utf8',
    );

    expect(planBareMetroConfig(projectRoot)).toBeNull();
  });

  it('uses the single existing CommonJS variant and rejects competing configs', () => {
    fs.writeFileSync(path.join(projectRoot, 'metro.config.cjs'), 'module.exports = {};\n');

    expect(planBareMetroConfig(projectRoot)).toEqual(expect.objectContaining({
      file: 'metro.config.cjs',
    }));

    fs.writeFileSync(path.join(projectRoot, 'metro.config.js'), 'module.exports = {};\n');
    expect(() => planBareMetroConfig(projectRoot)).toThrow('Multiple Metro config files');
  });

  it('ignores wrapper text in comments and strings', () => {
    const metroPath = path.join(projectRoot, 'metro.config.js');
    for (const decoy of [
      '// withBundleDrop(config)\nmodule.exports = config;\n',
      'const note = "withBundleDrop(config)";\nmodule.exports = config;\n',
    ]) {
      fs.writeFileSync(metroPath, decoy);
      const change = planBareMetroConfig(projectRoot);
      expect(change).not.toBeNull();
      expect(change?.updated).toContain('module.exports = withBundleDrop(module.exports || {}');
    }
  });

  it.each([
    [
      'aliased package export',
      "const { withBundleDrop: other } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = {};\nmodule.exports = withBundleDrop(config);\n',
    ],
    [
      'unrelated package export renamed to the wrapper',
      "const { other: withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = {};\nmodule.exports = withBundleDrop(config);\n',
    ],
    [
      'nested dead export',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = {};\nfunction dead() { module.exports = withBundleDrop(config); }\n' +
        'module.exports = config;\n',
    ],
    [
      'zero-argument wrapper',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop();\n',
    ],
    [
      'unsupported base value',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = undefined;\nmodule.exports = withBundleDrop(config);\n',
    ],
  ])('fails closed on a non-authoritative %s', (_label, content) => {
    fs.writeFileSync(path.join(projectRoot, 'metro.config.js'), content);

    expect(() => planBareMetroConfig(projectRoot)).toThrow(
      'contains a non-authoritative withBundleDrop reference',
    );
  });

  it('creates a CommonJS config safely for ESM packages and fails closed on ESM edits', () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
    expect(planBareMetroConfig(projectRoot)?.file).toBe('metro.config.cjs');

    fs.writeFileSync(path.join(projectRoot, 'metro.config.js'), 'export default {};\n');
    expect(() => planBareMetroConfig(projectRoot)).toThrow('will not append CommonJS');
  });
});
