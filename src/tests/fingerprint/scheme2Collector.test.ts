import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectNativeFingerprintV2 } from '../../fingerprintV2/collect';
import { readText } from '../../fingerprintV2/dependencies';
import { compareText } from '../../fingerprintV2/files';

describe('Scheme 2 native input collection', () => {
  let project: string;
  const write = (name: string, content: string, root = project) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const collect = (platform: 'android' | 'ios' = 'android', root = project) =>
    collectNativeFingerprintV2(root, platform, {}, null);

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-scheme2-'));
    write('package.json', '{"name":"test-app","dependencies":{"native-controls":"1.2.3"}}');
    write('node_modules/react-native/package.json', '{"name":"react-native","version":"0.88.1"}');
    write('node_modules/react-native/cli.js', `
      const path = require('path');
      const root = process.cwd();
      const dependency = path.join(root, 'node_modules/native-controls');
      console.log(JSON.stringify({ root, dependencies: {
        'native-controls': { root: dependency, platforms: {
          android: { sourceDir: path.join(dependency, 'android') },
          ios: { podspecPath: path.join(dependency, 'NativeControls.podspec') },
        } },
      } }));
    `);
    write('node_modules/native-controls/package.json', '{"name":"native-controls","version":"1.2.3"}');
    write('node_modules/native-controls/android/AndroidManifest.xml', '<manifest package="org.example"/>');
    write('node_modules/native-controls/NativeControls.podspec', 'spec.source_files = "ios/*.m"');
    write('node_modules/native-controls/ios/Config.m', 'int setting = 0;');
    write('android/app/build.gradle', 'android {\n defaultConfig {\n versionCode 1\n targetSdk 35\n }\n}\n');
    write('android/app/src/main/AndroidManifest.xml', '<manifest/>');
    write('ios/Podfile', "setup_permissions(['Camera', 'Contacts'])\n");
    write('ios/Podfile.lock', 'PODS:\n  - NativeControls (1.2.3)\n');
    write('ios/Test.xcodeproj/project.pbxproj', '{ buildSettings = { CURRENT_PROJECT_VERSION = 1; }; }');
    write('.gitignore', 'ios/generated.xcconfig\nios/*.env\n!ios/native.env\n');
  });

  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it('preserves Scheme 2 runtimes for native files and escaped brace ignore rules', async () => {
    const baseline = await Promise.all([collect('android'), collect('ios')]);
    write('.fingerprintignore', String.raw`**/{Demo,Other}\\Policy.*` + '\n');
    write('android/app/src/main/DemoPolicy.kt', 'fun policy() = true\n');
    write('ios/DemoPolicy.m', 'int policy(void) { return 1; }\n');
    const withPolicy = await Promise.all([collect('android'), collect('ios')]);

    expect([...baseline, ...withPolicy].map((report) => report.runtimeVersion)).toMatchInlineSnapshot(`
[
  "bdfp2-d39c845d5878d139dba322267c759ca97b09422cb5cb8dab0bcb2f0bf3ec9427",
  "bdfp2-517b9120d2d071a05a306567e0053b9f78709fbc7324e67ee993957244cc9048",
  "bdfp2-3fddb0944fa3373d302153ce91b99484347067169a7f39d2724b90f363958303",
  "bdfp2-ea5b128fbbb82c05e6e2bc4c5e7f2388c31583bae1907f9f5a3731f8542bf10c",
]
`);
  }, 25_000);

  it('matches independent checkouts after build-only writes and ordinary JS changes', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-scheme2-other-'));
    try {
      fs.cpSync(project, checkout, { recursive: true });
      const android = await collect();
      const ios = await collect('ios');
      expect(android.runtimeVersion).toMatch(/^bdfp2-[a-f0-9]{64}$/);
      write('node_modules/native-controls/android/AndroidManifest.xml', '<manifest/>', checkout);
      write('node_modules/native-controls/NativeControls.podspec', 'spec.source_files = "ios/{Camera,Contacts}.m"', checkout);
      write('node_modules/native-controls/ios/Config.m', `const char *root = "${checkout}";`, checkout);
      write('ios/generated.xcconfig', `SOURCE_ROOT = ${checkout}`, checkout);
      write('android/app/build/generated/out.txt', 'build output', checkout);
      write('.git/info/exclude', 'ios/Podfile\n', checkout);
      write('App.js', 'export default 2;', checkout);
      write('package.json', '{"name":"test-app","dependencies":{"native-controls":"1.2.3","js-only":"7.4.0"}}', checkout);
      expect(await collect('android', checkout)).toEqual(android);
      expect(await collect('ios', checkout)).toEqual(ios);
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  }, 25_000);

  it('detects app-owned manifests, permissions, native settings, and manager-defined patches', async () => {
    const first = await collect();
    write('android/app/src/main/AndroidManifest.xml', '<manifest><uses-permission android:name="android.permission.CAMERA"/></manifest>');
    expect((await collect()).runtimeVersion).not.toBe(first.runtimeVersion);
    const ios = await collect('ios');
    write('ios/Podfile', "setup_permissions(['Camera'])\n");
    const permissionEdit = await collect('ios');
    expect(permissionEdit.runtimeVersion).not.toBe(ios.runtimeVersion);
    write('ios/native.env', 'NATIVE_FEATURE=YES');
    const settingEdit = await collect('ios');
    expect(settingEdit.runtimeVersion).not.toBe(permissionEdit.runtimeVersion);
    write('.yarn/patches/native-controls.patch', 'native patch content');
    expect((await collect('ios')).runtimeVersion).not.toBe(settingEdit.runtimeVersion);
  }, 25_000);

  it('checks native package provenance without hashing unrelated lockfile entries', async () => {
    const writeLock = (native: string, js: string) => write('yarn.lock', `
__metadata:
  version: 6
"native-controls@npm:1.2.3":
  version: 1.2.3
  resolution: "native-controls@npm:1.2.3"
  checksum: ${native}
"js-only@npm:7.4.0":
  version: 7.4.0
  resolution: "js-only@npm:7.4.0"
  checksum: ${js}
`);
    writeLock('aa111', 'unrelated1');
    const first = await collect();
    writeLock('aa111', 'unrelated2');
    expect(await collect()).toEqual(first);
    writeLock('aa222', 'unrelated2');
    expect((await collect()).runtimeVersion).not.toBe(first.runtimeVersion);
  }, 25_000);

  it('hashes locally installed native code and app codegen specifications', async () => {
    write('package.json', JSON.stringify({
      name: 'test-app',
      dependencies: { 'native-controls': 'file:./modules/native-controls' },
      codegenConfig: { name: 'AppSpec', jsSrcsDir: 'src/specs' },
    }));
    write('src/specs/NativeCounter.ts', 'export interface Spec { count(): number }');
    const first = await collect();
    write('node_modules/native-controls/android/Native.kt', 'fun implementation() = 2');
    const localEdit = await collect();
    expect(localEdit.runtimeVersion).not.toBe(first.runtimeVersion);
    write('src/specs/helpers.js', 'export const helper = 2;');
    expect(await collect()).toEqual(localEdit);
    write('src/specs/NativeCounter.ts', 'export interface Spec { count(): string }');
    expect((await collect()).runtimeVersion).not.toBe(localEdit.runtimeVersion);
  }, 25_000);

  it('excludes the local SDK bundle output while retaining authored dist files in other native dependencies', async () => {
    write('package.json', JSON.stringify({ name: 'test-app', dependencies: {
      '@gfean/react-native-bundle-drop': 'file:./.yalc/@gfean/react-native-bundle-drop',
      'native-controls': 'file:./modules/native-controls',
    } }));
    write('node_modules/@gfean/react-native-bundle-drop/package.json',
      '{"name":"@gfean/react-native-bundle-drop","version":"0.13.1","nativeVersion":"0.6.4"}');
    write('node_modules/@gfean/react-native-bundle-drop/android/ActualNative.kt', 'fun sdk() = 1');
    write('node_modules/native-controls/dist/android/Native.kt', 'fun implementation() = 1');
    write('node_modules/react-native/cli.js', `
      const path = require('path');
      const root = process.cwd();
      const names = ['@gfean/react-native-bundle-drop', 'native-controls'];
      const dependencies = Object.fromEntries(names.map(name => {
        const dependency = path.join(root, 'node_modules', name);
        return [name, { root: dependency, platforms: { android: { sourceDir: path.join(dependency, 'android') } } }];
      }));
      console.log(JSON.stringify({ root, dependencies }));
    `);
    const original = await collect();
    write('node_modules/@gfean/react-native-bundle-drop/dist/main.jsbundle', 'volatile standalone export');
    write('node_modules/@gfean/react-native-bundle-drop/dist/bundle-manifest.json', '{}');
    expect(await collect()).toEqual(original);
    write('node_modules/native-controls/dist/android/Native.kt', 'fun implementation() = 2');
    const dependencyEdit = await collect();
    expect(dependencyEdit.runtimeVersion).not.toBe(original.runtimeVersion);
    write('node_modules/@gfean/react-native-bundle-drop/android/ActualNative.kt', 'fun sdk() = 2');
    expect((await collect()).runtimeVersion).not.toBe(dependencyEdit.runtimeVersion);
  }, 25_000);

  it('hashes Fabric and TurboModule specs only on their applicable platform', async () => {
    write('package.json', '{"name":"test-app","codegenConfig":{"name":"AppSpec","jsSrcsDir":"src/specs"}}');
    write('src/specs/CounterNativeComponent.ios.ts', 'export default iosComponent;');
    write('src/specs/CounterNativeComponent.android.ts', 'export default androidComponent;');
    write('src/specs/NativeFeature.ios.fb.ts', 'export interface Spec { feature: boolean; }');
    write('src/specs/NativeTypes.d.ts', 'export interface Test {}');
    write('src/specs/NativeNotes.txt', 'not a codegen input');
    write('src/specs/__tests/NativeExample.js', 'not a codegen input');
    const android = await collect();
    const ios = await collect('ios');
    const androidSpecs = android.sources.filter(source => source.id.startsWith('codegen:')).map(source => source.id);
    const iosSpecs = ios.sources.filter(source => source.id.startsWith('codegen:')).map(source => source.id);
    expect(androidSpecs).toEqual(['codegen:src/specs/CounterNativeComponent.android.ts']);
    expect(iosSpecs).toEqual(['codegen:src/specs/CounterNativeComponent.ios.ts', 'codegen:src/specs/NativeFeature.ios.fb.ts']);
    write('src/specs/CounterNativeComponent.ios.ts', 'export default enhancedIosComponent;');
    expect(await collect()).toEqual(android);
    expect((await collect('ios')).runtimeVersion).not.toBe(ios.runtimeVersion);
  }, 25_000);

  it('includes explicit build inputs even when automatic discovery excludes them', async () => {
    write('ios/private.env', 'NATIVE_FEATURE=NO');
    const first = await collect('ios');
    const options = { extraSources: [{ id: 'env-file', type: 'file' as const, value: 'ios/private.env' }] };
    const original = await collectNativeFingerprintV2(project, 'ios', options, null);
    write('ios/private.env', 'NATIVE_FEATURE=YES');
    expect(await collect('ios')).toEqual(first);
    const updated = await collectNativeFingerprintV2(project, 'ios', options, null);
    expect(updated.runtimeVersion).not.toBe(original.runtimeVersion);
    expect(JSON.stringify(updated)).not.toContain('NATIVE_FEATURE');
    const bounded = await collectNativeFingerprintV2(project, 'ios', options, 'custom boundary');
    expect(bounded.nativeHash).toBe(updated.nativeHash);
    expect(bounded.runtimeVersion).not.toBe(updated.runtimeVersion);
  }, 25_000);

  it('hashes evaluated Expo configuration and leaves generated CNG directories out', async () => {
    write('.gitignore', 'android/\nios/\n');
    write('node_modules/expo/package.json', '{"name":"expo","version":"58.0.0"}');
    write('node_modules/@expo/env/index.js', 'exports.loadProjectEnv = () => {};');
    write('node_modules/expo/config.js', 'exports.getConfig = () => ({ exp: require(process.cwd() + "/app.json").expo });');
    write('app.json', '{"expo":{"name":"fixture","slug":"fixture","ios":{"infoPlist":{"NSCameraUsageDescription":"camera"}}}}');
    const first = await collect('ios');
    fs.rmSync(path.join(project, 'ios'), { recursive: true });
    expect(await collect('ios')).toEqual(first);
    write('app.json', '{"expo":{"name":"fixture","slug":"fixture","ios":{"infoPlist":{"NSCameraUsageDescription":"camera for scanning codes"}}}}');
    expect((await collect('ios')).runtimeVersion).not.toBe(first.runtimeVersion);
    write('.gitignore', 'android/\n');
    write('ios/Podfile', 'use_expo_modules!\n');
    expect((await collect('ios')).sources.some(source => source.id === 'ios/Podfile')).toBe(true);
  }, 25_000);

  it('scopes linked native dependencies and paths to the selected platform', async () => {
    write('node_modules/ios-only/package.json', '{"name":"ios-only","version":"1.0.0"}');
    write('node_modules/react-native/cli.js', `
      const path = require('path');
      const root = process.cwd();
      console.log(JSON.stringify({ root, dependencies: {
        'native-controls': { root: path.join(root, 'node_modules/native-controls'), platforms: {
          android: { sourceDir: path.join(root, 'android/custom'), extra: ['node_modules/ios-only', 'node_modules/ios-only/lib', true, null] },
          ios: null,
        } },
        'ios-only': { root: path.join(root, 'node_modules/ios-only'), platforms: {
          android: null, ios: { podspecPath: 'native.podspec' },
        } },
      } }));
    `);
    const android = await collect();
    const ios = await collect('ios');
    expect(android.sources.some(source => source.id === 'ios-only')).toBe(false);
    expect(ios.sources.some(source => source.id === 'native-controls')).toBe(false);
    write('node_modules/ios-only/package.json', '{"name":"ios-only","version":"2.0.0"}');
    expect(await collect()).toEqual(android);
    expect((await collect('ios')).runtimeVersion).not.toBe(ios.runtimeVersion);
  }, 25_000);

  it('handles npm, Yarn classic and pnpm package provenance and declared patch locations', async () => {
    const manifest = (packageManager: string) =>
      write('package.json', JSON.stringify({ name: 'test-app', packageManager, dependencies: { 'native-controls': '1.2.3' } }));
    manifest('npm@11.0.0');
    const npmLock = (integrity: string) => write('package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/native-controls': { version: '1.2.3', resolved: 'https://npm.example/controls.tgz', integrity } },
    }));
    npmLock('sha512-first');
    write('yarn.lock', 'this lock belongs to a different package manager');
    const npm = await collect();
    write('yarn.lock', 'still unrelated');
    expect(await collect()).toEqual(npm);
    npmLock('sha512-second');
    expect((await collect()).runtimeVersion).not.toBe(npm.runtimeVersion);
    manifest('yarn@1.22.22');
    write('custom/native.patch', 'patch before');
    write('yarn.lock', `native-controls@1.2.3:
  version "1.2.3"
  resolved "https://npm.example/controls.tgz#./custom/native.patch"
  integrity sha512-first
`);
    const yarn = await collect();
    expect(yarn.sources.find(source => source.id === 'patch:custom/native.patch')).toBeDefined();
    write('custom/native.patch', 'patch after');
    expect((await collect()).runtimeVersion).not.toBe(yarn.runtimeVersion);
    manifest('pnpm@10.0.0');
    write('pnpm-lock.yaml', `lockfileVersion: '9.0'
packages:
  malformed-header:
    version: 1
  native-controls@1.2.3:
    resolution: {integrity: sha512-inline, tarball: https://npm.example/controls.tgz}
  other-native@3.2.1:
    integrity: sha512-block
    tarball: https://npm.example/other.tgz
  unrelated@1.0.0:
    resolution: {}
patchedDependencies:
  native-controls@1.2.3:
    hash: abcd
    path: custom/native.patch
`);
    write('pnpm-workspace.yaml', 'patchedDependencies:\n  "native-controls@1.2.3": custom/native.patch\n');
    const pnpm = await collect();
    expect(pnpm.sources.find(source => source.id === 'patch:custom/native.patch')).toBeDefined();
    write('pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');
    write('pnpm-workspace.yaml', 'patchedDependencies:\n  native-controls@1.2.3: ../escaped.patch\n');
    await expect(collect()).rejects.toThrow('must be inside the dependency lock root');
    fs.rmSync(path.join(project, 'pnpm-workspace.yaml'));
    expect((await collect()).runtimeVersion).not.toBe(pnpm.runtimeVersion);
  }, 25_000);

  it('reads relevant native provenance and declared patches from a monorepo parent', async () => {
    const app = path.join(project, 'packages', 'app');
    const entries = fs.readdirSync(project);
    fs.mkdirSync(app, { recursive: true });
    for (const entry of entries) fs.cpSync(path.join(project, entry), path.join(app, entry), { recursive: true });
    write('yarn.lock', `native-controls@1.2.3:
  version "1.2.3"
  integrity sha512-parent
`);
    write('patches/native.patch', 'native patch in workspace root');
    const report = await collect('android', app);
    expect(report.sources.some(source => source.id.endsWith('/patches/native.patch'))).toBe(true);
    write('packages/.gitignore', 'app/android/build-timestamp.txt\n');
    write('android/build-timestamp.txt', 'generated under a nested workspace ignore', app);
    expect(await collect('android', app)).toEqual(report);
    write('.gitignore', 'packages/app/ios/\n');
    write('node_modules/expo/package.json', '{"name":"expo","version":"58.0.0"}', app);
    write('node_modules/@expo/env/index.js', 'exports.loadProjectEnv = () => {};', app);
    write('node_modules/expo/config.js', 'exports.getConfig = () => ({ exp: { name: "fixture", slug: "fixture" } });', app);
    const cng = await collect('ios', app);
    expect(cng.sources.some(source => source.id.startsWith('ios/'))).toBe(false);
    fs.rmSync(path.join(app, 'ios'), { recursive: true });
    expect(await collect('ios', app)).toEqual(cng);
  }, 25_000);

  it.each(['android', 'ios'] as const)('preserves pnpm %s provenance and patches with CRLF', async platform => {
    write('package.json', '{"name":"test-app","packageManager":"pnpm@10.0.0","dependencies":{"native-controls":"1.2.3"}}');
    const lockfile = `lockfileVersion: '9.0'

patchedDependencies:
  native-controls@1.2.3:
    path: native-patches/controls.patch

packages:
  native-controls@1.2.3:
    resolution: {integrity: sha512-first, tarball: https://example.org/controls.tgz}
`;
    const workspace = `patchedDependencies:
  other-native@1.0.0: native-patches/workspace.patch
`;
    write('pnpm-lock.yaml', lockfile);
    write('pnpm-workspace.yaml', workspace);
    write('native-patches/controls.patch', 'controls patch');
    write('native-patches/workspace.patch', 'workspace patch');
    const lf = await collect(platform);
    expect(lf.sources.map(source => source.id)).toEqual(expect.arrayContaining([
      'native-controls', 'patch:native-patches/controls.patch', 'patch:native-patches/workspace.patch',
    ]));

    const crlfLockfile = lockfile.replace(/\n/g, '\r\n');
    const crlfWorkspace = workspace.replace(/\n/g, '\r\n');
    write('pnpm-workspace.yaml', crlfWorkspace);
    expect(await collect(platform)).toEqual(lf);
    write('pnpm-workspace.yaml', workspace);
    write('pnpm-lock.yaml', crlfLockfile);
    expect(await collect(platform)).toEqual(lf);
    write('pnpm-workspace.yaml', crlfWorkspace);
    expect(await collect(platform)).toEqual(lf);

    write('pnpm-lock.yaml', crlfLockfile.replace('sha512-first', 'sha512-changed'));
    expect((await collect(platform)).runtimeVersion).not.toBe(lf.runtimeVersion);
    write('pnpm-lock.yaml', crlfLockfile.replace('example.org/controls.tgz', 'mirror.example.org/controls.tgz'));
    expect((await collect(platform)).runtimeVersion).not.toBe(lf.runtimeVersion);
    write('pnpm-lock.yaml', crlfLockfile);
    write('native-patches/controls.patch', 'changed controls patch');
    expect((await collect(platform)).runtimeVersion).not.toBe(lf.runtimeVersion);
    write('native-patches/controls.patch', 'controls patch');
    write('native-patches/workspace.patch', 'changed workspace patch');
    expect((await collect(platform)).runtimeVersion).not.toBe(lf.runtimeVersion);
  }, 25_000);

  it('includes transitive pnpm Git resolutions and slash-prefixed lockfile v6 keys', async () => {
    write('package.json', '{"name":"test-app","packageManager":"pnpm@10.0.0"}');
    const gitLock = (commit: string, repository = 'https://example.org/native-controls.git') => write('pnpm-lock.yaml', `
lockfileVersion: '9.0'
packages:
  native-controls@git+${repository}#${commit}:
    resolution: {commit: ${commit}, repo: '${repository}', type: git}
`);
    gitLock('689903ddda38cf376ec685e0c7c5b09af0017f80');
    const first = await collect();
    gitLock('0f9f34c9c7ca871d93b07a8f8a1e007f5407be4b');
    const second = await collect();
    expect(second.runtimeVersion).not.toBe(first.runtimeVersion);
    gitLock('689903ddda38cf376ec685e0c7c5b09af0017f80', 'file:///private/build-a/git-module');
    const localGit = await collect();
    gitLock('689903ddda38cf376ec685e0c7c5b09af0017f80', 'file:///tmp/build-b/git-module');
    expect(await collect()).toEqual(localGit);
    gitLock('0f9f34c9c7ca871d93b07a8f8a1e007f5407be4b', 'file:///tmp/build-b/git-module');
    expect((await collect()).runtimeVersion).not.toBe(localGit.runtimeVersion);
    const classicLock = (integrity: string) => write('pnpm-lock.yaml', `
lockfileVersion: '6.0'
packages:
  /native-controls@1.2.3:
    resolution:
      integrity: ${integrity}
`);
    classicLock('sha512-first');
    const classic = await collect();
    classicLock('sha512-second');
    expect((await collect()).runtimeVersion).not.toBe(classic.runtimeVersion);
  }, 25_000);

  it('hashes mutable non-registry inputs when an immutable resolution is unavailable', async () => {
    write('package.json', '{"name":"test-app","dependencies":{"native-controls":"https://example.org/native.tgz"}}');
    const before = await collect();
    write('node_modules/native-controls/android/native.c', 'const int value = 1;');
    expect((await collect()).runtimeVersion).not.toBe(before.runtimeVersion);
    write('node_modules/native-controls/package.json', '{"name":"native-controls"}');
    await expect(collect()).rejects.toThrow('Invalid native dependency manifest');
  }, 25_000);

  it('fails closed on invalid explicit input declarations, missing sources, and type mismatches', async () => {
    const withSources = (extraSources: unknown[]) => collectNativeFingerprintV2(project, 'ios', {
      extraSources: extraSources as { id: string; type: 'environment' | 'dir' | 'file'; value: string }[],
    }, null);
    await expect(withSources([null])).rejects.toThrow('Invalid fingerprint extra source');
    await expect(withSources([{ id: '', type: 'file', value: 'missing' }])).rejects.toThrow('Invalid fingerprint extra source');
    await expect(withSources([{ id: 'value', type: 'unknown', value: 'missing' }])).rejects.toThrow('Invalid fingerprint extra source');
    await expect(withSources([{ id: 'platform', type: 'file', value: 'missing', platforms: 'ios' }]))
      .rejects.toThrow('Invalid fingerprint extra source platforms');
    await expect(withSources([{ id: 'platform', type: 'file', value: 'missing', platforms: ['andriod'] }]))
      .rejects.toThrow('Invalid fingerprint extra source platforms');
    await expect(withSources([{ id: 'platform', type: 'file', value: 'missing', platforms: [] }]))
      .rejects.toThrow('Invalid fingerprint extra source platforms');
    await expect(withSources([{ id: 'optional', type: 'file', value: 'missing', optional: 'true' }]))
      .rejects.toThrow('Invalid fingerprint extra source optional flag');
    await expect(withSources([{ id: 'file', type: 'file', value: 'missing' }])).rejects.toThrow('Required fingerprint extra source');
    await expect(withSources([{ id: 'env', type: 'environment', value: '__BDFP_TEST_ABSENT' }])).rejects.toThrow('Required fingerprint extra source');
    await expect(withSources([{ id: 'wrong-type', type: 'dir', value: 'ios/Podfile' }])).rejects.toThrow('wrong type');
    const file = { id: 'file', type: 'file', value: 'ios/Podfile', platforms: ['ios'] };
    await expect(withSources([file, file])).rejects.toThrow('Duplicate fingerprint extra source');
    process.env.__BDFP_TEST_SECRET = 'value-should-never-appear-in-report';
    try {
      const report = await withSources([
        file,
        { id: 'other-platform', type: 'file', value: 'missing', platforms: ['android'] },
        { id: 'directory', type: 'dir', value: 'ios' },
        { id: 'absent-file', type: 'file', value: 'missing', optional: true },
        { id: 'absent-env', type: 'environment', value: '__BDFP_TEST_ABSENT', optional: true },
        { id: 'secret', type: 'environment', value: '__BDFP_TEST_SECRET' },
      ]);
      expect(report.sources.map(source => source.id)).toEqual(expect.arrayContaining(['extra:directory', 'extra:absent-file', 'extra:secret']));
      expect(JSON.stringify(report)).not.toContain(process.env.__BDFP_TEST_SECRET);
    } finally {
      delete process.env.__BDFP_TEST_SECRET;
    }
  }, 25_000);

  it('reports missing native project inputs and hashes app-owned discovery settings', async () => {
    write('react-native.config.cjs', 'module.exports = {};');
    const report = await collect();
    expect(report.sources.find(source => source.id === 'react-native.config.cjs')).toBeDefined();
    write('package.json', '{"name":"test-app","codegenConfig":{"libraries":[{"platforms":{"android":{"jsSrcsDir":"."}}}]}}');
    write('NativeApp.ts', 'export const Spec = null;');
    expect((await collect()).sources.find(source => source.id === 'codegen:NativeApp.ts')).toBeDefined();
    write('package.json', '{"name":"test-app","codegenConfig":{"jsSrcsDir":"../external"}}');
    await expect(collect()).rejects.toThrow('App codegen sources must be within the project');
    await expect(collectNativeFingerprintV2(project, 'ios', { nativeProjectMode: { ios: 'cng' } }, null))
      .rejects.toThrow('requires a discoverable Expo configuration');
    fs.rmSync(path.join(project, 'android'), { recursive: true });
    await expect(collect()).rejects.toThrow('Required native fingerprint directory');
    fs.mkdirSync(path.join(project, 'android'));
    await expect(collect()).rejects.toThrow('No app-owned native fingerprint inputs');
  }, 25_000);

  it('uses nested ignores and symlinks without allowing filesystem cycles', async () => {
    write('android/app/.gitignore', 'generated.txt\n');
    write('android/app/generated.txt', 'local output');
    write('android/app/node_modules/file', 'package cache');
    fs.symlinkSync('build.gradle', path.join(project, 'android/app/config.gradle'));
    const report = await collect();
    expect(report.sources.map(source => source.id)).toContain('android/app/config.gradle');
    expect(report.sources.map(source => source.id)).not.toContain('android/app/generated.txt');
    fs.symlinkSync('.', path.join(project, 'android/app/alias'));
    await expect(collect()).rejects.toThrow('Circular native input symlink');
    fs.mkdirSync(path.join(project, 'ios/.gitignore'));
    await expect(collect('ios')).rejects.toThrow('EISDIR');
    expect(() => readText(path.join(project, 'ios'))).toThrow('EISDIR');
    expect(compareText('same', 'same')).toBe(0);
  }, 25_000);

  it('retains local plugins and module files reported by the discovery adapter', async () => {
    const sourcer = require('../../../third_party/expo-fingerprint/build/sourcer/Sourcer');
    write('react-native.config.js', 'module.exports = {};');
    write('plugins/with-test.js', 'module.exports = app => app;');
    write('modules/workspace/package.json', '{"name":"test-module","version":"1.0.0"}');
    write('modules/workspace/ios/code.m', 'int test() { return 2; }');
    write('external-android/build.gradle', 'plugins {}');
    write('.fingerprintignore', 'plugins/excluded.js\n');
    const original = jest.spyOn(sourcer, 'getHashSourcesAsync');
    const external = { type: 'dir', filePath: 'external-android', reasons: ['rncoreAutolinking'] };
    const workspace = { type: 'dir', filePath: 'modules/workspace/ios', reasons: ['expoAutolinkingIos'] };
    const plugin = { type: 'file', filePath: 'plugins/with-test.js', reasons: ['expoConfigPlugins'] };
    try {
      original.mockResolvedValue([workspace, workspace, external, plugin, { ...plugin, filePath: 'plugins/excluded.js' }]);
      const first = await collect('ios');
      expect(first.sources.some(source => source.id === 'dependency:test-module/ios/code.m')).toBe(true);
      expect(first.sources.some(source => source.id === 'plugins/with-test.js')).toBe(true);
      expect(first.sources.some(source => source.id === 'external-android/build.gradle')).toBe(true);
      write('modules/alternate/package.json', '{"name":"test-module","version":"2.0.0"}');
      original.mockResolvedValue([workspace, { ...workspace, filePath: 'modules/alternate' }]);
      await expect(collect('ios')).rejects.toThrow('Conflicting native fingerprint input');
      write('modules/alternate/package.json', '{"version":"2.0.0"}');
      original.mockResolvedValue([{ ...workspace, filePath: 'modules/alternate' }]);
      await expect(collect('ios')).rejects.toThrow('Native dependency manifest has no name');
    } finally {
      original.mockRestore();
    }
  }, 25_000);
});
