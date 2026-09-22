import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

// This recognizes a known template, not arbitrary Ruby configuration. Unknown
// layouts must keep using the existing detector or an explicit SDK setting.
const engineMention = /hermes|jsc|javascriptcore|js[_-]?engine/i;
function withoutUnusedTemplateFramework(text: string): string {
  // The stock Xcode template lists JavaScriptCore in its navigator but does not
  // link it. Ignore that exact unused reference, not linked JSC or engine flags.
  const reference = text.match(/^\s*([A-F0-9]{24}) \/\* JavaScriptCore\.framework \*\/ = \{isa = PBXFileReference; lastKnownFileType = wrapper\.framework; name = JavaScriptCore\.framework; path = System\/Library\/Frameworks\/JavaScriptCore\.framework; sourceTree = SDKROOT; \};$/m);
  if (!reference || text.split(reference[1]).length !== 3) return text;
  return text.replace(reference[0], '').replace(
    new RegExp(`^\\s*${reference[1]} /\\* JavaScriptCore\\.framework \\*/,\\s*$`, 'm'), '',
  );
}
// RN 0.81.5's shipped helpers. Deliberately decline other implementations rather
// than interpret Ruby or assume that a package version proves engine semantics.
const helperHashes = {
  'scripts/react_native_pods.rb': 'bd090959a5ff31edcd1c391a44a4e5f342969a33e11f9d4ecd457bda2a2eef73',
  'scripts/cocoapods/jsengine.rb': '4bc4b49e4ab5adf1fc2000e276822cb31af7819a5d9ce1a635563cb7cc527106',
};
const compactRuby = (text: string): string => text
  .replace(/^\s*#.*$/gm, '')
  .replace(/\s+/g, ' ')
  .replace(/"/g, "'")
  .trim();

const standardLoader = compactRuby(`require Pod::Executable.execute_command('node', ['-p',
  'require.resolve(
    "react-native/scripts/react_native_pods.rb",
    {paths: [process.argv[1]]},
  )', __dir__]).strip`);
const standardArguments = compactRuby(`
  :path => config[:reactNativePath],
  :app_path => "#{Pod::Config.instance.installation_root}/.."
`);

/** Only infer the installed 0.81.x template's default after explicit detection. */
export function detectImplicitIosHermes(projectRoot: string, snapshotRoot?: string): true | undefined {
  if (process.env.USE_HERMES !== undefined || process.env.USE_THIRD_PARTY_JSC !== undefined) return undefined;

  try {
    const boundary = snapshotRoot ? fs.realpathSync(snapshotRoot) : undefined;
    function checked(file: string): string {
      const resolved = fs.realpathSync(file);
      if (boundary) {
        const relative = path.relative(boundary, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('Hermes configuration resolved outside the comparison snapshot.');
        }
      }
      return resolved;
    }
    function read(file: string): string {
      return fs.readFileSync(checked(file), 'utf8');
    }
    const app = JSON.parse(read(path.join(projectRoot, 'package.json')));
    const dependencies = { ...app.dependencies, ...app.devDependencies, ...app.optionalDependencies, ...app.peerDependencies };
    if (!dependencies['react-native'] || Object.keys(dependencies).some(name => /jsc|javascriptcore/i.test(name))) return undefined;
    if (['js', 'cjs', 'mjs', 'ts'].some(extension => fs.existsSync(path.join(projectRoot, `react-native.config.${extension}`)))) return undefined;

    const ios = path.join(projectRoot, 'ios');
    if (fs.existsSync(path.join(ios, 'node_modules/react-native'))) return undefined;
    const podfile = read(path.join(ios, 'Podfile'));
    const nativeFiles = ['.xcode.env', '.xcode.env.local', 'Podfile.properties.json']
      .map(name => path.join(ios, name));
    for (const name of fs.readdirSync(checked(ios))) {
      if (name.endsWith('.xcodeproj')) nativeFiles.push(path.join(ios, name, 'project.pbxproj'));
      if (name.endsWith('.xcconfig')) nativeFiles.push(path.join(ios, name));
    }
    const nativeContents = nativeFiles.filter(file => fs.existsSync(file)).map(file => {
      const contents = read(file);
      return file.endsWith('project.pbxproj') ? withoutUnusedTemplateFramework(contents) : contents;
    });
    if ([podfile, ...nativeContents].some(text => engineMention.test(text))) return undefined;
    // The stock template already references CocoaPods' generated debug/release
    // configs before pods are installed. Other referenced configs are custom.
    for (const text of nativeContents) {
      for (const line of text.split('\n').filter(line => line.includes('baseConfigurationReference'))) {
        if (!/\/\* Pods-[\w-]+\.(?:debug|release)\.xcconfig \*\//.test(line)) return undefined;
      }
    }

    const ruby = compactRuby(podfile);
    const calls = [...ruby.matchAll(/\buse_react_native!\s*\(([^()]*)\)/g)];
    if (!ruby.includes(standardLoader) || calls.length !== 1 ||
        [...ruby.matchAll(/\buse_react_native!/g)].length !== 1 ||
        compactRuby(calls[0][1]) !== standardArguments ||
        !/\bconfig = use_native_modules! use_react_native!/.test(ruby) ||
        [...ruby.matchAll(/\bconfig\s*=/g)].length !== 1 ||
        /\bconfig\s*(?:\[[^\]]*\]\s*=|\.)/.test(ruby) ||
        /\b(?:def|eval|load|require_relative)\b/.test(ruby) ||
        [...ruby.matchAll(/\brequire\b(?!\.)/g)].length !== 1) return undefined;

    // Search only the consumer's node_modules ancestry: never NODE_PATH or the
    // CLI's own React Native dependency. Hoisted and symlinked installs work too.
    let directory = path.resolve(projectRoot);
    let manifest: string | undefined;
    while (true) {
      const candidate = path.join(directory, 'node_modules/react-native/package.json');
      if (fs.existsSync(candidate)) {
        manifest = checked(candidate);
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory || (boundary && fs.realpathSync(directory) === boundary)) break;
      directory = parent;
    }
    if (!manifest) return undefined;
    const rn = JSON.parse(read(manifest));
    if (rn.name !== 'react-native' || typeof rn.version !== 'string' || !/^0\.81\.\d+$/.test(rn.version)) return undefined;

    const root = path.dirname(manifest);
    for (const [file, expectedHash] of Object.entries(helperHashes)) {
      const source = read(path.join(root, file)).replace(/\r\n/g, '\n');
      if (createHash('sha256').update(source).digest('hex') !== expectedHash) return undefined;
    }
    return true;
  } catch {
    // Missing, unreadable, or unfamiliar inputs provide no evidence of a default.
    return undefined;
  }
}
