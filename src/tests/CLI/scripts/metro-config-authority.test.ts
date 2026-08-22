import fs from 'fs';
import path from 'path';

import {
  assertCommonJsMetroConfig,
  findSingleMetroConfig,
  hasAuthoritativeMetroWrapper,
  hasExecutableMetroModuleReference,
  hasExecutableMetroWrapperReference,
  newCommonJsMetroConfigFile,
} from '../../../CLI/scripts/metro-config-authority';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

describe('CLI/scripts/metro-config-authority', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = createTempProjectDir();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('distinguishes executable wrapper and package references from comments and strings', () => {
    expect(hasExecutableMetroWrapperReference('withBundleDrop(config)', 'withBundleDrop')).toBe(true);
    expect(hasExecutableMetroWrapperReference(
      '// withBundleDrop(config)\nconst note = "withBundleDrop(config)";',
      'withBundleDrop',
    )).toBe(false);
    expect(hasExecutableMetroWrapperReference(
      '/* withBundleDrop(config)\n * remains documentation only\n */',
      'withBundleDrop',
    )).toBe(false);
    expect(hasExecutableMetroModuleReference(
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');",
      '@gfean/react-native-bundle-drop/metro',
    )).toBe(true);
    expect(hasExecutableMetroModuleReference(
      "if (false) { require('@gfean/react-native-bundle-drop/metro'); }",
      '@gfean/react-native-bundle-drop/metro',
    )).toBe(false);
    expect(hasExecutableMetroModuleReference(
      "const note = \"require('@gfean/react-native-bundle-drop/metro')\";",
      '@gfean/react-native-bundle-drop/metro',
    )).toBe(false);
    expect(hasExecutableMetroModuleReference(
      "/* require('@gfean/react-native-bundle-drop/metro')\n * documentation only\n */",
      '@gfean/react-native-bundle-drop/metro',
    )).toBe(false);
  });

  it.each([
    [
      'direct object',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop({ resolver: {} });\n',
      'withBundleDrop',
    ],
    [
      'Expo default config',
      "import { withBundleDropExpo } from '@gfean/react-native-bundle-drop/metro';\n" +
        "import { getDefaultConfig } from 'expo/metro-config';\n" +
        'export default withBundleDropExpo(getDefaultConfig(__dirname));\n',
      'withBundleDropExpo',
    ],
    [
      'React Native merge config',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');\n" +
        'module.exports = withBundleDrop(mergeConfig(getDefaultConfig(__dirname), {}));\n',
      'withBundleDrop',
    ],
    [
      'React Native aliased base config',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');\n" +
        'const base = getDefaultConfig(__dirname);\n' +
        'const config = mergeConfig(base, { resolver: {} });\n' +
        'module.exports = withBundleDrop(config);\n',
      'withBundleDrop',
    ],
    [
      'earlier CommonJS export',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = {};\n' +
        'module.exports = withBundleDrop(module.exports);\n',
      'withBundleDrop',
    ],
    [
      'top-level initializer chain',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const base = {};\nconst config = base;\n' +
        'module.exports = withBundleDrop(config, { projectRoot: __dirname });\n',
      'withBundleDrop',
    ],
    [
      'package-managed appended wrapper',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop(module.exports || {}, { projectRoot: __dirname });\n',
      'withBundleDrop',
    ],
  ] as const)('accepts an authoritative %s export', (_label, source, wrapper) => {
    expect(hasAuthoritativeMetroWrapper(source, wrapper)).toBe(true);
  });

  it.each([
    [
      'aliased binding',
      "const { withBundleDrop: other } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop({});\n',
    ],
    [
      'duplicate binding',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        "import { withBundleDrop } from '@gfean/react-native-bundle-drop/metro';\n" +
        'module.exports = withBundleDrop({});\n',
    ],
    [
      'nested export',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'function dead() { module.exports = withBundleDrop({}); }\nmodule.exports = {};\n',
    ],
    [
      'wrapper is not final',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop({});\nmodule.exports = {};\n',
    ],
    [
      'missing base argument',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop();\n',
    ],
    [
      'unsupported base',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = undefined;\nmodule.exports = withBundleDrop(config);\n',
    ],
    [
      'unsupported initializer call',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = createConfig();\nmodule.exports = withBundleDrop(config);\n',
    ],
    [
      'merge config without an imported binding',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop(mergeConfig({}, {}));\n',
    ],
    [
      'unterminated initializer before the final export',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const config = createConfig()module.exports = withBundleDrop(config)',
    ],
    [
      'cyclic initializer',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'const first = second;\nconst second = first;\nmodule.exports = withBundleDrop(first);\n',
    ],
    [
      'trailing executable code',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop({});\nstartServer();\n',
    ],
    [
      'unbalanced wrapper call',
      "const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');\n" +
        'module.exports = withBundleDrop({};\n',
    ],
  ])('rejects %s', (_label, source) => {
    expect(hasAuthoritativeMetroWrapper(source, 'withBundleDrop')).toBe(false);
  });

  it('finds one Metro authority and rejects competing configs', () => {
    expect(findSingleMetroConfig(projectRoot)).toBeUndefined();
    fs.writeFileSync(path.join(projectRoot, 'metro.config.cjs'), 'module.exports = {};\n');
    expect(findSingleMetroConfig(projectRoot)).toBe('metro.config.cjs');
    fs.writeFileSync(path.join(projectRoot, 'metro.config.js'), 'module.exports = {};\n');
    expect(() => findSingleMetroConfig(projectRoot)).toThrow('Multiple Metro config files');
  });

  it('selects and validates CommonJS config filenames from package type', () => {
    expect(newCommonJsMetroConfigFile(projectRoot)).toBe('metro.config.js');
    expect(() => assertCommonJsMetroConfig(projectRoot, 'metro.config.js')).not.toThrow();

    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"type":"module"}\n');
    expect(newCommonJsMetroConfigFile(projectRoot)).toBe('metro.config.cjs');
    expect(() => assertCommonJsMetroConfig(projectRoot, 'metro.config.cjs')).not.toThrow();
    expect(() => assertCommonJsMetroConfig(projectRoot, 'metro.config.js')).toThrow(
      'uses ESM or TypeScript syntax',
    );
    expect(() => assertCommonJsMetroConfig(projectRoot, 'metro.config.mjs')).toThrow(
      'uses ESM or TypeScript syntax',
    );
    expect(() => assertCommonJsMetroConfig(projectRoot, 'metro.config.ts')).toThrow(
      'uses ESM or TypeScript syntax',
    );
  });
});
