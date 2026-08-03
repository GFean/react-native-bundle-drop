import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  applyExpoConfigurationChanges,
  hasDynamicExpoConfig,
  planExpoProjectConfiguration,
  restoreExpoConfiguration,
  setBundleDropProjectType,
  setupChangeHash,
  type ExpoSetupFileChange,
} from '../../../../CLI/scripts/expo/configure-expo';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

const digest = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

describe('CLI/scripts/expo/configure-expo', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = createTempProjectDir();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  const write = (file: string, content: string) => {
    const filePath = path.join(projectRoot, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  const writeStandardBundleConfig = () => write(
    'bundle.drop.config.js',
    `module.exports = {
  runtimeVersion: { ios: '1', android: '1' },
  serverUrl: 'https://api.bundledrop.app',
};
`,
  );

  it('plans a complete explicit Expo Updates migration and is idempotent after apply', () => {
    write(
      'app.json',
      `${JSON.stringify({
        expo: {
          plugins: [
            'expo-router',
            ['@gfean/react-native-bundle-drop', { stale: true }],
            'expo-updates',
          ],
          updates: {
            url: 'https://u.expo.dev/project',
            enabled: true,
            checkAutomatically: 'ON_LOAD',
          },
        },
      }, null, 2)}\n`,
    );
    write(
      'package.json',
      `${JSON.stringify({
        dependencies: { expo: '57.0.0', 'expo-updates': '1.0.0' },
        devDependencies: { 'expo-updates': '1.0.0' },
        optionalDependencies: { 'expo-updates': '1.0.0' },
        peerDependencies: { 'expo-updates': '1.0.0' },
      }, null, 2)}\n`,
    );
    write(
      'metro.config.js',
      "const { getDefaultConfig } = require('expo/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n",
    );
    write('.gitignore', 'node_modules\n');
    writeStandardBundleConfig();

    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: true });
    expect(changes.map(change => change.file)).toEqual([
      'app.json',
      'metro.config.js',
      'bundle.drop.config.js',
      'package.json',
      '.gitignore',
    ]);
    expect(changes.find(change => change.file === 'metro.config.js')?.updated).toContain(
      "require('expo/metro-config')",
    );
    expect(changes.find(change => change.file === 'metro.config.js')?.updated).toContain(
      'withBundleDropExpo',
    );

    applyExpoConfigurationChanges({ projectRoot, changes });

    const app = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8')).expo;
    expect(app.plugins).toEqual(['expo-router', '@gfean/react-native-bundle-drop']);
    expect(app).not.toHaveProperty('runtimeVersion');
    expect(app.updates).toEqual({ checkAutomatically: 'ON_LOAD' });
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    expect([
      pkg.dependencies,
      pkg.devDependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies,
    ].some(group => group?.['expo-updates'])).toBe(false);
    expect(fs.readFileSync(path.join(projectRoot, 'bundle.drop.config.js'), 'utf8')).toContain(
      "runtimeVersion: { ios: '1', android: '1' }",
    );
    expect(fs.readFileSync(path.join(projectRoot, 'bundle.drop.config.js'), 'utf8')).toContain(
      "projectType: 'expo'",
    );
    expect(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8')).toBe(
      'node_modules\n.bundle-drop/\n',
    );
    expect(fs.existsSync(path.join(projectRoot, '.fingerprintignore'))).toBe(false);
    expect(planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: true })).toEqual([]);
  });

  it('registers the plugin once without removing Expo Updates when migration is declined', () => {
    const originalPackage = `${JSON.stringify({
      dependencies: { expo: '56.0.0', 'expo-updates': '1.0.0' },
    }, null, 2)}\n`;
    write('package.json', originalPackage);
    write('app.json', JSON.stringify({
      expo: {
        plugins: ['expo-updates'],
        updates: { url: 'https://u.expo.dev/project', enabled: true },
      },
    }));
    writeStandardBundleConfig();

    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });
    const appChange = changes.find(change => change.file === 'app.json');

    expect(JSON.parse(appChange!.updated).expo).toEqual(expect.objectContaining({
      plugins: ['expo-updates', '@gfean/react-native-bundle-drop'],
      updates: { url: 'https://u.expo.dev/project', enabled: true },
    }));
    expect(JSON.parse(appChange!.updated).expo).not.toHaveProperty('runtimeVersion');
    expect(changes.find(change => change.file === 'package.json')).toBeUndefined();
    expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe(originalPackage);
  });

  it('drops empty migrated Updates configuration and preserves unrelated plugin entries', () => {
    write('package.json', '{"dependencies":{"expo-updates":"1.0.0"}}');
    write('app.json', JSON.stringify({
      expo: {
        plugins: [null, {}, ['expo-camera', { cameraPermission: 'Camera' }], 'expo-updates'],
        updates: { url: 'https://u.expo.dev/project', enabled: true },
      },
    }));
    writeStandardBundleConfig();

    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: true });
    const app = JSON.parse(changes.find(change => change.file === 'app.json')!.updated).expo;

    expect(app.plugins).toEqual([
      null,
      {},
      ['expo-camera', { cameraPermission: 'Camera' }],
      '@gfean/react-native-bundle-drop',
    ]);
    expect(app).not.toHaveProperty('updates');
  });

  it('supports root-style app.json and creates missing Metro and gitignore files', () => {
    write('package.json', '{"dependencies":{"expo":"55.0.0"}}');
    write('app.json', '{"name":"Demo"}');
    write(
      'bundle.drop.config.js',
      "module.exports = { runtimeVersion: { source: 'expo' } };\n",
    );

    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });
    const app = JSON.parse(changes.find(change => change.file === 'app.json')!.updated);
    const metro = changes.find(change => change.file === 'metro.config.js');
    const fingerprintIgnore = changes.find(change => change.file === '.fingerprintignore');
    const gitignore = changes.find(change => change.file === '.gitignore');

    expect(app.plugins).toEqual(['@gfean/react-native-bundle-drop']);
    expect(app).not.toHaveProperty('runtimeVersion');
    expect(metro).toEqual(expect.objectContaining({ original: null }));
    expect(metro?.updated).toContain("getDefaultConfig } = require('expo/metro-config')");
    expect(fingerprintIgnore).toEqual(expect.objectContaining({
      original: null,
      updated: '**/*-gradle-plugin/.kotlin/**/*\n',
    }));
    expect(gitignore).toEqual(expect.objectContaining({ original: null, updated: '.bundle-drop/\n' }));
  });

  it('preserves an existing Expo runtime policy', () => {
    write('package.json', '{"dependencies":{"expo":"57.0.0"}}');
    write('app.json', JSON.stringify({
      expo: {
        runtimeVersion: { policy: 'appVersion' },
        plugins: [],
      },
    }));
    writeStandardBundleConfig();

    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });
    const app = JSON.parse(changes.find(change => change.file === 'app.json')!.updated).expo;

    expect(app.runtimeVersion).toEqual({ policy: 'appVersion' });
  });

  it('preserves a platform-specific Expo runtime without adding a fallback', () => {
    write('package.json', '{"dependencies":{"expo":"57.0.0"}}');
    write('app.json', JSON.stringify({
      expo: {
        ios: { runtimeVersion: 'ios-runtime' },
        plugins: [],
      },
    }));
    writeStandardBundleConfig();

    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });
    const app = JSON.parse(changes.find(change => change.file === 'app.json')!.updated).expo;

    expect(app.ios.runtimeVersion).toBe('ios-runtime');
    expect(app).not.toHaveProperty('runtimeVersion');
  });

  it('preserves existing Expo fingerprint exclusions and adds the transient Kotlin pattern once', () => {
    write('package.json', '{"dependencies":{"expo":"55.0.0"}}');
    write('app.json', '{"expo":{}}');
    write('.fingerprintignore', 'ios/generated/**/*\n');
    write(
      'bundle.drop.config.js',
      "module.exports = { runtimeVersion: { source: 'expo' } };\n",
    );

    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });
    const fingerprintChange = changes.find(change => change.file === '.fingerprintignore');

    expect(fingerprintChange).toEqual(expect.objectContaining({
      original: 'ios/generated/**/*\n',
      updated: 'ios/generated/**/*\n**/*-gradle-plugin/.kotlin/**/*\n',
    }));

    applyExpoConfigurationChanges({ projectRoot, changes });
    expect(planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false })).toEqual([]);
  });

  it.each(['app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs'])(
    'detects dynamic config %s and leaves it for the bounded AI setup path',
    configFile => {
      write('package.json', '{"dependencies":{"expo":"57.0.0"}}');
      write(configFile, 'module.exports = ({ config }) => config;');
      write('app.json', '{"expo":{"plugins":[]}}');
      writeStandardBundleConfig();

      expect(hasDynamicExpoConfig(projectRoot)).toBe(true);
      const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });
      expect(changes.map(change => change.file)).not.toContain('app.json');
      expect(changes.map(change => change.file)).not.toContain(configFile);
    },
  );

  it('reports no dynamic config for a static app.json project', () => {
    write('app.json', '{"expo":{}}');
    expect(hasDynamicExpoConfig(projectRoot)).toBe(false);
  });

  it('preserves an unusual Bundle Drop runtime config while persisting Expo project type', () => {
    write('package.json', '{}');
    write('app.json', '{"expo":{}}');
    write('bundle.drop.config.js', "module.exports = { runtimeVersion: 'unstructured' };\n");

    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });
    expect(changes.find(change => change.file === 'bundle.drop.config.js')).toEqual(
      expect.objectContaining({
        updated: expect.stringContaining("projectType: 'expo'"),
      }),
    );
  });

  it('requires a real or previewed Bundle Drop config before planning', () => {
    write('package.json', '{}');
    write('app.json', '{"expo":{}}');

    expect(() => planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false }))
      .toThrow('bundle.drop.config.js is required');
  });

  it('can plan creation from previewed Bundle Drop config without requiring a prior write', () => {
    write('package.json', '{}');
    write('app.config.js', 'module.exports = {};');
    const previewConfig = `module.exports = {
      runtimeVersion: { ios: '1', android: '1' },
      serverUrl: 'https://api.bundledrop.app',
    };\n`;

    const changes = planExpoProjectConfiguration({
      projectRoot,
      migrateExpoUpdates: false,
      bundleConfigContent: previewConfig,
    });
    const bundleChange = changes.find(change => change.file === 'bundle.drop.config.js');

    expect(bundleChange).toEqual(expect.objectContaining({
      original: null,
      updated: expect.stringContaining("runtimeVersion: { ios: '1', android: '1' }"),
    }));
    expect(bundleChange?.updated).toContain("projectType: 'expo'");
    expect(fs.existsSync(path.join(projectRoot, 'bundle.drop.config.js'))).toBe(false);
  });

  it('creates a previewed config that already uses Expo runtime identity', () => {
    write('package.json', '{}');
    write('app.config.js', 'module.exports = {};');
    const previewConfig = `module.exports = {
      runtimeVersion: { source: 'expo' },
      serverUrl: 'https://api.bundledrop.app',
    };\n`;

    const changes = planExpoProjectConfiguration({
      projectRoot,
      migrateExpoUpdates: false,
      bundleConfigContent: previewConfig,
    });

    expect(changes.find(change => change.file === 'bundle.drop.config.js')).toEqual(
      expect.objectContaining({
        original: null,
        updated: expect.stringContaining("projectType: 'expo'"),
      }),
    );
  });

  it('writes project type markers deterministically and updates an explicit choice', () => {
    const original = `module.exports = {
  runtimeVersion: { ios: '1', android: '1' },
};
`;
    const bare = setBundleDropProjectType(original, 'bare');

    expect(bare).toContain("projectType: 'bare'");
    expect(setBundleDropProjectType(bare, 'bare')).toBe(bare);
    expect(setBundleDropProjectType(bare, 'expo')).toBe(
      bare.replace("projectType: 'bare'", "projectType: 'expo'"),
    );
  });

  it('backs up existing files and removes newly created files when explicitly restored', () => {
    write('package.json', '{}');
    write('app.config.js', 'module.exports = {};');
    const bundlePath = writeStandardBundleConfig();
    const originalBundle = fs.readFileSync(bundlePath, 'utf8');
    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });

    const result = applyExpoConfigurationChanges({ projectRoot, changes });
    expect(fs.existsSync(path.join(projectRoot, 'metro.config.js'))).toBe(true);
    expect(fs.readFileSync(bundlePath, 'utf8')).not.toBe(originalBundle);

    restoreExpoConfiguration(result);
    expect(fs.existsSync(path.join(projectRoot, 'metro.config.js'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.fingerprintignore'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.gitignore'))).toBe(false);
    expect(fs.readFileSync(bundlePath, 'utf8')).toBe(originalBundle);
  });

  it('archives and invalidates the native build receipt until setup is rolled back', () => {
    const receipt = '{"schemaVersion":2,"proof":"old-build"}\n';
    const receiptPath = write('.bundle-drop/build-identity.json', receipt);

    const result = applyExpoConfigurationChanges({ projectRoot, changes: [] });

    expect(result.buildReceiptInvalidated).toBe(true);
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(fs.readFileSync(
      path.join(result.backupDir, '.bundle-drop/build-identity.json'),
      'utf8',
    )).toBe(receipt);

    restoreExpoConfiguration(result);
    expect(fs.readFileSync(receiptPath, 'utf8')).toBe(receipt);
  });

  it('rolls back earlier existing and newly created changes after a later stale preview', () => {
    write('package.json', '{}');
    write('app.config.js', 'module.exports = {};');
    const originalBundle = fs.readFileSync(writeStandardBundleConfig(), 'utf8');
    const receipt = '{"schemaVersion":2,"proof":"before-setup"}\n';
    const receiptPath = write('.bundle-drop/build-identity.json', receipt);
    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });
    fs.writeFileSync(path.join(projectRoot, 'bundle.drop.config.js'), 'changed after preview');

    expect(() => applyExpoConfigurationChanges({ projectRoot, changes })).toThrow(
      'File changed since Expo setup preview',
    );
    expect(fs.existsSync(path.join(projectRoot, 'metro.config.js'))).toBe(false);
    expect(fs.readFileSync(path.join(projectRoot, 'bundle.drop.config.js'), 'utf8')).toBe(
      'changed after preview',
    );
    expect(fs.readFileSync(receiptPath, 'utf8')).toBe(receipt);
    expect(originalBundle).toContain("runtimeVersion: { ios: '1', android: '1' }");
  });

  it('rejects traversal, absolute paths, backslashes, and existence changes', () => {
    const unsafeChanges = ['../app.json', '/tmp/app.json', 'nested\\app.json'].map(file => ({
      file,
      original: null,
      updated: '{}',
      reason: 'unsafe',
    }));
    for (const change of unsafeChanges) {
      expect(() => applyExpoConfigurationChanges({ projectRoot, changes: [change] }))
        .toThrow('outside the Expo setup allowlist');
    }

    write('app.json', '{}');
    const appeared: ExpoSetupFileChange = {
      file: 'app.json',
      original: null,
      updated: '{"expo":{}}',
      reason: 'previewed absent',
    };
    expect(() => applyExpoConfigurationChanges({ projectRoot, changes: [appeared] }))
      .toThrow('File existence changed since Expo setup preview');

    const disappeared: ExpoSetupFileChange = {
      file: 'metro.config.js',
      original: 'module.exports = {};',
      updated: 'module.exports = withBundleDropExpo({});',
      reason: 'previewed present',
    };
    expect(() => applyExpoConfigurationChanges({ projectRoot, changes: [disappeared] }))
      .toThrow('File existence changed since Expo setup preview');
  });

  it('hashes the exact original preview content and treats a new file as empty', () => {
    expect(setupChangeHash({ file: 'app.json', original: 'abc', updated: 'def', reason: 'x' }))
      .toBe(digest('abc'));
    expect(setupChangeHash({ file: 'app.json', original: null, updated: '{}', reason: 'x' }))
      .toBe(digest(''));
  });

  it('applies a preview against an existing empty allowlisted file', () => {
    write('package.json', '{}');
    write('app.config.js', 'module.exports = {};');
    writeStandardBundleConfig();
    write('.gitignore', '');
    const changes = planExpoProjectConfiguration({ projectRoot, migrateExpoUpdates: false });

    expect(() => applyExpoConfigurationChanges({ projectRoot, changes })).not.toThrow();
    expect(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8')).toBe('.bundle-drop/\n');
  });
});
