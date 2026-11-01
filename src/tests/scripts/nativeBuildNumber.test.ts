import fs from 'fs';
import os from 'os';
import path from 'path';
import { androidBuildNumber, expoBuildNumber, iosBuildNumber, normalizeBuildNumber, readAndroidBuildNumber } from '../../scripts/nativeBuildNumber';
import type { ExpoBuildIdentity } from '../../expo/types';

describe('optional native build number metadata', () => {
  let root: string;
  const write = (name: string, content: string) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const settings = (value: string) => `ID = { buildSettings = { CURRENT_PROJECT_VERSION = ${value}; }; };`;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-build-number-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it.each([
    ['android', 122132, '122132'], ['android', ' 42 ', '42'], ['android', 0, null],
    ['android', '1.2', null], ['android', -1, null], ['android', '2100000001', null],
    ['android', '99999999999999999999', null], ['android', {}, null],
    ['ios', '12.3.4', '12.3.4'], ['ios', 1, '1'], ['ios', '1.2.3.4', null],
    ['ios', '1'.repeat(65), null], ['ios', '$BUILD_NUMBER', null], ['ios', null, null],
  ] as const)('normalizes %s build number %j', (platform, value, expected) => {
    expect(normalizeBuildNumber(value, platform)).toBe(expected);
  });

  it.each([
    ['android { defaultConfig { versionCode 122132 } }', '122132'],
    ['android { defaultConfig {\r\n versionCode = 42;\r\n} }', '42'],
    ['// versionCode 999\n android { defaultConfig { /* versionCode 7 */ versionCode 12 // comment\n minSdk 26\n} }', '12'],
    ['def text = "versionCode 9"; android { defaultConfig { versionCode 3 } }', '3'],
    ['{ }\nandroid { defaultConfig { versionCode 4\n} }', '4'],
    ['android { defaultConfig { versionCode 6', '6'],
    ['android { defaultConfig { versionCode = getBuildNumber() } }', null],
    ['android { defaultConfig { versionCode 12 + 1 } }', null],
    ['android { defaultConfig { versionCode 12\n + 1 } }', null],
    ['android { defaultConfig { versionCode 12\n', '12'],
    ['android { defaultConfig { versionCode 12\n\n targetSdk 35 } }', '12'],
    ['android { defaultConfig { versionCode 12 }; productFlavors { free {} } }', null],
    ['android { defaultConfig { versionCode 12 }; buildTypes { release { versionCode 13 } } }', null],
    ['android { defaultConfig { versionCode 12 }; setVersionCode(14) }', null],
    ['android { defaultConfig { versionCode 12 }; versionCodeOverride = 14 }', null],
    ['versionCode 12', null], ['defaultConfig { nested { versionCode 12 } }', null],
    ['defaultConfig { android.versionCode = 12 }', null],
    ['defaultConfig { versionCode 0 }', null], ['defaultConfig { versionCode }', null],
    ['def text = /versionCode 7/; defaultConfig { versionCode 12 }', null],
    ['defaultConfig { versionCode 12 }; "unclosed', null], ['', null],
  ])('reads only an unambiguous Gradle literal: %s', (source, expected) => {
    expect(androidBuildNumber(source)).toBe(expected);
  });

  it('reads a selected Gradle file, with Kotlin DSL support and no ambiguous default selection', () => {
    expect(readAndroidBuildNumber(root)).toBeNull();
    write('android/app/build.gradle.kts', 'android { defaultConfig { versionCode = 122132 } }');
    expect(readAndroidBuildNumber(root)).toBe('122132');
    write('android/app/build.gradle', 'android { defaultConfig { versionCode 42 } }');
    expect(readAndroidBuildNumber(root)).toBeNull();
    expect(readAndroidBuildNumber(root, 'android/app/build.gradle')).toBe('42');
    expect(readAndroidBuildNumber(root, 'absent.gradle')).toBeNull();
  });

  it('reads a literal CFBundleVersion or unambiguous standard Xcode build settings', () => {
    expect(iosBuildNumber('12.3', root)).toBe('12.3');
    expect(iosBuildNumber('$(OTHER_VALUE)', root)).toBeNull();
    expect(iosBuildNumber('$(CURRENT_PROJECT_VERSION)', root)).toBeNull();
    fs.mkdirSync(path.join(root, 'ios/Example.xcodeproj'), { recursive: true });
    expect(iosBuildNumber('$(CURRENT_PROJECT_VERSION)', root)).toBeNull();
    write('ios/Example.xcodeproj/project.pbxproj', `{ ${settings('42')} ${settings('"42"')} }`);
    expect(iosBuildNumber('$(CURRENT_PROJECT_VERSION)', root)).toBe('42');
    expect(iosBuildNumber('${CURRENT_PROJECT_VERSION}', root)).toBe('42');
    write('ios/Other.xcodeproj/project.pbxproj', '{}');
    expect(iosBuildNumber('$(CURRENT_PROJECT_VERSION)', root)).toBeNull();
  });

  it('resolves the standard Xcode variable with ordinary unquoted resource and source paths', () => {
    write('ios/Example.xcodeproj/project.pbxproj', `
      // !$*UTF8*$!
      {
        objects = {
          SOURCE = { path = Example/AppDelegate.swift; sourceTree = "<group>"; };
          RESOURCE = { path = Example/Images.xcassets; sourceTree = "<group>"; };
          DEBUG = { buildSettings = {
            INFOPLIST_FILE = Example/Info.plist;
            CURRENT_PROJECT_VERSION = 42;
          }; };
          RELEASE = { buildSettings = { CURRENT_PROJECT_VERSION = "42"; }; };
        };
      }
    `);
    expect(iosBuildNumber('$(CURRENT_PROJECT_VERSION)', root)).toBe('42');
    expect(iosBuildNumber('${CURRENT_PROJECT_VERSION}', root)).toBe('42');
  });

  it.each([
    `{ ${settings('1')} ${settings('2')} }`,
    '{ buildSettings = { CURRENT_PROJECT_VERSION = "$(OTHER_VALUE)"; }; }',
    `{ ${settings('42 / 2')} }`,
    `{ ${settings('"42/2"')} }`,
    '{ buildSettings = { CURRENT_PROJECT_VERSION[sdk=iphoneos*] = 42; }; }',
    '{ buildSettings = { CURRENT_PROJECT_VERSION = 42 } }',
    '{ CURRENT_PROJECT_VERSION = 42; }',
    '{ comment = "CURRENT_PROJECT_VERSION = 42;"; }',
    '{ buildSettings = { /* CURRENT_PROJECT_VERSION = 42; */ }; }',
    '{ comment = "unterminated }',
    '{ }',
  ])('leaves ambiguous Xcode settings unknown: %s', content => {
    write('ios/Example.xcodeproj/project.pbxproj', content);
    expect(iosBuildNumber('$(CURRENT_PROJECT_VERSION)', root)).toBeNull();
  });

  it('uses the resolved Expo identity including remote build numbers', () => {
    const identity = { appVersion: '1.0.0', platform: 'android', nativeVersion: '1.0.0(122132)' } as ExpoBuildIdentity;
    expect(expoBuildNumber(identity)).toBe('122132');
    expect(expoBuildNumber({ ...identity, nativeVersion: '2.0.0(12)' })).toBeNull();
    expect(expoBuildNumber({ ...identity, nativeVersion: '1.0.0(12' })).toBeNull();
    expect(expoBuildNumber({ ...identity, nativeVersion: '1.0.0(no)' })).toBeNull();
  });
});
