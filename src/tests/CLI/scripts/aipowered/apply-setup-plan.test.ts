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

  it('uses random exclusive temps and rejects target, parent, and backup symlink escapes', () => {
    const outsideRoot = createTempProjectDir();
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt');
    fs.writeFileSync(outsideSentinel, 'outside-safe');
    try {
      const original = '{"expo":{}}\n';
      const appPath = write('app.json', original);
      fs.symlinkSync(outsideSentinel, `${appPath}.bundledrop-tmp`);
      applySetupPatchPlans({
        projectRoot,
        projectType: 'expo',
        changes: [changeFor('app.json', original, '{"expo":{"plugins":[]}}\n')],
      });
      expect(fs.readFileSync(outsideSentinel, 'utf8')).toBe('outside-safe');

      fs.rmSync(path.join(projectRoot, '.bundledrop-backup'), { recursive: true });
      fs.symlinkSync(outsideRoot, path.join(projectRoot, '.bundledrop-backup'));
      expect(() => applySetupPatchPlans({
        projectRoot,
        projectType: 'expo',
        changes: [changeFor('app.json', '{"expo":{"plugins":[]}}\n', original)],
      })).toThrow('symlinked or non-directory');
      expect(fs.readFileSync(outsideSentinel, 'utf8')).toBe('outside-safe');

      fs.unlinkSync(path.join(projectRoot, '.bundledrop-backup'));
      fs.unlinkSync(appPath);
      fs.symlinkSync(outsideSentinel, appPath);
      expect(() => applySetupPatchPlans({
        projectRoot,
        projectType: 'expo',
        changes: [changeFor('app.json', 'outside-safe', original)],
      })).toThrow('symlinked or non-regular');
      expect(fs.readFileSync(outsideSentinel, 'utf8')).toBe('outside-safe');

      fs.unlinkSync(appPath);
      fs.symlinkSync(outsideRoot, path.join(projectRoot, 'android'));
      expect(() => applySetupPatchPlans({
        projectRoot,
        projectType: 'bare',
        changes: [changeFor(
          'android/app/src/main/java/demo/MainApplication.kt',
          'outside-safe',
          'updated',
        )],
      })).toThrow('symlinked or non-directory');
      expect(fs.readFileSync(outsideSentinel, 'utf8')).toBe('outside-safe');
    } finally {
      removeTempDir(outsideRoot);
    }
  });

  it('rolls back an earlier write when a later target is a symlink', () => {
    const outsideRoot = createTempProjectDir();
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt');
    fs.writeFileSync(outsideSentinel, 'outside-safe');
    const originalApp = '{"expo":{}}\n';
    const appPath = write('app.json', originalApp);
    fs.symlinkSync(outsideSentinel, path.join(projectRoot, 'metro.config.js'));
    try {
      expect(() => applySetupPatchPlans({
        projectRoot,
        projectType: 'expo',
        changes: [
          changeFor('app.json', originalApp, '{"expo":{"plugins":[]}}\n'),
          changeFor('metro.config.js', 'outside-safe', 'module.exports = {};\n'),
        ],
      })).toThrow('symlinked or non-regular');
      expect(fs.readFileSync(appPath, 'utf8')).toBe(originalApp);
      expect(fs.readFileSync(outsideSentinel, 'utf8')).toBe('outside-safe');
    } finally {
      removeTempDir(outsideRoot);
    }
  });
});
