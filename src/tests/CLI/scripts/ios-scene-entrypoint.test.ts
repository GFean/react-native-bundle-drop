import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { scanProjectForAiSetup } from '../../../CLI/scripts/aipowered/scanner';
import { validateAppliedSetupChanges, validateSetupChangesBeforeApply } from '../../../CLI/scripts/aipowered/validate-plan';
import { applySetupPatchPlans } from '../../../CLI/scripts/aipowered/apply-setup-plan';
import { inspectProject } from '../../../CLI/scripts/doctor';
import { findBareIosSceneEntrypoint } from '../../../CLI/scripts/native-entrypoint-authority';
import { findMissingBareNativeStartupStructure } from '../../../CLI/scripts/native-startup-validator';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

const scenePath = 'ios/Demo/SceneDelegate.swift';
const plistPath = 'ios/Demo/Info.plist';
const projectPath = 'ios/Demo.xcodeproj/project.pbxproj';
const appDelegate = 'import UIKit\n@main\nclass AppDelegate: UIResponder, UIApplicationDelegate {}\n';
const sceneDelegate = `import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import UIKit

class SceneDelegate: RCTDefaultReactNativeFactoryDelegate, UIWindowSceneDelegate {
  var window: UIWindow?
  var reactNativeFactory: RCTReactNativeFactory?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    dependencyProvider = RCTAppDependencyProvider()
    reactNativeFactory = RCTReactNativeFactory(delegate: self)
    window = UIWindow(windowScene: windowScene)
    #if DEBUG
    reactNativeFactory?.devMenuConfiguration = RCTDevMenuConfiguration(devMenuEnabled: true)
    #endif
    reactNativeFactory?.startReactNative(
      withModuleName: "Demo",
      in: window,
      connectionOptions: connectionOptions
    )
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.scene(scene, continue: userActivity)
  }

  override func bundleURL() -> URL? {
    #if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
    #else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    #endif
  }
}
`;
const integrated = sceneDelegate.replace('import UIKit', 'import UIKit\nimport BundleDrop')
  .replace('Bundle.main.url(', 'BundleDropLocator.bundleURL() ?? Bundle.main.url(');
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>UIApplicationSceneManifest</key><dict>
    <key>UIApplicationSupportsMultipleScenes</key><false/>
    <key>UISceneConfigurations</key><dict>
      <key>UIWindowSceneSessionRoleApplication</key><array><dict>
        <key>UISceneDelegateClassName</key><string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
      </dict></array>
    </dict>
  </dict>
</dict></plist>`;
const xcodeProject = `{
  rootObject = PROJECT;
  objects = {
    PROJECT = {isa = PBXProject; mainGroup = ROOT; targets = (APP);};
    APP = {isa = PBXNativeTarget; productType = com.apple.product-type.application;
      buildConfigurationList = CONFIGS; buildPhases = (SOURCES);};
    CONFIGS = {isa = XCConfigurationList; buildConfigurations = (RELEASE, DEBUG);};
    RELEASE = {isa = XCBuildConfiguration; buildSettings = {INFOPLIST_FILE = Demo/Info.plist;};};
    DEBUG = {isa = XCBuildConfiguration; buildSettings = {INFOPLIST_FILE = Demo/Info.plist;};};
    SOURCES = {isa = PBXSourcesBuildPhase; files = (APP_BUILD, SCENE_BUILD);};
    APP_BUILD = {isa = PBXBuildFile; fileRef = APP_FILE;};
    SCENE_BUILD = {isa = PBXBuildFile; fileRef = SCENE_FILE;};
    ROOT = {isa = PBXGroup; sourceTree = "<group>"; children = (DEMO);};
    DEMO = {isa = PBXGroup; sourceTree = "<group>"; path = Demo; children = (APP_FILE, SCENE_FILE);};
    APP_FILE = {isa = PBXFileReference; sourceTree = "<group>"; path = AppDelegate.swift;};
    SCENE_FILE = {isa = PBXFileReference; sourceTree = "<group>"; path = SceneDelegate.swift;};
  };
}`;
const legacyProject = xcodeProject.replace('files = (APP_BUILD, SCENE_BUILD)', 'files = (APP_BUILD)');
const legacyInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleName</key><string>Demo</string></dict></plist>`;
const legacyAppDelegate = `import BundleDrop
@main class AppDelegate: RCTAppDelegate {
  override func bundleURL() -> URL? { BundleDropLocator.bundleURL() }
}`;

describe('bare iOS scene startup', () => {
  let projectRoot: string;

  const write = (relativePath: string, content: string) => {
    const destination = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  };

  beforeEach(() => {
    projectRoot = createTempProjectDir();
    write('package.json', JSON.stringify({ dependencies: { 'react-native': '0.88.1' } }));
    write('node_modules/react-native/package.json', JSON.stringify({ name: 'react-native', version: '0.88.1' }));
    write('ios/Demo/AppDelegate.swift', appDelegate);
    write(scenePath, sceneDelegate);
    write(plistPath, infoPlist);
    write(projectPath, xcodeProject);
  });

  afterEach(() => removeTempDir(projectRoot));

  it('allows a comment inside bundleURL while guarding edits outside it', () => {
    const withResolverComment = integrated.replace(
      '    BundleDropLocator.bundleURL()',
      '    // Prefer the downloaded bundle.\n    BundleDropLocator.bundleURL()',
    );
    const withLinkingChange = withResolverComment.replace(
      '    RCTLinkingManager.scene',
      '    print("Forwarding the activity")\n    RCTLinkingManager.scene',
    );

    expect(findMissingBareNativeStartupStructure(scenePath, sceneDelegate, withResolverComment))
      .toEqual([]);
    expect(findMissingBareNativeStartupStructure(scenePath, sceneDelegate, withLinkingChange))
      .toEqual(['SceneDelegate code outside bundleURL']);
  });

  it('rejects a setup patch that leaves the scene class unclosed', () => {
    const withoutClassClosingBrace = integrated.trimEnd().slice(0, -1);

    expect(findMissingBareNativeStartupStructure(scenePath, sceneDelegate, withoutClassClosingBrace))
      .toContain('bundleURL');
  });

  it('shares only the active bundle owner and reports it integrated after review', async () => {
    write('ios/Unused/SceneDelegate.swift', sceneDelegate);
    const actualScene = await findBareIosSceneEntrypoint(projectRoot);
    expect(actualScene).toBe(scenePath);
    const scan = scanProjectForAiSetup('bare', projectRoot, {
      serverUrl: 'https://api.bundledrop.app',
      orgSlug: 'test-org',
      projectSlug: 'test-project',
      authToken: 'test',
      content: 'module.exports = {};',
    }, actualScene!);
    const files = scan.request.files.filter(file => file.kind === 'ios_entrypoint');
    expect(files.map(file => file.path)).toEqual([scenePath]);

    const change = {
      file: scenePath,
      originalSha256: crypto.createHash('sha256').update(sceneDelegate).digest('hex'),
      updated: integrated,
      reason: 'Add the Bundle Drop Release fallback.',
      confidence: 'high' as const,
      decisionType: 'review_only_patch' as const,
    };
    const validation = {
      projectType: 'bare' as const,
      originals: new Map([[scenePath, sceneDelegate]]),
      changes: [change],
    };
    expect(() => validateSetupChangesBeforeApply(validation)).toThrow('may not modify');
    expect(() => validateSetupChangesBeforeApply({
      ...validation,
      iosSceneEntrypoint: scenePath,
      changes: [{
        ...change,
        updated: integrated.replace('RCTLinkingManager.scene', 'CustomLinkingManager.scene'),
      }],
    })).toThrow('startup structure');
    expect(() => validateSetupChangesBeforeApply({ ...validation, iosSceneEntrypoint: scenePath }))
      .not.toThrow();
    applySetupPatchPlans({ projectRoot, projectType: 'bare', changes: [change], iosSceneEntrypoint: scenePath });
    expect(await findBareIosSceneEntrypoint(projectRoot)).toBe(scenePath);
    expect(() => validateAppliedSetupChanges({ ...validation, projectRoot, iosSceneEntrypoint: scenePath }))
      .not.toThrow();
    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare', platform: 'ios' });
    expect(result.checks.find(check => check.name === 'ios OTA startup ownership')).toMatchObject({
      status: 'pass',
      message: 'The iOS scene delegate asks Bundle Drop for the cold-start bundle.',
    });
  });

  it('rejects a scene that is registered but absent from the app target sources', async () => {
    write(projectPath, legacyProject);
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow('must compile exactly one SceneDelegate');
  });

  it('keeps the legacy AppDelegate owner when every project excludes the dormant scene', async () => {
    write(projectPath, legacyProject);
    write('ios/Second.xcodeproj/project.pbxproj', legacyProject);
    write(plistPath, legacyInfoPlist);
    write('ios/Demo/AppDelegate.swift', legacyAppDelegate);

    await expect(findBareIosSceneEntrypoint(projectRoot)).resolves.toBeNull();
    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare', platform: 'ios' });
    expect(result.checks.find(check => check.name === 'ios OTA startup ownership')).toMatchObject({
      status: 'pass',
      message: 'The ios application entrypoint asks Bundle Drop for the cold-start bundle.',
    });
  });

  it('requires all applications in one Xcode project to exclude the scene', async () => {
    const twoApps = legacyProject.replace('targets = (APP)', 'targets = (APP, SECOND)').replace(
      '    CONFIGS =',
      '    SECOND = {isa = PBXNativeTarget; productType = com.apple.product-type.application;' +
        ' buildConfigurationList = CONFIGS; buildPhases = (SOURCES);};\n    CONFIGS =',
    );
    write(projectPath, twoApps);
    write(plistPath, legacyInfoPlist);
    await expect(findBareIosSceneEntrypoint(projectRoot)).resolves.toBeNull();

    write(projectPath, twoApps.replace('buildPhases = (SOURCES);};\n    CONFIGS', 'buildPhases = (OTHER);};\n' +
      '    OTHER = {isa = PBXSourcesBuildPhase; files = (APP_BUILD, SCENE_BUILD);};\n    CONFIGS'));
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow('Could not prove SceneDelegate is dormant');
  });

  it.each([
    ['compiled scene', xcodeProject, legacyInfoPlist],
    ['registered scene', legacyProject, infoPlist],
    ['unknown source membership', legacyProject.replace('files = (APP_BUILD)', 'files = (UNKNOWN)'), legacyInfoPlist],
    ['unknown build phase', legacyProject.replace('buildPhases = (SOURCES)', 'buildPhases = (SOURCES, UNKNOWN)'), legacyInfoPlist],
    ['filesystem-synchronized sources', legacyProject.replace('isa = PBXGroup', 'isa = PBXFileSystemSynchronizedRootGroup'), legacyInfoPlist],
    ['inherited scene settings', legacyProject.replace('isa = XCBuildConfiguration', 'isa = XCBuildConfiguration; baseConfigurationReference = CONFIG_FILE'), legacyInfoPlist],
    ['generated Info.plist', legacyProject.replace('INFOPLIST_FILE = Demo/Info.plist;', 'INFOPLIST_FILE = Demo/Info.plist; GENERATE_INFOPLIST_FILE = YES;'), legacyInfoPlist],
    ['unresolved project configurations', legacyProject.replace('mainGroup = ROOT;', 'mainGroup = ROOT; buildConfigurationList = UNKNOWN;'), legacyInfoPlist],
    ['a referenced external project', legacyProject.replace('mainGroup = ROOT;', 'mainGroup = ROOT; projectReferences = ({ ProjectRef = EXTERNAL; });'), legacyInfoPlist],
    ['a custom build rule', legacyProject.replace('buildPhases = (SOURCES);', 'buildPhases = (SOURCES); buildRules = (RULE);'), legacyInfoPlist],
  ])('keeps ambiguous multi-project ownership manual with %s', async (_reason, secondProject, plist) => {
    write(projectPath, legacyProject);
    write('ios/Second.xcodeproj/project.pbxproj', secondProject);
    write(plistPath, plist);
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow('Could not prove SceneDelegate is dormant');
  });

  it('allows an explicit aggregate build target alongside a legacy application', async () => {
    const projectWithAggregate = legacyProject.replace('targets = (APP)', 'targets = (APP, AGGREGATE)').replace(
      '    CONFIGS =',
      '    AGGREGATE = {isa = PBXAggregateTarget; buildPhases = (SCRIPT);};\n' +
        '    SCRIPT = {isa = PBXShellScriptBuildPhase;};\n    CONFIGS =',
    );
    write(projectPath, projectWithAggregate);
    write('ios/Second.xcodeproj/project.pbxproj', legacyProject);
    write(plistPath, legacyInfoPlist);
    await expect(findBareIosSceneEntrypoint(projectRoot)).resolves.toBeNull();
  });

  it('keeps AppDelegate ownership for a single target with no registered scene', async () => {
    write(projectPath, legacyProject);
    write(plistPath, legacyInfoPlist);
    await expect(findBareIosSceneEntrypoint(projectRoot)).resolves.toBeNull();
  });

  it.each([
    ['a different project directory', xcodeProject.replace('mainGroup = ROOT;', 'mainGroup = ROOT; projectDirPath = Other;'), 'must resolve iOS source paths'],
    ['computed scene registration', xcodeProject.replace('INFOPLIST_FILE = Demo/Info.plist;', 'INFOPLIST_FILE = Demo/Info.plist; INFOPLIST_PREPROCESS = YES;'), 'computed iOS scene manifest'],
    ['an unresolved plist path', xcodeProject.replace(/Demo\/Info\.plist/g, '"$(SRCROOT)/Demo/Info.plist"'), 'no literal Info.plist path'],
    ['a repeated source group', xcodeProject.replace('children = (DEMO)', 'children = (DEMO, DEMO)'), 'references a source group more than once'],
    ['an unresolved scene build file', xcodeProject.replace('files = (APP_BUILD, SCENE_BUILD)', 'files = (APP_BUILD, UNKNOWN)'), 'must compile exactly one SceneDelegate'],
  ])('rejects active scene metadata with %s', async (_reason, project, message) => {
    write(projectPath, project);
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow(message);
  });

  it.each([
    ['a non-XML plist', 'non-XML property list', 'Info.plist must be XML'],
    ['a top-level array', '<?xml version="1.0"?><plist version="1.0"><array><string>Demo</string></array></plist>', 'Info.plist must contain a dictionary'],
  ])('rejects unsupported scene registration metadata in %s', async (_reason, plist, message) => {
    write(plistPath, plist);
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow(message);
  });

  it('requires Xcode metadata before selecting an app with a scene source', async () => {
    fs.unlinkSync(path.join(projectRoot, projectPath));
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow('iOS target metadata is missing');
    fs.rmdirSync(path.dirname(path.join(projectRoot, projectPath)));
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow('An Xcode project is required');
  });

  it('resolves a project-relative scene and skips source references outside the project', async () => {
    const projectWithSourceRoot = xcodeProject.replace(
      'SCENE_FILE = {isa = PBXFileReference; sourceTree = "<group>"; path = SceneDelegate.swift;};',
      'SCENE_FILE = {isa = PBXFileReference; sourceTree = SOURCE_ROOT; path = Demo/SceneDelegate.swift;};\n' +
        '    EXTERNAL = {isa = PBXGroup; sourceTree = SDKROOT; children = ();};',
    ).replace('children = (DEMO)', 'children = (DEMO, EXTERNAL)');
    write(projectPath, projectWithSourceRoot);
    await expect(findBareIosSceneEntrypoint(projectRoot)).resolves.toBe(scenePath);
  });

  it('reports an unintegrated scene as a doctor error', async () => {
    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare', platform: 'ios' });
    expect(result.checks.find(check => check.name === 'ios OTA startup ownership')).toMatchObject({
      status: 'error',
      message: 'The iOS scene delegate does not hand cold-start bundle resolution to Bundle Drop.',
    });
  });

  it('does not use a registered scene when the application principal is unresolved', async () => {
    write('ios/Demo/AppDelegate.swift', appDelegate.replace('@main\n', ''));
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow('Swift @main/UIApplicationMain principal is missing');

    const result = await inspectProject({ cwd: projectRoot, projectType: 'bare', platform: 'ios' });
    expect(result.checks.find(check => check.name === 'ios OTA startup ownership')).toMatchObject({
      status: 'error',
      message: expect.stringContaining('Native application entrypoint authority is ambiguous'),
    });
  });

  it('rejects a differing plist in another app build configuration', async () => {
    write(projectPath, xcodeProject.replace(
      'DEBUG = {isa = XCBuildConfiguration; buildSettings = {INFOPLIST_FILE = Demo/Info.plist;',
      'DEBUG = {isa = XCBuildConfiguration; buildSettings = {INFOPLIST_FILE = Demo/Debug.plist;',
    ));
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow('same Info.plist');
  });

  it('rejects drift in the registered scene or the retained React Native factory', async () => {
    expect(await findBareIosSceneEntrypoint(projectRoot)).toBe(scenePath);
    write(plistPath, infoPlist.replace('.SceneDelegate', '.OtherDelegate'));
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow('uniquely register SceneDelegate');
    write(plistPath, infoPlist);
    write(scenePath, sceneDelegate.replace('RCTReactNativeFactory(delegate: self)', 'RCTReactNativeFactory(delegate: other)'));
    await expect(findBareIosSceneEntrypoint(projectRoot)).rejects.toThrow('does not own');
  });
});
