import crypto from 'node:crypto';
import nativeFs from 'node:fs';
import fs from 'fs-extra';
import path from 'node:path';

import { listNativeSetupContext } from '../../../../CLI/scripts/aipowered/native-setup-context';
import { authoritativeDynamicExpoConfigFile, scanProjectForAiSetupV2 } from '../../../../CLI/scripts/aipowered/scanner';
import { assertNativeSetupSnapshot, verifyNativeSetupPlan } from '../../../../CLI/scripts/aipowered/setup-v2';
import type { AiPatchPlan, AiSetupPlanResponse } from '../../../../CLI/scripts/aipowered/types';
import * as files from '../../../../CLI/scripts/safe-file-transaction';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

const androidSource = 'android/mobile/src/main/java/ui/Launch.kt';
const iosSource = 'ios/Application/ColdStart.swift';
const manifest = 'android/mobile/src/main/AndroidManifest.xml';
const project = 'ios/Demo.xcodeproj/project.pbxproj';
const plist = 'ios/Application/Info.plist';
const header = 'ios/Application/Bridge.h';
const gradle = 'android/mobile/build.gradle';
const plistContent = '<plist version="1.0"><dict></dict></plist>';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const virtualConfig = {
  content: 'module.exports = { serverUrl: "https://api.bundledrop.app" };',
  serverUrl: 'https://api.bundledrop.app',
  orgSlug: 'demo',
  projectSlug: 'fixture',
  authToken: 'test-token',
};

describe('AI-led native setup wire and transaction', () => {
  let projectRoot: string;
  const write = (file: string, body: string) => {
    const destination = path.join(projectRoot, file);
    fs.ensureDirSync(path.dirname(destination));
    fs.writeFileSync(destination, body);
  };
  const scan = () => scanProjectForAiSetupV2(projectRoot, virtualConfig);
  const patch = (file: string, initial: string, updated: string): AiPatchPlan => ({
    file,
    originalSha256: hash(initial),
    updated,
    confidence: 'high',
    decisionType: 'review_only_patch',
    reason: 'Integrate the native resolver.',
  });
  const plan = (...changes: AiPatchPlan[]): AiSetupPlanResponse => ({
    confidence: 'high', summary: 'Ready for review.', actions: [], changes, warnings: [],
  });

  beforeEach(() => {
    projectRoot = createTempProjectDir();
    write('package.json', '{"dependencies":{"react-native":"0.84.1"}}');
    write(androidSource, 'Kotlin provided for the planner to inspect');
    write(iosSource, 'Swift provided for the planner to inspect');
    write(manifest, '<manifest><application /></manifest>');
    write(project, 'Xcode target metadata');
    write(plist, plistContent);
    write(header, 'Objective-C bridge metadata');
    write('android/settings.gradle.kts', 'include(":mobile")');
    write(gradle, 'android {\n  namespace "app.example"\n}');
    write('ios/Podfile', 'platform :ios');
  });
  afterEach(() => removeTempDir(projectRoot));

  it('shares application source and only allowlisted facts from build metadata', async () => {
    write('ios/Pods/Dependency.mm', 'excluded');
    write('ios/FixtureTests/Test.swift', 'excluded');
    write('ios/Application/GoogleService-Info.plist', plistContent);
    write('android/mobile/src/test/java/Runner.java', 'excluded');
    write('android/mobile/build/generated/MainApplication.java', 'excluded');
    write('android/generated/src/main/java/Hidden.java', 'excluded');
    const { request, snapshot } = await scan();
    expect(request.schemaVersion).toBe(2);
    expect(request.nativeEditPaths).toEqual([androidSource, iosSource]);
    expect(request).not.toHaveProperty('nativeTargets');
    expect(request.detected).toMatchObject({ bundleDropStatus: 'partial', jsEngine: 'unknown', codePushDetected: false });
    expect(request.files.filter(file => file.kind === 'native_support').map(file => file.path))
      .toEqual(expect.arrayContaining([
        manifest, plist, gradle,
      ]));
    for (const file of [project, header, 'android/settings.gradle.kts', 'ios/Podfile', 'ios/Application/GoogleService-Info.plist']) {
      expect(request.files.some(item => item.path === file)).toBe(false);
    }
    expect(request.files).not.toEqual(expect.arrayContaining([expect.objectContaining({ content: 'excluded' })]));
    expect(snapshot.get(androidSource)).toBe(hash('Kotlin provided for the planner to inspect'));
    expect(snapshot.get('bundle.drop.config.js')).toBeNull();
  });

  it('marks declared CodePush for an explicit migration without interpreting source text', async () => {
    write(iosSource, 'CodePush.bundleURL()');
    expect((await scan()).request.detected.codePushDetected).toBe(false);
    write('package.json', '{"dependencies":{"react-native-code-push":"9.0.0"}}');
    expect((await scan()).request.detected).toMatchObject({
      codePushDetected: true, signals: expect.arrayContaining(['codePushDependency']),
    });
  });

  it('reports only platforms with supplied editable source even if another native directory remains', async () => {
    fs.unlinkSync(path.join(projectRoot, androidSource));
    const { request } = await scan();
    expect(request.nativeEditPaths).toEqual([iosSource]);
    expect(request.detected.signals).toContain('iosDirectory');
    expect(request.detected.signals).not.toContain('androidDirectory');
    expect(request.files.some(file => file.path === manifest)).toBe(false);
  });

  it('accepts reviewed edits for allowed sources and rejects metadata or automatic edits', async () => {
    const context = await scan();
    const change = patch(iosSource, 'Swift provided for the planner to inspect', 'Planner-proposed Swift replacement');
    expect(verifyNativeSetupPlan(context, plan(change))).toEqual(new Set([iosSource]));
    expect(verifyNativeSetupPlan(context, { ...plan(), confidence: 'low' })).toEqual(new Set());
    expect(() => verifyNativeSetupPlan(context, plan(patch(plist, '<plist/>', 'other metadata'))))
      .toThrow('outside the consented files');
    expect(() => verifyNativeSetupPlan(context, plan({ ...change, decisionType: 'safe_auto_patch' })))
      .toThrow('outside the consented files');
    expect(() => verifyNativeSetupPlan(context, plan({ ...change, originalSha256: hash('other') })))
      .toThrow('outside the consented files');
    expect(() => verifyNativeSetupPlan(context, plan(change, change))).toThrow('outside the consented files');
    expect(() => verifyNativeSetupPlan(context, { ...plan(change), confidence: 'low' })).toThrow('invalid native plan');
    const outdated = { ...plan(change), nativeEvidence: {} };
    expect(() => verifyNativeSetupPlan(context, outdated)).toThrow('invalid native plan');
  });

  it('rejects unreviewable replacement sizes, identical changes, and credential literals', async () => {
    const context = await scan();
    const original = 'Swift provided for the planner to inspect';
    for (const replacement of [original, ' '.repeat(81 * 1024), 'let password = "localSecret"']) {
      expect(() => verifyNativeSetupPlan(context, plan(patch(iosSource, original, replacement))))
        .toThrow('outside the consented files');
    }
  });

  it('compares the raw shared files before and after writes, including summarized config and read-only metadata', async () => {
    const context = await scan();
    const change = patch(androidSource, 'Kotlin provided for the planner to inspect', 'The reviewed update');
    expect(() => assertNativeSetupSnapshot(context)).not.toThrow();
    write(androidSource, change.updated);
    expect(() => assertNativeSetupSnapshot(context)).toThrow(androidSource);
    expect(() => assertNativeSetupSnapshot(context, [change])).not.toThrow();

    write(manifest, '<manifest package="changed"/>');
    expect(() => assertNativeSetupSnapshot(context, [change])).toThrow(manifest);
    write(manifest, '<manifest><application /></manifest>');
    write('package.json', '{"dependencies":{}}');
    expect(() => assertNativeSetupSnapshot(context, [change])).toThrow('package.json');
    expect(() => assertNativeSetupSnapshot(context, [change], true)).not.toThrow();
    write('bundle.drop.config.js', 'module.exports = {}');
    expect(() => assertNativeSetupSnapshot(context, [change], true)).toThrow('bundle.drop.config.js');
  });

  it('rejects an added source even if every reviewed file still matches', async () => {
    const context = await scan();
    write('ios/Application/AnotherStart.swift', 'new source');
    expect(() => assertNativeSetupSnapshot(context)).toThrow('changed during review');
  });

  it('protects local authority metadata that was inspected but not shared', async () => {
    const unrelatedPlist = 'ios/Application/Other.plist';
    write(unrelatedPlist, plistContent);
    const context = await scan();
    expect(context.request.files.some(file => file.path === unrelatedPlist)).toBe(false);
    write(unrelatedPlist, plistContent + '\n');
    expect(() => assertNativeSetupSnapshot(context)).toThrow(unrelatedPlist);
  });

  it('bounds source and aggregate context before sharing', async () => {
    write(iosSource, ' '.repeat(81 * 1024));
    await expect(scan()).rejects.toThrow('startup source exceeds');
    write(iosSource, ' '.repeat(70 * 1024));
    write(androidSource, ' '.repeat(70 * 1024));
    await expect(scan()).rejects.toThrow('startup source exceeds');
  });

  it('leaves an oversized optional Metro summary out of the small planning context', async () => {
    write('metro.config.js', ' '.repeat(1024 * 1024 + 1));
    const { request, snapshot } = await scan();
    expect(request.files.some(file => file.path === 'metro.config.js')).toBe(false);
    expect(snapshot.has('metro.config.js')).toBe(false);
  });

  it('bounds filesystem walking before reading individual native sources', () => {
    const crowded = jest.spyOn(nativeFs, 'readdirSync').mockReturnValueOnce(Array(5_001));
    try {
      expect(() => listNativeSetupContext(projectRoot)).toThrow('directory inspection limit');
    } finally {
      crowded.mockRestore();
    }
  });

  it('rejects unsafe native paths and symlinks', () => {
    const linked = path.join(projectRoot, 'ios/Application/Linked.swift');
    fs.symlinkSync(path.join(projectRoot, androidSource), linked);
    expect(() => listNativeSetupContext(projectRoot)).toThrow('symlinked native setup path');
    fs.unlinkSync(linked);
    fs.unlinkSync(path.join(projectRoot, gradle));
    fs.symlinkSync(path.join(projectRoot, androidSource), path.join(projectRoot, gradle));
    expect(() => listNativeSetupContext(projectRoot)).toThrow('non-regular native setup path');
    fs.unlinkSync(path.join(projectRoot, gradle));
    write('ios/Application/Bad\nPath.swift', 'unsafe');
    expect(() => listNativeSetupContext(projectRoot)).toThrow('unsafe characters');
  });

  it('rejects empty projects and ignores headers as read-only context', async () => {
    fs.removeSync(path.join(projectRoot, 'android'));
    fs.removeSync(path.join(projectRoot, 'ios'));
    expect(() => listNativeSetupContext(projectRoot)).toThrow('No app-owned native source files');
    write(iosSource, 'one source');
    for (let index = 0; index < 24; index += 1) write('ios/Application/Extra' + index + '.h', 'header');
    expect((await scan()).request.files.some(file => file.path.endsWith('.h'))).toBe(false);
  });

  it('keeps registered startup sources in scope without uploading an entire large inventory', async () => {
    write(manifest, '<manifest package="ui"><application android:name=".Launch" /></manifest>');
    write(plist, '<plist version="1.0"><dict><key>UIApplicationSceneManifest</key><dict>' +
      '<key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict>' +
      '<key>UISceneDelegateClassName</key><string>$(PRODUCT_MODULE_NAME).ColdStart</string>' +
      '</dict></array></dict></dict></dict></plist>');
    for (let index = 0; index < 25; index++) {
      write(`ios/Application/Auxiliary${index}.swift`, 'struct Auxiliary {}');
    }
    const context = await scan();
    expect(context.request.nativeEditPaths).toHaveLength(16);
    expect(context.request.nativeEditPaths).toEqual(expect.arrayContaining([androidSource, iosSource]));
    expect(context.nativeInventory).toHaveLength(listNativeSetupContext(projectRoot).length);
    expect(() => assertNativeSetupSnapshot(context)).not.toThrow();
  });

  it('keeps Xcode app source and plist associations and skips oversized optional inputs', async () => {
    const customPlist = 'ios/Application/Custom.plist';
    const builtFile = 'ios/Application/Chosen.swift';
    write(customPlist, plistContent);
    write(builtFile, 'struct Chosen {}');
    write('ios/Application/BodyResolver.swift', 'struct BodyResolver {}');
    write('ios/Application/AppDelegate.swift', 'struct AppDelegate {}');
    write('ios/Application/LargeSupport.swift', ' '.repeat(81 * 1024));
    write('ios/Application/Large.plist', ' '.repeat(2 * 1024 * 1024 + 1));
    write(project, [
      '{ rootObject = PROJECT; objects = {',
      ' PROJECT = {isa = PBXProject; mainGroup = ROOT; targets = (APP);};',
      ' APP = {isa = PBXNativeTarget; productType = com.apple.product-type.application;',
      '   buildConfigurationList = CONFIGS; buildPhases = (SOURCES);};',
      ' CONFIGS = {isa = XCConfigurationList; buildConfigurations = (RELEASE);};',
      ' RELEASE = {isa = XCBuildConfiguration; buildSettings = {INFOPLIST_FILE = Application/Custom.plist;};};',
      ' SOURCES = {isa = PBXSourcesBuildPhase; files = (BUILT);};',
      ' BUILT = {isa = PBXBuildFile; fileRef = CHOSEN;};',
      ' ROOT = {isa = PBXGroup; sourceTree = "<group>"; children = (CHOSEN);};',
      ' CHOSEN = {isa = PBXFileReference; sourceTree = "<group>"; path = Application/Chosen.swift;};',
      '};}',
    ].join('\n'));
    const { request } = await scan();
    const evidence = request.files.find(file => file.path === project);
    expect(JSON.parse(evidence!.content)).toEqual({
      targets: [{ sourcePaths: [builtFile], infoPlistPaths: [customPlist] }],
    });
    expect(request.files.map(file => file.path)).toContain(customPlist);
    expect(request.files.some(file => file.path.includes('/Large'))).toBe(false);
    expect(request.nativeEditPaths).toContain(builtFile);
  });

  it('aborts if a metadata file disappears after discovery', async () => {
    const inspect = jest.spyOn(files, 'inspectProjectFile').mockReturnValueOnce({
      exists: false, content: '', mode: 0,
    });
    try {
      await expect(scan()).rejects.toThrow('changed during discovery');
    } finally {
      inspect.mockRestore();
    }
  });

  it('aborts if a selected source becomes unsafe or grows beyond the total budget', async () => {
    const read = files.inspectProjectFile;
    const inspect = jest.spyOn(files, 'inspectProjectFile').mockImplementation((root, file) => {
      if (file === androidSource) throw new Error('Source changed to a symlink');
      return read(root, file);
    });
    try {
      await expect(scan()).rejects.toThrow('not a regular project file');
      inspect.mockImplementation((root, file) => file === androidSource
        ? { exists: false, content: '', mode: 0 }
        : read(root, file));
      await expect(scan()).rejects.toThrow('changed during discovery');
      inspect.mockImplementation((root, file) => {
        const result = read(root, file);
        return file === androidSource || file === iosSource
          ? { ...result, content: ' '.repeat(70 * 1024) }
          : result;
      });
      await expect(scan()).rejects.toThrow('native setup context exceeds the size limit');
    } finally {
      inspect.mockRestore();
    }
  });

  it('describes configured runtime authority without transmitting runtime values', async () => {
    write('bundle.drop.config.js', 'module.exports = { runtimeVersion: { ios: "ios-fixture", android: "android-fixture" } };');
    const planned = (await scan()).request.files.find(file => file.path === 'bundle.drop.config.js');
    expect(planned?.content).toContain('runtimeVersionAuthority: ios_literal,android_literal');
    expect(planned?.content).not.toContain('ios-fixture');
    expect(planned?.content).not.toContain('android-fixture');
  });

  it('still fails closed on unusable Expo dynamic config paths', () => {
    expect(() => authoritativeDynamicExpoConfigFile(projectRoot, ' '))
      .toThrow('usable authoritative dynamic app config path');
    expect(() => authoritativeDynamicExpoConfigFile(projectRoot, 'nested/app.config.js'))
      .toThrow('unsafe dynamic app config path');
    expect(() => authoritativeDynamicExpoConfigFile(projectRoot, 'app.config.js'))
      .toThrow('authoritative dynamic app config is missing');
  });

  it('omits optional metadata if the sources use the remaining context budget', async () => {
    write('bundle.drop.config.js', virtualConfig.content);
    const { request } = await scan();
    const configBytes = request.files
      .filter(file => !['ios_entrypoint', 'android_entrypoint', 'native_support'].includes(file.kind))
      .reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0);
    // The files grew after local discovery while staying within the per-file cap.
    const read = files.inspectProjectFile;
    const inspect = jest.spyOn(files, 'inspectProjectFile').mockImplementation((root, file) => {
      const result = read(root, file);
      if (file === androidSource) return { ...result, content: ' '.repeat(64 * 1024) };
      if (file === iosSource) return { ...result, content: ' '.repeat(64 * 1024 - configBytes) };
      return result;
    });
    try {
      expect((await scan()).request.files.some(file => file.kind === 'native_support')).toBe(false);
    } finally {
      inspect.mockRestore();
    }
  });

  it('keeps Groovy and XML secrets out of the outbound setup payload', async () => {
    write(gradle, 'android {\nnamespace "app.example"\nsigningConfigs { release { storePassword "GroovyDummySecret" } }\n}');
    write(manifest, '<manifest package="app.example"><application android:name=".Launch">' +
      '<meta-data android:name="ClientSecret" android:value="ManifestDummySecret" /></application></manifest>');
    write(plist, '<plist version="1.0"><dict><key>ClientSecret</key><string>PlistDummySecret</string></dict></plist>');
    const { request, snapshot } = await scan();
    expect(JSON.stringify(request)).not.toContain('DummySecret');
    const evidence = Object.fromEntries(request.files.filter(file => file.kind === 'native_support')
      .map(file => [file.path, JSON.parse(file.content)]));
    expect(evidence[gradle]).toEqual({ namespace: 'app.example' });
    expect(evidence[manifest]).toEqual({ applicationClass: '.Launch', packageName: 'app.example' });
    expect(evidence[plist]).toEqual({ sceneDelegateClasses: [] });
    expect(snapshot.get(gradle)).toBe(hash(fs.readFileSync(path.join(projectRoot, gradle), 'utf8')));
  });
});
