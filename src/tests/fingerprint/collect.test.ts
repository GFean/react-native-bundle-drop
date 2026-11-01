import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectNativeFingerprint } from '../../fingerprint/collect';
import scheme1Golden from './scheme-1-golden.json';

describe('scheme-1 native input collection with real discovery subprocesses', () => {
  let root: string;
  let runtime: Record<string, unknown>;
  const write = (name: string, value: string) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const configure = () => {
    // Jest has a separate module registry; native/CLI collection runs in a fresh Node process.
    jest.resetModules();
    write('bundle.drop.config.js', `module.exports = ${JSON.stringify({ projectType: 'bare', runtimeVersion: runtime })};`);
  };
  const collect = () => { configure(); return collectNativeFingerprint(root, 'android'); };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-fingerprint-'));
    runtime = { compatibilitySource: 'fingerprint', fingerprint: { schemeVersion: 1, nativeProjectMode: { android: 'native' } } };
    write('package.json', '{"name":"fingerprint-fixture","scripts":{}}');
    write('node_modules/react-native/package.json', '{"name":"react-native","version":"0.78.3"}');
    write('node_modules/react-native/cli.js', 'console.log(JSON.stringify({root:process.cwd(),dependencies:{}}));');
    write('android/app/build.gradle', 'android {\n defaultConfig {\n versionCode 1\n targetSdk 35\n }\n}\n');
    write('android/app/src/main/Native.kt', 'fun feature() = false\n');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('is stable across JS, generated output, build-number, and checkout-root differences', async () => {
    const before = await collect();
    expect(before.status).toBe('stable');
    expect(before.nativeHash).toBe(scheme1Golden.nativeHash);
    expect(before.runtimeVersion).toBe(scheme1Golden.runtimeVersion);
    expect(before.runtimeVersion).toMatch(/^bdfp1-[a-f0-9]{64}$/);
    expect(await collect()).toEqual(before);
    write('App.js', 'export default 2;');
    write('android/app/build/generated/noise.txt', String(Date.now()));
    write('android/.kotlin/sessions/kotlin-compiler-nonce.salive', '');
    write('android/.kotlin/errors/compiler-error.log', 'generated compiler diagnostics');
    write('android/local.properties', 'sdk.dir=/machine/specific/sdk');
    write('.bundle-drop/generated/bundle.drop.config.js', 'generated noise');
    write('android/app/build.gradle', 'android {\n defaultConfig {\n versionCode 42\n targetSdk 35\n }\n}\n');
    expect((await collect()).runtimeVersion).toBe(before.runtimeVersion);
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-other-checkout-'));
    try {
      fs.cpSync(root, second, { recursive: true });
      expect((await collectNativeFingerprint(second, 'android')).runtimeVersion).toBe(before.runtimeVersion);
    } finally { fs.rmSync(second, { recursive: true, force: true }); }
  });

  it('keeps the frozen identity when the redundant public scheme option is omitted', async () => {
    const explicit = await collect();
    delete (runtime.fingerprint as Record<string, unknown>).schemeVersion;
    expect(await collect()).toEqual(explicit);
    expect(explicit.runtimeVersion).toBe(scheme1Golden.runtimeVersion);
  });

  it('uses the revised multi-globstar ignore semantics without hiding included native edits', async () => {
    write('.fingerprintignore', '**/a/b/c/**/d/**\n');
    write('android/a/b/c/d/file.kt', 'fun ignored() = false\n');
    const before = await collect();
    expect(before.nativeHash).toBe(scheme1Golden.cases.multiGlobstarIgnore.nativeHash);
    expect(before.runtimeVersion).toBe(scheme1Golden.cases.multiGlobstarIgnore.runtimeVersion);
    write('android/a/b/c/d/file.kt', 'fun ignored() = true\n');
    expect((await collect()).runtimeVersion).toBe(before.runtimeVersion);
    write('android/app/src/main/Native.kt', 'fun feature() = true\n');
    expect((await collect()).runtimeVersion).not.toBe(before.runtimeVersion);
  });

  it('changes for native edits and explicit boundaries, retaining source digest evidence', async () => {
    const before = await collect();
    write('android/app/src/main/Native.kt', 'fun feature() = true\n');
    const after = await collect();
    expect(after.runtimeVersion).toBe(scheme1Golden.cases.bareAndroidNativeEdit.runtimeVersion);
    expect(after.nativeHash).toBe(scheme1Golden.cases.bareAndroidNativeEdit.nativeHash);
    expect(after.sources.find(source => source.id === 'android')?.hash)
      .not.toBe(before.sources.find(source => source.id === 'android')?.hash);
    runtime.android = 'boundary-2';
    expect((await collect()).runtimeVersion).not.toBe(after.runtimeVersion);
  });

  it('preserves the frozen manual-boundary domain without changing native input hashing', async () => {
    runtime.android = 'boundary-2';
    const report = await collect();
    expect(report.nativeHash).toBe(scheme1Golden.cases.bareAndroidBoundary.nativeHash);
    expect(report.runtimeVersion).toBe(scheme1Golden.cases.bareAndroidBoundary.runtimeVersion);
  });

  it('uses identical source IDs through a symlinked checkout root', async () => {
    const before = await collect();
    const aliases = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-checkout-alias-'));
    const alias = path.join(aliases, 'checkout');
    try {
      fs.symlinkSync(root, alias, 'dir');
      expect(await collectNativeFingerprint(alias, 'android')).toEqual(before);
    } finally { fs.rmSync(aliases, { recursive: true, force: true }); }
  });

  it('normalizes recognized iOS build settings without removing native settings', async () => {
    (runtime.fingerprint as Record<string, unknown>).nativeProjectMode = { ios: 'native' };
    const source = '{ objects = { ID = { buildSettings = { CURRENT_PROJECT_VERSION = 1; ENABLE_NATIVE_PROBE = NO; }; }; }; }';
    write('ios/Fixture.xcodeproj/project.pbxproj', source);
    configure();
    const before = await collectNativeFingerprint(root, 'ios');
    expect(before.nativeHash).toBe(scheme1Golden.cases.bareIos.nativeHash);
    expect(before.runtimeVersion).toBe(scheme1Golden.cases.bareIos.runtimeVersion);
    write('ios/Fixture.xcodeproj/project.pbxproj', source.replace('VERSION = 1;', 'VERSION = 2;'));
    expect((await collectNativeFingerprint(root, 'ios')).runtimeVersion).toBe(before.runtimeVersion);
    write('ios/Fixture.xcodeproj/project.pbxproj', source.replace('PROBE = NO;', 'PROBE = YES;'));
    expect((await collectNativeFingerprint(root, 'ios')).runtimeVersion).toBe(scheme1Golden.cases.bareIosNativeEdit.runtimeVersion);
  });

  it('hashes modified autolinked native module contents even without a version change', async () => {
    write('node_modules/native-kit/package.json', '{"name":"native-kit","version":"1.0.0"}');
    write('node_modules/native-kit/android/Native.kt', 'fun feature() = false');
    write('node_modules/react-native/cli.js', `const path=require('path'); console.log(JSON.stringify({root:process.cwd(),dependencies:{'native-kit':{root:path.join(process.cwd(),'node_modules/native-kit'),platforms:{android:{sourceDir:path.join(process.cwd(),'node_modules/native-kit/android')}}}}}));`);
    const before = await collect();
    write('node_modules/native-kit/android/Native.kt', 'fun feature() = true');
    expect((await collect()).runtimeVersion).not.toBe(before.runtimeVersion);
  });

  it('requires successful applicable discovery and real native inputs', async () => {
    write('node_modules/react-native/cli.js', 'process.stderr.write("autolinking failed"); process.exit(2)');
    await expect(collect()).rejects.toThrow('autolinking failed');
    fs.rmSync(path.join(root, 'android'), { recursive: true });
    await expect(collect()).rejects.toThrow();
  });
  it('rejects a file in place of the explicitly selected native directory', async () => {
    fs.rmSync(path.join(root, 'android'), { recursive: true });
    write('android', 'not a native directory');
    await expect(collect()).rejects.toThrow('selected native fingerprint project');
  });

  it('records optional absence and hashes explicit file, directory, and environment inputs without exposing values', async () => {
    const options = runtime.fingerprint as Record<string, unknown>;
    options.extraSources = [{ id: 'native-config', type: 'file', value: 'external/native.json' }];
    await expect(collect()).rejects.toThrow('Required fingerprint extra source');
    write('external/native.json', '{"native":true}');
    write('external/native-dir/a.cpp', 'int value = 1;');
    options.extraSources = [
      { id: 'native-config', type: 'file', value: 'external/native.json' },
      { id: 'native-dir', type: 'dir', value: 'external/native-dir' },
      { id: 'secret-setting', type: 'environment', value: 'BD_FP_TEST_SECRET' },
      { id: 'absent', type: 'environment', value: 'BD_FP_TEST_ABSENT', optional: true },
      { id: 'ios-only', type: 'file', value: 'does-not-exist', platforms: ['ios'] },
    ];
    process.env.BD_FP_TEST_SECRET = 'never-report-this-value';
    try {
      const before = await collect();
      expect(JSON.stringify(before)).not.toContain('never-report-this-value');
      process.env.BD_FP_TEST_SECRET = 'changed';
      expect((await collect()).runtimeVersion).not.toBe(before.runtimeVersion);
    } finally { delete process.env.BD_FP_TEST_SECRET; }
  });

  it.each([
    [null], [{ id: 'x', type: 'other', value: 'x' }],
    [{ id: 'x', type: 'file', value: 'package.json' }, { id: 'x', type: 'dir', value: 'android' }],
    [{ id: 'x', type: 'dir', value: 'package.json' }],
    [{ id: 'x', type: 'file', value: 'android' }],
  ])('rejects invalid extra-source configurations: %j', async (...entries) => {
    (runtime.fingerprint as Record<string, unknown>).extraSources = entries;
    await expect(collect()).rejects.toThrow();
  });

  it('requires the fingerprint selector and can discover native mode without an explicit map', async () => {
    runtime = { android: 'manual' };
    await expect(collect()).rejects.toThrow('requires compatibilitySource');
    runtime = { compatibilitySource: 'fingerprint' };
    expect((await collect()).runtimeVersion).toMatch(/^bdfp1-/);
    fs.rmSync(path.join(root, 'android'), { recursive: true });
    await expect(collect()).rejects.toThrow('Required native fingerprint directory');
  });
});
