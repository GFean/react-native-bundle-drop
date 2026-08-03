import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  applySetupPatchPlans,
  restoreSetupBackups,
} from '../../../../CLI/scripts/aipowered/apply-setup-plan';
import type { AiPatchPlan } from '../../../../CLI/scripts/aipowered/types';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

const hash = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

const changeFor = (file: string, original: string, updated: string): AiPatchPlan => ({
  file,
  originalSha256: hash(original),
  updated,
  reason: 'Configure Bundle Drop',
  confidence: 'high',
  decisionType: 'safe_auto_patch',
});

describe('CLI/scripts/aipowered/apply-setup-plan', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = createTempProjectDir();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  const write = (relativePath: string, content: string) => {
    const filePath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  it('applies and restores allowlisted Expo patches with hash-bound backups', () => {
    const originalApp = '{"expo":{"plugins":[]}}\n';
    const originalMetro = 'module.exports = {};\n';
    const appPath = write('app.json', originalApp);
    const metroPath = write('metro.config.js', originalMetro);
    const changes = [
      changeFor(
        'app.json',
        originalApp,
        '{"expo":{"plugins":["@gfean/react-native-bundle-drop"]}}\n',
      ),
      changeFor(
        'metro.config.js',
        originalMetro,
        "module.exports = withBundleDropExpo(require('expo/metro-config'));\n",
      ),
    ];

    const result = applySetupPatchPlans({ projectRoot, projectType: 'expo', changes });

    expect(result.changedFiles).toEqual(['app.json', 'metro.config.js']);
    expect(fs.readFileSync(appPath, 'utf8')).toBe(changes[0].updated);
    expect(fs.readFileSync(metroPath, 'utf8')).toBe(changes[1].updated);
    expect(fs.readFileSync(path.join(result.backupDir, 'app.json'), 'utf8')).toBe(originalApp);

    restoreSetupBackups(result);
    expect(fs.readFileSync(appPath, 'utf8')).toBe(originalApp);
    expect(fs.readFileSync(metroPath, 'utf8')).toBe(originalMetro);
  });

  it('allows bare native entrypoints but keeps the Expo and bare allowlists isolated', () => {
    const original = 'class MainApplication {}\n';
    const file = 'android/app/src/main/java/com/demo/MainApplication.kt';
    const targetPath = write(file, original);
    const change = changeFor(
      file,
      original,
      'class MainApplication { fun getJSBundleFile() = BundleDropModule.resolveJSBundleFile(this, null) }\n',
    );

    applySetupPatchPlans({ projectRoot, projectType: 'bare', changes: [change] });
    expect(fs.readFileSync(targetPath, 'utf8')).toContain('resolveJSBundleFile');

    expect(() =>
      applySetupPatchPlans({ projectRoot, projectType: 'expo', changes: [change] }),
    ).toThrow('outside its allowlist');
    expect(() =>
      applySetupPatchPlans({
        projectRoot,
        projectType: 'bare',
        changes: [changeFor('app.json', '', '{}')],
      }),
    ).toThrow('outside its allowlist');
  });

  it.each(['../app.json', '/tmp/app.json', 'config\\app.json', 'app.json/../secret']) (
    'rejects unsafe path %s before reading or writing it',
    unsafePath => {
      expect(() =>
        applySetupPatchPlans({
          projectRoot,
          projectType: 'expo',
          changes: [changeFor(unsafePath, '', '{}')],
        }),
      ).toThrow('outside its allowlist');
    },
  );

  it('rejects a stale hash without mutating the file', () => {
    const appPath = write('app.json', '{"expo":{}}\n');

    expect(() =>
      applySetupPatchPlans({
        projectRoot,
        projectType: 'expo',
        changes: [changeFor('app.json', 'older content', '{"expo":{"plugins":[]}}')],
      }),
    ).toThrow('File changed since AI setup scan');
    expect(fs.readFileSync(appPath, 'utf8')).toBe('{"expo":{}}\n');
  });

  it('rolls back earlier writes when a later hash check fails', () => {
    const originalApp = '{"expo":{}}\n';
    const originalMetro = 'module.exports = {};\n';
    const appPath = write('app.json', originalApp);
    const metroPath = write('metro.config.js', originalMetro);

    expect(() =>
      applySetupPatchPlans({
        projectRoot,
        projectType: 'expo',
        changes: [
          changeFor('app.json', originalApp, '{"expo":{"plugins":["bundle-drop"]}}\n'),
          changeFor('metro.config.js', 'stale', 'module.exports = withBundleDropExpo({});\n'),
        ],
      }),
    ).toThrow('File changed since AI setup scan');

    expect(fs.readFileSync(appPath, 'utf8')).toBe(originalApp);
    expect(fs.readFileSync(metroPath, 'utf8')).toBe(originalMetro);
  });

  it('fails closed for an allowlisted file that disappeared after preview', () => {
    expect(() =>
      applySetupPatchPlans({
        projectRoot,
        projectType: 'expo',
        changes: [changeFor('app.json', '{}', '{"expo":{}}')],
      }),
    ).toThrow();
  });
});
