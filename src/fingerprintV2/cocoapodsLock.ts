import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Recipe = {
  artifact: 'core' | 'dependencies' | 'hermes';
  marker: string;
  checkoutPath: { file?: string; code: string };
  inputs: string[];
  sourceOverrides: string[];
  disabledSwitch: string;
};

// CocoaPods stores SHA-1s of the evaluated Ruby specs. These React Native
// generators put checkout-local artifact paths in those evaluated specs. Their
// installed recipes and inputs are available even before a clean pod install.
const reactNativeRecipes = new Map<string, Recipe>([
  ['React-Core-prebuilt.podspec', {
    artifact: 'core',
    marker: 'ReactNativeCoreUtils.resolve_podspec_source()',
    checkoutPath: { file: 'scripts/cocoapods/rncore.rb', code: 'URI::File.build(path: destinationDebug)' },
    inputs: ['scripts/cocoapods/rncore.rb', 'scripts/replace-rncore-version.js'],
    sourceOverrides: ['RCT_TESTONLY_RNCORE_TARBALL_PATH', 'RCT_TESTONLY_RNCORE_VERSION', 'ENTERPRISE_REPOSITORY'],
    disabledSwitch: 'RCT_USE_PREBUILT_RNCORE',
  }],
  ['third-party-podspecs/ReactNativeDependencies.podspec', {
    artifact: 'dependencies',
    marker: 'ReactNativeDependenciesUtils.resolve_podspec_source()',
    checkoutPath: { file: 'scripts/cocoapods/rndependencies.rb', code: 'URI::File.build(path: destinationDebug)' },
    inputs: ['scripts/cocoapods/rndependencies.rb', 'third-party-podspecs/replace_dependencies_version.js'],
    sourceOverrides: ['RCT_USE_LOCAL_RN_DEP', 'RCT_DEPS_VERSION', 'ENTERPRISE_REPOSITORY'],
    disabledSwitch: 'RCT_USE_RN_DEP',
  }],
  ['sdks/hermes-engine/hermes-engine.podspec', {
    artifact: 'hermes',
    marker: String.raw`require.resolve(\"hermes-compiler\"`,
    checkoutPath: { code: `'HERMES_CLI_PATH' => "#{hermes_compiler_path}/hermesc/osx-bin/hermesc"` },
    inputs: [
      'sdks/hermes-engine/hermes-utils.rb', 'sdks/hermes-engine/version.properties',
      'sdks/hermes-engine/utils/replace_hermes_version.js',
    ],
    sourceOverrides: [
      'HERMES_ENGINE_TARBALL_PATH', 'HERMES_OVERRIDE_HERMESC_PATH', 'REACT_NATIVE_OVERRIDE_HERMES_DIR',
      'HERMES_COMMIT', 'RCT_BUILD_HERMES_FROM_SOURCE', 'ENTERPRISE_REPOSITORY',
    ],
    disabledSwitch: 'RCT_HERMES_V1_ENABLED',
  }],
]);

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const checksumRow = /^  ([\w.+-]+): ([a-f0-9]{40})(\r?\n)?$/;
const releaseVersion = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

function publishedRelease(bytes: Buffer | undefined): boolean {
  if (!bytes) return false;
  try {
    const manifest = JSON.parse(bytes.toString('utf8')) as { version?: unknown } | null;
    return typeof manifest?.version === 'string' && releaseVersion.test(manifest.version);
  } catch {
    return false;
  }
}

function readFile(file: string): Buffer | undefined {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
  return fs.readFileSync(file);
}

function section(lines: string[], title: string): [number, number] | undefined {
  const matches = lines.flatMap((line, index) => line.trimEnd() === title ? [index] : []);
  if (matches.length !== 1) return undefined;
  const start = matches[0] + 1;
  const nextSection = lines.findIndex((line, index) => index >= start && /^\S/.test(line));
  return [start, nextSection < 0 ? lines.length : nextSection];
}

function externalPodspecs(lines: string[]): Map<string, string> {
  // Match the subset of CocoaPods' block YAML that names a Ruby file using
  // :podspec, optionally with :tag. Leave unfamiliar formatting untouched.
  const pods = new Map<string, string>();
  const seen = new Set<string>();
  const entries = lines.join('').split(/(?=^  [^ \r\n])/m);
  for (const entry of entries) {
    const [header, ...fields] = entry.trimEnd().split(/\r?\n/);
    if (!header) continue;
    const name = /^  ([\w.+-]+):$/.exec(header)?.[1];
    if (!name) return new Map();
    if (seen.has(name)) {
      pods.delete(name);
      continue;
    }
    seen.add(name);
    const spec = fields.find(line => line.startsWith('    :podspec: '));
    if (!spec || fields.length > 2 || fields.some(line => line !== spec && !line.startsWith('    :tag: '))) continue;
    const value = spec.slice('    :podspec: '.length);
    const pathname = /^(?:"([^"\\]+)"|'([^']+)'|([^\s'"#]+))$/.exec(value);
    const relative = pathname?.[1] ?? pathname?.[2] ?? pathname?.[3];
    if (relative && !path.isAbsolute(relative) && !relative.includes(':') && relative.split('/').includes('node_modules')) {
      pods.set(name, relative);
    }
  }
  return pods;
}

function matchesGeneratedPodspec(
  iosRoot: string,
  name: string,
  checksum: string,
  artifact: Recipe['artifact'],
  compilerPath?: string,
): boolean {
  // The generated spec is optional. When available, use it only to check
  // that CocoaPods used the default artifact and compiler for this lock row.
  const generated = readFile(path.join(iosRoot, 'Pods/Local Podspecs', `${name}.podspec.json`));
  if (!generated) return true;
  if (createHash('sha1').update(generated).digest('hex') !== checksum) return false;

  let spec: { name?: string; version?: string; source?: { http?: string }; user_target_xcconfig?: { HERMES_CLI_PATH?: string } };
  try {
    spec = JSON.parse(generated.toString('utf8'));
  } catch {
    return false;
  }
  if (spec?.name !== name || typeof spec.version !== 'string' || !releaseVersion.test(spec.version)) return false;
  if (!spec.source || typeof spec.source.http !== 'string' || Object.keys(spec.source).length !== 1) return false;
  const source = spec.source.http;
  if (artifact === 'hermes') {
    const defaultSource = `https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios/${spec.version}/hermes-ios-${spec.version}-hermes-ios-debug.tar.gz`;
    return source === defaultSource && spec.user_target_xcconfig?.HERMES_CLI_PATH === compilerPath;
  }
  const directory = artifact === 'core' ? 'ReactNativeCore-artifacts' : 'ReactNativeDependencies-artifacts';
  const archive = path.join(iosRoot, 'Pods', directory, `reactnative-${artifact}-${spec.version}-debug.tar.gz`);
  return source === pathToFileURL(archive).href || source === `file://${archive}`;
}

function recipeDigest(iosRoot: string, reactNativeRoot: string, relative: string, name: string, checksum: string): string | undefined {
  const podspec = path.resolve(iosRoot, relative);
  if (!fs.statSync(podspec, { throwIfNoEntry: false })?.isFile()) return undefined;
  const recipePath = path.relative(reactNativeRoot, fs.realpathSync(podspec)).split(path.sep).join('/');
  const recipe = reactNativeRecipes.get(recipePath);
  if (!recipe) return undefined;
  if (recipe.sourceOverrides.some(name => Boolean(process.env[name])) || process.env[recipe.disabledSwitch] === '0') {
    return undefined;
  }

  const spec = fs.readFileSync(podspec);
  if (!spec.includes(recipe.marker)) return undefined;
  // Later React Native recipes already write a Maven URL or a PODS_ROOT-relative
  // compiler path. Preserve their original CocoaPods checksums on both hosts.
  if (!recipe.checkoutPath.file && !spec.includes(recipe.checkoutPath.code)) return undefined;
  const digests = [recipePath, sha256(spec)];
  for (const file of ['scripts/react_native_pods.rb', 'scripts/cocoapods/utils.rb', ...recipe.inputs]) {
    const input = readFile(path.join(reactNativeRoot, file));
    if (!input) return undefined;
    if (file === recipe.checkoutPath.file && !input.includes(recipe.checkoutPath.code)) return undefined;
    digests.push(sha256(input));
  }

  // Recent Hermes recipes use the compiler selected by Node from React Native's
  // install. Hash its runnable bytes so same-version compiler overrides differ.
  let compilerPath: string | undefined;
  if (recipe.artifact === 'hermes') {
    const resolveFrom = require('resolve-from') as { silent(root: string, module: string): string | undefined };
    const compiler = resolveFrom.silent(reactNativeRoot, 'hermes-compiler');
    if (!compiler) return undefined;
    compilerPath = path.join(path.dirname(compiler), 'hermesc/osx-bin/hermesc');
    const binary = readFile(compilerPath);
    if (!binary) return undefined;
    digests.push(sha256(binary));
  }

  return matchesGeneratedPodspec(iosRoot, name, checksum, recipe.artifact, compilerPath)
    ? sha256(JSON.stringify(digests))
    : undefined;
}

export function portableCocoaPodsLock(bytes: Buffer, iosRoot: string, reactNativeRoot: string): Buffer | string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) return bytes;
  const lines = text.split(/(?<=\n)/);
  const external = section(lines, 'EXTERNAL SOURCES:');
  const checksums = section(lines, 'SPEC CHECKSUMS:');
  if (!external || !checksums) return bytes;

  const packageRoot = fs.realpathSync(reactNativeRoot);
  // Nightly artifact selectors can resolve a different build for the same
  // package version. Preserve their checksums even before Pods exists.
  if (!publishedRelease(readFile(path.join(packageRoot, 'package.json')))) return bytes;
  const podspecs = externalPodspecs(lines.slice(...external));
  const checksumRows = lines.slice(...checksums).map(line => checksumRow.exec(line));
  for (const [name, relative] of podspecs) {
    const rows = checksumRows.flatMap((row, index) => row?.[1] === name ? [{ row, index }] : []);
    if (rows.length !== 1) continue;
    const { row, index } = rows[0];
    const [, , checksum, ending = ''] = row;
    const recipe = recipeDigest(iosRoot, packageRoot, relative, name, checksum);
    if (!recipe) continue;
    lines[checksums[0] + index] = `  ${name}: bundle-drop-podspec-sha256:${recipe}${ending}`;
  }
  return lines.join('');
}
