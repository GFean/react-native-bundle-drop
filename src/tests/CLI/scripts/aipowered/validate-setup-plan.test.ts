import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { AiPatchPlan } from '../../../../CLI/scripts/aipowered/types';
import {
  isPatchableExpoConfig,
  isPatchableNativeEntrypoint,
  validateAppliedSetupChanges,
  validateSetupChangesBeforeApply,
} from '../../../../CLI/scripts/aipowered/validate-plan';
import {
  MODERN_KOTLIN_MAIN_APPLICATION,
  RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
  RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION,
  RN71_KOTLIN_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
  RN71_KOTLIN_MAIN_APPLICATION,
  RN71_KOTLIN_NATIVE_PATHS_MAIN_APPLICATION,
  RN71_OBJC_APP_DELEGATE,
  RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION,
  RN85_SWIFT_APP_DELEGATE,
} from '../../../fixtures/rn85SwiftAppDelegate';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

const hash = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

const patchFor = (file: string, original: string, updated: string): AiPatchPlan => ({
  file,
  originalSha256: hash(original),
  updated,
  reason: 'test',
  confidence: 'high',
  decisionType: isPatchableNativeEntrypoint(file) || file.startsWith('app.config.')
    ? 'review_only_patch'
    : 'safe_auto_patch',
});

const writeAuthoritativeNativeFile = (
  projectRoot: string,
  relativePath: string,
  source: string,
) => {
  let authoritativeSource = source;
  if (
    relativePath.endsWith('AppDelegate.swift') &&
    !/@(?:main|UIApplicationMain)\b/.test(source)
  ) {
    authoritativeSource = source.replace(/\bclass\s+AppDelegate\b/, '@main class AppDelegate');
  }
  const filePath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, authoritativeSource);

  if (relativePath.includes('/MainApplication.')) {
    const packageName = authoritativeSource.match(
      /(?:^|\n)\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/,
    )?.[1] || relativePath.match(/\/(?:java|kotlin)\/(.+)\/MainApplication\./)?.[1]
      ?.replace(/\//g, '.');
    const manifest = path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(
      manifest,
      `<manifest package="${packageName}"><application android:name=".MainApplication" /></manifest>`,
    );
  } else if (/AppDelegate\.m{1,2}$/.test(relativePath)) {
    fs.writeFileSync(
      path.join(path.dirname(filePath), 'main.m'),
      'int main(int argc, char **argv) { return UIApplicationMain(argc, argv, nil, @"AppDelegate"); }',
    );
  }
  return authoritativeSource;
};

const modernPostApplyProbe = (resolver: string, lazyPrefix = '') => [
  'package com.demo',
  'import com.bundledrop.BundleDropModule',
  'class MainApplication: Application(), ReactApplication {',
  `  ${resolver}`,
  '  override val reactHost: ReactHost by lazy {',
  `    ${lazyPrefix}`,
  '    getDefaultReactHost(',
  '      context = applicationContext,',
  '      packages = PackageList(this).packages,',
  '      jsBundleFilePath = getJSBundleFile(),',
  '    )',
  '  }',
  '}',
].join('\n');

describe('CLI/scripts/aipowered/validate-plan setup validation', () => {
  const original = 'module.exports = {};\n';

  it('recognizes only supported Expo config and native entrypoint names', () => {
    for (const file of ['app.json', 'app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs', 'metro.config.js', 'metro.config.ts', 'metro.config.cjs', 'metro.config.mjs']) {
      expect(isPatchableExpoConfig(file)).toBe(true);
    }
    expect(isPatchableExpoConfig('config/app.json')).toBe(false);
    expect(isPatchableExpoConfig('package.json')).toBe(false);
    expect(isPatchableNativeEntrypoint('android/app/src/main/java/demo/MainApplication.java')).toBe(true);
    expect(isPatchableNativeEntrypoint('ios/Demo/AppDelegate.mm')).toBe(true);
    expect(isPatchableNativeEntrypoint('ios/Demo/SceneDelegate.swift')).toBe(false);
  });

  it('accepts only a valid provider-authored dynamic Expo config change', () => {
    const dynamicOriginal =
      'export default ({ config }) => ({ ...config, name: "Demo" });\n';
    const changes = [patchFor(
      'app.config.ts',
      dynamicOriginal,
      'export default ({ config }) => ({ ...config, ' +
        'plugins: ["@gfean/react-native-bundle-drop"], name: "Demo" });\n',
    )];
    const originals = new Map([['app.config.ts', dynamicOriginal]]);

    expect(() =>
      validateSetupChangesBeforeApply({ projectType: 'expo', originals, changes }),
    ).not.toThrow();
  });

  it('requires review-only dynamic Expo patches and preserves unrelated config code', () => {
    const file = 'app.config.ts';
    const dynamicOriginal = [
      'import { withSentry } from "./sentry";',
      'export default ({ config }) => ({',
      '  ...config,',
      '  name: "Critical App",',
      '  extra: { apiRegion: "eu-west-1" },',
      '});',
    ].join('\n');
    const validUpdate = dynamicOriginal.replace(
      '  name: "Critical App",',
      '  plugins: ["@gfean/react-native-bundle-drop"],\n  name: "Critical App",',
    );
    const validate = (change: AiPatchPlan) => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, dynamicOriginal]]),
      changes: [change],
    });

    expect(() => validate(patchFor(file, dynamicOriginal, validUpdate))).not.toThrow();
    expect(() => validate({
      ...patchFor(file, dynamicOriginal, validUpdate),
      decisionType: 'safe_auto_patch',
    })).toThrow('require explicit review-only approval');
    expect(() => validate(patchFor(
      file,
      dynamicOriginal,
      validUpdate.replace('  extra: { apiRegion: "eu-west-1" },\n', ''),
    ))).toThrow('changed code outside authorized setup fields');
    expect(() => validate(patchFor(
      file,
      dynamicOriginal,
      validUpdate.replace(
        '  name: "Critical App",\n  extra: { apiRegion: "eu-west-1" },',
        '  extra: { apiRegion: "eu-west-1" },\n  name: "Critical App",',
      ),
    ))).toThrow('changed code outside authorized setup fields');
  });

  it('allows only approved expo-updates fields to be removed from dynamic config', () => {
    const file = 'app.config.ts';
    const migrationOriginal = [
      'export default ({ config }) => ({',
      '  ...config,',
      '  name: "Critical App",',
      '  plugins: ["expo-router", "expo-updates"],',
      '  updates: { enabled: true, url: "https://u.expo.dev/project", checkAutomatically: "ON_LOAD" },',
      '  extra: { apiRegion: "eu-west-1" },',
      '});',
    ].join('\n');
    const migrationUpdate = [
      'export default ({ config }) => ({',
      '  ...config,',
      '  name: "Critical App",',
      '  plugins: ["expo-router", "@gfean/react-native-bundle-drop"],',
      '  updates: { checkAutomatically: "ON_LOAD" },',
      '  extra: { apiRegion: "eu-west-1" },',
      '});',
    ].join('\n');
    const change = patchFor(file, migrationOriginal, migrationUpdate);
    const validate = (updatedChange: AiPatchPlan, migrateExpoUpdates: boolean) =>
      validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals: new Map([[file, migrationOriginal]]),
        changes: [updatedChange],
        migrateExpoUpdates,
      });

    expect(() => validate(change, false)).toThrow('changed code outside authorized setup fields');
    expect(() => validate(change, true)).not.toThrow();
    expect(() => validate({
      ...change,
      updated: migrationUpdate.replace('  extra: { apiRegion: "eu-west-1" },\n', ''),
    }, true)).toThrow('changed code outside authorized setup fields');

    const projectRoot = createTempProjectDir();
    const filePath = path.join(projectRoot, file);
    fs.writeFileSync(filePath, migrationUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      migrateExpoUpdates: true,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('exempts the full nested expo-updates plugin tuple but preserves unrelated tuples', () => {
    const file = 'app.config.ts';
    const migrationOriginal = [
      'export default {',
      '  plugins: [',
      '    ["expo-router", { root: "app" }],',
      '    ["expo-updates", { requestHeaders: { nested: { channel: "stable" } }, assets: ["one", { two: true }] }],',
      '    ["unrelated-plugin", { keep: { deeply: [1, 2, 3] } }],',
      '  ],',
      '};',
    ].join('\n');
    const migrationUpdate = [
      'export default {',
      '  plugins: [',
      '    ["expo-router", { root: "app" }],',
      '    ["unrelated-plugin", { keep: { deeply: [1, 2, 3] } }],',
      '    "@gfean/react-native-bundle-drop",',
      '  ],',
      '};',
    ].join('\n');
    const validate = (updated: string) => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, migrationOriginal]]),
      changes: [patchFor(file, migrationOriginal, updated)],
      migrateExpoUpdates: true,
    });

    expect(() => validate(migrationUpdate)).not.toThrow();
    expect(() => validate(migrationUpdate.replace(
      '    ["unrelated-plugin", { keep: { deeply: [1, 2, 3] } }],\n',
      '',
    ))).toThrow('changed code outside authorized setup fields');
  });

  it('accepts the canonical E3 CommonJS Expo Updates migration pre- and post-apply', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: [',
      '    ...(config.plugins ?? []),',
      '    ["expo-updates", { requestHeaders: { "expo-channel-name": "production" } }],',
      '    ["expo-build-properties", { ios: { deploymentTarget: "15.1" }, android: { kotlinVersion: "2.1.20" } }],',
      '  ],',
      '  updates: {',
      '    enabled: true,',
      '    url: "https://u.expo.dev/project-id",',
      '    checkAutomatically: "ON_LOAD",',
      '  },',
      '  extra: { ...config.extra, keepMe: { nested: ["one", { two: true }] } },',
      '});',
    ].join('\n');
    const migrationUpdate = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: [',
      '    ...(config.plugins ?? []),',
      '    ["expo-build-properties", { ios: { deploymentTarget: "15.1" }, android: { kotlinVersion: "2.1.20" } }],',
      '    "@gfean/react-native-bundle-drop",',
      '  ],',
      '  updates: {',
      '    checkAutomatically: "ON_LOAD",',
      '  },',
      '  extra: { ...config.extra, keepMe: { nested: ["one", { two: true }] } },',
      '});',
    ].join('\n');
    const change = patchFor(file, migrationOriginal, migrationUpdate);
    const originals = new Map([[file, migrationOriginal]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).not.toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), migrationUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).not.toThrow();
    removeTempDir(projectRoot);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(
        file,
        migrationOriginal,
        migrationUpdate.replace(
          '    ["expo-build-properties", { ios: { deploymentTarget: "15.1" }, android: { kotlinVersion: "2.1.20" } }],\n',
          '',
        ),
      )],
      migrateExpoUpdates: true,
    })).toThrow('changed code outside authorized setup fields');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(
        file,
        migrationOriginal,
        migrationUpdate.replace('    checkAutomatically: "ON_LOAD",\n', ''),
      )],
      migrateExpoUpdates: true,
    })).toThrow('changed code outside authorized setup fields');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(
        file,
        migrationOriginal,
        migrationUpdate.replace('keepMe: { nested: ["one", { two: true }] }', 'keepMe: {}'),
      )],
      migrateExpoUpdates: true,
    })).toThrow('changed code outside authorized setup fields');
  });

  it('preserves the complete dynamic-config source outside exact migration spans', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'const audit = value => ({ value });',
      'module.exports = {',
      '  plugins: ["expo-updates"],',
      '  extra: audit("unchanged"),',
      '};',
    ].join('\n');
    const migrationUpdate = migrationOriginal.replace(
      '"expo-updates"',
      '"@gfean/react-native-bundle-drop"',
    );
    const change = patchFor(file, migrationOriginal, migrationUpdate);
    const originals = new Map([[file, migrationOriginal]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).not.toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), migrationUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('adds one literal Bundle Drop property when the dynamic config has no plugins property', () => {
    const file = 'app.config.cjs';
    const originalConfig = 'module.exports = { name: "Demo" };';
    const updatedConfig = 'module.exports = { name: "Demo", ' +
      'plugins: ["@gfean/react-native-bundle-drop"] };';
    const change = patchFor(file, originalConfig, updatedConfig);
    const originals = new Map([[file, originalConfig]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
    })).not.toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), updatedConfig);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('adds one literal plugin to a unique direct exported expo object', () => {
    const file = 'app.config.cjs';
    const originalConfig = 'module.exports = { expo: { name: "Demo" }, outside: "keep" };';
    const updatedConfig = 'module.exports = { expo: { name: "Demo", ' +
      'plugins: ["@gfean/react-native-bundle-drop"] }, outside: "keep" };';
    const change = patchFor(file, originalConfig, updatedConfig);
    const originals = new Map([[file, originalConfig]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
    })).not.toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), updatedConfig);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('migrates Expo Updates only inside a unique direct exported expo object', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'module.exports = {',
      '  expo: {',
      '    plugins: ["expo-updates", "expo-build-properties"],',
      '    updates: { enabled: true, url: "https://u.expo.dev/project", checkAutomatically: "ON_LOAD" },',
      '    extra: { keepMe: "yes" },',
      '  },',
      '  outside: { keepToo: true },',
      '};',
    ].join('\n');
    const migrationUpdate = [
      'module.exports = {',
      '  expo: {',
      '    plugins: ["@gfean/react-native-bundle-drop", "expo-build-properties"],',
      '    updates: { checkAutomatically: "ON_LOAD" },',
      '    extra: { keepMe: "yes" },',
      '  },',
      '  outside: { keepToo: true },',
      '};',
    ].join('\n');
    const change = patchFor(file, migrationOriginal, migrationUpdate);
    const originals = new Map([[file, migrationOriginal]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).not.toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), migrationUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('preserves leading outer and nested spreads before explicit Expo authority', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  expo: {',
      '    ...config.expo,',
      '    plugins: ["expo-updates"],',
      '    updates: { enabled: true, url: "https://u.expo.dev/project" },',
      '  },',
      '});',
    ].join('\n');
    const migrationUpdate = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  expo: {',
      '    ...config.expo,',
      '    plugins: ["@gfean/react-native-bundle-drop"],',
      '  },',
      '});',
    ].join('\n');
    const change = patchFor(file, migrationOriginal, migrationUpdate);
    const originals = new Map([[file, migrationOriginal]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).not.toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), migrationUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('preserves an unrelated outer method beside direct nested Expo authority', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = 'module.exports = { helper() { return "keep"; }, ' +
      '"quotedHelper"() { return "keep-too"; }, ' +
      'expo: { plugins: ["expo-updates"] } };';
    const migrationUpdate = migrationOriginal.replace(
      '"expo-updates"',
      '"@gfean/react-native-bundle-drop"',
    );
    const originals = new Map([[file, migrationOriginal]]);
    const change = patchFor(file, migrationOriginal, migrationUpdate);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).not.toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), migrationUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it.each([
    [
      'simultaneous root and nested plugin authority',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"], ' +
        'expo: { plugins: ["@gfean/react-native-bundle-drop"] } };',
    ],
    [
      'duplicate direct expo objects',
      'module.exports = { expo: { plugins: ["@gfean/react-native-bundle-drop"] }, ' +
        'expo: { name: "decoy" } };',
    ],
    [
      'a computed expo object',
      'module.exports = { ["expo"]: { ' +
        'plugins: ["@gfean/react-native-bundle-drop"] } };',
    ],
    [
      'an expo accessor beside direct nested authority',
      'module.exports = { expo: { ' +
        'plugins: ["@gfean/react-native-bundle-drop"] }, ' +
        'get expo() { return { plugins: [] }; } };',
    ],
    [
      'an expo method beside direct nested authority',
      'module.exports = { expo: { ' +
        'plugins: ["@gfean/react-native-bundle-drop"] }, ' +
        'expo() { return { plugins: [] }; } };',
    ],
    [
      'a quoted expo accessor beside direct nested authority',
      'module.exports = { expo: { ' +
        'plugins: ["@gfean/react-native-bundle-drop"] }, ' +
        'get "expo"() { return { plugins: [] }; } };',
    ],
    [
      'an escaped quoted expo method beside direct nested authority',
      'module.exports = { expo: { ' +
        'plugins: ["@gfean/react-native-bundle-drop"] }, ' +
        '"ex\\u0070o"() { return { plugins: [] }; } };',
    ],
    [
      'a quoted nested plugins accessor',
      'module.exports = { expo: { ' +
        'plugins: ["@gfean/react-native-bundle-drop"], ' +
        'get "plugins"() { return []; } } };',
    ],
    [
      'an outer spread after nested authority',
      'module.exports = { expo: { ' +
        'plugins: ["@gfean/react-native-bundle-drop"] }, ...config };',
    ],
    [
      'a spread after nested plugin authority',
      'module.exports = { expo: { ' +
        'plugins: ["@gfean/react-native-bundle-drop"], ...config.expo } };',
    ],
    [
      'a dynamic expo authority value',
      'module.exports = { expo: (() => ({ ' +
        'plugins: ["@gfean/react-native-bundle-drop"] }))() };',
    ],
    [
      'a newly executable value inside nested authority',
      'module.exports = { expo: { ' +
        'plugins: ["@gfean/react-native-bundle-drop"], ' +
        'extra: (() => { module = { exports: {} }; return {}; })() } };',
    ],
  ])('rejects ambiguous or mutable nested Expo authority: %s', (_label, invalidUpdate) => {
    const file = 'app.config.cjs';
    const migrationOriginal = 'module.exports = { expo: { ' +
      'plugins: ["expo-updates"], extra: {} } };';
    const originals = new Map([[file, migrationOriginal]]);
    const change = patchFor(file, migrationOriginal, invalidUpdate);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), invalidUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).toThrow();
    removeTempDir(projectRoot);
  });

  it.each([
    ['fixed Unicode identifier', 'pl\\u0075gins'],
    ['braced Unicode identifier', 'pl\\u{75}gins'],
    ['quoted fixed Unicode', '"pl\\u0075gins"'],
    ['quoted braced Unicode', '"pl\\u{75}gins"'],
    ['quoted hex', '"pl\\x75gins"'],
    ['quoted legacy octal', '"pl\\165gins"'],
    ['quoted simple escape', '"\\plugins"'],
    ['quoted line continuation', '"plu' + '\\' + '\n' + 'gins"'],
  ])('rejects a duplicate runtime plugins key encoded as %s', (_label, runtimeKey) => {
    const file = 'app.config.cjs';
    const originalConfig = 'module.exports = { plugins: [] };';
    const invalidUpdate = 'module.exports = { ' +
      'plugins: ["@gfean/react-native-bundle-drop"], ' +
      `${runtimeKey}: [] };`;
    const originals = new Map([[file, originalConfig]]);
    const change = patchFor(file, originalConfig, invalidUpdate);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
    })).toThrow('must contain exactly one Bundle Drop plugin');

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), invalidUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
    })).toThrow('must contain exactly one Bundle Drop plugin');
    removeTempDir(projectRoot);
  });

  it('rejects escaped updates and expo definitions that override nested authority', () => {
    const file = 'app.config.cjs';
    const originalConfig = 'module.exports = { expo: { plugins: [] } };';
    const invalidUpdates = 'module.exports = { expo: { ' +
      'plugins: ["@gfean/react-native-bundle-drop"], updates: {}, ' +
      '"upd\\u0061tes": { enabled: true } } };';
    const invalidExpoAccessor = 'module.exports = { ' +
      'expo: { plugins: ["@gfean/react-native-bundle-drop"] }, ' +
      'get \\u0065xpo() { return { plugins: [] }; } };';
    const originals = new Map([[file, originalConfig]]);

    for (const invalidUpdate of [invalidUpdates, invalidExpoAccessor]) {
      const change = patchFor(file, originalConfig, invalidUpdate);
      expect(() => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals,
        changes: [change],
      })).toThrow();

      const projectRoot = createTempProjectDir();
      fs.writeFileSync(path.join(projectRoot, file), invalidUpdate);
      expect(() => validateAppliedSetupChanges({
        projectRoot,
        projectType: 'expo',
        changes: [change],
        originals,
      })).toThrow();
      removeTempDir(projectRoot);
    }
  });

  it('preserves unrelated escaped keys and exact computed authority literals', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'module.exports = {',
      '  ["expo"]: {',
      '    ["plugins"]: ["expo-updates"],',
      '    ["updates"]: { ["enabled"]: true, checkAutomatically: "ON_LOAD" },',
      '    h\\u0065lper: "keep",',
      '  },',
      '};',
    ].join('\n');
    const migrationUpdate = [
      'module.exports = {',
      '  ["expo"]: {',
      '    ["plugins"]: ["@gfean/react-native-bundle-drop"],',
      '    ["updates"]: { checkAutomatically: "ON_LOAD" },',
      '    h\\u0065lper: "keep",',
      '  },',
      '};',
    ].join('\n');
    const originals = new Map([[file, migrationOriginal]]);
    const change = patchFor(file, migrationOriginal, migrationUpdate);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).not.toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), migrationUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it.each([
    ['dynamic concatenation', '["plu" + "gins"]'],
    ['a newly inserted computed literal property', '["plugins"]'],
  ])('fails closed on computed authority from %s', (_label, propertyKey) => {
    const file = 'app.config.cjs';
    const originalConfig = 'module.exports = { name: "Demo" };';
    const invalidUpdate = 'module.exports = { ' +
      `name: "Demo", ${propertyKey}: ` +
      '["@gfean/react-native-bundle-drop"] };';
    const originals = new Map([[file, originalConfig]]);
    const change = patchFor(file, originalConfig, invalidUpdate);
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
    })).toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), invalidUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
    })).toThrow();
    removeTempDir(projectRoot);
  });

  it.each([
    [
      'module rebinding in a new prelude',
      'module.exports = { plugins: ["expo-updates"] };',
      [
        'const ignored = (module = { exports: { plugins: [] } });',
        'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] };',
      ].join('\n'),
    ],
    [
      'eval in a new prelude',
      'module.exports = { plugins: ["expo-updates"] };',
      [
        'eval("module = { exports: {} }");',
        'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] };',
      ].join('\n'),
    ],
    [
      'an invented pre-export call',
      'module.exports = { plugins: ["expo-updates"] };',
      [
        'inventedSetupCall();',
        'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] };',
      ].join('\n'),
    ],
    [
      'a root-value side effect',
      'module.exports = { plugins: ["expo-updates"], extra: {} };',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"], ' +
        'extra: (() => { module = { exports: {} }; return {}; })() };',
    ],
    [
      'an executable Bundle Drop tuple option',
      'module.exports = { plugins: ["expo-updates"] };',
      'module.exports = { plugins: [["@gfean/react-native-bundle-drop", ' +
        '(() => { module = { exports: {} }; return {}; })()]] };',
    ],
    [
      'an operator flip that activates a preserved side effect',
      [
        'const changeModule = () => { module = { exports: {} }; };',
        'module.exports = { plugins: ["expo-updates"], extra: false && changeModule() };',
      ].join('\n'),
      [
        'const changeModule = () => { module = { exports: {} }; };',
        'module.exports = { plugins: ["@gfean/react-native-bundle-drop"], ' +
          'extra: false || changeModule() };',
      ].join('\n'),
    ],
    [
      'a removed return line terminator',
      [
        'module.exports = {',
        '  plugins: ["expo-updates"],',
        '  extra: (() => { return',
        '    (() => { module = { exports: {} }; return {}; })(); })(),',
        '};',
      ].join('\n'),
      [
        'module.exports = {',
        '  plugins: ["@gfean/react-native-bundle-drop"],',
        '  extra: (() => { return (() => { module = { exports: {} }; return {}; })(); })(),',
        '};',
      ].join('\n'),
    ],
    [
      'a removed return terminator after a block comment',
      [
        'module.exports = {',
        '  plugins: ["expo-updates"],',
        '  extra: (() => { return /* preserve ASI */',
        '    (() => { module = { exports: {} }; return {}; })(); })(),',
        '};',
      ].join('\n'),
      [
        'module.exports = {',
        '  plugins: ["@gfean/react-native-bundle-drop"],',
        '  extra: (() => { return /* preserve ASI */ (() => { ' +
          'module = { exports: {} }; return {}; })(); })(),',
        '};',
      ].join('\n'),
    ],
  ])('rejects an unauthorized dynamic-config change: %s', (
    _label,
    migrationOriginal,
    invalidMigration,
  ) => {
    const file = 'app.config.cjs';
    const originals = new Map([[file, migrationOriginal]]);
    const change = patchFor(file, migrationOriginal, invalidMigration);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), invalidMigration);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).toThrow();
    removeTempDir(projectRoot);
  });

  it.each(['\u2028', '\u2029'])(
    'rejects JavaScript line separator %p before and after dynamic config apply',
    separator => {
      const file = 'app.config.cjs';
      const originalConfig = 'module.exports = { plugins: [] };';
      const updatedConfig = '// documentation' + separator +
        'module = { exports: {} };\n' +
        'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] };';
      const originals = new Map([[file, originalConfig]]);
      const change = patchFor(file, originalConfig, updatedConfig);

      expect(() => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals,
        changes: [change],
      })).toThrow('unsafe control or JavaScript line-separator characters');

      const projectRoot = createTempProjectDir();
      fs.writeFileSync(path.join(projectRoot, file), updatedConfig);
      expect(() => validateAppliedSetupChanges({
        projectRoot,
        projectType: 'expo',
        changes: [change],
        originals,
      })).toThrow('unsafe control or JavaScript line-separator characters');
      removeTempDir(projectRoot);
    },
  );

  it('requires an approved Expo Updates migration to be complete pre- and post-apply', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["expo-updates", "expo-build-properties"],',
      '  updates: { enabled: true, url: "https://u.expo.dev/project", checkAutomatically: "ON_LOAD" },',
      '  extra: {',
      '    plugins: ["expo-updates", "keep-plugin"],',
      '    updates: { enabled: true, url: "https://nested.example", keepNested: "yes" },',
      '  },',
      '});',
    ].join('\n');
    const completeMigration = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["@gfean/react-native-bundle-drop", "expo-build-properties"],',
      '  updates: { checkAutomatically: "ON_LOAD" },',
      '  extra: {',
      '    plugins: ["expo-updates", "keep-plugin"],',
      '    updates: { enabled: true, url: "https://nested.example", keepNested: "yes" },',
      '  },',
      '});',
    ].join('\n');
    const originals = new Map([[file, migrationOriginal]]);
    const validateBefore = (updated: string) => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, migrationOriginal, updated)],
      migrateExpoUpdates: true,
    });

    expect(() => validateBefore(completeMigration)).not.toThrow();

    const incompleteMigrations = [
      completeMigration.replace(
        'plugins: ["@gfean/react-native-bundle-drop", "expo-build-properties"]',
        'plugins: ["@gfean/react-native-bundle-drop", "expo-updates", "expo-build-properties"]',
      ),
      completeMigration.replace(
        'updates: { checkAutomatically: "ON_LOAD" }',
        'updates: { enabled: true, checkAutomatically: "ON_LOAD" }',
      ),
      completeMigration.replace(
        'updates: { checkAutomatically: "ON_LOAD" }',
        'updates: { url: "https://u.expo.dev/project", checkAutomatically: "ON_LOAD" }',
      ),
    ];
    for (const incompleteMigration of incompleteMigrations) {
      expect(() => validateBefore(incompleteMigration))
        .toThrow('did not fully remove active Expo Updates configuration');

      const projectRoot = createTempProjectDir();
      fs.writeFileSync(path.join(projectRoot, file), incompleteMigration);
      expect(() => validateAppliedSetupChanges({
        projectRoot,
        projectType: 'expo',
        changes: [patchFor(file, migrationOriginal, completeMigration)],
        originals,
        migrateExpoUpdates: true,
      })).toThrow('did not fully remove active Expo Updates configuration');
      removeTempDir(projectRoot);
    }
  });

  it('removes shorthand and computed root Expo Updates fields without accepting partial migration', () => {
    const file = 'app.config.cjs';
    const originalVariants = [
      [
        'const enabled = true;',
        'const url = "https://u.expo.dev/project";',
        'module.exports = {',
        '  plugins: ["expo-updates"],',
        '  updates: { enabled, url, checkAutomatically: "ON_LOAD" },',
        '};',
      ].join('\n'),
      [
        'module.exports = {',
        '  plugins: ["expo-updates"],',
        '  updates: { ["enabled"]: true, ["url"]: "https://u.expo.dev/project", checkAutomatically: "ON_LOAD" },',
        '};',
      ].join('\n'),
    ];

    for (const migrationOriginal of originalVariants) {
      const incompleteMigration = migrationOriginal.replace(
        'plugins: ["expo-updates"]',
        'plugins: ["@gfean/react-native-bundle-drop"]',
      );
      const completeMigration = incompleteMigration
        .replace('enabled, url, ', '')
        .replace('["enabled"]: true, ["url"]: "https://u.expo.dev/project", ', '');
      const originals = new Map([[file, migrationOriginal]]);
      const validate = (updated: string) => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals,
        changes: [patchFor(file, migrationOriginal, updated)],
        migrateExpoUpdates: true,
      });

      expect(() => validate(completeMigration)).not.toThrow();
      expect(() => validate(incompleteMigration))
        .toThrow('did not fully remove active Expo Updates configuration');

      const projectRoot = createTempProjectDir();
      fs.writeFileSync(path.join(projectRoot, file), incompleteMigration);
      expect(() => validateAppliedSetupChanges({
        projectRoot,
        projectType: 'expo',
        changes: [patchFor(file, migrationOriginal, completeMigration)],
        originals,
        migrateExpoUpdates: true,
      })).toThrow('did not fully remove active Expo Updates configuration');
      removeTempDir(projectRoot);
    }
  });

  it('requires exactly one real Bundle Drop plugin in the exported root config', () => {
    const file = 'app.config.js';
    const originalConfig = 'export default { plugins: [] };';
    const validate = (updated: string) => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, originalConfig]]),
      changes: [patchFor(file, originalConfig, updated)],
    });

    expect(() => validate([
      'export default {',
      '  plugins: [],',
      '  documentation: "@gfean/react-native-bundle-drop",',
      '};',
    ].join('\n'))).toThrow('must contain exactly one Bundle Drop plugin');
    expect(() => validate([
      'export default {',
      '  // @gfean/react-native-bundle-drop',
      '  plugins: [],',
      '};',
    ].join('\n'))).toThrow('must contain exactly one Bundle Drop plugin');
    expect(() => validate([
      'export default {',
      '  plugins: [',
      '    "@gfean/react-native-bundle-drop",',
      '    ["@gfean/react-native-bundle-drop", {}],',
      '  ],',
      '};',
    ].join('\n'))).toThrow('must contain exactly one Bundle Drop plugin');
    expect(() => validate([
      'export default {',
      '  plugins: [["@gfean/react-native-bundle-drop"] && "not-a-plugin"],',
      '};',
    ].join('\n'))).toThrow('must contain exactly one Bundle Drop plugin');
  });

  it('decodes constant plugin expressions and rejects hidden Expo Updates authority', () => {
    const file = 'app.config.cjs';
    const expoPluginExpressions = [
      '"expo\\u002dupdates"',
      '`expo-updates`',
      '"expo-" + "updates"',
      'EXPO_UPDATES',
    ];
    for (const expoPlugin of expoPluginExpressions) {
      const declaration = expoPlugin === 'EXPO_UPDATES'
        ? 'const EXPO_UPDATES = "expo-" + "updates";\n'
        : '';
      const migrationOriginal = `${declaration}module.exports = { plugins: [${expoPlugin}] };`;
      const incompleteMigration = `${declaration}module.exports = { plugins: [` +
        `${expoPlugin}, "@gfean/react-native-bundle-drop"] };`;
      const completeMigration = `${declaration}module.exports = { ` +
        'plugins: ["@gfean/react-native-bundle-drop"] };';
      const originals = new Map([[file, migrationOriginal]]);

      expect(() => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals,
        changes: [patchFor(file, migrationOriginal, completeMigration)],
        migrateExpoUpdates: true,
      })).not.toThrow();
      expect(() => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals,
        changes: [patchFor(file, migrationOriginal, incompleteMigration)],
        migrateExpoUpdates: true,
      })).toThrow('did not fully remove active Expo Updates configuration');

      const projectRoot = createTempProjectDir();
      fs.writeFileSync(path.join(projectRoot, file), incompleteMigration);
      expect(() => validateAppliedSetupChanges({
        projectRoot,
        projectType: 'expo',
        changes: [patchFor(file, migrationOriginal, completeMigration)],
        originals,
        migrateExpoUpdates: true,
      })).toThrow('did not fully remove active Expo Updates configuration');
      removeTempDir(projectRoot);
    }
  });

  it('resolves only static multiline leading-plus constants before migration completion', () => {
    const file = 'app.config.cjs';
    const declaration = [
      'const ACTIVE = "expo-"',
      '  + "updates";',
    ].join('\n');
    const migrationOriginal = [
      declaration,
      'module.exports = { plugins: [ACTIVE] };',
    ].join('\n');
    const incompleteMigration = [
      declaration,
      'module.exports = { plugins: [ACTIVE, "@gfean/react-native-bundle-drop"] };',
    ].join('\n');
    const completeMigration = [
      declaration,
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] };',
    ].join('\n');
    const originals = new Map([[file, migrationOriginal]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, migrationOriginal, completeMigration)],
      migrateExpoUpdates: true,
    })).not.toThrow();
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, migrationOriginal, incompleteMigration)],
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), incompleteMigration);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [patchFor(file, migrationOriginal, completeMigration)],
      originals,
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');
    removeTempDir(projectRoot);

    const dynamicDeclaration = [
      'const ACTIVE = "expo-"',
      '  + getPluginName();',
    ].join('\n');
    const dynamicOriginal = [
      dynamicDeclaration,
      'module.exports = { plugins: [ACTIVE] };',
    ].join('\n');
    const dynamicUpdate = [
      dynamicDeclaration,
      'module.exports = { plugins: [ACTIVE, "@gfean/react-native-bundle-drop"] };',
    ].join('\n');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, dynamicOriginal]]),
      changes: [patchFor(file, dynamicOriginal, dynamicUpdate)],
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');
  });

  it.each([
    [
      'block comment',
      'const ACTIVE = "expo-"\n  /* kept comment */ + "updates";',
    ],
    [
      'line comment',
      'const ACTIVE = "expo-" // kept comment\n  + "updates";',
    ],
  ])('resolves a leading-plus continuation after a %s', (_label, declaration) => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      declaration,
      'module.exports = { plugins: [ACTIVE] };',
    ].join('\n');
    const completeMigration = [
      declaration,
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] };',
    ].join('\n');
    const incompleteMigration = [
      declaration,
      'module.exports = { plugins: [ACTIVE, "@gfean/react-native-bundle-drop"] };',
    ].join('\n');
    const originals = new Map([[file, migrationOriginal]]);
    const completeChange = patchFor(file, migrationOriginal, completeMigration);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [completeChange],
      migrateExpoUpdates: true,
    })).not.toThrow();
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, migrationOriginal, incompleteMigration)],
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), incompleteMigration);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [completeChange],
      originals,
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');
    removeTempDir(projectRoot);
  });

  it.each([
    ['logical AND', '"@gfean/react-native-bundle-drop"\n  && "customer-plugin"'],
    ['logical OR', '""\n  || "expo-updates"'],
    ['nullish coalescing', 'null\n  ?? "expo-updates"'],
    ['subtraction', '"@gfean/react-native-bundle-drop"\n  - 1'],
    ['multiplication', '"@gfean/react-native-bundle-drop"\n  * 1'],
    ['division', '"@gfean/react-native-bundle-drop"\n  / 1'],
    ['remainder', '"@gfean/react-native-bundle-drop"\n  % 1'],
    ['member access', '"@gfean/react-native-bundle-drop"\n  .trim()'],
    ['optional member access', '"@gfean/react-native-bundle-drop"\n  ?.trim()'],
    ['index access', '"@gfean/react-native-bundle-drop"\n  [0]'],
    ['call', '"@gfean/react-native-bundle-drop"\n  ()'],
    ['in operator', '"@gfean/react-native-bundle-drop"\n  in registry'],
    ['instanceof operator', '"@gfean/react-native-bundle-drop"\n  instanceof String'],
  ])('does not truncate a multiline %s expression into a trusted plugin alias', (
    _label,
    expression,
  ) => {
    const file = 'app.config.cjs';
    const originalConfig = 'module.exports = { plugins: [] };';
    const updatedConfig = [
      `const PLUGIN = ${expression};`,
      'module.exports = { plugins: [PLUGIN] };',
    ].join('\n');

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, originalConfig]]),
      changes: [patchFor(file, originalConfig, updatedConfig)],
    })).toThrow('must contain exactly one Bundle Drop plugin');
  });

  it('rejects a retained Expo Updates alias continued with logical OR', () => {
    const file = 'app.config.cjs';
    const declaration = 'const ACTIVE = ""\n  || "expo-updates";';
    const migrationOriginal = [
      declaration,
      'module.exports = { plugins: [ACTIVE] };',
    ].join('\n');
    const incompleteMigration = [
      declaration,
      'module.exports = { plugins: [ACTIVE, "@gfean/react-native-bundle-drop"] };',
    ].join('\n');
    const originals = new Map([[file, migrationOriginal]]);
    const change = patchFor(file, migrationOriginal, incompleteMigration);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), incompleteMigration);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).toThrow();
    removeTempDir(projectRoot);
  });

  it('preserves a semicolonless static prelude while inserting the literal plugin', () => {
    const file = 'app.config.cjs';
    const originalConfig = [
      'const BUNDLE_DROP = "@gfean/react-native-bundle-drop"',
      'module.exports = { plugins: [] };',
    ].join('\n');
    const updatedConfig = [
      'const BUNDLE_DROP = "@gfean/react-native-bundle-drop"',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] };',
    ].join('\n');

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, originalConfig]]),
      changes: [patchFor(file, originalConfig, updatedConfig)],
    })).not.toThrow();
  });

  it('supports bounded TypeScript string aliases and const assertions', () => {
    const file = 'app.config.ts';
    const originalConfig = [
      'const EXPO_UPDATES = "expo-updates" as const;',
      'const BUNDLE_DROP: string = "@gfean/react-native-bundle-drop";',
      'export default { plugins: [EXPO_UPDATES] };',
    ].join('\n');
    const completeMigration = [
      'const EXPO_UPDATES = "expo-updates" as const;',
      'const BUNDLE_DROP: string = "@gfean/react-native-bundle-drop";',
      'export default { plugins: ["@gfean/react-native-bundle-drop"] };',
    ].join('\n');
    const incompleteMigration = completeMigration.replace(
      'plugins: ["@gfean/react-native-bundle-drop"]',
      'plugins: [EXPO_UPDATES, "@gfean/react-native-bundle-drop"]',
    );
    const originals = new Map([[file, originalConfig]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, originalConfig, completeMigration)],
      migrateExpoUpdates: true,
    })).not.toThrow();
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, originalConfig, incompleteMigration)],
      migrateExpoUpdates: true,
    })).toThrow();

    const dynamicOriginal = [
      'const EXPO_UPDATES = getPluginName() as const;',
      'export default { plugins: [EXPO_UPDATES] };',
    ].join('\n');
    const dynamicUpdate = dynamicOriginal.replace(
      'plugins: [EXPO_UPDATES]',
      'plugins: [EXPO_UPDATES, "@gfean/react-native-bundle-drop"]',
    );
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, dynamicOriginal]]),
      changes: [patchFor(file, dynamicOriginal, dynamicUpdate)],
      migrateExpoUpdates: true,
    })).toThrow();

    for (const assertion of ['as string', 'satisfies string']) {
      const assertedOriginal = [
        `const EXPO_UPDATES = "expo-updates" ${assertion};`,
        `const BUNDLE_DROP = "@gfean/react-native-bundle-drop" ${assertion};`,
        'export default { plugins: [EXPO_UPDATES] };',
      ].join('\n');
      const assertedComplete = [
        `const EXPO_UPDATES = "expo-updates" ${assertion};`,
        `const BUNDLE_DROP = "@gfean/react-native-bundle-drop" ${assertion};`,
        'export default { plugins: ["@gfean/react-native-bundle-drop"] };',
      ].join('\n');
      const assertedIncomplete = assertedComplete.replace(
        'plugins: ["@gfean/react-native-bundle-drop"]',
        'plugins: [EXPO_UPDATES, "@gfean/react-native-bundle-drop"]',
      );
      const assertedOriginals = new Map([[file, assertedOriginal]]);

      expect(() => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals: assertedOriginals,
        changes: [patchFor(file, assertedOriginal, assertedComplete)],
        migrateExpoUpdates: true,
      })).not.toThrow();
      expect(() => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals: assertedOriginals,
        changes: [patchFor(file, assertedOriginal, assertedIncomplete)],
        migrateExpoUpdates: true,
      })).toThrow();

      const dynamicAssertedOriginal = [
        `const EXPO_UPDATES = getPluginName() ${assertion};`,
        'export default { plugins: [EXPO_UPDATES] };',
      ].join('\n');
      const dynamicAssertedUpdate = dynamicAssertedOriginal.replace(
        'plugins: [EXPO_UPDATES]',
        'plugins: [EXPO_UPDATES, "@gfean/react-native-bundle-drop"]',
      );
      expect(() => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals: new Map([[file, dynamicAssertedOriginal]]),
        changes: [patchFor(file, dynamicAssertedOriginal, dynamicAssertedUpdate)],
        migrateExpoUpdates: true,
      })).toThrow();
    }

    const complexAssertionOriginal = [
      'const EXPO_UPDATES = "expo-updates" as string | null;',
      'export default { plugins: [EXPO_UPDATES] };',
    ].join('\n');
    const complexAssertionUpdate = complexAssertionOriginal.replace(
      'plugins: [EXPO_UPDATES]',
      'plugins: [EXPO_UPDATES, "@gfean/react-native-bundle-drop"]',
    );
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, complexAssertionOriginal]]),
      changes: [patchFor(file, complexAssertionOriginal, complexAssertionUpdate)],
      migrateExpoUpdates: true,
    })).toThrow();
  });

  it('recognizes decoded Bundle Drop authority but authorizes only a literal insertion', () => {
    const file = 'app.config.js';
    const originalConfig = 'export default { plugins: [] };';
    const decodedBundleDropExpressions = [
      '"@gfean/react-native-bundle\\u002ddrop"',
      '`@gfean/react-native-bundle-drop`',
      '"@gfean/react-native-" + "bundle-drop"',
    ];
    for (const pluginExpression of decodedBundleDropExpressions) {
      expect(() => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals: new Map([[file, originalConfig]]),
        changes: [patchFor(
          file,
          originalConfig,
          `export default { plugins: [${pluginExpression}] };`,
        )],
      })).toThrow('changed code outside authorized setup fields');
      expect(() => validateSetupChangesBeforeApply({
        projectType: 'expo',
        originals: new Map([[file, originalConfig]]),
        changes: [patchFor(
          file,
          originalConfig,
          `export default { plugins: [${pluginExpression}, "@gfean/react-native-bundle-drop"] };`,
        )],
      })).toThrow('must contain exactly one Bundle Drop plugin');
    }
  });

  it('rejects ambiguous or statically authoritative plugin spreads but keeps the live spread', () => {
    const file = 'app.config.cjs';
    const originalConfig = 'module.exports = ({ config }) => ({ ...config, plugins: [' +
      '...(config.plugins || [])] });';
    const validate = (plugins: string) => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, originalConfig]]),
      changes: [patchFor(
        file,
        originalConfig,
        `module.exports = ({ config }) => ({ ...config, plugins: [${plugins}] });`,
      )],
      migrateExpoUpdates: true,
    });

    expect(() => validate(
      '...(config.plugins || []), "@gfean/react-native-bundle-drop"',
    )).not.toThrow();
    expect(() => validate(
      '...["expo-updates"], "@gfean/react-native-bundle-drop"',
    )).toThrow();
    expect(() => validate(
      '...["expo\\u002dupdates"], "@gfean/react-native-bundle-drop"',
    )).toThrow();
    expect(() => validate(
      '`expo-${updates}`, "@gfean/react-native-bundle-drop"',
    )).toThrow();
    expect(() => validate(
      '...ACTIVE_PLUGINS, "@gfean/react-native-bundle-drop"',
    )).toThrow();
  });

  it.each([
    [
      'mutable alias',
      'let ACTIVE = "expo-updates";',
      'ACTIVE',
    ],
    [
      'function result',
      'const ACTIVE = getPluginName();',
      'ACTIVE',
    ],
    [
      'spread',
      'const ACTIVE_PLUGINS = getPluginNames();',
      '...ACTIVE_PLUGINS',
    ],
  ])('fails closed on an unresolved %s plugin during migration', (
    _label,
    declaration,
    pluginExpression,
  ) => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      declaration,
      `module.exports = { plugins: [${pluginExpression}] };`,
    ].join('\n');
    const incompleteMigration = [
      declaration,
      `module.exports = { plugins: [${pluginExpression}, ` +
        '"@gfean/react-native-bundle-drop"] };',
    ].join('\n');
    const change = patchFor(file, migrationOriginal, incompleteMigration);
    const originals = new Map([[file, migrationOriginal]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), incompleteMigration);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');
    removeTempDir(projectRoot);
  });

  it('does not allow a provider to introduce the existing-config plugin spread', () => {
    const file = 'app.config.cjs';
    const originalConfig = 'module.exports = ({ config }) => ({ ...config, plugins: [] });';
    const updatedConfig = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: [',
      '    ...(config.plugins || []),',
      '    "@gfean/react-native-bundle-drop",',
      '  ],',
      '});',
    ].join('\n');

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, originalConfig]]),
      changes: [patchFor(file, originalConfig, updatedConfig)],
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');
  });

  it('rejects every spread inside authoritative updates during migration', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'module.exports = {',
      '  plugins: ["expo-updates"],',
      '  updates: { enabled: true, url: "https://u.expo.dev/project", checkAutomatically: "ON_LOAD" },',
      '};',
    ].join('\n');
    const invalidMigration = [
      'module.exports = {',
      '  plugins: ["@gfean/react-native-bundle-drop"],',
      '  updates: { ...{ enabled: true, url: "https://u.expo.dev/project" }, checkAutomatically: "ON_LOAD" },',
      '};',
    ].join('\n');

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, migrationOriginal]]),
      changes: [patchFor(file, migrationOriginal, invalidMigration)],
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');
  });

  it('does not authorize deletion of an original authoritative updates spread', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["expo-updates"],',
      '  updates: { ...config.updates, enabled: true, url: "https://u.expo.dev/project" },',
      '});',
    ].join('\n');
    const invalidMigration = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["@gfean/react-native-bundle-drop"],',
      '  updates: {},',
      '});',
    ].join('\n');

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, migrationOriginal]]),
      changes: [patchFor(file, migrationOriginal, invalidMigration)],
      migrateExpoUpdates: true,
    })).toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), invalidMigration);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [patchFor(file, migrationOriginal, invalidMigration)],
      originals: new Map([[file, migrationOriginal]]),
      migrateExpoUpdates: true,
    })).toThrow('changed code outside authorized setup fields');
    removeTempDir(projectRoot);
  });

  it('migrates escaped direct Expo Updates keys but preserves unrelated escaped keys', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'module.exports = {',
      '  plugins: ["expo-updates"],',
      '  updates: {',
      '    en\\u0061bled: true,',
      '    ["u\\u0072l"]: "https://u.expo.dev/project",',
      '    "check\\u0041utomatically": "ON_LOAD",',
      '  },',
      '};',
    ].join('\n');
    const migrationUpdate = [
      'module.exports = {',
      '  plugins: ["@gfean/react-native-bundle-drop"],',
      '  updates: {',
      '    "check\\u0041utomatically": "ON_LOAD",',
      '  },',
      '};',
    ].join('\n');
    const originals = new Map([[file, migrationOriginal]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, migrationOriginal, migrationUpdate)],
      migrateExpoUpdates: true,
    })).not.toThrow();
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(
        file,
        migrationOriginal,
        migrationUpdate.replace('    "check\\u0041utomatically": "ON_LOAD",\n', ''),
      )],
      migrateExpoUpdates: true,
    })).toThrow('changed code outside authorized setup fields');

    const retainedAuthority = migrationUpdate.replace(
      '  updates: {',
      '  updates: { en\\u0061bled: true,',
    );
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, migrationOriginal, retainedAuthority)],
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');

    const escapedMethodAuthority = migrationUpdate.replace(
      '  updates: {',
      '  updates: { get en\\u0061bled() { return true; }, ' +
        'u\\u0072l() { return "https://u.expo.dev/project"; },',
    );
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, migrationOriginal, escapedMethodAuthority)],
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');

    const projectRoot = createTempProjectDir();
    const completedChange = patchFor(file, migrationOriginal, migrationUpdate);
    fs.writeFileSync(path.join(projectRoot, file), migrationUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [completedChange],
      originals,
      migrateExpoUpdates: true,
    })).not.toThrow();
    fs.writeFileSync(path.join(projectRoot, file), retainedAuthority);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [completedChange],
      originals,
      migrateExpoUpdates: true,
    })).toThrow('did not fully remove active Expo Updates configuration');
    removeTempDir(projectRoot);
  });

  it('accepts a canonical block-body dynamic config export pre- and post-apply', () => {
    const file = 'app.config.cjs';
    const originalConfig = [
      'module.exports = ({ config }) => {',
      '  return { ...config, plugins: [] };',
      '};',
    ].join('\n');
    const updatedConfig = originalConfig.replace(
      'plugins: []',
      'plugins: ["@gfean/react-native-bundle-drop"]',
    );
    const change = patchFor(file, originalConfig, updatedConfig);
    const originals = new Map([[file, originalConfig]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
    })).not.toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), updatedConfig);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('accepts a canonical typed TypeScript dynamic config export', () => {
    const file = 'app.config.ts';
    const originalConfig = [
      'import type { ConfigContext, ExpoConfig } from "expo/config";',
      'export default ({ config }: ConfigContext): ExpoConfig => ({',
      '  ...config,',
      '  plugins: [],',
      '});',
    ].join('\n');
    const updatedConfig = originalConfig.replace(
      'plugins: []',
      'plugins: ["@gfean/react-native-bundle-drop"]',
    );

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, originalConfig]]),
      changes: [patchFor(file, originalConfig, updatedConfig)],
    })).not.toThrow();
  });

  it('accepts a semicolonless declaration before the authoritative export', () => {
    const file = 'app.config.cjs';
    const originalConfig = [
      'const helper = 1',
      'module.exports = { plugins: [], extra: { helper } }; // terminal comment is allowed',
    ].join('\n');
    const updatedConfig = originalConfig.replace(
      'plugins: []',
      'plugins: ["@gfean/react-native-bundle-drop"]',
    );

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, originalConfig]]),
      changes: [patchFor(file, originalConfig, updatedConfig)],
    })).not.toThrow();
  });

  it.each([
    [
      'post-export arrow decoy',
      [
        'const actual = { plugins: [] };',
        'module.exports = actual;',
        'const decoy = () => ({ plugins: ["@gfean/react-native-bundle-drop"] });',
      ].join('\n'),
    ],
    [
      'conditional export',
      'if (false) module.exports = () => ({ plugins: ["@gfean/react-native-bundle-drop"] });',
    ],
    [
      'nested dead export',
      'function dead() { module.exports = () => ({ plugins: ["@gfean/react-native-bundle-drop"] }); }',
    ],
    [
      'template interpolation override',
      [
        'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] };',
        'const override = `${module.exports = { plugins: [] }}`;',
      ].join('\n'),
    ],
    [
      'direct object value bypass',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] } && { plugins: [] };',
    ],
    [
      'concise arrow value bypass',
      'module.exports = ({ config }) => ({ plugins: ["@gfean/react-native-bundle-drop"] }) && ({ plugins: [] });',
    ],
    [
      'trailing root spread override',
      'module.exports = ({ config }) => ({ plugins: ["@gfean/react-native-bundle-drop"], updates: {}, ...config });',
    ],
    [
      'computed root overrides',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"], ["plugins"]: [], updates: {}, ["updates"]: { enabled: true } };',
    ],
    [
      'accessor root overrides',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"], get plugins() { return []; }, updates: {}, get updates() { return { enabled: true }; } };',
    ],
    [
      'post-export plugin mutation',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] }; module.exports.plugins = [];',
    ],
    [
      'post-export Object.assign mutation',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] }; Object.assign(module.exports, { plugins: [] });',
    ],
    [
      'post-export Expo Updates mutation',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"], updates: {} }; module.exports.updates = { enabled: true };',
    ],
    [
      'post-export plugin push',
      'module.exports = { plugins: ["@gfean/react-native-bundle-drop"] }; module.exports.plugins.push("expo-updates");',
    ],
  ])('rejects a non-authoritative dynamic Expo root: %s', (_label, updatedConfig) => {
    const file = 'app.config.cjs';
    const originals = new Map([[file, updatedConfig]]);
    const change = patchFor(file, updatedConfig, updatedConfig);
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
    })).toThrow('must contain exactly one Bundle Drop plugin');

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), updatedConfig);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
    })).toThrow('must contain exactly one Bundle Drop plugin');
    removeTempDir(projectRoot);
  });

  it('exempts Expo Updates migration fields only from the exported root config', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["expo-updates"],',
      '  updates: { enabled: true, url: "https://u.expo.dev/project", checkAutomatically: "ON_LOAD" },',
      '  extra: {',
      '    plugins: ["expo-updates", "keep-plugin"],',
      '    updates: { enabled: true, url: "https://unrelated.example", keepNested: "yes" },',
      '    keepMe: "yes",',
      '  },',
      '});',
    ].join('\n');
    const migrationUpdate = [
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["@gfean/react-native-bundle-drop"],',
      '  updates: { checkAutomatically: "ON_LOAD" },',
      '  extra: {',
      '    plugins: ["expo-updates", "keep-plugin"],',
      '    updates: { enabled: true, url: "https://unrelated.example", keepNested: "yes" },',
      '    keepMe: "yes",',
      '  },',
      '});',
    ].join('\n');
    const originals = new Map([[file, migrationOriginal]]);
    const validateBefore = (updated: string) => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, migrationOriginal, updated)],
      migrateExpoUpdates: true,
    });

    expect(() => validateBefore(migrationUpdate)).not.toThrow();

    const invalidUpdates = migrationUpdate.replace(
      '    updates: { enabled: true, url: "https://unrelated.example", keepNested: "yes" },',
      '    updates: { keepNested: "yes" },',
    );
    const invalidPlugins = migrationUpdate.replace(
      '    plugins: ["expo-updates", "keep-plugin"],',
      '    plugins: ["keep-plugin"],',
    );
    for (const invalidUpdate of [invalidUpdates, invalidPlugins]) {
      expect(() => validateBefore(invalidUpdate)).toThrow('changed code outside authorized setup fields');

      const projectRoot = createTempProjectDir();
      fs.writeFileSync(path.join(projectRoot, file), invalidUpdate);
      expect(() => validateAppliedSetupChanges({
        projectRoot,
        projectType: 'expo',
        changes: [patchFor(file, migrationOriginal, migrationUpdate)],
        originals,
        migrateExpoUpdates: true,
      })).toThrow('changed code outside authorized setup fields');
      removeTempDir(projectRoot);
    }
  });

  it('binds Expo Updates migration exemptions to the actual export expression', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'const helper = () => ({ updates: { enabled: true, url: "https://unrelated", keep: "yes" } });',
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["expo-updates"],',
      '  extra: { keepMe: "yes" },',
      '});',
    ].join('\n');
    const migrationUpdate = migrationOriginal
      .replace('plugins: ["expo-updates"]', 'plugins: ["@gfean/react-native-bundle-drop"]');
    const originals = new Map([[file, migrationOriginal]]);
    const validate = (updated: string) => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [patchFor(file, migrationOriginal, updated)],
      migrateExpoUpdates: true,
    });

    expect(() => validate(migrationUpdate)).not.toThrow();
    expect(() => validate(migrationUpdate.replace(
      'updates: { enabled: true, url: "https://unrelated", keep: "yes" }',
      'updates: { keep: "yes" }',
    ))).toThrow('changed code outside authorized setup fields');
  });

  it('rejects Expo Updates migration exemptions when exports are ambiguous', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'if (false) module.exports = () => ({',
      '  updates: { enabled: true, url: "https://unrelated", keep: "yes" },',
      '});',
      'module.exports = ({ config }) => ({ ...config, extra: { keepMe: "yes" } });',
    ].join('\n');
    const invalidUpdate = [
      'if (false) module.exports = () => ({',
      '  updates: { keep: "yes" },',
      '});',
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["@gfean/react-native-bundle-drop"],',
      '  extra: { keepMe: "yes" },',
      '});',
    ].join('\n');
    const originals = new Map([[file, migrationOriginal]]);
    const change = patchFor(file, migrationOriginal, invalidUpdate);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals,
      changes: [change],
      migrateExpoUpdates: true,
    })).toThrow();

    const projectRoot = createTempProjectDir();
    fs.writeFileSync(path.join(projectRoot, file), invalidUpdate);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'expo',
      changes: [change],
      originals,
      migrateExpoUpdates: true,
    })).toThrow();
    removeTempDir(projectRoot);
  });

  it('ignores export examples inside dynamic config string and regex literals', () => {
    const file = 'app.config.cjs';
    const migrationOriginal = [
      'const matcher = /module.exports = example|export default example/;',
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["expo-updates"],',
      '  updates: { enabled: true, url: "https://u.expo.dev/project", checkAutomatically: "ON_LOAD" },',
      '  extra: { matcher: /}/, documentation: "module.exports = example; export default example", keepMe: "yes" },',
      '});',
    ].join('\n');
    const migrationUpdate = [
      'const matcher = /module.exports = example|export default example/;',
      'module.exports = ({ config }) => ({',
      '  ...config,',
      '  plugins: ["@gfean/react-native-bundle-drop"],',
      '  updates: { checkAutomatically: "ON_LOAD" },',
      '  extra: { matcher: /}/, documentation: "module.exports = example; export default example", keepMe: "yes" },',
      '});',
    ].join('\n');

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, migrationOriginal]]),
      changes: [patchFor(file, migrationOriginal, migrationUpdate)],
      migrateExpoUpdates: true,
    })).not.toThrow();
  });

  it('exempts only the authoritative top-level updates field during migration', () => {
    const file = 'app.config.ts';
    const originalConfig = [
      'export default {',
      '  plugins: ["expo-updates"],',
      '  updates: { enabled: true, url: "https://u.expo.dev/project" },',
      '  extra: { updates: { enabled: true, url: "keep-private" } },',
      '};',
    ].join('\n');
    const validUpdate = [
      'export default {',
      '  plugins: ["@gfean/react-native-bundle-drop"],',
      '  extra: { updates: { enabled: true, url: "keep-private" } },',
      '};',
    ].join('\n');
    const validate = (updated: string) => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([[file, originalConfig]]),
      changes: [patchFor(file, originalConfig, updated)],
      migrateExpoUpdates: true,
    });

    expect(() => validate(validUpdate)).not.toThrow();
    expect(() => validate(validUpdate.replace(
      '  extra: { updates: { enabled: true, url: "keep-private" } },',
      '  extra: { updates: {} },',
    ))).toThrow('changed code outside authorized setup fields');
  });

  it('rejects common unsafe, stale, duplicate, empty, placeholder, and malformed changes', () => {
    const dynamicOriginal = 'export default {};';
    const valid = patchFor(
      'app.config.js',
      dynamicOriginal,
      'export default { plugins: ["@gfean/react-native-bundle-drop"] };',
    );
    const originals = new Map([[valid.file, dynamicOriginal]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([['../app.json', original]]),
      changes: [{ ...valid, file: '../app.json' }],
    })).toThrow('unsafe file path');
    expect(() => validateSetupChangesBeforeApply({ projectType: 'expo', originals: new Map(), changes: [valid] })).toThrow('not shared');
    expect(() => validateSetupChangesBeforeApply({ projectType: 'expo', originals, changes: [valid, valid] })).toThrow('multiple updates');
    expect(() => validateSetupChangesBeforeApply({ projectType: 'expo', originals, changes: [{ ...valid, originalSha256: 'stale' }] })).toThrow('hash mismatch');
    expect(() => validateSetupChangesBeforeApply({ projectType: 'expo', originals, changes: [{ ...valid, updated: '  ' }] })).toThrow('empty update');
    expect(() => validateSetupChangesBeforeApply({ projectType: 'expo', originals, changes: [{ ...valid, updated: '<TODO>' }] })).toThrow('placeholder');
    expect(() => validateSetupChangesBeforeApply({ projectType: 'expo', originals, changes: [{ ...valid, updated: '{]' }] })).toThrow('unbalanced');
  });

  it('allows provider changes only for dynamic Expo config', () => {
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([['package.json', original]]),
      changes: [patchFor('package.json', original, '{"name":"demo"}')],
    })).toThrow('dynamic root app.config');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([['metro.config.js', original]]),
      changes: [patchFor('metro.config.js', original, "module.exports = require('expo/metro-config');")],
    })).toThrow('dynamic root app.config');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([['app.json', original]]),
      changes: [patchFor('app.json', original, '{"expo":{"plugins":[]}}')],
    })).toThrow('dynamic root app.config');
  });

  it('accepts valid Android and iOS bare changes and rejects missing resolver calls', () => {
    const androidFile = 'android/app/src/main/java/demo/MainApplication.kt';
    const iosFile = 'ios/Demo/AppDelegate.swift';
    const androidOriginal = 'class MainApplication {}';
    const iosOriginal = 'class AppDelegate {}';
    const validAndroid = patchFor(
      androidFile,
      androidOriginal,
      RN71_KOTLIN_MAIN_APPLICATION,
    );
    const validIos = patchFor(
      iosFile,
      iosOriginal,
      [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
    );
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[androidFile, androidOriginal], [iosFile, iosOriginal]]),
      changes: [validAndroid, validIos],
    })).not.toThrow();

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([['metro.config.js', original]]),
      changes: [patchFor('metro.config.js', original, original)],
    })).toThrow('may not modify');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[androidFile, androidOriginal]]),
      changes: [patchFor(androidFile, androidOriginal, 'class MainApplication { fun getJSBundleFile() = null }')],
    })).toThrow('Android update');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[iosFile, iosOriginal]]),
      changes: [patchFor(iosFile, iosOriginal, 'class AppDelegate { func bundleURL() -> URL? { nil } }')],
    })).toThrow('iOS update');
  });

  it('requires every native AI patch to use explicit review-only approval', () => {
    const androidFile = 'android/app/src/main/java/demo/MainApplication.kt';
    const androidOriginal = 'class MainApplication {}';
    const validUpdate = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
      '}',
    ].join('\n');

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[androidFile, androidOriginal]]),
      changes: [{
        ...patchFor(androidFile, androidOriginal, validUpdate),
        decisionType: 'safe_auto_patch',
      }],
    })).toThrow('require explicit review-only approval');
  });

  it('rejects deletion or reordering of custom packages, analytics, and startup fallbacks', () => {
    const androidFile = 'android/app/src/main/java/demo/MainApplication.kt';
    const androidOriginal = [
      'import com.example.analytics.Analytics',
      'import com.example.packages.CustomPackage',
      'class MainApplication {',
      '  override val reactNativeHost: ReactNativeHost =',
      '    object : DefaultReactNativeHost(this) {',
      '      override fun getJSBundleFile(): String? =',
      '        CustomBundleProvider.shared.path("embedded-main")',
      '    }',
      '  override fun onCreate() {',
      '    super.onCreate()',
      '    Analytics.start(this)',
      '  }',
      '  override fun getPackages() = PackageList(this).packages.apply {',
      '    add(CustomPackage())',
      '  }',
      '}',
    ].join('\n');
    const completeUpdate = [
      'import com.bundledrop.BundleDropModule',
      'import com.example.analytics.Analytics',
      'import com.example.packages.CustomPackage',
      'class MainApplication {',
      '  override val reactNativeHost: ReactNativeHost =',
      '    object : DefaultReactNativeHost(this) {',
      '      override fun getJSBundleFile(): String? =',
      '        BundleDropModule.resolveJSBundleFile(',
      '          this@MainApplication,',
      '          CustomBundleProvider.shared.path("embedded-main"),',
      '        )',
      '    }',
      '  override fun onCreate() {',
      '    super.onCreate()',
      '    Analytics.start(this)',
      '  }',
      '  override fun getPackages() = PackageList(this).packages.apply {',
      '    add(CustomPackage())',
      '  }',
      '}',
    ].join('\n');
    const validate = (updated: string) => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[androidFile, androidOriginal]]),
      changes: [patchFor(androidFile, androidOriginal, updated)],
    });

    expect(() => validate(completeUpdate)).not.toThrow();
    expect(() => validate(completeUpdate.replace(
      '  override fun getPackages() = PackageList(this).packages.apply {\n' +
        '    add(CustomPackage())\n  }\n',
      '',
    ))).toThrow('substantive native code or ordering');
    expect(() => validate(completeUpdate.replace('    Analytics.start(this)\n', '')))
      .toThrow('substantive native code or ordering');
    expect(() => validate(completeUpdate.replace(
      '          CustomBundleProvider.shared.path("embedded-main"),',
      '          null,',
    ))).toThrow('substantive native code or ordering');
    expect(() => validate(completeUpdate.replace(
      'import com.example.analytics.Analytics\nimport com.example.packages.CustomPackage',
      'import com.example.packages.CustomPackage\nimport com.example.analytics.Analytics',
    ))).toThrow('substantive native code or ordering');
  });

  it('allows the authorized CodePush resolver replacement while preserving the startup declaration', () => {
    const androidFile = 'android/app/src/main/java/demo/MainApplication.kt';
    const codePushOriginal = [
      'import com.microsoft.codepush.react.CodePush',
      'class MainApplication {',
      '  override val reactNativeHost: ReactNativeHost =',
      '    object : DefaultReactNativeHost(this) {',
      '      override fun getJSBundleFile(): String? = CodePush.getJSBundleFile()',
      '    }',
      '}',
    ].join('\n');
    const bundleDropUpdate = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override val reactNativeHost: ReactNativeHost =',
      '    object : DefaultReactNativeHost(this) {',
      '      override fun getJSBundleFile(): String? =',
      '        BundleDropModule.resolveJSBundleFile(this@MainApplication, null)',
      '    }',
      '}',
    ].join('\n');

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[androidFile, codePushOriginal]]),
      changes: [patchFor(androidFile, codePushOriginal, bundleDropUpdate)],
    })).not.toThrow();

    const aliasedCodePushOriginal = codePushOriginal
      .replace('import com.microsoft.codepush.react.CodePush',
        'import com.microsoft.codepush.react.CodePush as LegacyCodePush')
      .replace('CodePush.getJSBundleFile()', 'LegacyCodePush.getJSBundleFile()');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[androidFile, aliasedCodePushOriginal]]),
      changes: [patchFor(androidFile, aliasedCodePushOriginal, bundleDropUpdate)],
    })).not.toThrow();

    const customAliasUse = aliasedCodePushOriginal.replace(
      'class MainApplication {',
      'class MainApplication {\n  val registeredProvider = LegacyCodePush::class.java',
    );
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[androidFile, customAliasUse]]),
      changes: [patchFor(androidFile, customAliasUse, bundleDropUpdate)],
    })).toThrow('substantive native code or ordering');

    const iosFile = 'ios/Demo/AppDelegate.mm';
    const macroCodePushOriginal = [
      '#define LegacyCodePush CodePush',
      '@implementation AppDelegate',
      '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {',
      '  return [LegacyCodePush bundleURL];',
      '}',
      '@end',
    ].join('\n');
    const iosBundleDropUpdate = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {',
      '  return [BundleDropLocator bundleURL];',
      '}',
      '@end',
    ].join('\n');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[iosFile, macroCodePushOriginal]]),
      changes: [patchFor(iosFile, macroCodePushOriginal, iosBundleDropUpdate)],
    })).not.toThrow();
  });

  it('rejects retained CodePush native co-authority before and after apply', () => {
    const projectRoot = createTempProjectDir();
    const file = 'android/app/src/main/java/demo/MainApplication.kt';
    const originalContent = 'class MainApplication {}';
    const retainedCodePush = [
      'import com.bundledrop.BundleDropModule',
      'import com.microsoft.codepush.react.CodePush as LegacyCodePush',
      'class MainApplication {',
      '  override val reactNativeHost: ReactNativeHost =',
      '    object : DefaultReactNativeHost(this) {',
      '      override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(',
      '        this@MainApplication, LegacyCodePush.getJSBundleFile(),',
      '      )',
      '    }',
      '}',
    ].join('\n');
    const change = patchFor(file, originalContent, retainedCodePush);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[file, originalContent]]),
      changes: [change],
    })).toThrow('Android update');

    const filePath = path.join(projectRoot, file);
    writeAuthoritativeNativeFile(projectRoot, file, retainedCodePush);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'bare',
      changes: [change],
    })).toThrow('Android update');

    const aliasedOriginal = [
      'import com.microsoft.codepush.react.CodePush as LegacyCodePush',
      'class MainApplication {',
      '  override val reactNativeHost: ReactNativeHost =',
      '    object : DefaultReactNativeHost(this) {',
      '      override fun getJSBundleFile() = LegacyCodePush.getJSBundleFile()',
      '    }',
      '}',
    ].join('\n');
    const aliasRetainedWithoutImport = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override val reactNativeHost: ReactNativeHost =',
      '    object : DefaultReactNativeHost(this) {',
      '      override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(',
      '        this@MainApplication, LegacyCodePush.getJSBundleFile(),',
      '      )',
      '    }',
      '}',
    ].join('\n');
    const aliasChange = patchFor(file, aliasedOriginal, aliasRetainedWithoutImport);
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[file, aliasedOriginal]]),
      changes: [aliasChange],
    })).toThrow('CodePush alias residue');
    fs.writeFileSync(filePath, aliasRetainedWithoutImport);
    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'bare',
      changes: [aliasChange],
      originals: new Map([[file, aliasedOriginal]]),
    })).toThrow('CodePush alias residue');

    const iosFile = 'ios/Demo/AppDelegate.mm';
    const macroOriginal = [
      '#define LegacyCodePush CodePush',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL { return [LegacyCodePush bundleURL]; }',
      '@end',
    ].join('\n');
    const macroAliasRetained = [
      '#import <BundleDrop/BundleDropLocator.h>',
      '@implementation AppDelegate',
      '- (NSURL *)bundleURL {',
      '  return [BundleDropLocator bundleURL] ?: [LegacyCodePush bundleURL];',
      '}',
      '@end',
    ].join('\n');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[iosFile, macroOriginal]]),
      changes: [patchFor(iosFile, macroOriginal, macroAliasRetained)],
    })).toThrow('CodePush alias residue');
    removeTempDir(projectRoot);
  });

  it('rejects invented bare native module identifiers even when resolver calls are present', () => {
    const androidFile = 'android/app/src/main/java/demo/MainApplication.kt';
    const iosFile = 'ios/Demo/AppDelegate.swift';
    const originals = new Map([[androidFile, original], [iosFile, original]]);

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals,
      changes: [patchFor(
        androidFile,
        original,
        'import com.gfean.reactnativebundledrop.BundleDropModule\nclass MainApplication { fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null) }',
      )],
    })).toThrow('Android update');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals,
      changes: [patchFor(
        iosFile,
        original,
        'import ReactNativeBundleDrop\nclass AppDelegate { func bundleURL() -> URL? { BundleDropLocator.bundleURL() } }',
      )],
    })).toThrow('iOS update');
  });

  it('validates files again after application using their current content', () => {
    const projectRoot = createTempProjectDir();
    const file = 'app.config.js';
    const filePath = path.join(projectRoot, file);
    fs.writeFileSync(
      filePath,
      'export default { plugins: ["@gfean/react-native-bundle-drop"] };',
    );
    const change = patchFor(file, original, fs.readFileSync(filePath, 'utf8'));

    expect(() => validateAppliedSetupChanges({ projectRoot, projectType: 'expo', changes: [change] })).not.toThrow();
    fs.writeFileSync(filePath, 'export default { plugins: [] };');
    expect(() => validateAppliedSetupChanges({ projectRoot, projectType: 'expo', changes: [change] }))
      .toThrow('must contain exactly one Bundle Drop plugin');
    removeTempDir(projectRoot);
  });

  it('rejects a post-apply file swapped to a symlink without reading its target', () => {
    const projectRoot = createTempProjectDir();
    const outsideRoot = createTempProjectDir();
    const file = 'app.config.js';
    const outsideFile = path.join(outsideRoot, 'secret.js');
    fs.writeFileSync(outsideFile, 'outside-secret-sentinel');
    fs.symlinkSync(outsideFile, path.join(projectRoot, file));
    const change = patchFor(file, original, 'export default { plugins: [] };');

    expect(() => validateAppliedSetupChanges({ projectRoot, projectType: 'expo', changes: [change] }))
      .toThrow('symlinked or non-regular transaction target');
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside-secret-sentinel');
    removeTempDir(projectRoot);
    removeTempDir(outsideRoot);
  });

  it('rejects native post-apply entrypoints not selected by platform principals', () => {
    const projectRoot = createTempProjectDir();
    const androidFile = 'android/app/src/main/kotlin/com/demo/MainApplication.kt';
    const iosFile = 'ios/Demo/AppDelegate.m';
    for (const [file, content] of [
      [androidFile, RN71_KOTLIN_MAIN_APPLICATION],
      [iosFile, [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '@end',
      ].join('\n')],
    ] as const) {
      const filePath = path.join(projectRoot, file);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    fs.writeFileSync(
      path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
      '<manifest><application android:name=".CustomApplication" /></manifest>',
    );
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Demo/main.m'),
      'int main(int argc, char **argv) { return UIApplicationMain(argc, argv, nil, @"OtherDelegate"); }',
    );

    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'bare',
      changes: [
        patchFor(androidFile, RN71_KOTLIN_MAIN_APPLICATION, RN71_KOTLIN_MAIN_APPLICATION),
        patchFor(iosFile, 'class Placeholder {}', fs.readFileSync(path.join(projectRoot, iosFile), 'utf8')),
      ],
    })).toThrow('entrypoint authority is invalid');
    removeTempDir(projectRoot);
  });

  it('rejects a post-apply Swift principal hidden in a string beside the real principal', () => {
    const projectRoot = createTempProjectDir();
    const file = 'ios/Demo/AppDelegate.swift';
    const content = [
      'import BundleDrop',
      'let documentation = "@main class AppDelegate"',
      'class AppDelegate: RCTAppDelegate {',
      '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
      '}',
    ].join('\n');
    writeAuthoritativeNativeFile(projectRoot, file, content);
    fs.writeFileSync(
      path.join(projectRoot, 'ios/Demo/RealApp.swift'),
      '@main struct RealApp { static func main() {} }',
    );

    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'bare',
      changes: [patchFor(file, 'class AppDelegate {}', content)],
    })).toThrow('entrypoint authority');
    removeTempDir(projectRoot);
  });

  it('rejects a parameterized Android onCreate overload during post-apply validation', () => {
    const projectRoot = createTempProjectDir();
    const file = 'android/app/src/main/java/demo/MainApplication.kt';
    const invalidAppliedContent = [
      'import com.bundledrop.BundleDropModule',
      'class MainApplication {',
      '  override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
      '  fun onCreate(test: Boolean) { super.onCreate(); loadReactNative(this) }',
      '}',
    ].join('\n');
    const authoritativeContent = writeAuthoritativeNativeFile(
      projectRoot,
      file,
      invalidAppliedContent,
    );
    const change = patchFor(file, 'class MainApplication {}', authoritativeContent);

    expect(() => validateAppliedSetupChanges({ projectRoot, projectType: 'bare', changes: [change] }))
      .toThrow('Android update');
    removeTempDir(projectRoot);
  });

  it('accepts archived RN85 NativePaths and connected Swift delegate post-apply', () => {
    const projectRoot = createTempProjectDir();
    const changes = [
      patchFor(
        'android/app/src/main/java/demo/MainApplication.kt',
        RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION,
        RN85_ANDROID_NATIVE_PATHS_MAIN_APPLICATION,
      ),
      patchFor(
        'ios/Demo/AppDelegate.swift',
        RN85_SWIFT_APP_DELEGATE,
        RN85_SWIFT_APP_DELEGATE,
      ),
    ];
    for (const change of changes) {
      change.updated = writeAuthoritativeNativeFile(projectRoot, change.file, change.updated);
    }

    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'bare',
      changes,
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('accepts the RN71 Java multiline local fallback post-apply', () => {
    const projectRoot = createTempProjectDir();
    const file = 'android/app/src/main/java/com/demo/MainApplication.java';
    const updated = writeAuthoritativeNativeFile(
      projectRoot,
      file,
      RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION,
    );

    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'bare',
      changes: [patchFor(file, 'public class MainApplication {}', updated)],
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('accepts the preserved Kotlin conditional local fallback post-apply', () => {
    const projectRoot = createTempProjectDir();
    const file = 'android/app/src/main/kotlin/com/demo/MainApplication.kt';
    const updated = writeAuthoritativeNativeFile(
      projectRoot,
      file,
      RN71_KOTLIN_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
    );

    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'bare',
      changes: [patchFor(file, 'class MainApplication {}', updated)],
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('accepts the preserved Java conditional local fallback post-apply', () => {
    const projectRoot = createTempProjectDir();
    const file = 'android/app/src/main/java/com/demo/MainApplication.java';
    const updated = writeAuthoritativeNativeFile(
      projectRoot,
      file,
      RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION,
    );

    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'bare',
      changes: [patchFor(file, 'public class MainApplication {}', updated)],
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it('accepts RN71 Objective-C delegated startup and preserves DEBUG Metro fallback post-apply', () => {
    const projectRoot = createTempProjectDir();
    const file = 'ios/Demo/AppDelegate.m';
    const updated = writeAuthoritativeNativeFile(
      projectRoot,
      file,
      RN71_OBJC_APP_DELEGATE,
    );

    expect(() => validateAppliedSetupChanges({
      projectRoot,
      projectType: 'bare',
      changes: [patchFor(file, RN71_OBJC_APP_DELEGATE, updated)],
      originals: new Map([[file, RN71_OBJC_APP_DELEGATE]]),
    })).not.toThrow();
    removeTempDir(projectRoot);
  });

  it.each([
    {
      label: 'nested Kotlin comment resolver',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: [
        'package com.demo',
        'class MainApplication {',
        '  /* outer /* nested */',
        '    import com.bundledrop.BundleDropModule',
        '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null)',
        '  */',
        '}',
      ].join('\n'),
      error: 'Android update',
    },
    {
      label: 'Kotlin raw multiline string resolver and host decoy',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: [
        'package com.demo',
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  val documentation = """ "',
        '  private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
        '  override val reactHost: ReactHost by lazy {',
        '    getDefaultReactHost(jsBundleFilePath = getJSBundleFile())',
        '  }',
        '  " """',
        '}',
      ].join('\n'),
      error: 'Android update',
    },
    {
      label: 'nested Swift comment resolver',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  /* outer /* nested */',
        '    override func bundleURL() -> URL? { return BundleDropLocator.bundleURL() }',
        '  */',
        '}',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'Swift multiline string resolver decoy',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  let documentation = """ "',
        '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '  " """',
        '}',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'conditional Android Release bypass',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: modernPostApplyProbe(
        'private fun getJSBundleFile(): String? { return if (useOta) BundleDropModule.resolveJSBundleFile(this, null) else "/android_asset/index.android.bundle" }',
      ),
      error: 'Android update',
    },
    {
      label: 'near-match Android resolver',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: modernPostApplyProbe(
        'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFileForTests(this, null)',
      ),
      error: 'Android update',
    },
    {
      label: 'wrong Android resolver context',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: modernPostApplyProbe(
        'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(42, null)',
      ),
      error: 'Android update',
    },
    {
      label: 'transformed Java resolver return',
      file: 'android/app/src/main/java/demo/MainApplication.java',
      content: RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace(
        '      );',
        '      ).trim();',
      ),
      error: 'Android update',
    },
    {
      label: 'Java fallback ternary with a statement branch',
      file: 'android/app/src/main/java/demo/MainApplication.java',
      content: RN71_JAVA_CONDITIONAL_FALLBACK_MAIN_APPLICATION.replace(
        '? selectEnterpriseBundle()',
        '? return selectEnterpriseBundle()',
      ),
      error: 'Android update',
    },
    {
      label: 'Java resolver with Kotlin non-null suffix',
      file: 'android/app/src/main/java/demo/MainApplication.java',
      content: RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace('      );', '      )!!;'),
      error: 'Android update',
    },
    {
      label: 'Java anonymous host with wrong this receiver',
      file: 'android/app/src/main/java/demo/MainApplication.java',
      content: RN71_JAVA_LOCAL_FALLBACK_MAIN_APPLICATION.replace(
        'getApplicationContext(),',
        'this,',
      ),
      error: 'Android update',
    },
    {
      label: 'Kotlin anonymous host with Java receiver syntax',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION.replace(
        'this@MainApplication,',
        'MainApplication.this,',
      ),
      error: 'Android update',
    },
    {
      label: 'non-null Kotlin resolver without unwrap',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION.replace('          )!!', '          )'),
      error: 'Android update',
    },
    {
      label: 'mismatched Android import alias',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: modernPostApplyProbe(
        'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
      ).replace('import com.bundledrop.BundleDropModule', 'import com.bundledrop.BundleDropModule as BDM'),
      error: 'Android update',
    },
    {
      label: 'early modern Android host bypass',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: modernPostApplyProbe(
        'private fun getJSBundleFile(): String? = BundleDropModule.resolveJSBundleFile(this, null)',
        'if (useCustom) return@lazy customReactHost',
      ),
      error: 'Android update',
    },
    {
      label: 'conditional Swift Release bypass',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  override func bundleURL() -> URL? {',
        '    return useOta ? BundleDropLocator.bundleURL() : Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        '  }',
        '}',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'RN85 sourceURL bypass',
      file: 'ios/Demo/AppDelegate.swift',
      content: RN85_SWIFT_APP_DELEGATE.replace(
        '    self.bundleURL()',
        '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
      ),
      error: 'iOS update',
    },
    {
      label: 'direct Swift sourceURL bypass',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate: RCTAppDelegate {',
        '  override func bundleURL() -> URL? { return BundleDropLocator.bundleURL() }',
        '  override func sourceURL(for bridge: RCTBridge) -> URL? {',
        '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        '  }',
        '}',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'ignored Objective-C delegation',
      file: 'ios/Demo/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {',
        '  [self bundleURL];',
        '  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];',
        '}',
        '@end',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'parameterized Kotlin resolver',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  override fun getJSBundleFile(test: Boolean) =',
        '    BundleDropModule.resolveJSBundleFile(this, null)',
        '}',
      ].join('\n'),
      error: 'Android update',
    },
    {
      label: 'parameterized Java resolver',
      file: 'android/app/src/main/java/demo/MainApplication.java',
      content: [
        'import com.bundledrop.BundleDropModule;',
        'public class MainApplication {',
        '  public String getJSBundleFile(boolean test) {',
        '    return BundleDropModule.resolveJSBundleFile(this, null);',
        '  }',
        '}',
      ].join('\n'),
      error: 'Android update',
    },
    {
      label: 'parameterized Swift resolver',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate {',
        '  func bundleURL(test: Bool) -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'unconnected Swift factory delegate',
      file: 'ios/Demo/AppDelegate.swift',
      content: RN85_SWIFT_APP_DELEGATE.replace(
        'RCTReactNativeFactory(delegate: delegate)',
        'RCTReactNativeFactory(delegate: ReactNativeDelegate())',
      ),
      error: 'iOS update',
    },
    {
      label: 'Objective-C AppDelegate category',
      file: 'ios/Demo/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate (BundleDrop)',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '@end',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'duplicate Objective-C AppDelegate implementation',
      file: 'ios/Demo/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)bundleURL { return [BundleDropLocator bundleURL]; }',
        '@end',
        '@implementation AppDelegate',
        '@end',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'dead modern Kotlin host connection',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: MODERN_KOTLIN_MAIN_APPLICATION
        .replace('jsBundleFilePath = getJSBundleFile(),', 'isHermesEnabled = true,')
        .replace(
          '\n}',
          '\n  fun deadHost() = getDefaultReactHost(jsBundleFilePath = getJSBundleFile())\n}',
        ),
      error: 'Android update',
    },
    {
      label: 'unused legacy Kotlin host',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: RN71_KOTLIN_MAIN_APPLICATION.replace(
        'override val reactNativeHost',
        'val unusedHost',
      ),
      error: 'Android update',
    },
    {
      label: 'nested legacy Kotlin authority getter',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: [
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  val deadHost: ReactNativeHost = object : DefaultReactNativeHost(this) {',
        '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this@MainApplication, null)',
        '  }',
        '  val actualHost: ReactNativeHost = object : DefaultReactNativeHost(this) {}',
        '  override val reactNativeHost: ReactNativeHost get() = actualHost',
        '  class Helper {',
        '    override val reactNativeHost: ReactNativeHost get() = deadHost',
        '  }',
        '}',
      ].join('\n'),
      error: 'Android update',
    },
    {
      label: 'anonymous legacy Kotlin authority getter',
      file: 'android/app/src/main/java/demo/MainApplication.kt',
      content: [
        'package com.demo',
        'import com.bundledrop.BundleDropModule',
        'class MainApplication {',
        '  val deadHost: ReactNativeHost = object : DefaultReactNativeHost(this) {',
        '    override fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this@MainApplication, null)',
        '  }',
        '  val deadApplication = object : ReactApplication {',
        '    override val reactNativeHost: ReactNativeHost get() = deadHost',
        '  }',
        '}',
      ].join('\n'),
      error: 'Android update',
    },
    {
      label: 'dead Swift AppDelegate beside the real principal',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        '@main class RealAppDelegate: UIResponder, UIApplicationDelegate {}',
        'class AppDelegate: RCTAppDelegate {',
        '  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }',
        '}',
      ].join('\n'),
      error: 'entrypoint authority',
    },
    {
      label: 'DEBUG-only Swift resolver',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate {',
        '  func bundleURL() -> URL? {',
        '#if DEBUG',
        '    return BundleDropLocator.bundleURL()',
        '#else',
        '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        '#endif',
        '  }',
        '}',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'ignored Objective-C resolver result',
      file: 'ios/Demo/AppDelegate.mm',
      content: [
        '#import <BundleDrop/BundleDropLocator.h>',
        '@implementation AppDelegate',
        '- (NSURL *)bundleURL { [BundleDropLocator bundleURL]; return nil; }',
        '@end',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'cross-statement Swift resolver result',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate {',
        '  func bundleURL() -> URL? {',
        '    let otaURL = Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        '    BundleDropLocator.bundleURL()',
        '    return otaURL',
        '  }',
        '}',
      ].join('\n'),
      error: 'iOS update',
    },
    {
      label: 'DEBUG-only mixed Swift preprocessor branch',
      file: 'ios/Demo/AppDelegate.swift',
      content: [
        'import BundleDrop',
        'class AppDelegate {',
        '  func bundleURL() -> URL? {',
        '#if FEATURE_PREVIEW',
        '    return Bundle.main.url(forResource: "preview", withExtension: "jsbundle")',
        '#elseif DEBUG',
        '    return BundleDropLocator.bundleURL()',
        '#else',
        '    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        '#endif',
        '  }',
        '}',
      ].join('\n'),
      error: 'iOS update',
    },
  ])('rejects a $label during post-apply validation', ({ file, content, error }) => {
    const projectRoot = createTempProjectDir();
    const authoritativeContent = writeAuthoritativeNativeFile(projectRoot, file, content);
    const change = patchFor(file, 'class Placeholder {}', authoritativeContent);

    expect(() => validateAppliedSetupChanges({ projectRoot, projectType: 'bare', changes: [change] }))
      .toThrow(error);
    removeTempDir(projectRoot);
  });
});
