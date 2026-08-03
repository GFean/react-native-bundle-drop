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
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

const hash = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

const patchFor = (file: string, original: string, updated: string): AiPatchPlan => ({
  file,
  originalSha256: hash(original),
  updated,
  reason: 'test',
  confidence: 'high',
  decisionType: 'safe_auto_patch',
});

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

  it('accepts valid Expo app-config and Metro changes', () => {
    const changes = [
      patchFor(
        'app.config.ts',
        original,
        "export default { plugins: ['@gfean/react-native-bundle-drop'] };\n",
      ),
      patchFor(
        'metro.config.cjs',
        original,
        "module.exports = withBundleDropExpo(require('expo/metro-config'));\n",
      ),
    ];
    const originals = new Map(changes.map(change => [change.file, original]));

    expect(() =>
      validateSetupChangesBeforeApply({ projectType: 'expo', originals, changes }),
    ).not.toThrow();
  });

  it('rejects common unsafe, stale, duplicate, empty, placeholder, and malformed changes', () => {
    const valid = patchFor(
      'app.json',
      original,
      '{"expo":{"plugins":["@gfean/react-native-bundle-drop"]}}',
    );
    const originals = new Map([[valid.file, original]]);

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

  it('rejects Expo changes outside the allowlist or missing required integration markers', () => {
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([['package.json', original]]),
      changes: [patchFor('package.json', original, '{"name":"demo"}')],
    })).toThrow('may not modify');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([['metro.config.js', original]]),
      changes: [patchFor('metro.config.js', original, "module.exports = require('expo/metro-config');")],
    })).toThrow('missing the Bundle Drop wrapper');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'expo',
      originals: new Map([['app.json', original]]),
      changes: [patchFor('app.json', original, '{"expo":{"plugins":[]}}')],
    })).toThrow('missing the Bundle Drop plugin');
  });

  it('accepts valid Android and iOS bare changes and rejects missing resolver calls', () => {
    const androidFile = 'android/app/src/main/java/demo/MainApplication.kt';
    const iosFile = 'ios/Demo/AppDelegate.swift';
    const validAndroid = patchFor(
      androidFile,
      original,
      'import com.bundledrop.BundleDropModule\nclass MainApplication { fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null) }',
    );
    const validIos = patchFor(
      iosFile,
      original,
      'import BundleDrop\nclass AppDelegate { func bundleURL() -> URL? { BundleDropLocator.bundleURL() } }',
    );
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[androidFile, original], [iosFile, original]]),
      changes: [validAndroid, validIos],
    })).not.toThrow();

    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([['metro.config.js', original]]),
      changes: [patchFor('metro.config.js', original, original)],
    })).toThrow('may not modify');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[androidFile, original]]),
      changes: [patchFor(androidFile, original, 'class MainApplication { fun getJSBundleFile() = null }')],
    })).toThrow('Android update');
    expect(() => validateSetupChangesBeforeApply({
      projectType: 'bare',
      originals: new Map([[iosFile, original]]),
      changes: [patchFor(iosFile, original, 'class AppDelegate { func bundleURL() -> URL? { nil } }')],
    })).toThrow('iOS update');
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
    const file = 'app.json';
    const filePath = path.join(projectRoot, file);
    fs.writeFileSync(filePath, '{"expo":{"plugins":["@gfean/react-native-bundle-drop"]}}');
    const change = patchFor(file, original, fs.readFileSync(filePath, 'utf8'));

    expect(() => validateAppliedSetupChanges({ projectRoot, projectType: 'expo', changes: [change] })).not.toThrow();
    fs.writeFileSync(filePath, '{"expo":{"plugins":[]}}');
    expect(() => validateAppliedSetupChanges({ projectRoot, projectType: 'expo', changes: [change] })).toThrow('missing the Bundle Drop plugin');
    removeTempDir(projectRoot);
  });
});
