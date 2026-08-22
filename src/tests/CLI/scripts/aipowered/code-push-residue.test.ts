import fs from 'fs-extra';
import type { Dirent, Stats } from 'fs';
import path from 'path';

import { findCodePushResiduePaths } from '../../../../CLI/scripts/aipowered/code-push-residue';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

describe('CLI/scripts/aipowered/code-push-residue', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = createTempProjectDir();
  });

  afterEach(() => {
    removeTempDir(projectRoot);
  });

  const writeFixture = (relativePath: string, content: string) => {
    const filePath = path.join(projectRoot, relativePath);
    fs.ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, content);
  };

  it('finds JS wrappers, Gradle hooks, and native deployment-key configuration', () => {
    writeFixture(
      'src/App.tsx',
      "import codePush from 'react-native-code-push';\nexport default codePush(App);\n",
    );
    writeFixture(
      'android/app/build.gradle',
      "apply from: '../../node_modules/react-native-code-push/android/codepush.gradle'\n",
    );
    writeFixture(
      'android/app/src/main/res/values/strings.xml',
      '<string name="CodePushDeploymentKey">deployment-key</string>\n',
    );
    writeFixture(
      'ios/Demo/Info.plist',
      '<key>CodePushDeploymentKey</key><string>deployment-key</string>\n',
    );
    writeFixture(
      'ios/Demo.xcodeproj/project.pbxproj',
      'CODEPUSH_KEY = deployment-key;\n',
    );

    expect(findCodePushResiduePaths(projectRoot)).toEqual([
      'android/app/build.gradle',
      'android/app/src/main/res/values/strings.xml',
      'ios/Demo.xcodeproj/project.pbxproj',
      'ios/Demo/Info.plist',
      'src/App.tsx',
    ]);
  });

  it('ignores package files, provider-patched entrypoints, and generated files but rejects symlinks', () => {
    writeFixture(
      'package.json',
      JSON.stringify({ dependencies: { 'react-native-code-push': '9.0.0' } }),
    );
    writeFixture('yarn.lock', 'react-native-code-push@9.0.0\n');
    writeFixture(
      'android/app/src/main/kotlin/com/demo/MainApplication.kt',
      'fun getJSBundleFile() = CodePush.getJSBundleFile()\n',
    );
    writeFixture(
      'ios/Demo/AppDelegate.mm',
      'return [CodePush bundleURL];\n',
    );
    writeFixture('src/generated/OldApp.tsx', 'CodePush.sync();\n');
    writeFixture('node_modules/example/index.js', 'CodePush.sync();\n');
    writeFixture('vendor/legacy/Updater.ts', 'CodePush.sync();\n');
    const outsideFile = path.join(projectRoot, '..', `${path.basename(projectRoot)}-outside.ts`);
    fs.writeFileSync(outsideFile, 'CodePush.sync();\n');
    fs.ensureDirSync(path.join(projectRoot, 'src'));
    fs.symlinkSync(outsideFile, path.join(projectRoot, 'src', 'Linked.ts'));

    try {
      expect(() => findCodePushResiduePaths(projectRoot)).toThrow(
        'src/Linked.ts is a symbolic link',
      );
    } finally {
      fs.removeSync(outsideFile);
    }
  });

  it('finds custom native CodePush references outside provider-patched entrypoints', () => {
    writeFixture(
      'android/app/src/main/java/com/demo/CustomBundleResolver.java',
      'return CodePush.getJSBundleFile();\n',
    );
    writeFixture(
      'ios/Demo/CustomBundleResolver.mm',
      'return [CodePush bundleURL];\n',
    );
    writeFixture(
      'ios/Podfile',
      "pod 'CodePush', :path => '../node_modules/react-native-code-push'\n",
    );
    writeFixture(
      'ios/Demo/AppDelegate.swift',
      'return CodePush.bundleURL()\n',
    );

    expect(findCodePushResiduePaths(projectRoot)).toEqual([
      'android/app/src/main/java/com/demo/CustomBundleResolver.java',
      'ios/Demo/CustomBundleResolver.mm',
      'ios/Podfile',
    ]);
  });

  it('does not traverse excluded vendor symlinks', () => {
    const outsideRoot = createTempProjectDir();
    fs.writeFileSync(path.join(outsideRoot, 'Updater.ts'), 'CodePush.sync();\n');
    fs.symlinkSync(outsideRoot, path.join(projectRoot, 'vendor'));
    try {
      expect(findCodePushResiduePaths(projectRoot)).toEqual([]);
    } finally {
      removeTempDir(outsideRoot);
    }
  });

  it('finds CodePush outside src and in Android manifest, properties, and RN config', () => {
    writeFixture(
      'components/Updater.tsx',
      "import codePush from 'react-native-code-push';\nexport default codePush(Updater);\n",
    );
    writeFixture('app/services/updates.ts', 'CodePush.sync();\n');
    writeFixture('packages/mobile/js/update-client.js', 'code_push.restartApp();\n');
    writeFixture(
      'android/app/src/main/AndroidManifest.xml',
      '<meta-data android:name="CodePushDeploymentKey" android:value="key" />\n',
    );
    writeFixture('android/gradle.properties', 'CODEPUSH_KEY=key\n');
    writeFixture(
      'react-native.config.js',
      'module.exports = { codePush: { android: {} } };\n',
    );

    expect(findCodePushResiduePaths(projectRoot)).toEqual([
      'android/app/src/main/AndroidManifest.xml',
      'android/gradle.properties',
      'app/services/updates.ts',
      'components/Updater.tsx',
      'packages/mobile/js/update-client.js',
      'react-native.config.js',
    ]);
  });

  it('allows a clean JS and native configuration to proceed', () => {
    writeFixture('index.js', "import { AppRegistry } from 'react-native';\n");
    writeFixture('src/App.tsx', 'export default function App() { return null; }\n');
    writeFixture('android/app/build.gradle', "apply plugin: 'com.android.application'\n");
    writeFixture('ios/Demo/Info.plist', '<key>CFBundleName</key><string>Demo</string>\n');

    expect(findCodePushResiduePaths(projectRoot)).toEqual([]);
  });

  it('fails closed when a relevant file exceeds the per-file scan limit', () => {
    writeFixture('src/Updater.ts', 'x'.repeat(1024 * 1024 + 1));

    expect(() => findCodePushResiduePaths(projectRoot)).toThrow('exceeds the per-file limit');
  });

  it('fails closed when relevant files exceed the aggregate scan limit', () => {
    for (let index = 0; index < 6; index += 1) {
      writeFixture(`src/Updater${index}.ts`, 'x'.repeat(900 * 1024));
    }

    expect(() => findCodePushResiduePaths(projectRoot)).toThrow(
      'relevant files exceed 5242880 bytes',
    );
  });

  it('fails closed when more than 500 relevant files are present', () => {
    for (let index = 0; index <= 500; index += 1) {
      writeFixture(`src/generated-${index}.ts`, 'export {};\n');
    }

    expect(() => findCodePushResiduePaths(projectRoot)).toThrow(
      'more than 500 relevant files',
    );
  });

  it('fails closed when the filesystem traversal exceeds its entry cap', () => {
    const entries = Array.from({ length: 20_001 }, (_value, index) => ({
      name: `entry-${String(index).padStart(5, '0')}`,
    })) as Dirent[];
    const readdir = jest.spyOn(fs, 'readdirSync').mockReturnValue(entries);
    const lstat = jest.spyOn(fs, 'lstatSync').mockReturnValue({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => false,
    } as Stats);

    try {
      expect(() => findCodePushResiduePaths(projectRoot)).toThrow(
        'more than 20000 filesystem entries',
      );
    } finally {
      readdir.mockRestore();
      lstat.mockRestore();
    }
  });

  it('fails closed when a directory cannot be inspected', () => {
    const readdir = jest.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
      throw new Error('unreadable');
    });

    try {
      expect(() => findCodePushResiduePaths(projectRoot)).toThrow('cannot inspect .');
    } finally {
      readdir.mockRestore();
    }
  });

  it('fails closed when a candidate file disappears during inspection or reading', () => {
    writeFixture('src/Updater.ts', 'CodePush.sync();\n');
    const realLstat = fs.lstatSync.bind(fs);
    const lstat = jest.spyOn(fs, 'lstatSync').mockImplementation(targetPath => {
      if (String(targetPath).endsWith(`${path.sep}Updater.ts`)) throw new Error('gone');
      return realLstat(targetPath);
    });
    try {
      expect(() => findCodePushResiduePaths(projectRoot)).toThrow(
        'cannot inspect src/Updater.ts',
      );
    } finally {
      lstat.mockRestore();
    }

    const readFile = jest.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw new Error('unreadable');
    });
    try {
      expect(() => findCodePushResiduePaths(projectRoot)).toThrow('cannot read src/Updater.ts');
    } finally {
      readFile.mockRestore();
    }
  });
});
