import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { measureInstalledSightOta, measureSightOta, type MeasureSightOtaOptions } from '../../../CLI/scripts/sight-ota';
import { resolveExpoBuildIdentity } from '../../../expo/buildIdentity';
import { runComparisonProcess } from '../../../CLI/scripts/sight-compare/process';

jest.mock('../../../expo/buildIdentity');
jest.mock('../../../CLI/scripts/sight-compare/process', () => ({
  ...jest.requireActual('../../../CLI/scripts/sight-compare/process'),
  runComparisonProcess: jest.fn(),
}));

const magic = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const xmlPlist = (fields: string): string => `<plist version="1.0"><dict>${fields}</dict></plist>`;

describe('Sight local OTA measurements', () => {
  let root: string;
  let options: MeasureSightOtaOptions;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalOverride = process.env.REACT_NATIVE_OVERRIDE_HERMES_DIR;
  const write = (file: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const configuration = (value: object) => write(path.join(root, 'bundle.drop.config.js'), 'module.exports=' + JSON.stringify(value));
  const hermesConfig = () => configuration({ runtimeVersion: { android: '1', ios: '1' }, hermesBytecode: true });
  const nativeCompiler = (directory?: string) => {
    const file = directory || path.join(root, 'node_modules/react-native/sdks/hermesc/osx-bin/hermesc');
    write(file, 'compiler');
    return file;
  };
  const mockCompiler = (bytes = magic) => jest.spyOn(childProcess, 'spawnSync').mockImplementation((_command, args) => {
    if (args?.includes('-help')) return { status: 0, stdout: '  -O\n  -g0\n  -output-source-map\n' } as any;
    write(String(args![args!.indexOf('-out') + 1]), bytes);
    return { status: 0 } as any;
  });
  const expoProject = () => {
    options.projectType = 'expo';
    write(path.join(root, 'node_modules/expo/package.json'), '{"name":"expo","version":"55.0.0"}');
    write(path.join(root, 'node_modules/@expo/cli/package.json'), '{"name":"@expo/cli"}');
    write(path.join(root, 'node_modules/@expo/cli/index.js'), '// project-local CLI');
    write(path.join(root, 'node_modules/@expo/cli/build/src/utils/nodeEnv.js'), 'exports.loadEnvFiles=()=>{};');
    write(path.join(root, 'node_modules/@expo/config/paths.js'), 'exports.resolveEntryPoint=()=>"index.js";');
    write(path.join(root, 'index.js'), 'export {};');
    jest.mocked(resolveExpoBuildIdentity).mockResolvedValue({ appVersion: '1.2.3', runtimeVersion: 'runtime', javaScriptEngine: 'hermes' } as any);
  };
  const mockExpoExport = () => jest.spyOn(childProcess, 'spawnSync').mockImplementation((_command, args) => {
    const destination = (flag: string) => String(args![args!.indexOf(flag) + 1]);
    write(destination('--bundle-output'), magic);
    write(destination('--sourcemap-output'), '{"version":3,"sources":[],"mappings":""}');
    fs.cpSync(options.assetsDirectory, destination('--assets-dest'), { recursive: true });
    return { status: 0 } as any;
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-ota-test-'));
    options = {
      projectRoot: root, snapshotRoot: root, projectType: 'bare', platform: 'android',
      bundlePath: path.join(root, 'input/main.android.jsbundle'), sourceMapPath: path.join(root, 'input/main.android.jsbundle.map'),
      assetsDirectory: path.join(root, 'assets'), workDirectory: path.join(root, 'work'),
    };
    fs.mkdirSync(options.workDirectory);
    write(path.join(root, 'package.json'), '{"name":"fixture"}');
    write(path.join(root, 'node_modules/react-native/package.json'), '{"name":"react-native","version":"0.83.1"}');
    write(options.bundlePath, 'console.log(1);');
    write(options.sourceMapPath, '{"version":3,"sources":["index.js"],"mappings":"AAAA"}');
    write(path.join(options.assetsDirectory, 'images/image.png'), 'image');
    write(path.join(root, 'android/app/build.gradle'), 'versionName "1.2.3"\n');
    configuration({ runtimeVersion: { android: '1', ios: '1' }, hermesBytecode: false });
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.REACT_NATIVE_OVERRIDE_HERMES_DIR;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.mocked(resolveExpoBuildIdentity).mockReset();
    jest.mocked(runComparisonProcess).mockReset();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', platform);
    if (originalOverride === undefined) delete process.env.REACT_NATIVE_OVERRIDE_HERMES_DIR;
    else process.env.REACT_NATIVE_OVERRIDE_HERMES_DIR = originalOverride;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('measures a real canonical JavaScript ZIP and preserves analysis inputs', async () => {
    const before = fs.readFileSync(options.bundlePath);
    const result = await measureInstalledSightOta(options);
    expect(result).toMatchObject({ status: 'available', engine: 'javascript', bundleBytes: before.length });
    if (result.status === 'available') expect(result.zipBytes).toBe(fs.statSync(path.join(options.workDirectory, 'bundle-android.zip')).size);
    expect(fs.readFileSync(options.bundlePath)).toEqual(before);
    expect(fs.readFileSync(path.join(options.workDirectory, 'bundle-android.zip')).subarray(0, 2).toString()).toBe('PK');
  });

  it.each(['missing-config', 'missing-runtime', 'empty-runtime', 'missing-native', 'two-native', 'dynamic-version', 'two-versions', 'invalid-version', 'invalid-config'])('leaves missing or ambiguous identity unavailable: %s', async scenario => {
    if (scenario === 'missing-config') fs.unlinkSync(path.join(root, 'bundle.drop.config.js'));
    if (scenario === 'missing-runtime') configuration({});
    if (scenario === 'empty-runtime') configuration({ runtimeVersion: { android: ' ' } });
    if (scenario === 'missing-native') fs.unlinkSync(path.join(root, 'android/app/build.gradle'));
    if (scenario === 'two-native') write(path.join(root, 'android/app/build.gradle.kts'), 'versionName = "1.2.3"');
    if (scenario === 'dynamic-version') write(path.join(root, 'android/app/build.gradle'), 'versionName versionFromEnvironment');
    if (scenario === 'two-versions') write(path.join(root, 'android/app/build.gradle'), 'versionName "1.2.3"\nversionName "2.0.0"');
    if (scenario === 'invalid-version') write(path.join(root, 'android/app/build.gradle'), 'versionName "${VERSION}"');
    if (scenario === 'invalid-config') write(path.join(root, 'bundle.drop.config.js'), 'throw new Error("/private/secret");');
    const result = await measureInstalledSightOta(options);
    const expectedReason = scenario === 'missing-config'
      ? 'This project has no bundle.drop.config.js. Configure Bundle Drop to measure its OTA archive.'
      : ['missing-runtime', 'empty-runtime'].includes(scenario)
        ? 'Bundle Drop has no runtime version configured for android. Set runtimeVersion.android in bundle.drop.config.js.'
        : scenario === 'invalid-config'
          ? 'The project configuration could not be read for Bundle Drop OTA packaging.'
          : 'The native android app version could not be resolved unambiguously for Bundle Drop OTA packaging.';
    expect(result).toEqual({ status: 'unavailable', reason: expectedReason });
    expect(JSON.stringify(result)).not.toContain('/private/secret');
  });

  it('supports a literal Kotlin native version without needing an SDK in the project', async () => {
    fs.unlinkSync(path.join(root, 'android/app/build.gradle'));
    write(path.join(root, 'android/app/build.gradle.kts'), '  versionName = "1.2.3"\n');
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'available' });
  });

  it.each(['literal', 'variable', 'mixed', 'unresolved', 'non-string', 'missing', 'empty-project', 'invalid-setting'])('handles iOS version identity %s conservatively', async scenario => {
    options.platform = 'ios';
    if (scenario !== 'missing') {
      const version = scenario === 'non-string' ? '<integer>123</integer>'
        : `<string>${scenario === 'literal' ? '1.2.3' : '$(MARKETING_VERSION)'}</string>`;
      write(path.join(root, 'ios/App/Info.plist'), xmlPlist(`<key>CFBundleShortVersionString</key>${version}`));
      fs.mkdirSync(path.join(root, 'ios/Pods'));
      write(path.join(root, 'ios/note.txt'), 'not a project');
      fs.mkdirSync(path.join(root, 'ios/Empty.xcodeproj'));
    }
    if (['variable', 'mixed', 'invalid-setting'].includes(scenario)) {
      write(path.join(root, 'ios/App.xcodeproj/project.pbxproj'), `MARKETING_VERSION = "1.2.3";\nMARKETING_VERSION = ${scenario === 'mixed' ? '2.0.0' : scenario === 'invalid-setting' ? '$(VERSION)' : '1.2.3'};\n`);
    }
    const result = await measureInstalledSightOta(options);
    expect(result.status).toBe(['literal', 'variable'].includes(scenario) ? 'available' : 'unavailable');
  });

  it('rejects disagreeing app plist versions and an empty iOS directory', async () => {
    options.platform = 'ios';
    fs.mkdirSync(path.join(root, 'ios'));
    expect((await measureInstalledSightOta(options)).status).toBe('unavailable');
    write(path.join(root, 'ios/Info.plist'), xmlPlist('<key>CFBundleShortVersionString</key><string>1.0.0</string>'));
    write(path.join(root, 'ios/Other/Info.plist'), xmlPlist('<key>CFBundleShortVersionString</key><string>2.0.0</string>'));
    expect((await measureInstalledSightOta(options)).status).toBe('unavailable');
  });

  it.each([
    ['OpenStep', '{ CFBundleShortVersionString = "1.2.3"; }'],
    ['binary', Buffer.from('bplist00\0\0')],
    ['array', '<plist><array/></plist>'],
    ['empty version', '<plist><dict><key>CFBundleShortVersionString</key><string/></dict></plist>'],
  ])('keeps unsupported iOS metadata unavailable: %s', async (_name, contents) => {
    options.platform = 'ios';
    write(path.join(root, 'ios/App/Info.plist'), contents);
    expect(await measureInstalledSightOta(options)).toEqual({
      status: 'unavailable',
      reason: 'The native ios app version could not be resolved unambiguously for Bundle Drop OTA packaging.',
    });
    expect(fs.existsSync(path.join(options.workDirectory, 'bundle-ios.zip'))).toBe(false);
  });

  it('uses the application version rather than test and extension plist versions', async () => {
    options.platform = 'ios';
    write(path.join(root, 'ios/App/Info.plist'), xmlPlist('<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>4.7.9</string>'));
    write(path.join(root, 'ios/AppTests/Info.plist'), xmlPlist('<key>CFBundlePackageType</key><string>BNDL</string><key>CFBundleShortVersionString</key><string>2.7.71</string>'));
    write(path.join(root, 'ios/WalletExtension/Info.plist'), xmlPlist('<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>wallet</string></dict>'));
    write(path.join(root, 'ios/WalletExtensionAuth/Info.plist'), xmlPlist('<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>wallet-auth</string></dict>'));
    expect((await measureInstalledSightOta(options)).status).toBe('available');
    const manifest = JSON.parse(fs.readFileSync(path.join(options.workDirectory, 'bundle-manifest.json'), 'utf8'));
    expect(manifest.version).toBe('4.7.9');

    write(path.join(root, 'ios/AnotherApp/Info.plist'), xmlPlist('<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>5.0.0</string>'));
    expect((await measureInstalledSightOta(options)).status).toBe('unavailable');
  });

  it('does not use test or extension versions when an application plist is absent', async () => {
    options.platform = 'ios';
    write(path.join(root, 'ios/Tests/Info.plist'), xmlPlist('<key>CFBundlePackageType</key><string>BNDL</string><key>CFBundleShortVersionString</key><string>1.0.0</string>'));
    write(path.join(root, 'ios/Extension/Info.plist'), xmlPlist('<key>NSExtension</key><dict/><key>CFBundleShortVersionString</key><string>1.0.0</string>'));
    expect((await measureInstalledSightOta(options)).status).toBe('unavailable');
  });

  it('compiles a separate Hermes output using upload compiler flags', async () => {
    hermesConfig();
    nativeCompiler();
    const compiler = mockCompiler();
    const source = fs.readFileSync(options.bundlePath);
    const map = fs.readFileSync(options.sourceMapPath);
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'available', engine: 'hermes', bundleBytes: 8 });
    expect(compiler.mock.calls[1][1]).toEqual(expect.arrayContaining(['-emit-binary', '-O', '-g0', '-output-source-map']));
    expect(fs.readFileSync(options.bundlePath)).toEqual(source);
    expect(fs.readFileSync(options.sourceMapPath)).toEqual(map);
  });

  it.each(['missing', 'failed', 'spawn-error', 'invalid-output'])('reports Hermes %s as unavailable instead of silently using JavaScript', async scenario => {
    hermesConfig();
    if (scenario !== 'missing') nativeCompiler();
    const compiler = mockCompiler(scenario === 'invalid-output' ? Buffer.from('not bytecode') : magic);
    if (scenario === 'failed') compiler.mockReturnValue({ status: 1 } as any);
    if (scenario === 'spawn-error') compiler.mockReturnValue({ error: new Error('/private/compiler') } as any);
    const result = await measureInstalledSightOta(options);
    expect(result).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('Hermes compiler') });
    expect(JSON.stringify(result)).not.toContain('/private/compiler');
  });

  it.each([['hermes-compiler', 'linux'], ['hermes-engine', 'win32']] as const)('resolves %s compiler layout on %s', async (moduleId, host) => {
    Object.defineProperty(process, 'platform', { value: host });
    hermesConfig();
    write(path.join(root, 'node_modules', moduleId, 'package.json'), JSON.stringify({ name: moduleId }));
    nativeCompiler(path.join(root, 'node_modules', moduleId, ...(moduleId === 'hermes-compiler' ? ['hermesc'] : []), host === 'win32' ? 'win64-bin/hermesc.exe' : 'linux64-bin/hermesc'));
    mockCompiler();
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'available', engine: 'hermes' });
  });

  it('packages Expo JavaScript with its resolved local identity', async () => {
    expoProject();
    jest.mocked(resolveExpoBuildIdentity).mockResolvedValue({ appVersion: '1.2.3', runtimeVersion: 'runtime', javaScriptEngine: 'jsc' } as any);
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'available', engine: 'javascript' });
  });

  it('uses the project-local Expo bytecode export, preserving original sources', async () => {
    expoProject();
    nativeCompiler();
    const compiler = mockExpoExport();
    const original = fs.readFileSync(options.bundlePath);
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'available', engine: 'hermes', bundleBytes: 8 });
    expect(fs.readFileSync(options.bundlePath)).toEqual(original);
    expect(compiler).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['export:embed', '--bytecode', '--minify', 'true', '--reset-cache']), expect.objectContaining({ stdio: ['ignore', 'ignore', 'inherit'] }));
  });

  it.each(['explicit-entry', 'missing-entry', 'failed', 'spawn-error', 'asset-mismatch'])('handles Expo export %s', async scenario => {
    expoProject();
    nativeCompiler();
    const compiler = mockExpoExport();
    if (scenario === 'explicit-entry') {
      options.entryFile = 'custom.js';
      write(path.join(root, 'custom.js'), 'export {};');
    }
    if (scenario === 'missing-entry') write(path.join(root, 'node_modules/@expo/config/paths.js'), 'exports.resolveEntryPoint=()=>null;');
    if (scenario === 'failed') compiler.mockReturnValue({ status: 1 } as any);
    if (scenario === 'spawn-error') compiler.mockReturnValue({ error: new Error('/private/compiler') } as any);
    if (scenario === 'asset-mismatch') {
      const implementation = compiler.getMockImplementation()!;
      compiler.mockImplementation((...args) => {
        const result = implementation(...args);
        write(path.join(options.workDirectory, 'assets/extra.png'), 'different');
        return result;
      });
    }
    const result = await measureInstalledSightOta(options);
    expect(result.status).toBe(scenario === 'explicit-entry' ? 'available' : 'unavailable');
    if (scenario === 'explicit-entry') expect(compiler.mock.calls[0][1]).toContain(fs.realpathSync(path.join(root, 'custom.js')));
    if (scenario === 'asset-mismatch') expect(result).toMatchObject({ reason: expect.stringContaining('different assets') });
    expect(JSON.stringify(result)).not.toContain('/private/compiler');
  });

  it('handles Expo identity failure without exporting private exception details', async () => {
    expoProject();
    jest.mocked(resolveExpoBuildIdentity).mockRejectedValue(new Error('/private/identity'));
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'unavailable', reason: 'The Expo configuration could not resolve a local app version and runtime version for Bundle Drop OTA packaging.' });
  });

  it('honors an internal Expo compiler override and rejects an escaping override', async () => {
    expoProject();
    mockExpoExport();
    const override = path.join(root, 'hermes-source');
    nativeCompiler(path.join(override, 'build/bin/hermesc'));
    process.env.REACT_NATIVE_OVERRIDE_HERMES_DIR = override;
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'available' });
    process.env.REACT_NATIVE_OVERRIDE_HERMES_DIR = path.dirname(root);
    const outside = path.join(path.dirname(root), 'build/bin/hermesc');
    // The external candidate is simulated without creating files outside this fixture.
    const exists = fs.existsSync;
    const stat = fs.statSync;
    jest.spyOn(fs, 'existsSync').mockImplementation(file => String(file) === outside || exists(file));
    jest.spyOn(fs, 'statSync').mockImplementation(((file: string) => file === outside ? stat(path.join(override, 'build/bin/hermesc')) : stat(file)) as any);
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'unavailable' });
  });

  it('prefers the Expo hermes-compiler package over the React Native bundled compiler', async () => {
    expoProject();
    write(path.join(root, 'node_modules/hermes-compiler/package.json'), '{"name":"hermes-compiler"}');
    nativeCompiler(path.join(root, 'node_modules/hermes-compiler/hermesc/osx-bin/hermesc'));
    mockExpoExport();
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'available' });
  });

  it('rejects snapshot escapes while allowing standalone hoisted dependencies', async () => {
    hermesConfig();
    nativeCompiler();
    mockCompiler();
    const snapshot = path.join(root, 'narrow-snapshot');
    fs.mkdirSync(snapshot);
    expect(await measureInstalledSightOta({ ...options, snapshotRoot: snapshot })).toMatchObject({ status: 'unavailable' });
    expect(await measureInstalledSightOta({ ...options, snapshotRoot: undefined })).toMatchObject({ status: 'available' });
  });

  it('reports packaging failures without replacing the source bundle', async () => {
    fs.symlinkSync(options.bundlePath, path.join(options.assetsDirectory, 'link'));
    expect(await measureInstalledSightOta(options)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('packaged') });
    expect(fs.readFileSync(options.bundlePath, 'utf8')).toBe('console.log(1);');
  });

  it('isolates measurement in a child, passes the captured environment, and cleans only owned output', async () => {
    const measurement = { status: 'available', engine: 'hermes', bundleBytes: 100, zipBytes: 200 };
    jest.mocked(runComparisonProcess).mockResolvedValue({ stdout: 'compiler log\nBUNDLE_DROP_SIGHT_OTA=' + JSON.stringify(measurement) + '\n', stderr: '', exitCode: 0 });
    write(path.join(options.workDirectory, 'keep'), 'owned by caller');
    const env = { NODE_ENV: 'production', BUNDLE_DROP_OTA_BUILD: '1' };
    expect(await measureSightOta(options, { env, logPath: path.join(root, 'log') })).toEqual(measurement);
    expect(runComparisonProcess).toHaveBeenCalledWith(expect.objectContaining({ env, logPath: path.join(root, 'log') }));
    expect(fs.readdirSync(options.workDirectory)).toEqual(['keep']);
  });

  it.each(['missing', 'invalid', 'failed'])('handles a %s child result', async scenario => {
    if (scenario === 'failed') jest.mocked(runComparisonProcess).mockRejectedValue(new Error('/private/process'));
    else jest.mocked(runComparisonProcess).mockResolvedValue({ stdout: scenario === 'missing' ? 'output' : 'BUNDLE_DROP_SIGHT_OTA={', stderr: '', exitCode: 0 });
    expect(await measureSightOta(options)).toMatchObject({ status: 'unavailable' });
    expect(fs.readdirSync(options.workDirectory)).toEqual([]);
  });

  it('propagates cancellation and removes its private work directory', async () => {
    const controller = new AbortController();
    jest.mocked(runComparisonProcess).mockImplementation(async () => { controller.abort(); throw new Error('stopped'); });
    await expect(measureSightOta(options, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.readdirSync(options.workDirectory)).toEqual([]);
    await expect(measureSightOta(options, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('owns %s cancellation only when the caller supplies no signal', async event => {
    const before = process.listenerCount(event);
    jest.mocked(runComparisonProcess).mockImplementation(async ({ signal }) => {
      expect(process.listenerCount(event)).toBe(before + 1);
      process.emit(event);
      expect(signal!.aborted).toBe(true);
      throw new Error('cancelled');
    });
    await expect(measureSightOta(options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(process.listenerCount(event)).toBe(before);
    expect(fs.readdirSync(options.workDirectory)).toEqual([]);
  });

  it('removes owned signal listeners if temporary directory creation fails', async () => {
    const before = process.listenerCount('SIGINT');
    fs.rmSync(options.workDirectory, { recursive: true });
    expect(await measureSightOta(options)).toMatchObject({ status: 'unavailable' });
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
