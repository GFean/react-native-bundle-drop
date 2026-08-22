import fs from 'fs';
import path from 'path';

const packageRoot = path.resolve(__dirname, '../../..');

const readPackageFile = (relativePath: string) =>
  fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');

describe('Expo native target isolation', () => {
  it('uses the Expo integration native revision for both native targets', () => {
    const packageManifest = JSON.parse(readPackageFile('package.json'));
    const barePodspec = readPackageFile('BundleDrop.podspec');
    const expoPodspec = readPackageFile('BundleDropExpo.podspec');
    const expoAndroidBuild = readPackageFile('expo/android/build.gradle');

    expect(packageManifest.nativeVersion).toBe('0.5.0');
    expect(barePodspec).toContain('native_version = package["nativeVersion"] || package["version"]');
    expect(expoPodspec).toContain('native_version = package["nativeVersion"] || package["version"]');
    expect(expoAndroidBuild).toContain(
      'version = packageJson.nativeVersion ?: packageJson.version',
    );
  });

  it('keeps the bare React Native targets independent of Expo', () => {
    const barePodspec = readPackageFile('BundleDrop.podspec');
    const bareAndroidBuild = readPackageFile('android/build.gradle');
    const reactNativeConfig = readPackageFile('react-native.config.js');

    expect(barePodspec).not.toContain('ExpoModulesCore');
    expect(barePodspec).not.toContain('BundleDropExpo');
    expect(bareAndroidBuild).not.toContain('expo-module-gradle-plugin');
    expect(bareAndroidBuild).not.toContain('expo.modules');
    expect(reactNativeConfig).not.toContain('podspecPath');
    expect(reactNativeConfig).toContain("sourceDir: 'android'");
  });

  it('keeps the iOS adapter in an isolated pod that depends on the unchanged core pod', () => {
    const moduleConfig = JSON.parse(readPackageFile('expo-module.config.json'));
    const expoPodspec = readPackageFile('BundleDropExpo.podspec');
    const adapter = readPackageFile(
      'expo/ios/Sources/BundleDropExpoReactDelegateHandler.swift',
    );
    const identityModule = readPackageFile(
      'expo/ios/Sources/BundleDropExpoIdentity.m',
    );

    expect(moduleConfig.apple.podspecPath).toBe('BundleDropExpo.podspec');
    expect(expoPodspec).toContain('"expo/ios/Sources/**/*.{h,m,mm,swift}"');
    expect(expoPodspec).toContain('s.dependency "ExpoModulesCore"');
    expect(expoPodspec).toContain('s.dependency "BundleDrop"');
    expect(expoPodspec).not.toContain('"ios/**/*.{h,m,mm,swift}"');
    expect(adapter).toContain('import BundleDrop');
    expect(adapter).toContain('BundleDropLocatorCore.bundleURL()');
    expect(adapter).toContain('EXAppDefines.APP_DEBUG');
    expect(adapter).not.toContain('NSClassFromString("EXDevLauncherController")');
    expect(identityModule).toContain('RCT_EXPORT_MODULE(BundleDropExpoIdentity)');
    expect(identityModule).toContain('@"appVersion": appVersion');
    expect(identityModule).toContain('@"appBuildVersion": appBuildVersion');
    expect(identityModule).toContain(
      '@"otaStartupEnabled": @(pluginEnabled && !EXAppDefines.APP_DEBUG)',
    );
    expect(identityModule).toContain('info[@"BundleDropExpoEnabled"]');
  });

  it('links the isolated Android adapter to the autolinked core library', () => {
    const moduleConfig = JSON.parse(readPackageFile('expo-module.config.json'));
    const expoBuild = readPackageFile('expo/android/build.gradle');
    const expoPackage = readPackageFile(
      'expo/android/src/main/java/com/bundledrop/expo/BundleDropExpoPackage.kt',
    );
    const identityModule = readPackageFile(
      'expo/android/src/main/java/com/bundledrop/expo/BundleDropExpoIdentityModule.kt',
    );
    const configuration = readPackageFile(
      'expo/android/src/main/java/com/bundledrop/expo/BundleDropExpoConfiguration.kt',
    );

    expect(expoBuild).toContain(
      'candidate.projectDir.canonicalFile == bundleDropCoreDirectory',
    );
    expect(expoBuild).toContain('bundleDropCoreProjects.size() != 1');
    expect(expoBuild).toContain('implementation project(path: bundleDropCoreProject.path)');
    expect(expoBuild).toContain('implementation "com.facebook.react:react-android"');
    expect(moduleConfig.android.gradlePlugins).toEqual([
      {
        id: 'bundle-drop-expo-gradle-plugin',
        group: 'com.bundledrop',
        sourceDir: 'expo/bundle-drop-expo-gradle-plugin',
      },
    ]);
    expect(expoBuild).toContain('versionName version.toString()');
    expect(expoBuild).not.toContain('java.srcDirs');
    expect(expoBuild).not.toContain('externalNativeBuild');
    expect(expoBuild).not.toContain('src/main/cpp/CMakeLists.txt');
    expect(expoBuild).toContain('output.versionNameOverride ?: variant.versionName');
    expect(expoBuild).toContain('output.versionCodeOverride ?: output.versionCode ?: variant.versionCode');
    expect(expoBuild).not.toContain('defaultConfig.versionCode');
    expect(expoPackage).toContain('class BundleDropExpoPackage : Package, ReactPackage');
    expect(expoPackage).toContain(
      'return listOf(BundleDropExpoIdentityModule(reactContext))',
    );
    expect(expoPackage).toContain('return emptyList()');
    expect(expoPackage).toContain('BundleDropExpoReactNativeHostHandler(context)');
    expect(expoPackage).not.toContain('import com.bundledrop.BundleDropPackage');
    expect(expoPackage).not.toContain('BundleDropPackage()');
    expect(expoPackage).not.toContain('corePackage');
    expect(expoPackage).not.toContain('BundleDropModule');
    expect(identityModule).toContain('override fun getName(): String = "BundleDropExpoIdentity"');
    expect(identityModule).toContain(
      '"otaStartupEnabled" to BundleDropExpoConfiguration.isOtaStartupEnabled()',
    );
    expect(configuration).toContain('!useDeveloperSupport && isEnabled(context)');
    expect(identityModule).toContain('"appVersion" to (packageInfo.versionName ?: "")');
    expect(identityModule).toContain('"appBuildVersion" to buildVersion.toString()');
  });

  it('runs Android identity writers through the Gradle 8 and 9 execution service', () => {
    const expoBuild = readPackageFile('expo/android/build.gradle');
    const identityTask = readPackageFile(
      'expo/bundle-drop-expo-gradle-plugin/src/main/groovy/com/bundledrop/gradle/GenerateBundleDropBuildIdentityTask.groovy',
    );

    expect(expoBuild).toContain('import org.gradle.process.ExecOperations');
    expect(expoBuild).toContain('abstract class BundleDropCommandExecutor');
    expect(expoBuild).toContain('abstract ExecOperations getExecOperations()');
    expect(expoBuild).toContain(
      'applicationProject.objects.newInstance(\n        BundleDropCommandExecutor',
    );
    expect(expoBuild.match(/bundleDropCommandExecutor\.execute\(/g)).toHaveLength(1);
    expect(expoBuild).toContain('spec.workingDir workingDirectory');
    expect(expoBuild).toContain('}.assertNormalExitValue()');
    expect(identityTask).toContain('abstract ExecOperations getExecOperations()');
    expect(identityTask).toContain('execOperations.exec { spec ->');
    expect(identityTask).toContain('}.assertNormalExitValue()');
    expect(expoBuild).not.toContain('applicationProject.exec');
    expect(expoBuild).not.toMatch(/\bproject\.exec\s*\{/);
    expect(identityTask).not.toMatch(/\bproject\.exec\s*\{/);
  });

  it('registers generated identity assets through the Android Components API', () => {
    const expoBuild = readPackageFile('expo/android/build.gradle');
    const pluginBuild = readPackageFile(
      'expo/bundle-drop-expo-gradle-plugin/build.gradle',
    );
    const expoPlugin = readPackageFile(
      'expo/bundle-drop-expo-gradle-plugin/src/main/groovy/com/bundledrop/gradle/BundleDropExpoPlugin.groovy',
    );
    const identityTask = readPackageFile(
      'expo/bundle-drop-expo-gradle-plugin/src/main/groovy/com/bundledrop/gradle/GenerateBundleDropBuildIdentityTask.groovy',
    );

    expect(pluginBuild).toContain("compileOnly 'com.android.tools.build:gradle:8.5.0'");
    expect(expoPlugin).toContain('androidComponents.onVariants(');
    expect(expoPlugin).toContain(
      "androidComponents.selector().withBuildType('release')",
    );
    expect(expoPlugin).toContain(
      'variant.sources.assets.addGeneratedSourceDirectory(identityTask)',
    );
    expect(expoPlugin).toContain('task.appVersion.set(variantOutput.versionName)');
    expect(expoPlugin).toContain('task.nativeBuildVersion.set(variantOutput.versionCode.map');
    expect(identityTask).toContain('abstract DirectoryProperty getOutputDirectory()');
    expect(identityTask).toContain('@OutputDirectory');
    expect(expoBuild).not.toContain('assets.srcDir(candidateTask)');
    expect(expoBuild).not.toContain('assets.srcDir(generatedAssets)');
    expect(expoBuild).not.toContain('.builtBy(candidateTask)');
    expect(expoBuild).not.toContain('generatedAssetsConsumer');
    expect(expoBuild).not.toContain('generateBundleDrop${capitalizedVariant}BuildIdentity');
    expect(expoBuild).toContain('task.name ==~ /(?i)(package|bundle).*release/');
    expect(expoBuild).toContain('task.doLast {');
    expect(expoBuild).not.toContain('task.finalizedBy');
  });
});
