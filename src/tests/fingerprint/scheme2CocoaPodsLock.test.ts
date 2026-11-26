import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectNativeFingerprintV2 } from '../../fingerprintV2/collect';
import { portableCocoaPodsLock } from '../../fingerprintV2/cocoapodsLock';

const cleanChecksum = 'a'.repeat(40);
const warmChecksum = 'b'.repeat(40);
const rnRecipe = '../node_modules/react-native/React-Core-prebuilt.podspec';
const hermesRecipe = '../node_modules/react-native/sdks/hermes-engine/hermes-engine.podspec';
const rnDependenciesRecipe = '../node_modules/react-native/third-party-podspecs/ReactNativeDependencies.podspec';
const checkoutLocalSource = 'return {:http => URI::File.build(path: destinationDebug).to_s }';
const resolveHermes = String.raw`command = "require.resolve(\"hermes-compiler\", {paths: [\"#{react_native_path}\"]})"`;

function lock(checksum = cleanChecksum, source = rnRecipe, name = 'NativeCore'): string {
  return [
    'PODS:',
    `  - ${name} (0.84.1)`,
    '  - RegistryModule (3.0.0)',
    '',
    'DEPENDENCIES:',
    `  - '${name} (from \`${source}\`)'`,
    '  - RegistryModule',
    '',
    'SPEC REPOS:',
    '  trunk:',
    '    - RegistryModule',
    '',
    'EXTERNAL SOURCES:',
    `  ${name}:`,
    `    :podspec: "${source}"`,
    '',
    'SPEC CHECKSUMS:',
    `  ${name}: ${checksum}`,
    `  RegistryModule: ${'c'.repeat(40)}`,
    '',
    'PODFILE CHECKSUM: 1234',
    'COCOAPODS: 1.16.2',
    '',
  ].join('\n');
}

describe('Scheme 2 CocoaPods lockfile', () => {
  let fixture: string;
  const project = () => path.join(fixture, 'checkout with spaces');
  const iosRoot = () => path.join(project(), 'ios');
  const reactNative = () => path.join(project(), 'node_modules/react-native');

  function write(relative: string, contents: string): void {
    const file = path.join(project(), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  const normalize = (text: string) => portableCocoaPodsLock(Buffer.from(text), iosRoot(), reactNative()).toString();
  const collect = (root = project()) => collectNativeFingerprintV2(root, 'ios', {}, null);

  function installGeneratedSpec(name: string, spec: string): string {
    write(`ios/Pods/Local Podspecs/${name}.podspec.json`, spec);
    return createHash('sha1').update(spec).digest('hex');
  }

  function installGeneratedCoreSpec(source: string): string {
    const spec = JSON.stringify({ name: 'NativeCore', version: '0.84.1', source: { http: source } });
    return installGeneratedSpec('NativeCore', spec);
  }

  function installHermesRecipe(): void {
    write('node_modules/react-native/sdks/hermes-engine/hermes-engine.podspec',
      `${resolveHermes}\n'HERMES_CLI_PATH' => "#{hermes_compiler_path}/hermesc/osx-bin/hermesc"`);
    write('node_modules/react-native/sdks/hermes-engine/hermes-utils.rb', 'supported Hermes selector');
    write('node_modules/react-native/sdks/hermes-engine/version.properties', 'version=1');
    write('node_modules/react-native/sdks/hermes-engine/utils/replace_hermes_version.js', 'Hermes build script');
  }

  function installHermesCompiler(): string {
    const compiler = 'node_modules/react-native/node_modules/hermes-compiler';
    write(`${compiler}/package.json`, '{"name":"hermes-compiler","main":"main.js"}');
    write(`${compiler}/main.js`, '');
    return `${compiler}/hermesc/osx-bin/hermesc`;
  }

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-scheme2-pods-'));
    write('package.json', '{"name":"sample","dependencies":{"react-native":"0.84.1"}}');
    write('node_modules/react-native/package.json', '{"name":"react-native","version":"0.84.1"}');
    write('node_modules/react-native/cli.js', 'console.log(JSON.stringify({dependencies:{}}));');
    write('node_modules/react-native/React-Core-prebuilt.podspec', 'source = ReactNativeCoreUtils.resolve_podspec_source()');
    write('node_modules/react-native/scripts/react_native_pods.rb', 'stable integration script');
    write('node_modules/react-native/scripts/cocoapods/utils.rb', 'shared CocoaPods helpers');
    write('node_modules/react-native/scripts/cocoapods/rncore.rb', checkoutLocalSource);
    write('node_modules/react-native/scripts/replace-rncore-version.js', 'stable build script');
    write('ios/Podfile', 'platform :ios, "15.1"');
    write('ios/Podfile.lock', lock());
    write('.gitignore', 'ios/Pods/\n');
  });

  afterEach(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('matches a relocated build and an untouched clean checkout without reading generated CocoaPods output', async () => {
    const clean = path.join(fixture, 'independent checkout');
    fs.cpSync(project(), clean, { recursive: true });
    const cocoapodsRoot = fs.realpathSync(iosRoot());
    const generatedChecksum = installGeneratedCoreSpec(`file://${cocoapodsRoot}/Pods/ReactNativeCore-artifacts/reactnative-core-0.84.1-debug.tar.gz`);
    write('ios/Podfile.lock', lock(generatedChecksum));
    const warm = await collect();
    const independent = await collect(clean);
    expect(warm).toEqual(independent);
    expect(fs.readFileSync(path.join(clean, 'ios/Podfile.lock'), 'utf8')).toBe(lock());
    expect(fs.existsSync(path.join(clean, 'ios/Pods'))).toBe(false);
    expect(independent.sources.map(source => source.id)).toContain('ios/Podfile.lock');
  });

  it('retains real changes to the pod recipe, helper, native lock graph and unknown pod checksum', async () => {
    const baseline = await collect();
    write('node_modules/react-native/scripts/cocoapods/rncore.rb', `# select a different artifact\n${checkoutLocalSource}`);
    const helperChanged = await collect();
    expect(helperChanged.runtimeVersion).not.toBe(baseline.runtimeVersion);
    write('node_modules/react-native/React-Core-prebuilt.podspec', 'source = ReactNativeCoreUtils.resolve_podspec_source()\nname = "different"');
    expect((await collect()).runtimeVersion).not.toBe(helperChanged.runtimeVersion);

    const portable = normalize(lock());
    for (const edited of [
      lock().replace('NativeCore (0.84.1)', 'NativeCore (0.84.2)'),
      lock().replace('  RegistryModule: ' + 'c'.repeat(40), '  RegistryModule: ' + 'd'.repeat(40)),
      lock().replace('  trunk:', '  different-repository:'),
      lock().replace('PODFILE CHECKSUM: 1234', 'PODFILE CHECKSUM: 9999'),
      lock().replace('SPEC CHECKSUMS:', '    :tag: different-tag\n\nSPEC CHECKSUMS:'),
    ]) {
      expect(normalize(edited)).not.toBe(portable);
    }
  });

  it('retains the checksum for unrecognized, remote, ambiguous, or non-React Native podspecs', () => {
    write('node_modules/native-fork/React-Core-prebuilt.podspec', 'source = ReactNativeCoreUtils.resolve_podspec_source()');
    write('node_modules/react-native/Custom.podspec', 'source = ReactNativeCoreUtils.resolve_podspec_source()');
    write('node_modules/react-native/React-Core-prebuilt.podspec.json', '{"name":"NativeCore"}');
    write('Local/React-Core-prebuilt.podspec', 'source = ReactNativeCoreUtils.resolve_podspec_source()');
    for (const value of [
      lock(warmChecksum, '../node_modules/native-fork/React-Core-prebuilt.podspec'),
      lock(warmChecksum, '../node_modules/react-native/Custom.podspec'),
      lock(warmChecksum, '../node_modules/react-native/React-Core-prebuilt.podspec.json'),
      lock(warmChecksum, '../Local/React-Core-prebuilt.podspec'),
      lock(warmChecksum, 'https://example.com/React-Core-prebuilt.podspec'),
      lock(warmChecksum).replace(':podspec:', ':path:'),
      lock(warmChecksum).replace('SPEC CHECKSUMS:', '    :git: "https://example.com/rn.git"\n\nSPEC CHECKSUMS:'),
      lock(warmChecksum).replace('SPEC CHECKSUMS:', `  NativeCore:\n    :podspec: "${rnRecipe}"\n\nSPEC CHECKSUMS:`),
      lock(warmChecksum).replace('SPEC CHECKSUMS:', `SPEC CHECKSUMS:\n  NativeCore: ${cleanChecksum}`),
    ]) {
      expect(normalize(value)).toBe(value);
    }
  });

  it('binds the compiler that Hermes resolves from its installation', () => {
    installHermesRecipe();
    const compiler = installHermesCompiler();
    write(compiler, 'first selected compiler');
    const clean = lock(cleanChecksum, hermesRecipe);
    const warm = lock(warmChecksum, hermesRecipe);
    const initial = normalize(clean);
    expect(normalize(warm)).toBe(initial);
    write(compiler, 'second selected compiler');
    expect(normalize(clean)).not.toBe(initial);
  });

  it('preserves the raw checksum for configured custom native artifact selection', () => {
    jest.replaceProperty(process, 'env', { ...process.env, RCT_TESTONLY_RNCORE_TARBALL_PATH: '/other/core.tar.gz' });
    expect(normalize(lock())).toBe(lock());
    expect(normalize(lock(warmChecksum))).toBe(lock(warmChecksum));
  });

  it('retains checksums when a built CocoaPods spec used a nondefault artifact or disagrees with the lock', () => {
    const clean = normalize(lock());
    const generatedChecksum = installGeneratedCoreSpec('file:///custom/core-with-same-version.tar.gz');
    const custom = lock(generatedChecksum);
    expect(normalize(custom)).toBe(custom);
    expect(normalize(custom)).not.toBe(clean);
    expect(normalize(lock())).toBe(lock());
  });

  it('leaves already-portable React Native recipes raw with and without generated Pods', () => {
    write('node_modules/react-native/scripts/cocoapods/rncore.rb', `return {:http => stable_tarball_url(@@react_native_version, :debug) }`);
    write('node_modules/react-native/sdks/hermes-engine/hermes-engine.podspec',
      `${resolveHermes}\n'HERMES_CLI_PATH' => "$(PODS_ROOT)/#{relative_hermesc}"`);
    const evaluatedCore = lock(installGeneratedCoreSpec('https://repo.reactnative.dev/reactnative-core-0.88.1-debug.tar.gz'));
    const evaluatedHermes = lock(warmChecksum, hermesRecipe);
    expect(normalize(evaluatedCore)).toBe(evaluatedCore);
    expect(normalize(evaluatedHermes)).toBe(evaluatedHermes);
    fs.rmSync(path.join(iosRoot(), 'Pods'), { recursive: true });
    expect(normalize(evaluatedCore)).toBe(evaluatedCore);
    expect(normalize(evaluatedHermes)).toBe(evaluatedHermes);
  });

  it('keeps nightly and unrecognized React Native package versions raw with and without Pods', () => {
    const spec = JSON.stringify({ name: 'NativeCore', version: '0.84.1-nightly-20260101',
      source: { http: 'https://example.invalid/nightly.tar.gz' } });
    const warm = lock(installGeneratedSpec('NativeCore', spec));
    const manifest = 'node_modules/react-native/package.json';
    write(manifest, '{"name":"react-native","version":"0.84.1-nightly-20260101"}');
    expect(normalize(warm)).toBe(warm);
    fs.rmSync(path.join(iosRoot(), 'Pods'), { recursive: true });
    expect(normalize(warm)).toBe(warm);
    for (const invalid of ['unsupported manifest', '{"name":"react-native"}', 'null']) {
      write(manifest, invalid);
      expect(normalize(lock())).toBe(lock());
    }
    fs.rmSync(path.join(project(), manifest));
    expect(normalize(lock())).toBe(lock());
  });

  it('matches CocoaPods block syntax with optional tags, newline styles and supported scalars', () => {
    const tagged = lock().replace(`    :podspec: "${rnRecipe}"`, `    :podspec: "${rnRecipe}"\n    :tag: release-v2`);
    for (const value of [
      tagged.replace(`"${rnRecipe}"`, `'${rnRecipe}'`),
      lock().replace(`"${rnRecipe}"`, rnRecipe).replace(/\n/g, '\r\n'),
      lock().slice(0, lock().indexOf(`  NativeCore: ${cleanChecksum}`) + `  NativeCore: ${cleanChecksum}`.length),
    ]) {
      const portable = normalize(value);
      expect(portable).toContain('bundle-drop-podspec-sha256:');
      expect(normalize(value.replace(cleanChecksum, warmChecksum))).toBe(portable);
    }
  });

  it('retains unsupported, missing, or duplicate lock sections exactly', () => {
    for (const value of [
      lock().replace('EXTERNAL SOURCES:', 'UNKNOWN:'),
      lock().replace('SPEC CHECKSUMS:', 'UNKNOWN:'),
      lock().replace('SPEC CHECKSUMS:', 'SPEC CHECKSUMS:\nSPEC CHECKSUMS:'),
      lock().replace(`  NativeCore:\n    :podspec: "${rnRecipe}"\n`, ''),
      lock().replace('  NativeCore:\n', '  "NativeCore":\n'),
      lock().replace(`"${rnRecipe}"`, `"${rnRecipe}\\"`),
      lock().replace('SPEC CHECKSUMS:', '    :tag: release\n    :extra: value\n\nSPEC CHECKSUMS:'),
      lock(cleanChecksum, path.join(reactNative(), 'React-Core-prebuilt.podspec')),
    ]) {
      expect(normalize(value)).toBe(value);
    }
    const binary = Buffer.from([0xff, 0xfe, 0x01]);
    expect(portableCocoaPodsLock(binary, iosRoot(), reactNative())).toBe(binary);
  });

  it('preserves a recognized recipe checksum when required installed inputs are unavailable or unsupported', () => {
    const original = lock();
    expect(normalize(lock(cleanChecksum, '../node_modules/react-native/missing.podspec')))
      .toBe(lock(cleanChecksum, '../node_modules/react-native/missing.podspec'));
    const core = 'node_modules/react-native/React-Core-prebuilt.podspec';
    write(core, 'Unsupported Ruby spec');
    expect(normalize(original)).toBe(original);
    write(core, 'source = ReactNativeCoreUtils.resolve_podspec_source()');
    fs.rmSync(path.join(project(), 'node_modules/react-native/scripts/cocoapods/utils.rb'));
    expect(normalize(original)).toBe(original);

    write('node_modules/react-native/scripts/cocoapods/utils.rb', 'shared CocoaPods helpers');
    installHermesRecipe();
    const originalHermes = lock(cleanChecksum, hermesRecipe);
    expect(normalize(originalHermes)).toBe(originalHermes);
    installHermesCompiler();
    expect(normalize(originalHermes)).toBe(originalHermes);
  });

  it.each([
    'bad json',
    'null',
    '{"name":"NativeCore","version":42}',
    '{"name":"NativeCore","version":"0.84.1-nightly"}',
    '{"name":"NativeCore","version":"0.84.1"}',
    '{"name":"NativeCore","version":"0.84.1","source":{"git":"https://example.com/rn.git"}}',
    '{"name":"NativeCore","version":"0.84.1","source":{"http":"https://example.com/rn.tgz","sha256":"another hash"}}',
  ])('keeps the raw checksum for unsupported evaluated specs (%s)', spec => {
    const original = lock(installGeneratedSpec('NativeCore', spec));
    expect(normalize(original)).toBe(original);
  });

  it('recognizes the default encoded React Native dependencies archive in a checkout with spaces', () => {
    write('node_modules/react-native/third-party-podspecs/ReactNativeDependencies.podspec',
      'source = ReactNativeDependenciesUtils.resolve_podspec_source()');
    write('node_modules/react-native/scripts/cocoapods/rndependencies.rb', checkoutLocalSource);
    write('node_modules/react-native/third-party-podspecs/replace_dependencies_version.js', 'stable build script');
    const name = 'NativeDependencies';
    const source = pathToFileURL(path.join(iosRoot(), 'Pods/ReactNativeDependencies-artifacts/reactnative-dependencies-0.84.1-rc.0-debug.tar.gz')).href;
    const spec = JSON.stringify({ name, version: '0.84.1-rc.0', source: { http: source } });
    const warm = lock(installGeneratedSpec(name, spec), rnDependenciesRecipe, name);
    const normalizedWarm = normalize(warm);
    expect(normalizedWarm).toContain('bundle-drop-podspec-sha256:');
    fs.rmSync(path.join(iosRoot(), 'Pods'), { recursive: true });
    expect(normalize(lock(cleanChecksum, rnDependenciesRecipe, name))).toBe(normalizedWarm);
  });

  it('uses stock generated Hermes metadata as an eligibility check', () => {
    installHermesRecipe();
    const compiler = installHermesCompiler();
    write(compiler, 'selected compiler');
    const version = '250829098.0.9';
    const name = 'hermes-engine';
    const source = `https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios/${version}/hermes-ios-${version}-hermes-ios-debug.tar.gz`;
    const expectedCompiler = fs.realpathSync(path.join(project(), compiler));
    const evaluate = (http: string, compilerPath?: string) => lock(installGeneratedSpec(name, JSON.stringify({
      name, version, source: { http }, user_target_xcconfig: compilerPath ? { HERMES_CLI_PATH: compilerPath } : undefined,
    })), hermesRecipe, name);

    expect(normalize(evaluate(source, expectedCompiler))).toContain('bundle-drop-podspec-sha256:');
    for (const input of [
      evaluate(source),
      evaluate(source, '/custom/hermesc'),
      evaluate('https://example.com/custom.tgz', expectedCompiler),
    ]) {
      expect(normalize(input)).toBe(input);
    }
  });
});
