import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveIosPlistVersion, resolveXcodeBuildSetting } from '../../scripts/resolve-ios-version';

describe('resolve-ios-version', () => {
  let tmpDir: string;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-ios-ver-'));
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveXcodeBuildSetting', () => {
    it('reads MARKETING_VERSION from .pbxproj', () => {
      const projDir = path.join(tmpDir, 'ios', 'MyApp.xcodeproj');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, 'project.pbxproj'),
        'MARKETING_VERSION = 2.5.1;\nother = stuff;',
      );

      expect(resolveXcodeBuildSetting(tmpDir, 'MARKETING_VERSION')).toBe('2.5.1');
    });

    it('strips quotes from the value', () => {
      const projDir = path.join(tmpDir, 'ios', 'MyApp.xcodeproj');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, 'project.pbxproj'),
        'MARKETING_VERSION = "3.0.0";',
      );

      expect(resolveXcodeBuildSetting(tmpDir, 'MARKETING_VERSION')).toBe('3.0.0');
    });

    it('returns null when ios directory does not exist', () => {
      expect(resolveXcodeBuildSetting(tmpDir, 'MARKETING_VERSION')).toBeNull();
    });

    it('returns null when no .xcodeproj exists', () => {
      fs.mkdirSync(path.join(tmpDir, 'ios'), { recursive: true });
      expect(resolveXcodeBuildSetting(tmpDir, 'MARKETING_VERSION')).toBeNull();
    });

    it('returns null when .xcodeproj exists but project.pbxproj is missing', () => {
      fs.mkdirSync(path.join(tmpDir, 'ios', 'App.xcodeproj'), { recursive: true });
      expect(resolveXcodeBuildSetting(tmpDir, 'MARKETING_VERSION')).toBeNull();
    });

    it('returns null when variable is not in pbxproj', () => {
      const projDir = path.join(tmpDir, 'ios', 'App.xcodeproj');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, 'project.pbxproj'),
        'OTHER_SETTING = foo;',
      );

      expect(resolveXcodeBuildSetting(tmpDir, 'MARKETING_VERSION')).toBeNull();
    });

    it('returns null when value itself is an unresolved variable', () => {
      const projDir = path.join(tmpDir, 'ios', 'App.xcodeproj');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, 'project.pbxproj'),
        'MARKETING_VERSION = $(OTHER_VAR);',
      );

      expect(resolveXcodeBuildSetting(tmpDir, 'MARKETING_VERSION')).toBeNull();
    });
  });

  describe('resolveIosPlistVersion', () => {
    it('returns literal version strings as-is', () => {
      expect(resolveIosPlistVersion('1.2.3', tmpDir)).toBe('1.2.3');
    });

    it('resolves $(MARKETING_VERSION) from pbxproj', () => {
      const projDir = path.join(tmpDir, 'ios', 'App.xcodeproj');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, 'project.pbxproj'),
        'MARKETING_VERSION = 4.1.0;',
      );

      expect(resolveIosPlistVersion('$(MARKETING_VERSION)', tmpDir)).toBe('4.1.0');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('resolved to "4.1.0"'),
      );
    });

    it('returns null and logs error when variable cannot be resolved', () => {
      expect(resolveIosPlistVersion('$(MARKETING_VERSION)', tmpDir)).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not be resolved'),
      );
    });
  });
});
