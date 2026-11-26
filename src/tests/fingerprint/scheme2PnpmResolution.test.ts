import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dependencySources, loadDependencyLock } from '../../fingerprintV2/dependencies';

const name = 'native-controls';
const version = '1.2.3';
const first = `  ${name}@https://example.test/first.tgz:\n    version: ${version}\n    resolution: {integrity: sha512-first, tarball: https://example.test/first.tgz}\n`;
const second = first.replace(/first/g, 'second');
const firstKey = `${name}@https://example.test/first.tgz`;
const secondKey = `${name}@https://example.test/second.tgz`;
const firstLocator = `${name}@https+++example.test+first.tgz`;
const secondLocator = `${name}@https+++example.test+second.tgz`;

describe('Scheme 2 pnpm installed provenance', () => {
  let project: string;
  const write = (relative: string, content: string) => {
    const file = path.join(project, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const writeLock = (relative: string, packages: string, snapshots: string[] = []) => {
    write(relative, `lockfileVersion: '9.0'\npackages:\n${packages}${snapshots.length
      ? `snapshots:\n${snapshots.map(key => `  ${key}: {}\n`).join('')}` : ''}`);
  };
  const putPackage = (directory: string, nativeSource = 'embedded') => {
    write(`${directory}/package.json`, JSON.stringify({ name, version }));
    write(`${directory}/android/Native.kt`, nativeSource);
    return `${directory}/package.json`;
  };
  const collect = (packageJson: string) =>
    dependencySources(project, loadDependencyLock(project), { name, packageJson }, ['fixture'], () => false);

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-pnpm-resolution-'));
    write('package.json', JSON.stringify({ name: 'app', packageManager: 'pnpm@10.0.0' }));
  });

  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it('matches the installed locator and keeps the fingerprint stable when another importer adds a pin', () => {
    const firstInstall = putPackage(`node_modules/.pnpm/${firstLocator}/node_modules/${name}`);
    const secondInstall = putPackage(`node_modules/.pnpm/${secondLocator}/node_modules/${name}`);
    writeLock('pnpm-lock.yaml', first);
    const original = collect(firstInstall);
    writeLock('pnpm-lock.yaml', first + second, [firstKey, secondKey]);

    expect(collect(firstInstall)).toEqual(original);
    expect(collect(secondInstall)).not.toEqual(original);
    expect(collect(secondInstall)).toHaveLength(1);
  });

  it('uses the current install lock rather than the wanted lock for a stale tarball pin', () => {
    const installed = putPackage(`node_modules/.pnpm/${firstLocator}/node_modules/${name}`);
    writeLock('pnpm-lock.yaml', first);
    const original = collect(installed);
    writeLock('node_modules/.pnpm/lock.yaml', first, [firstKey]);
    writeLock('pnpm-lock.yaml', first.replace('sha512-first', 'sha512-new'), [firstKey]);

    expect(collect(installed)).toEqual(original);
  });

  it.each([
    ['10.11.0', 'node_modules/custom-store', 'node_modules/.pnpm'],
    ['10.12.1', 'node_modules/.pnpm', 'node_modules/custom-store'],
  ])('uses the current lock directory for pnpm %s', (installer, currentState, obsoleteState) => {
    const installed = putPackage(`node_modules/custom-store/${firstLocator}/node_modules/${name}`);
    writeLock('pnpm-lock.yaml', first);
    const original = collect(installed);
    const updated = first.replace('sha512-first', 'sha512-new');
    write('node_modules/.modules.yaml', JSON.stringify({ packageManager: `pnpm@${installer}`, virtualStoreDir: 'custom-store' }));
    writeLock('pnpm-lock.yaml', updated);
    writeLock(`${currentState}/lock.yaml`, first, [firstKey]);
    writeLock(`${obsoleteState}/lock.yaml`, updated, [firstKey]);

    expect(collect(installed)).toEqual(original);
  });

  it('matches shortened peer and patch snapshot locators in a configured virtual store', () => {
    const snapshot = `${firstKey}(patch_hash=abcd)(very-long-peer@123.45.67)`;
    const flattened = `${firstLocator}_patch_hash=abcd_very-long-peer@123.45.67`;
    const shortened = `${flattened.slice(0, 17)}_${createHash('sha256').update(flattened).digest('hex').slice(0, 32)}`;
    const store = 'node_modules/custom-store';
    const installed = putPackage(`${store}/${shortened}/node_modules/${name}`);
    writeLock('pnpm-lock.yaml', first);
    const original = collect(installed);
    write('node_modules/.modules.yaml', JSON.stringify({ virtualStoreDir: 'custom-store', virtualStoreDirMaxLength: '50' }));
    writeLock('pnpm-lock.yaml', first + second, [snapshot, secondKey]);

    expect(collect(installed)).toEqual(original);
  });

  it('matches a pnpm 9 lowercase base32 directory suffix', () => {
    const snapshot = `${firstKey}(long-peer@123.45.67)`;
    const locator = 'native-contro_vkmr2wqv42dmayta7wyky4iohm';
    const installed = putPackage(`node_modules/.pnpm/${locator}/node_modules/${name}`);
    writeLock('pnpm-lock.yaml', first);
    const original = collect(installed);
    write('node_modules/.modules.yaml', "virtualStoreDir: .pnpm\nvirtualStoreDirMaxLength: '40'\n");
    writeLock('pnpm-lock.yaml', first + second, [snapshot, secondKey]);

    expect(collect(installed)).toEqual(original);
  });

  it('hashes installed native bytes when an ambiguous hoisted install has no locator', () => {
    const installed = putPackage(`node_modules/${name}`);
    writeLock('pnpm-lock.yaml', first + second);
    const original = collect(installed);
    expect(original).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `dependency:${name}/android/Native.kt`, reasons: ['installedNativeDependency'] }),
    ]));
    writeLock('pnpm-lock.yaml', second + first);
    expect(collect(installed)).toEqual(original);
    putPackage(`node_modules/${name}`, 'different native bytes');
    expect(collect(installed)).not.toEqual(original);
  });

  it('hashes installed bytes when the escaped virtual store name matches multiple pins', () => {
    const firstPath = first.replace(/first\.tgz/g, 'split/first.tgz');
    const secondPath = second.replace(/second\.tgz/g, 'split+first.tgz');
    writeLock('pnpm-lock.yaml', firstPath + secondPath);
    const installed = putPackage(`node_modules/.pnpm/${name}@https+++example.test+split+first.tgz/node_modules/${name}`);

    expect(collect(installed)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `dependency:${name}/android/Native.kt` }),
    ]));
  });

  it('preserves ordinary v6 peer entries with the same underlying source', () => {
    const installed = putPackage(`node_modules/${name}`);
    write('pnpm-lock.yaml', `lockfileVersion: '6.0'
packages:
  /${name}@${version}(react@18.0.0):
    resolution: {integrity: sha512-same}
  /${name}@${version}(react@19.0.0):
    resolution: {integrity: sha512-same}
`);
    const sources = collect(installed);
    expect(sources).toHaveLength(1);
    putPackage(`node_modules/${name}`, 'generated output');
    expect(collect(installed)).toEqual(sources);
  });

  it('distinguishes v6 patch locators that share the same package integrity', () => {
    const firstInstall = putPackage(`node_modules/.pnpm/${name}@${version}_patch_hash=abcd/node_modules/${name}`);
    const secondInstall = putPackage(`node_modules/.pnpm/${name}@${version}_patch_hash=efgh/node_modules/${name}`);
    write('pnpm-lock.yaml', `lockfileVersion: '6.0'
packages:
  /${name}@${version}(patch_hash=abcd):
    resolution: {integrity: sha512-same}
  /${name}@${version}(patch_hash=efgh):
    resolution: {integrity: sha512-same}
`);

    expect(collect(firstInstall)).not.toEqual(collect(secondInstall));
    expect(collect(firstInstall)).toHaveLength(1);
  });
});
