import { projectNativeSetupMetadata } from '../../../../CLI/scripts/aipowered/native-setup-metadata';

describe('native setup metadata projection', () => {
  it('keeps only the namespace from Groovy and Kotlin Gradle signing configs', async () => {
    const groovy = [
      'android {',
      '  // namespace "com.example.comment"',
      '  namespace "com.example.app"',
      '  signingConfigs { release {',
      "    storePassword 'signing-store-fixture'",
      "    keyPassword 'signing-key-fixture'",
      '  } }',
      '}',
    ].join('\n');
    const kotlin = 'android { namespace = "com.example.kotlin"; keyPassword = "signing-fixture" }';

    await expect(projectNativeSetupMetadata('android/app/build.gradle', groovy))
      .resolves.toEqual({ namespace: 'com.example.app' });
    await expect(projectNativeSetupMetadata('android/feature/build.gradle.kts', kotlin))
      .resolves.toEqual({ namespace: 'com.example.kotlin' });
    await expect(projectNativeSetupMetadata('android/app/build.gradle.kts', 'namespace("com.example.call")'))
      .resolves.toEqual({ namespace: 'com.example.call' });
    await expect(projectNativeSetupMetadata('android/app/build.gradle', 'namespace "com.example" + suffix'))
      .resolves.toEqual({ namespace: null });
    await expect(projectNativeSetupMetadata('android/app/build.gradle', 'namespace("com.example"'))
      .resolves.toEqual({ namespace: null });
  });

  it('keeps only the application class and legacy package from an Android manifest', async () => {
    const manifest = [
      '<?xml version="1.0"?>',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">',
      '  <!-- <application android:name=".Ignored"> -->',
      "  <application android:label='Sample android:name=\".Ignored\"' android:name='.Startup'>",
      '    <meta-data android:name="ClientSecret" android:value="metadata-secret-fixture"/>',
      '  </application>',
      '</manifest>',
    ].join('\n');

    await expect(projectNativeSetupMetadata('android/app/src/main/AndroidManifest.xml', manifest))
      .resolves.toEqual({ applicationClass: '.Startup', packageName: 'com.example.app' });
    await expect(projectNativeSetupMetadata(
      'android/app/src/demo/AndroidManifest.xml',
      '<manifest><application android:name="\${applicationName}"/></manifest>',
    )).resolves.toEqual({ applicationClass: null, packageName: null });
    await expect(projectNativeSetupMetadata('android/app/src/main/AndroidManifest.xml', 'not XML'))
      .resolves.toBeNull();
    await expect(projectNativeSetupMetadata(
      'android/app/src/demo/AndroidManifest.xml',
      '<manifest><application android:name=".First"/><application android:name=".Second"/></manifest>',
    )).resolves.toEqual({ applicationClass: null, packageName: null });
  });

  it('keeps only valid application scene delegate names from scoped XML plists', async () => {
    const plist = [
      '<plist version="1.0"><dict>',
      '  <key>ClientSecret</key><string>plist-secret-fixture</string>',
      '  <key>UIApplicationSceneManifest</key><dict>',
      '    <key>UISceneConfigurations</key><dict>',
      '      <key>UIWindowSceneSessionRoleApplication</key><array>',
      '        <dict><key>UISceneDelegateClassName</key><string>$(PRODUCT_MODULE_NAME).SceneDelegate</string></dict>',
      '        <dict><key>UISceneDelegateClassName</key><string>App.SecondaryDelegate</string></dict>',
      '        <dict><key>UISceneDelegateClassName</key><string>${PRODUCT_MODULE_NAME}.SceneDelegate</string></dict>',
      '        <dict><key>UISceneDelegateClassName</key><string>$(SECRET).SceneDelegate</string></dict>',
      '        <dict><key>UISceneDelegateClassName</key><integer>4</integer></dict>',
      '      </array>',
      '      <key>UIWindowSceneSessionRoleExternalDisplay</key><array>',
      '        <dict><key>UISceneDelegateClassName</key><string>ExternalDelegate</string></dict>',
      '      </array>',
      '    </dict>',
      '  </dict>',
      '</dict></plist>',
    ].join('\n');

    await expect(projectNativeSetupMetadata('ios/App/Info-Release.plist', plist))
      .resolves.toEqual({ sceneDelegateClasses: ['SceneDelegate', 'App.SecondaryDelegate'] });
    await expect(projectNativeSetupMetadata('ios/App/Info.plist', '<plist><dict/></plist>'))
      .resolves.toEqual({ sceneDelegateClasses: [] });
    await expect(projectNativeSetupMetadata('ios/App/Info.plist', '<plist><string>text</string></plist>'))
      .resolves.toBeNull();
    await expect(projectNativeSetupMetadata('ios/App/Info.plist', 'bplist fixture'))
      .resolves.toBeNull();
  });

  it('extracts app target associations from a large Xcode project without build settings', async () => {
    const project = [
      '// !$*UTF8*$!',
      '{ rootObject = PROJECT; objects = {',
      '  PROJECT = {isa = PBXProject; mainGroup = ROOT; targets = (APP, FRAMEWORK);};',
      '  APP = {isa = PBXNativeTarget; productType = com.apple.product-type.application;',
      '    buildConfigurationList = CONFIGS; buildPhases = (SOURCES, SCRIPT);};',
      '  FRAMEWORK = {isa = PBXNativeTarget; productType = com.apple.product-type.framework;};',
      '  CONFIGS = {isa = XCConfigurationList; buildConfigurations = (DEBUG, RELEASE);};',
      '  DEBUG = {isa = XCBuildConfiguration; buildSettings = {INFOPLIST_FILE = App/Debug.plist;};};',
      '  RELEASE = {isa = XCBuildConfiguration; buildSettings = {',
      '    INFOPLIST_FILE = "$(SRCROOT)/App/Release.plist"; ACCESS_TOKEN = release-secret-fixture;};};',
      '  SOURCES = {isa = PBXSourcesBuildPhase; files = (BUILD_START, BUILD_DELEGATE, BUILD_NOT_SOURCE);};',
      '  BUILD_START = {isa = PBXBuildFile; fileRef = START;};',
      '  BUILD_DELEGATE = {isa = PBXBuildFile; fileRef = DELEGATE;};',
      '  BUILD_NOT_SOURCE = {isa = PBXBuildFile; fileRef = NOT_SOURCE;};',
      '  ROOT = {isa = PBXGroup; sourceTree = "<group>"; children = (GROUP);};',
      '  GROUP = {isa = PBXGroup; sourceTree = "<group>"; path = App;',
      '    children = (START, DELEGATE, NOT_SOURCE, OTHER);};',
      '  START = {isa = PBXFileReference; sourceTree = "<group>"; path = Startup.swift;};',
      '  DELEGATE = {isa = PBXFileReference; sourceTree = "<group>"; path = SceneDelegate.swift;};',
      '  OTHER = {isa = PBXFileReference; sourceTree = "<group>"; path = Unused.swift;};',
      '  NOT_SOURCE = {isa = PBXFileReference; sourceTree = "<group>"; path = signing-secret.txt;};',
      '  SCRIPT = {isa = PBXShellScriptBuildPhase; shellScript = "'.concat('chunk '.repeat(15_000), '";};'),
      '}; }',
    ].join('\n');
    expect(Buffer.byteLength(project)).toBeGreaterThan(80 * 1024);

    await expect(projectNativeSetupMetadata('ios/Workspace/App.xcodeproj/project.pbxproj', project))
      .resolves.toEqual({
        targets: [{
          sourcePaths: ['ios/Workspace/App/SceneDelegate.swift', 'ios/Workspace/App/Startup.swift'],
          infoPlistPaths: ['ios/Workspace/App/Debug.plist', 'ios/Workspace/App/Release.plist'],
        }],
      });
    await expect(projectNativeSetupMetadata('ios/App.xcodeproj/project.pbxproj', '{ malformed'))
      .resolves.toBeNull();
  });

  it('omits unsupported paths and bounds local parsing', async () => {
    for (const relativePath of ['ios/Podfile', 'ios/Pod.h', 'ios/../Info.plist', 'android/build.gradle']) {
      await expect(projectNativeSetupMetadata(relativePath, 'fixture')).resolves.toBeNull();
    }
    await expect(projectNativeSetupMetadata('ios/App/Info.plist', 'x'.repeat(2 * 1024 * 1024 + 1)))
      .resolves.toBeNull();
  });
});
