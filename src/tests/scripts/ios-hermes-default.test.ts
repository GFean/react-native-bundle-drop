import fs from 'fs';
import os from 'os';
import path from 'path';

import { detectImplicitIosHermes } from '../../scripts/iosHermesDefault';
import { shouldCompileHermesBytecode } from '../../scripts/bundle';

const standardPodfile = `
require Pod::Executable.execute_command('node', ['-p',
  'require.resolve(
    "react-native/scripts/react_native_pods.rb",
    {paths: [process.argv[1]]},
  )', __dir__]).strip
platform :ios, min_ios_version_supported
prepare_react_native_project!
target 'Demo' do
  config = use_native_modules!
  use_react_native!(
    :path => config[:reactNativePath],
    :app_path => "#{Pod::Config.instance.installation_root}/.."
  )
  post_install do |installer|
    react_native_post_install(installer, config[:reactNativePath], :mac_catalyst_enabled => false)
  end
end
`;

// Unmodified React Native 0.81.5 helpers, including their upstream license notices.
const podsHelper = fs.readFileSync(path.join(__dirname, '../fixtures/ios-hermes-default/react_native_pods.rb'), 'utf8');
const engineHelper = fs.readFileSync(path.join(__dirname, '../fixtures/ios-hermes-default/jsengine.rb'), 'utf8');
const stockXcodeProject = fs.readFileSync(path.join(__dirname, '../fixtures/ios-hermes-default/project.pbxproj'), 'utf8');

describe('implicit iOS Hermes default', () => {
  let root: string;
  const environmentKeys = ['USE_HERMES', 'USE_THIRD_PARTY_JSC'];
  let savedEnvironment: Array<[string, string | undefined]>;

  const write = (relativePath: string, contents: string) => {
    const filename = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  };
  const installReactNative = (version = '0.81.5') => {
    write('package.json', JSON.stringify({ dependencies: { 'react-native': version } }));
    write('node_modules/react-native/package.json', JSON.stringify({ name: 'react-native', version }));
    write('node_modules/react-native/scripts/react_native_pods.rb', podsHelper);
    write('node_modules/react-native/scripts/cocoapods/jsengine.rb', engineHelper);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-ios-hermes-'));
    savedEnvironment = environmentKeys.map(key => [key, process.env[key]]);
    for (const key of environmentKeys) delete process.env[key];
    installReactNative();
    write('ios/Podfile', standardPodfile);
  });

  afterEach(() => {
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['0.81.0', '0.81.5', '0.81.99'])('recognizes the verified default on stable %s', version => {
    installReactNative(version);
    expect(detectImplicitIosHermes(root)).toBe(true);
    expect(shouldCompileHermesBytecode({}, 'ios', root)).toBe(true);
  });

  it.each(['0.80.9', '0.82.0', '0.81.0-rc.0', '0.81.5-custom', '0.81.5+custom', 'invalid'])('does not extrapolate to %s', version => {
    installReactNative(version);
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it('recognizes the complete stock Xcode template with an unused JavaScriptCore navigator reference', () => {
    write('ios/Demo.xcodeproj/project.pbxproj', stockXcodeProject);
    expect(detectImplicitIosHermes(root)).toBe(true);
  });

  it('declines JavaScriptCore when the template reference is actually linked', () => {
    write('ios/Demo.xcodeproj/project.pbxproj', stockXcodeProject.replace('/* Begin PBXBuildFile section */',
      '/* Begin PBXBuildFile section */\nAAAAAAAAAAAAAAAAAAAAAAAA /* JavaScriptCore.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ED297162215061F000B7C4FE /* JavaScriptCore.framework */; };'));
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it('declines nonstandard JavaScriptCore references instead of discarding them', () => {
    write('ios/Demo.xcodeproj/project.pbxproj', stockXcodeProject.replace('sourceTree = SDKROOT;', 'sourceTree = "<group>";'));
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it('recognizes the same upstream helpers with Windows line endings', () => {
    write('node_modules/react-native/scripts/react_native_pods.rb', podsHelper.replace(/\r?\n/g, '\r\n'));
    write('node_modules/react-native/scripts/cocoapods/jsengine.rb', engineHelper.replace(/\r?\n/g, '\r\n'));
    expect(detectImplicitIosHermes(root)).toBe(true);
  });

  it.each(environmentKeys.flatMap(key => ['0', '1', 'false', ''].map(value => [key, value])))('declines an environment override %s=%s', (key, value) => {
    process.env[key] = value;
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it.each([
    ['ios/.xcode.env', 'export USE_HERMES=0'],
    ['ios/.xcode.env.local', 'export USE_THIRD_PARTY_JSC=1'],
    ['ios/Build.xcconfig', 'USE_HERMES = $(CUSTOM_ENGINE)'],
    ['ios/Demo.xcodeproj/project.pbxproj', 'USE_THIRD_PARTY_JSC = YES;'],
    ['react-native.config.js', "module.exports = { reactNativePath: '../custom-native' };"],
  ])('declines unresolved project configuration in %s', (filename, contents) => {
    write(filename, contents);
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it('accepts the stock CocoaPods build configuration references before pods are installed', () => {
    write('ios/Demo.xcodeproj/project.pbxproj', `
      123456 /* Debug */ = {
        isa = XCBuildConfiguration;
        baseConfigurationReference = ABCDEF /* Pods-Demo.debug.xcconfig */;
      };
      654321 /* Release */ = {
        isa = XCBuildConfiguration;
        baseConfigurationReference = FEDCBA /* Pods-Demo.release.xcconfig */;
      };
    `);
    expect(detectImplicitIosHermes(root)).toBe(true);
  });

  it.each([
    'baseConfigurationReference = ABCDEF /* Custom.release.xcconfig */;',
    'baseConfigurationReference = ABCDEF;',
  ])('declines custom or unresolved base configuration: %s', reference => {
    write('ios/Demo.xcodeproj/project.pbxproj', reference);
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it('declines an iOS-local React Native that shadows the consumer installation', () => {
    write('ios/node_modules/react-native/package.json', JSON.stringify({ name: 'react-native', version: '0.81.5' }));
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it.each([
    '{}',
    '{invalid json',
  ])('declines an app without a readable React Native declaration: %s', contents => {
    write('package.json', contents);
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it.each([
    { name: 'custom-react-native', version: '0.81.5' },
    { name: 'react-native', version: 81 },
  ])('declines an unexpected resolved package identity %j', manifest => {
    write('node_modules/react-native/package.json', JSON.stringify(manifest));
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])('declines community JSC in %s', section => {
    write('package.json', JSON.stringify({ dependencies: { 'react-native': '0.81.5' }, [section]: { 'react-native': '0.81.5', '@react-native-community/javascriptcore': '1.0.0' } }));
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it.each([
    standardPodfile.replace(':path => config[:reactNativePath]', ':path => "../custom-native"'),
    standardPodfile.replace('config = use_native_modules!', 'config = custom_native_modules!'),
    standardPodfile.replace('config = use_native_modules!', 'config = use_native_modules!\n config[:reactNativePath] = "../custom-native"'),
    standardPodfile.replace('react-native/scripts/react_native_pods.rb', 'custom-native/scripts/react_native_pods.rb'),
    standardPodfile + '\nuse_react_native!(:path => config[:reactNativePath])',
    standardPodfile.replace(':app_path =>', ':hermes_enabled => ENV["ENGINE"],\n    :app_path =>'),
    standardPodfile + '\nENV["USE_THIRD_PARTY_JSC"] = "1"',
    standardPodfile + '\nconfig = custom_config',
    standardPodfile + '\nconfig.merge!({reactNativePath: "../custom-native"})',
    standardPodfile + '\nrequire_relative "./custom_setup"',
    standardPodfile + '\nrequire "custom_setup"',
    standardPodfile + '\nuse_react_native! :path => config[:reactNativePath]',
  ])('declines customized Podfile engine resolution', podfile => {
    write('ios/Podfile', podfile);
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it.each([
    ['scripts/react_native_pods.rb', podsHelper.replace('hermes_enabled: true', 'hermes_enabled: false')],
    ['scripts/react_native_pods.rb', podsHelper.replace('hermes_enabled= true', 'hermes_enabled= false')],
    ['scripts/cocoapods/jsengine.rb', engineHelper.replace('return !use_third_party_jsc()', 'return false')],
    ['scripts/cocoapods/jsengine.rb', engineHelper.replace("== '1'", "!= '0'")],
  ])('declines modified helper semantics in %s', (filename, contents) => {
    write(`node_modules/react-native/${filename}`, contents);
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it.each(['ios/Podfile', 'package.json', 'node_modules/react-native/package.json', 'node_modules/react-native/scripts/react_native_pods.rb', 'node_modules/react-native/scripts/cocoapods/jsengine.rb'])('declines a missing %s', filename => {
    fs.rmSync(path.join(root, filename));
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it('does not fall back to the SDK installation when the app has no React Native', () => {
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    expect(detectImplicitIosHermes(root)).toBeUndefined();
  });

  it('rejects a dependency resolved outside the captured snapshot', () => {
    const snapshot = path.join(root, 'snapshot');
    fs.mkdirSync(path.join(snapshot, 'ios'), { recursive: true });
    fs.writeFileSync(path.join(snapshot, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.5' } }));
    fs.writeFileSync(path.join(snapshot, 'ios/Podfile'), standardPodfile);
    expect(detectImplicitIosHermes(snapshot, snapshot)).toBeUndefined();
  });

  it('resolves workspace dependencies inside the snapshot', () => {
    const app = path.join(root, 'apps/demo');
    fs.mkdirSync(path.join(app, 'ios'), { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.5' } }));
    fs.writeFileSync(path.join(app, 'ios/Podfile'), standardPodfile);
    expect(detectImplicitIosHermes(app, root)).toBe(true);
  });

  it('checks the real dependency path when node_modules uses a symlink', () => {
    const snapshot = path.join(root, 'snapshot');
    fs.mkdirSync(path.join(snapshot, 'ios'), { recursive: true });
    fs.mkdirSync(path.join(snapshot, 'node_modules'));
    fs.writeFileSync(path.join(snapshot, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.5' } }));
    fs.writeFileSync(path.join(snapshot, 'ios/Podfile'), standardPodfile);
    fs.symlinkSync(path.join(root, 'node_modules/react-native'), path.join(snapshot, 'node_modules/react-native'), 'junction');
    expect(detectImplicitIosHermes(snapshot, snapshot)).toBeUndefined();
  });

  it('rechecks installed helpers instead of caching a previous detection', () => {
    expect(detectImplicitIosHermes(root, root)).toBe(true);
    write('node_modules/react-native/package.json', JSON.stringify({ name: 'react-native', version: '0.80.0' }));
    expect(detectImplicitIosHermes(root, root)).toBeUndefined();
  });

  it('preserves explicit Bundle Drop options ahead of implicit and native defaults', () => {
    expect(shouldCompileHermesBytecode({ hermesBytecode: false }, 'ios', root)).toBe(false);
    expect(shouldCompileHermesBytecode({ hermes: { ios: false } }, 'ios', root)).toBe(false);
    write('ios/Podfile', standardPodfile.replace(':app_path =>', ':hermes_enabled => false,\n    :app_path =>'));
    expect(shouldCompileHermesBytecode({ hermesBytecode: { ios: true } }, 'ios', root)).toBe(true);
  });

  it.each([true, false])('preserves native Hermes %s declarations', enabled => {
    write('ios/Podfile', standardPodfile.replace(':app_path =>', `:hermes_enabled => ${enabled},\n    :app_path =>`));
    expect(shouldCompileHermesBytecode({}, 'ios', root)).toBe(enabled);
  });

  it('does not use the iOS fallback for Android', () => {
    expect(shouldCompileHermesBytecode({}, 'android', root)).toBe(false);
    write('android/gradle.properties', 'hermesEnabled=true');
    expect(shouldCompileHermesBytecode({}, 'android', root)).toBe(true);
  });
});
