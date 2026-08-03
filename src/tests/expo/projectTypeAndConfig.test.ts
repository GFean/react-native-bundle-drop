import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  detectProjectType,
  evaluateExpoConfig,
  ExpoIntegrationError,
} from '../../expo';
import { setBundleDropProjectType } from '../../expo/projectType';
import {
  loadExpoDependency,
  loadProjectModule,
  resolveExpoDependency,
  resolveProjectModule,
} from '../../expo/localModules';
import {
  createExpoFixture,
  removeFixture,
  writeExpoConfigModule,
} from './fixture';
import { initConfig } from '../../CLI/scripts/init-config';

describe('Expo project detection and project-local module loading', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      removeFixture(root);
    }
  });

  const fixture = (...args: Parameters<typeof createExpoFixture>): string => {
    const root = createExpoFixture(...args);
    roots.push(root);
    return root;
  };

  it('honors explicit overrides after proving their local prerequisites', () => {
    const root = fixture();
    expect(detectProjectType({ projectRoot: root, explicitType: 'expo' })).toBe('expo');
    expect(detectProjectType({ projectRoot: root, explicitType: 'bare' })).toBe('bare');
    expect(() =>
      detectProjectType({ projectRoot: root, explicitType: 'unknown' as 'expo' }),
    ).toThrow('Unsupported explicit project type');
  });

  it('fails closed when an explicit override cannot be proven', () => {
    const missingRoot = path.join(os.tmpdir(), `bundle-drop-explicit-missing-${Date.now()}`);
    expect(() => detectProjectType({ projectRoot: missingRoot, explicitType: 'expo' })).toThrow(
      'requires a project-local Expo installation',
    );
    expect(() => detectProjectType({ projectRoot: missingRoot, explicitType: 'bare' })).toThrow(
      'requires a project-local React Native installation',
    );

    const invalidExpoRoot = fixture();
    writeExpoConfigModule(
      invalidExpoRoot,
      `exports.getConfig = () => { throw new Error('invalid'); };`,
    );
    expect(() =>
      detectProjectType({ projectRoot: invalidExpoRoot, explicitType: 'expo' }),
    ).toThrow('requires an Expo config that can be evaluated');
  });

  it('detects Expo from resolvable Expo plus evaluated config regardless of native folders', () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, 'ios'));
    fs.mkdirSync(path.join(root, 'android'));
    expect(detectProjectType({ projectRoot: root })).toBe('expo');
  });

  it('fails closed when a bare app installs Expo modules without an Expo project signal', () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'app.json'),
      JSON.stringify({ name: 'BareApp', displayName: 'Bare app' }),
    );
    writeExpoConfigModule(
      root,
      `exports.getConfig = root => ({
        exp: { name: 'Bare app', slug: 'bare-app' },
        pkg: require(root + '/package.json'),
        dynamicConfigPath: null,
        staticConfigPath: root + '/app.json'
      });`,
    );

    expect(() => detectProjectType({ projectRoot: root })).toThrow(
      'This is ambiguous because bare React Native apps may install Expo modules',
    );
    expect(detectProjectType({ projectRoot: root, explicitType: 'bare' })).toBe('bare');
  });

  it('detects Expo from an app.json with an explicit Expo configuration root', () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'app.json'),
      JSON.stringify({ expo: { name: 'Expo app', slug: 'expo-app' } }),
    );
    writeExpoConfigModule(
      root,
      `exports.getConfig = root => ({
        exp: { name: 'Expo app', slug: 'expo-app' },
        pkg: require(root + '/package.json'),
        dynamicConfigPath: null,
        staticConfigPath: root + '/app.json'
      });`,
    );

    expect(detectProjectType({ projectRoot: root })).toBe('expo');
  });

  it('detects Expo from an evaluated Bundle Drop plugin when config paths are unavailable', () => {
    const root = fixture();
    writeExpoConfigModule(
      root,
      `exports.getConfig = root => ({
        exp: { plugins: [['@gfean/react-native-bundle-drop', { enabled: true }]] },
        pkg: require(root + '/package.json'),
        dynamicConfigPath: null,
        staticConfigPath: null
      });`,
    );

    expect(detectProjectType({ projectRoot: root })).toBe('expo');
  });

  it('recognizes the Bundle Drop plugin in its string shorthand', () => {
    const root = fixture();
    writeExpoConfigModule(
      root,
      `exports.getConfig = root => ({
        exp: { plugins: ['@gfean/react-native-bundle-drop'] },
        pkg: require(root + '/package.json'),
        dynamicConfigPath: null,
        staticConfigPath: null
      });`,
    );

    expect(detectProjectType({ projectRoot: root })).toBe('expo');
  });

  it('detects Expo from the explicit Bundle Drop Expo runtime source', () => {
    const root = fixture();
    writeExpoConfigModule(
      root,
      `exports.getConfig = root => ({
        exp: {},
        pkg: require(root + '/package.json'),
        dynamicConfigPath: null,
        staticConfigPath: null
      });`,
    );
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      `module.exports = { runtimeVersion: { source: 'expo' } };`,
    );

    expect(detectProjectType({ projectRoot: root })).toBe('expo');
  });

  it('keeps the generated bare Bundle Drop config authoritative when Expo modules are installed', async () => {
    const root = fixture();
    fs.unlinkSync(path.join(root, 'bundle.drop.config.js'));
    writeExpoConfigModule(
      root,
      `exports.getConfig = root => ({
        exp: { name: 'Bare app', slug: 'bare-app' },
        pkg: require(root + '/package.json'),
        dynamicConfigPath: null,
        staticConfigPath: null
      });`,
    );
    const originalCwd = process.cwd();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.chdir(root);
      await initConfig({
        serverUrl: 'https://api.example.com',
        organizations: [],
        projects: [],
      });
    } finally {
      process.chdir(originalCwd);
      consoleSpy.mockRestore();
    }

    expect(fs.readFileSync(path.join(root, 'bundle.drop.config.js'), 'utf8')).toContain(
      "runtimeVersion: {\n    ios: '1.0.0',\n    android: '1.0.0'",
    );
    expect(detectProjectType({ projectRoot: root })).toBe('bare');
  });

  it('keeps a freshly generated Expo config unambiguous', async () => {
    const root = fixture();
    fs.unlinkSync(path.join(root, 'bundle.drop.config.js'));
    const originalCwd = process.cwd();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.chdir(root);
      await initConfig({
        serverUrl: 'https://api.example.com',
        organizations: [],
        projects: [],
        projectType: 'expo',
      });
    } finally {
      process.chdir(originalCwd);
      consoleSpy.mockRestore();
    }

    const config = fs.readFileSync(path.join(root, 'bundle.drop.config.js'), 'utf8');
    expect(config).toContain("projectType: 'expo'");
    expect(config).toContain("ios: '1.0.0'");
    expect(config).toContain("android: '1.0.0'");
    expect(config).not.toContain("runtimeVersion: { source: 'expo' }");
    expect(detectProjectType({ projectRoot: root })).toBe('expo');
  });

  it('fails closed when generated bare runtime config conflicts with Expo project signals', () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      `module.exports = {
        runtimeVersion: {
          ios: '1.0.0',
          android: '1.0.0',
        },
      };`,
    );

    expect(() => detectProjectType({ projectRoot: root })).toThrow(
      'conflicting Expo and bare Bundle Drop configuration signals',
    );
    expect(detectProjectType({ projectRoot: root, explicitType: 'expo' })).toBe('expo');
    expect(detectProjectType({ projectRoot: root, explicitType: 'bare' })).toBe('bare');
  });

  it('honors a persisted bare setup choice over Expo Modules app configuration', () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      `module.exports = {
        projectType: 'bare',
        runtimeVersion: { ios: '1.0.0', android: '1.0.0' },
      };`,
    );

    expect(detectProjectType({ projectRoot: root })).toBe('bare');
  });

  it('honors a persisted Expo setup choice over legacy bare runtime configuration', () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      `module.exports = {
        projectType: 'expo',
        runtimeVersion: { ios: '1.0.0', android: '1.0.0' },
      };`,
    );

    expect(detectProjectType({ projectRoot: root })).toBe('expo');
  });

  it('fails closed for invalid or duplicated persisted project type markers', () => {
    const root = fixture();
    const configPath = path.join(root, 'bundle.drop.config.js');
    fs.writeFileSync(
      configPath,
      `module.exports = { projectType: 'managed', runtimeVersion: { ios: '1', android: '1' } };`,
    );
    expect(() => detectProjectType({ projectRoot: root })).toThrow(
      'Unsupported bundle.drop.config.js projectType marker',
    );

    fs.writeFileSync(
      configPath,
      `module.exports = {
        projectType: 'bare',
        projectType: 'expo',
        runtimeVersion: { ios: '1', android: '1' },
      };`,
    );
    expect(() => detectProjectType({ projectRoot: root })).toThrow(
      'contains multiple projectType markers',
    );
  });

  it('persists one project type marker without changing unrelated config formatting', () => {
    const unmarked = `module.exports = {\r\n  runtimeVersion: { ios: '1', android: '1' },\r\n};\r\n`;
    const marked = setBundleDropProjectType(unmarked, 'bare');
    expect(marked).toBe(
      `module.exports = {\r\n  projectType: 'bare',\r\n  runtimeVersion: { ios: '1', android: '1' },\r\n};\r\n`,
    );
    expect(setBundleDropProjectType(marked, 'bare')).toBe(marked);
    expect(setBundleDropProjectType(marked, 'expo')).toContain("projectType: 'expo'");
  });

  it('refuses unsafe or ambiguous project type marker edits', () => {
    expect(() => setBundleDropProjectType(
      `module.exports = { projectType: 'bare', projectType: 'expo' };`,
      'bare',
    )).toThrow('contains multiple projectType markers');
    expect(() => setBundleDropProjectType(
      `module.exports = { projectType: 'managed' };`,
      'bare',
    )).toThrow('Unsupported bundle.drop.config.js projectType marker');
    expect(() => setBundleDropProjectType(`export default {};`, 'expo')).toThrow(
      'Could not safely persist projectType',
    );
  });

  it('ignores an unreadable static config instead of treating it as an Expo signal', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'app.json'), '{invalid');
    writeExpoConfigModule(
      root,
      `exports.getConfig = root => ({
        exp: { name: 'Ambiguous app', slug: 'ambiguous-app' },
        pkg: require(root + '/package.json'),
        dynamicConfigPath: null,
        staticConfigPath: root + '/app.json'
      });`,
    );

    expect(() => detectProjectType({ projectRoot: root })).toThrow(
      'This is ambiguous because bare React Native apps may install Expo modules',
    );
  });

  it('requires persisted project type prerequisites to remain usable', () => {
    const missingBareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-persisted-bare-'));
    roots.push(missingBareRoot);
    fs.writeFileSync(
      path.join(missingBareRoot, 'bundle.drop.config.js'),
      `module.exports = { projectType: 'bare' };`,
    );
    expect(() => detectProjectType({ projectRoot: missingBareRoot })).toThrow(
      'persisted bare project type requires a project-local React Native installation',
    );

    const missingExpoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-persisted-expo-'));
    roots.push(missingExpoRoot);
    fs.writeFileSync(
      path.join(missingExpoRoot, 'bundle.drop.config.js'),
      `module.exports = { projectType: 'expo' };`,
    );
    expect(() => detectProjectType({ projectRoot: missingExpoRoot })).toThrow(
      'persisted Expo project type requires a project-local Expo installation',
    );

    const invalidExpoRoot = fixture();
    fs.writeFileSync(
      path.join(invalidExpoRoot, 'bundle.drop.config.js'),
      `module.exports = { projectType: 'expo' };`,
    );
    writeExpoConfigModule(
      invalidExpoRoot,
      `exports.getConfig = () => { throw new Error('invalid persisted Expo config'); };`,
    );
    expect(() => detectProjectType({ projectRoot: invalidExpoRoot })).toThrow(
      'persisted Expo project type requires an Expo config that can be evaluated',
    );
  });

  it('fails closed when Expo is installed but its config cannot be evaluated', () => {
    const root = fixture();
    writeExpoConfigModule(root, `exports.getConfig = () => { throw new Error('bad config'); };`);
    expect(() => detectProjectType({ projectRoot: root })).toThrow(
      'Bundle Drop will not guess that this is a bare project',
    );
  });

  it('detects a pure bare React Native project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-bare-test-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bare' }));
    const rnDirectory = path.join(root, 'node_modules', 'react-native');
    fs.mkdirSync(rnDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(rnDirectory, 'package.json'),
      JSON.stringify({ name: 'react-native', version: '0.86.0' }),
    );
    expect(detectProjectType({ projectRoot: root })).toBe('bare');
  });

  it('fails closed when Expo is declared but dependencies are incomplete', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-declared-expo-test-'));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { expo: '~57.0.0', 'react-native': '0.86.0' } }),
    );
    const rnDirectory = path.join(root, 'node_modules', 'react-native');
    fs.mkdirSync(rnDirectory, { recursive: true });
    fs.writeFileSync(path.join(rnDirectory, 'package.json'), JSON.stringify({ version: '0.86.0' }));
    expect(() => detectProjectType({ projectRoot: root })).toThrow(
      'declares Expo, but the project-local Expo package is not resolvable',
    );
  });

  it('does not treat an uninstalled optional Expo peer as an Expo app signal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-optional-expo-peer-test-'));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        peerDependencies: { expo: '>=54', 'react-native': '>=0.71' },
        peerDependenciesMeta: { expo: { optional: true } },
      }),
    );
    const rnDirectory = path.join(root, 'node_modules', 'react-native');
    fs.mkdirSync(rnDirectory, { recursive: true });
    fs.writeFileSync(path.join(rnDirectory, 'package.json'), JSON.stringify({ version: '0.86.0' }));
    expect(detectProjectType({ projectRoot: root })).toBe('bare');
  });

  it('fails when neither Expo nor React Native can be resolved', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-unknown-test-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'unknown' }));
    expect(() => detectProjectType({ projectRoot: root })).toThrow(
      'Could not determine the project type',
    );
  });

  it('fails closed when the project manifest cannot be parsed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-bad-manifest-test-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{bad');
    expect(() => detectProjectType({ projectRoot: root })).toThrow(
      'Could not determine the project type',
    );
  });

  it('evaluates dynamic config through the project-local official API', () => {
    const root = fixture();
    const evaluated = evaluateExpoConfig(root);
    expect(evaluated.exp.runtimeVersion).toBe('runtime-literal');
    expect(evaluated.pkg.name).toBe('fixture');
    expect(evaluated.dynamicConfigPath).toBe(path.join(root, 'app.config.js'));
  });

  it.each([
    [`exports.getConfig = null;`, 'does not export getConfig'],
    [`exports.getConfig = () => ({ exp: null, pkg: {} });`, 'did not contain an Expo config'],
    [`exports.getConfig = () => ({ exp: {}, pkg: null });`, 'did not contain the project package'],
  ])('rejects incompatible config API result: %s', (source, message) => {
    const root = fixture();
    writeExpoConfigModule(root, source);
    expect(() => evaluateExpoConfig(root)).toThrow(message);
  });

  it('reports a missing project-local Expo config API', () => {
    const root = fixture({ omitExpoConfig: true });
    expect(() => evaluateExpoConfig(root)).toThrow('project-local @expo/config API is unavailable');
  });

  it('loads and resolves modules only from the project and Expo dependency graph', () => {
    const root = fixture();
    expect(resolveProjectModule(root, 'expo/package.json')).toContain('node_modules/expo/package.json');
    expect(loadProjectModule<{ version: string }>(root, 'expo/package.json').version).toBe('55.0.0');
    expect(resolveExpoDependency(root, '@expo/config')).toContain('@expo/config/index.js');
    expect(typeof loadExpoDependency<{ getConfig: unknown }>(root, '@expo/config').getConfig).toBe(
      'function',
    );
  });

  it('returns actionable project and Expo module resolution errors', () => {
    const missingRoot = path.join(os.tmpdir(), `missing-${Date.now()}`);
    expect(() => resolveProjectModule(missingRoot, 'expo')).toThrow('No package.json');

    const root = fixture();
    expect(() => resolveProjectModule(root, 'not-installed')).toThrow('Could not resolve not-installed');
    expect(() => resolveExpoDependency(root, 'not-in-expo')).toThrow(
      'project-local Expo installation could not resolve',
    );
    expect(() => loadProjectModule(root, 'not-installed')).toThrow(ExpoIntegrationError);
  });
});
