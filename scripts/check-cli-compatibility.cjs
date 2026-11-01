#!/usr/bin/env node
// Test the published file layout and native ESM interop, outside Jest and this
// checkout's node_modules. Run after an explicit build, or supply a tarball.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const nodeDirectory = path.dirname(process.execPath);
const npmCli = [
  path.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
  path.resolve(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
].find(file => fs.existsSync(file));
assert.ok(npmCli, 'npm must be installed alongside the Node executable');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-cli-compat-'));
const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
delete env.FORCE_COLOR;
delete env.NO_COLOR;

function run(args, cwd, expectedStatus = 0, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8',
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout + result.stderr;
}

try {
  let tarball = process.argv[2] && path.resolve(process.argv[2]);
  if (!tarball) {
    const packed = run([npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root);
    tarball = path.join(temporary, JSON.parse(packed)[0].filename);
  }
  const fixture = path.join(temporary, 'consumer');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
    name: 'bundle-drop-cli-compatibility', version: '1.0.0', private: true,
  }));
  // This is a CLI-only consumer: mobile peer dependencies are deliberately not
  // installed. Real mobile peer compatibility is exercised by Metro fixtures.
  run([npmCli, 'install', tarball, '--ignore-scripts', '--omit=peer', '--no-audit', '--no-fund'], fixture);
  const installed = path.join(fixture, 'node_modules/@gfean/react-native-bundle-drop');
  const cli = path.join(installed, 'lib/CLI/cli.js');
  const axiosRoot = path.dirname(require.resolve('axios/package.json', { paths: [installed] }));
  const redirects = require(require.resolve('follow-redirects/package.json', { paths: [axiosRoot] }));
  const semver = require(require.resolve('semver', { paths: [installed] }));
  assert(semver.gte(redirects.version, '1.16.2'), 'Fresh packed consumer must resolve the patched redirect transport');
  const installedGlob = require(require.resolve('glob/package.json', { paths: [installed] }));
  const matcherPath = require.resolve('minimatch', { paths: [installed] });
  const { Minimatch } = require(matcherPath);
  assert.equal(installedGlob.version, '14.0.3');
  assert.equal(require(require.resolve('minimatch/package.json', { paths: [installed] })).version, '11.0.3');
  assert(new Minimatch('**/a/b/c/**/d/**', { dot: true }).match('a/b/c/d/file.kt'));
  assert(!new Minimatch('native/*(x)', { dot: true }).match('native/'));
  const help = run([cli, '--help'], fixture, 0, { FORCE_COLOR: '0' });
  for (const group of ['Setup', 'Analysis', 'Releases', 'Account']) assert.ok(help.includes(group), group);
  assert.ok(!/\u001b\[/.test(help), 'FORCE_COLOR=0 must suppress ANSI colors');
  for (const command of ['init', 'sync', 'doctor', 'sight', 'upload', 'eas-receipt', 'login', 'logout', 'whoami']) {
    assert.ok(run([cli, command, '--help'], fixture).includes('Usage:'), command);
  }
  assert.ok(run([cli, 'help', 'sight'], fixture).includes('--compare'));
  const uploadHelp = run([cli, 'upload', '--help'], fixture);
  assert.ok(uploadHelp.includes('--release-notes-file <path>'), 'upload help must describe release notes files');
  const version = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'))).version;
  assert.ok(run([cli, '--cli-version'], fixture).includes(version));
  assert.match(run([cli, 'sight', '--does-not-exist'], fixture, 1), /unknown option/);
  assert.match(run([cli, 'upload'], fixture, 1), /missing required argument/);
  assert.match(run([cli, 'sight', '--fetch'], fixture, 1), /require --compare/);
  assert.match(run([cli, 'sight', '--compare', '', '--platform', 'ios'], fixture, 1), /requires a Git ref/);
  for (const level of ['1', '3']) assert.match(run([cli, '--help'], fixture, 0, { FORCE_COLOR: level }), /\u001b\[/);
  assert.ok(!/\u001b\[/.test(run([cli, '--help'], fixture, 0, { NO_COLOR: '1' })));

  const xmlFile = path.join(fixture, 'Info with spaces.plist');
  fs.writeFileSync(xmlFile, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>');
  const reader = path.join(installed, 'lib/CLI/utils/read-xml-plist.js');
  const probe = `const assert=require('node:assert/strict');require(process.argv[1]).readXmlPlist(process.argv[2]).then(value=>assert.equal(value.CFBundleShortVersionString,'1.2.3')).catch(error=>{console.error(error);process.exitCode=1;});`;
  run(['-e', probe, reader, xmlFile], fixture);
  for (const contents of ['bplist00invalid', '{ CFBundleShortVersionString = "1.2.3"; }', '<plist><array/></plist>']) {
    fs.writeFileSync(xmlFile, contents);
    const reject = `require(process.argv[1]).readXmlPlist(process.argv[2]).then(()=>{process.exitCode=1},()=>{});`;
    run(['-e', reject, reader, xmlFile], fixture);
  }
  // The installed package must preserve scheme1 even with a fresh npm dependency graph.
  const goldens = require(path.join(root, 'src/tests/fingerprint/scheme-1-golden.json'));
  const write = (relative, contents) => {
    const file = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  write('package.json', '{"name":"fingerprint-fixture","scripts":{}}');
  write('node_modules/react-native/package.json', '{"name":"react-native","version":"0.78.3"}');
  write('node_modules/react-native/cli.js', 'console.log(JSON.stringify({root:process.cwd(),dependencies:{}}));');
  write('android/app/build.gradle', 'android {\n defaultConfig {\n versionCode 1\n targetSdk 35\n }\n}\n');
  write('android/app/src/main/Native.kt', 'fun feature() = false\n');
  const setRuntime = (platform, schemeVersion = 1) => write('bundle.drop.config.js', `module.exports = ${JSON.stringify({
    projectType: 'bare', runtimeVersion: { compatibilitySource: 'fingerprint',
      fingerprint: { schemeVersion, nativeProjectMode: { [platform]: 'native' } } },
  })};`);
  setRuntime('android');
  const androidReport = JSON.parse(run([cli, 'fingerprint', '--platform', 'android', '--json'], fixture));
  assert.equal(androidReport.status, 'stable');
  assert.equal(androidReport.nativeHash, goldens.cases.bareAndroid.nativeHash);
  assert.equal(androidReport.runtimeVersion, goldens.cases.bareAndroid.runtimeVersion);
  write('previous-experimental-report.json', JSON.stringify({ ...androidReport, status: 'experimental' }));
  const compared = JSON.parse(run([cli, 'fingerprint', '--platform', 'android', '--compare', 'previous-experimental-report.json', '--json'], fixture));
  assert.deepEqual(compared.changes, []);
  write('ios/Fixture.xcodeproj/project.pbxproj', '{ objects = { ID = { buildSettings = { CURRENT_PROJECT_VERSION = 1; ENABLE_NATIVE_PROBE = NO; }; }; }; }');
  setRuntime('ios');
  const iosReport = JSON.parse(run([cli, 'fingerprint', '--platform', 'ios', '--json'], fixture));
  assert.equal(iosReport.runtimeVersion, goldens.cases.bareIos.runtimeVersion);
  setRuntime('android', 2);
  assert.match(run([cli, 'fingerprint', '--platform', 'android', '--json'], fixture, 1), /Unsupported fingerprint scheme/);
  console.log('Fresh packed CLI scheme1 goldens, experimental-report comparison and unsupported-scheme refusal passed.');
  console.log(`Packed CLI compatibility passed: ${process.platform}, Node ${process.version}, package ${version}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
