import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dependencySources, loadDependencyLock } from '../../fingerprintV2/dependencies';

const moduleName = '@controls/native';
const installedVersion = '1.2.3';
const firstTarball = 'https://one.example/native,ios.tgz';
const secondTarball = 'https://two.example/native,ios.tgz';
const attestedTarball = (tarball: string, digit: string) => `${tarball}#${digit.repeat(40)}`;

describe('Scheme 2 Yarn native dependency resolution', () => {
  let root: string;
  const consumer = 'apps/consumer';

  function write(relative: string, source: string | object): void {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof source === 'string' ? source : JSON.stringify(source));
  }

  function appDependencies(dependencies: Record<string, string>): void {
    write(`${consumer}/package.json`, { name: 'consumer', dependencies });
  }

  function install(relative: string, name = moduleName): void {
    write(`${relative}/package.json`, { name, version: installedVersion });
    write(`${relative}/ios/Control.m`, 'int control(void) { return 1; }\n');
  }

  function sources(directory = `node_modules/${moduleName}`) {
    const app = path.join(root, consumer);
    const packageJson = path.relative(app, path.join(root, directory, 'package.json'));
    return dependencySources(app, loadDependencyLock(app), { name: moduleName, packageJson }, ['fixture'], () => false);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-yarn-resolution-'));
    write('package.json', { name: 'workspace-root', private: true, workspaces: ['apps/*'] });
    appDependencies({});
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('uses only the selected Classic descriptor in a grouped lockfile and reads aliases by their install name', () => {
    const alias = '@company/device-controls';
    const directory = `node_modules/${alias}`;
    const lock = (unrelatedHash: string) => write('yarn.lock', [
      '# yarn lockfile v1',
      '',
      `"${alias}@${firstTarball}", "${alias}@https://alias.example/mirror.tgz":`,
      '  version "1.2.3"',
      `  resolved "${attestedTarball(firstTarball, 'a')}"`,
      '',
      `"${alias}@${secondTarball}":`,
      '  version "2.0.0"',
      `  resolved "${attestedTarball(secondTarball, unrelatedHash)}"`,
      '',
    ].join('\r\n'));
    lock('b');
    install(directory);
    appDependencies({ [alias]: firstTarball });
    write('apps/other/package.json', { name: 'other', dependencies: { [alias]: secondTarball } });
    const first = sources(directory);
    expect(first).toHaveLength(1);
    lock('c');
    write(`${directory}/ios/Control.m`, 'install-time rewrite of an immutable package');
    expect(sources(directory)).toEqual(first);

    const lockFile = path.join(root, 'yarn.lock');
    fs.writeFileSync(lockFile, fs.readFileSync(lockFile, 'utf8').replace('#' + 'a'.repeat(40), '#' + 'd'.repeat(40)));
    expect(sources(directory)).not.toEqual(first);
  });

  it('matches Classic npm alias selectors and root resolution overrides recorded in the lock', () => {
    const alias = '@company/device-controls';
    const directory = `node_modules/${alias}`;
    const range = `npm:${moduleName}@^1.0.0`;
    install(directory);
    appDependencies({ [alias]: range });
    const lock = (selected: string) => write('yarn.lock', `
"${alias}@${range}", "${alias}@npm:${moduleName}@1.2.3":
  version "1.2.3"
  resolved "${attestedTarball(selected, 'a')}"

"${moduleName}@^1.0.0":
  version "1.2.3"
  resolved "${attestedTarball(secondTarball, 'b')}"
`);
    write('package.json', {
      name: 'workspace-root', private: true, workspaces: ['apps/*'],
      resolutions: { ['**/' + alias]: `npm:${moduleName}@1.2.3` },
    });
    lock(firstTarball);
    const first = sources(directory);
    expect(first).toHaveLength(1);
    lock('https://third.example/native.tgz');
    expect(sources(directory)).not.toEqual(first);
  });

  it.each(['hoisted', 'nested'])('resolves the owning Classic declaration for a %s transitive install', layout => {
    const wrapper = 'node_modules/wrapper';
    const directory = layout === 'hoisted' ? `node_modules/${moduleName}` : `${wrapper}/node_modules/${moduleName}`;
    const lock = (selected: string, unrelatedHash: string) => write('yarn.lock', `
"${moduleName}@${selected}":
  version "1.2.3"
  resolved "${attestedTarball(selected, 'a')}"

"${moduleName}@^2.0.0":
  version "2.0.0"
  resolved "${attestedTarball('https://two.example/native-v2.tgz', unrelatedHash)}"
`);
    const wrapperDependencies = (resolution: string) => write(`${wrapper}/package.json`, {
      name: 'wrapper', version: '2.0.0', dependencies: { [moduleName]: resolution },
    });
    lock(firstTarball, 'b');
    appDependencies({ wrapper: '^2.0.0' });
    wrapperDependencies(firstTarball);
    install(directory);
    const first = sources(directory);
    expect(first).toHaveLength(1);
    lock(firstTarball, 'c');
    expect(sources(directory)).toEqual(first);
    wrapperDependencies(secondTarball);
    lock(secondTarball, 'c');
    expect(sources(directory)).not.toEqual(first);
  });

  it('uses the physical Berry locator across aliases and virtual peer contexts', () => {
    const alias = '@company/device-controls';
    const directory = `node_modules/${alias}`;
    const selector = `${alias}@npm:${moduleName}@^1.0.0`;
    const locator = `${moduleName}@${secondTarball}`;
    const lock = (checksum: string) => write('yarn.lock', `
__metadata:
  version: 8

"${selector}, ${alias}@npm:${moduleName}@~1.0.0":
  version: 1.2.3
  resolution: "${moduleName}@npm:1.2.3"
  checksum: 10c0/other

"${moduleName}@${secondTarball}":
  version: 1.2.3
  resolution: "${locator}"
  checksum: ${checksum}
`);
    const state = (peerHash: string) => write('node_modules/.yarn-state.yml', `
__metadata:
  version: 1

"${moduleName}@virtual:${peerHash}#${secondTarball}":
  locations:
    - "${directory}"
`);
    install(directory);
    appDependencies({ [alias]: `npm:${moduleName}@^1.0.0` });
    lock('10c0/first');
    state('first');
    const first = sources(directory);
    expect(first).toHaveLength(1);
    state('second');
    expect(sources(directory)).toEqual(first);
    lock('10c0/second');
    expect(sources(directory)).not.toEqual(first);

    fs.rmSync(path.join(root, 'node_modules/.yarn-state.yml'));
    const byDescriptor = sources(directory);
    expect(byDescriptor).toHaveLength(1);
    lock('10c0/third');
    expect(sources(directory)).toEqual(byDescriptor);
  });

  it('hashes the installed source when conflicting hoisted requests cannot prove a locator', () => {
    const directory = `node_modules/${moduleName}`;
    const lock = (unrelatedHash: string) => write('yarn.lock', `
"${moduleName}@${firstTarball}":
  version "1.2.3"
  resolved "${attestedTarball(firstTarball, 'a')}"

"${moduleName}@${secondTarball}":
  version "1.2.3"
  resolved "${attestedTarball(secondTarball, unrelatedHash)}"
`);
    lock('b');
    appDependencies({ one: '1.0.0', two: '1.0.0' });
    write('node_modules/one/package.json', { dependencies: { [moduleName]: firstTarball } });
    write('node_modules/two/package.json', { dependencies: { [moduleName]: secondTarball } });
    install(directory);
    write(`${directory}/.gitignore`, 'ios/\n');
    const first = sources();
    expect(first.map(source => source.id)).toContain(`dependency:${moduleName}/ios/Control.m`);
    lock('c');
    expect(sources()).toEqual(first);
    write('node_modules/two/package.json', { dependencies: { [moduleName]: 'unsupported-locator' } });
    expect(sources()).toEqual(first);
    write(`${directory}/ios/Control.m`, 'int control(void) { return 2; }\n');
    expect(sources()).not.toEqual(first);
  });

  it('preserves the stale installed identity after Classic swaps same-version workspace requests', () => {
    const directory = `node_modules/${moduleName}`;
    write('yarn.lock', `
"${moduleName}@${firstTarball}":
  version "1.2.3"
  resolved "${attestedTarball(firstTarball, 'a')}"

"${moduleName}@${secondTarball}":
  version "1.2.3"
  resolved "${attestedTarball(secondTarball, 'b')}"
`);
    appDependencies({ [moduleName]: firstTarball });
    write('apps/other/package.json', { name: 'other', dependencies: { [moduleName]: secondTarball } });
    install(directory);
    const initial = sources();
    expect(initial.map(source => source.id)).toContain(`dependency:${moduleName}/ios/Control.m`);

    appDependencies({ [moduleName]: secondTarball });
    write('apps/other/package.json', { name: 'other', dependencies: { [moduleName]: firstTarball } });
    expect(sources()).toEqual(initial);

    write(`${directory}/ios/Control.m`, 'int control(void) { return 2; }\n');
    expect(sources()).not.toEqual(initial);
  });

  it('keeps native files when Berry state claims two locators for the same installation', () => {
    const directory = `node_modules/${moduleName}`;
    install(directory);
    appDependencies({ [moduleName]: '^1.0.0' });
    write('yarn.lock', `
__metadata:
  version: 8

"${moduleName}@npm:^1.0.0":
  version: 1.2.3
  resolution: "${moduleName}@npm:1.2.3"
  checksum: 10c0/one
`);
    write('node_modules/.yarn-state.yml', `
__metadata:
  version: 1

"consumer@workspace:apps/consumer":
  locations:
    - "apps/consumer"

"${moduleName}@npm:1.2.3":
  locations:
    - "${directory}"

"${moduleName}@${secondTarball}":
  locations:
    - "${directory}"
`);
    const baseline = sources();
    expect(baseline.map(source => source.id)).toContain(`dependency:${moduleName}/ios/Control.m`);
    write(`${directory}/ios/Control.m`, 'int control(void) { return 2; }\n');
    expect(sources()).not.toEqual(baseline);
  });

  it('finds a reachable Classic request through cycles and optional or malformed declarations', () => {
    const directory = `node_modules/${moduleName}`;
    const unusualName = 'unrecognized package';
    appDependencies({ wrapper: '^2.0.0', 'unavailable-native-addon': '1.0.0' });
    write('node_modules/wrapper/package.json', {
      name: 'wrapper', version: '2.0.0',
      dependencies: {
        wrapper: '^2.0.0', [moduleName]: '1.2.3', 'disallowed/name': '1.0.0', fs: '1.0.0',
        [unusualName]: '1.0.0', 'invalid-selector': 12,
      },
    });
    write(`node_modules/${unusualName}/package.json`, {
      name: unusualName, version: '1.0.0', dependencies: { [moduleName]: '1.2.3' },
    });
    install(directory);
    write('yarn.lock', `
"${moduleName}@1.2.3":
  version "1.2.3"
  resolved "${attestedTarball(firstTarball, 'a')}"
`);
    expect(sources()).toHaveLength(1);
    // The malformed package name is never accepted as lock provenance,
    // even though it has a physical manifest inside the installation.
    expect(sources(`node_modules/${unusualName}`).map(source => source.id)).toContain(
      `dependency:${moduleName}/package.json`,
    );
  });

  it('uses a root-only Classic install when no workspace dependency reaches it', () => {
    install(`node_modules/${moduleName}`);
    write('package.json', {
      name: 'workspace-root', private: true, workspaces: ['apps/*'],
      devDependencies: { [moduleName]: '1.2.3' },
    });
    write('yarn.lock', `
"${moduleName}@1.2.3":
  version "1.2.3"
  integrity sha512-root
`);
    expect(sources()).toHaveLength(1);
  });

  it('uses the actual package files for unmatched, incomplete, or custom installation locations', () => {
    const directory = `node_modules/${moduleName}`;
    install(directory);
    appDependencies({ [moduleName]: '^1.0.0' });
    const fallback = `dependency:${moduleName}/ios/Control.m`;
    write('yarn.lock', `
"${moduleName}@~1.0.0":
  version "1.2.3"
  resolved "${attestedTarball(firstTarball, 'a')}"
`);
    expect(sources().map(source => source.id)).toContain(fallback);

    write('yarn.lock', `
"${moduleName}@^1.0.0":
  version "1.2.3"
`);
    expect(sources().map(source => source.id)).toContain(fallback);

    const customInstallation = 'node_modules/.cache/linked-plugin';
    install(customInstallation);
    expect(sources(customInstallation).map(source => source.id)).toContain(fallback);
  });
});
