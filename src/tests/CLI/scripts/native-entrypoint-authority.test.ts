import fs from 'fs';
import path from 'path';

import { findNativeEntrypointAuthorityIssue } from '../../../CLI/scripts/native-entrypoint-authority';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

describe('CLI/scripts/native-entrypoint-authority', () => {
  let projectRoot = '';

  const write = (relativePath: string, content: string) => {
    const filePath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  beforeEach(() => {
    projectRoot = createTempProjectDir();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  it('treats an absent platform as out of scope and duplicate entrypoints as ambiguous', () => {
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'android', [])).toBeNull();
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [
      'ios/One/AppDelegate.swift',
      'ios/Two/AppDelegate.swift',
    ])).toContain('Multiple ios application entrypoints');
  });

  it('binds the Android entrypoint through a Gradle namespace and ignores test sources', () => {
    const entrypoint = 'android/app/src/main/java/com/example/MainApplication.kt';
    write(entrypoint, 'class MainApplication\n');
    write('android/app/build.gradle.kts', 'android {\n  namespace = "com.example"\n}\n');
    write(
      'android/app/src/main/AndroidManifest.xml',
      '<manifest><application android:name=".MainApplication" /></manifest>',
    );
    write(
      'android/app/src/release/AndroidManifest.xml',
      '<manifest package="com.example"><application android:name="MainApplication" /></manifest>',
    );
    write(
      'android/app/src/androidTest/AndroidManifest.xml',
      '<manifest><application android:name=".WrongApplication" /></manifest>',
    );
    write('android/app/src/debug', 'not a source-set directory');

    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'android', [entrypoint])).toBeNull();
  });

  it('uses the declared Android package before the source path package', () => {
    const entrypoint = 'android/app/src/main/java/wrong/path/MainApplication.java';
    write(entrypoint, 'package com.example; public class MainApplication {}\n');
    write(
      'android/app/src/main/AndroidManifest.xml',
      '<manifest><application android:name="com.example.MainApplication" /></manifest>',
    );

    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'android', [entrypoint])).toBeNull();
  });

  it.each([
    ['missing entrypoint', null, 'Android application entrypoint is missing'],
    ['missing main manifest', undefined, 'main AndroidManifest.xml is missing'],
    [
      'missing application',
      '<manifest package="com.example"></manifest>',
      'has no application declaration',
    ],
    [
      'multiple applications',
      '<manifest><application android:name="com.example.MainApplication" />' +
        '<application android:name="com.example.MainApplication" /></manifest>',
      'multiple application declarations',
    ],
    [
      'missing application name',
      '<manifest package="com.example"><application /></manifest>',
      'does not explicitly name the application class',
    ],
    [
      'duplicate application name',
      '<manifest><application android:name="com.example.MainApplication" ' +
        'android:name="com.example.MainApplication" /></manifest>',
      'multiple android:name application authorities',
    ],
    [
      'dynamic application name',
      '<manifest><application android:name="${applicationClass}" /></manifest>',
      'application class is not statically resolvable',
    ],
    [
      'wrong application',
      '<manifest><application android:name="com.example.OtherApplication" /></manifest>',
      'not com.example.MainApplication',
    ],
  ])('rejects Android authority with %s', (_label, manifest, expected) => {
    const entrypoint = 'android/app/src/main/java/com/example/MainApplication.kt';
    if (manifest !== null) write(entrypoint, 'package com.example\nclass MainApplication\n');
    if (manifest !== null && manifest !== undefined) {
      write('android/app/src/main/AndroidManifest.xml', manifest);
    }

    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'android', [entrypoint])).toContain(
      expected,
    );
  });

  it('rejects a relative Android application without package or namespace authority', () => {
    const entrypoint = 'android/app/src/main/java/MainApplication.kt';
    write(entrypoint, 'class MainApplication\n');
    write(
      'android/app/src/main/AndroidManifest.xml',
      '<manifest><application android:name=".MainApplication" /></manifest>',
    );

    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'android', [entrypoint])).toContain(
      'without a manifest package or Gradle namespace',
    );
  });

  it('rejects a symlinked Android source set', () => {
    const entrypoint = 'android/app/src/main/java/com/example/MainApplication.kt';
    write(entrypoint, 'package com.example\nclass MainApplication\n');
    write(
      'android/app/src/main/AndroidManifest.xml',
      '<manifest><application android:name="com.example.MainApplication" /></manifest>',
    );
    const outside = createTempProjectDir();
    fs.symlinkSync(outside, path.join(projectRoot, 'android/app/src/release'));

    try {
      expect(() => findNativeEntrypointAuthorityIssue(projectRoot, 'android', [entrypoint]))
        .toThrow('Android source-set path is a symbolic link');
    } finally {
      removeTempDir(outside);
    }
  });

  it('accepts a unique annotated Swift AppDelegate', () => {
    const entrypoint = 'ios/Demo/AppDelegate.swift';
    write(
      entrypoint,
      '@main\npublic final class AppDelegate: UIResponder, UIApplicationDelegate {}\n',
    );
    write('ios/Demo/Notes.swift', 'let text = "@main class OtherDelegate"\n');

    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toBeNull();
  });

  it('rejects competing, conflicting, and missing Swift principals', () => {
    const entrypoint = 'ios/Demo/AppDelegate.swift';
    write(entrypoint, 'class AppDelegate: UIResponder, UIApplicationDelegate {}\n');
    write('ios/Demo/Other.swift', '@main struct MyApp {}\n');
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toContain(
      'does not uniquely select AppDelegate',
    );

    fs.rmSync(path.join(projectRoot, 'ios/Demo/Other.swift'));
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toContain(
      'Swift @main/UIApplicationMain principal is missing',
    );

    write(entrypoint, '@main class AppDelegate {}\n');
    write(
      'ios/main.swift',
      'UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, "AppDelegate")\n',
    );
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toContain(
      'conflicts with an external main source',
    );
  });

  it('accepts an explicit Swift main source with balanced nested arguments', () => {
    const entrypoint = 'ios/Demo/AppDelegate.swift';
    write(entrypoint, 'class AppDelegate: UIResponder, UIApplicationDelegate {}\n');
    write(
      'ios/main.swift',
      'UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, helper(nil, "x"), ' +
        'NSStringFromClass(AppDelegate.self))\n',
    );

    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toBeNull();
  });

  it('rejects an invalid or ambiguous Swift main source', () => {
    const entrypoint = 'ios/Demo/AppDelegate.swift';
    write(entrypoint, 'class AppDelegate {}\n');
    write(
      'ios/main.swift',
      'UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, "OtherDelegate")\n',
    );
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toContain(
      'argument 4 does not select AppDelegate',
    );

    write('ios/Second/main.swift', 'UIApplicationMain(1, nil, nil, "AppDelegate")\n');
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toContain(
      'Multiple or conflicting iOS application principal sources',
    );
  });

  it('accepts Objective-C UIApplicationMain and ignores commented decoys', () => {
    const entrypoint = 'ios/Demo/AppDelegate.m';
    write(entrypoint, '@implementation AppDelegate\n@end\n');
    write(
      'ios/Demo/main.m',
      '/* outer /* UIApplicationMain(0, nil, nil, @"Wrong") */ still comment */\n' +
        'int main(int argc, char **argv) {\n' +
        '  return UIApplicationMain(argc, argv, helper(nil, @"x"), ' +
        'NSStringFromClass([AppDelegate class]));\n}\n',
    );

    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toBeNull();
  });

  it('rejects missing, duplicate, and wrong Objective-C principals', () => {
    const entrypoint = 'ios/Demo/AppDelegate.mm';
    write(entrypoint, '@implementation AppDelegate\n@end\n');
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toContain(
      'principal source is missing',
    );

    write('ios/Demo/main.mm', 'UIApplicationMain(argc, argv, nil, @"OtherDelegate");\n');
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toContain(
      'argument 4 does not select AppDelegate',
    );

    write(
      'ios/Demo/main.mm',
      'UIApplicationMain(argc, argv, nil, @"AppDelegate");\n' +
        'UIApplicationMain(argc, argv, nil, @"AppDelegate");\n',
    );
    expect(findNativeEntrypointAuthorityIssue(projectRoot, 'ios', [entrypoint])).toContain(
      'Exactly one UIApplicationMain call is required',
    );
  });

  it('rejects a symlinked iOS source root', () => {
    const outside = createTempProjectDir();
    fs.symlinkSync(outside, path.join(projectRoot, 'ios'));
    try {
      expect(() => findNativeEntrypointAuthorityIssue(
        projectRoot,
        'ios',
        ['ios/Demo/AppDelegate.swift'],
      )).toThrow('iOS source root is not a regular project directory');
    } finally {
      removeTempDir(outside);
    }
  });
});
