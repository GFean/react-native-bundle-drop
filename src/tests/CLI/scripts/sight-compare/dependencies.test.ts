import fs from 'fs';
import os from 'os';
import path from 'path';
import { inspectDependencyPlan, installDependencies } from '../../../../CLI/scripts/sight-compare/dependencies';
import { runComparisonProcess } from '../../../../CLI/scripts/sight-compare/process';

jest.mock('../../../../CLI/scripts/sight-compare/process', () => ({ runComparisonProcess: jest.fn() }));
const run = jest.mocked(runComparisonProcess);

describe('comparison dependency isolation', () => {
  let root: string;
  let outputs: Record<string, string>;
  const write = (file: string, value: unknown = {}) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const inspect = (projectRelativePath = '.') => inspectDependencyPlan({ snapshotRoot: root, projectRelativePath });
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sight-dependencies-')));
    outputs = { '--version': '10.9.0' };
    write('package.json', { name: 'app', packageManager: 'npm@10.9.0' });
    write('package-lock.json');
    run.mockImplementation(async ({ args }) => ({ stdout: outputs[args.join(' ')] ?? '', stderr: '', exitCode: 0 }));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('plans npm ci from its own lockfile and retains configuration as immutable inputs', async () => {
    write('.npmrc', 'ignore-scripts=true');
    const plan = await inspect();
    expect(plan.installArgs).toEqual(['ci', '--include=dev', '--no-audit', '--no-fund']);
    expect(plan.inputFiles).toEqual(expect.arrayContaining([path.join(root, '.npmrc'), path.join(root, 'package.json')]));
    await installDependencies(plan);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: root, env: expect.objectContaining({ NODE_ENV: 'development', PATH: process.env.PATH }) }));
  });

  it('uses npm shrinkwrap and permits a uniquely inferred manager', async () => {
    write('package.json');
    write('npm-shrinkwrap.json');
    const plan = await inspect();
    expect(plan.packageManager).toEqual({ name: 'npm', version: '10.9.0' });
    expect(plan.inputFiles[0]).toBe(path.join(root, 'npm-shrinkwrap.json'));
    await installDependencies(plan, { env: { PATH: '/chosen/bin', NODE_ENV: 'production' } });
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ env: { PATH: '/chosen/bin', NODE_ENV: 'development', COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_ENABLE_NETWORK: '0' } }));
  });

  it.each([
    ['missing lock', () => fs.unlinkSync(path.join(root, 'package-lock.json')), 'exactly one'],
    ['conflicting locks', () => write('yarn.lock'), 'exactly one'],
    ['unsupported manager', () => { fs.unlinkSync(path.join(root, 'package-lock.json')); write('bun.lock'); }, 'Bun'],
    ['range declaration', () => write('package.json', { packageManager: 'npm@^10.0.0' }), 'exact supported'],
    ['conflicting declaration', () => write('package.json', { packageManager: 'pnpm@10.9.0' }), 'matching the lockfile'],
    ['wrong version', () => { outputs['--version'] = '10.8.0'; }, 'does not match'],
    ['invalid version', () => { outputs['--version'] = 'something else'; }, 'does not match'],
    ['unversioned invalid manager', () => { write('package.json'); outputs['--version'] = ''; }, 'supported version'],
  ])('rejects %s before installing', async (_name, prepare, message) => {
    prepare();
    await expect(inspect()).rejects.toThrow(message);
    expect(run.mock.calls.some(([options]) => options.args.includes('ci') || options.args.includes('install'))).toBe(false);
  });

  it('accepts an exact prerelease manager with integrity metadata', async () => {
    write('package.json', { packageManager: 'npm@10.9.0-rc.1+sha512.abcd' });
    outputs['--version'] = '10.9.0-rc.1';
    expect((await inspect()).packageManager.version).toBe('10.9.0-rc.1');
  });

  const yarn = (modern: boolean) => {
    fs.unlinkSync(path.join(root, 'package-lock.json'));
    write('yarn.lock');
    write('package.json', { name: 'app', packageManager: `yarn@${modern ? '3.8.3' : '1.22.22'}` });
    outputs['--version'] = modern ? '3.8.3' : '1.22.22';
    outputs['config get nodeLinker --json'] = '"node-modules"';
    outputs['config get yarnPath --json'] = 'null';
    outputs['config get installStatePath --json'] = '".yarn/install-state.gz"';
    outputs['config get yarn-path --json'] = '{"type":"inspect","data":"undefined"}';
  };

  it.each([true, false])('preserves Yarn %s configuration and installs with its frozen command', async modern => {
    yarn(modern);
    const plan = await inspect();
    expect(plan.installArgs).toEqual(modern ? ['install', '--immutable'] : ['install', '--frozen-lockfile', '--production=false', '--non-interactive']);
  });

  it.each([true, false])('records a repository-local yarnPath for Yarn modern=%s', async modern => {
    yarn(modern);
    write('.yarn/release.cjs', '// pinned Yarn');
    outputs[modern ? 'config get yarnPath --json' : 'config get yarn-path --json'] = modern
      ? '".yarn/release.cjs"' : '{"type":"inspect","data":".yarn/release.cjs"}';
    expect((await inspect()).inputFiles).toContain(path.join(root, '.yarn/release.cjs'));
  });

  it.each(['installConfig', '.pnp.cjs', '.pnp.js', 'linker'])('rejects Yarn PnP signal %s', async signal => {
    yarn(true);
    if (signal === 'installConfig') write('package.json', { installConfig: { pnp: true } });
    else if (signal === 'linker') outputs['config get nodeLinker --json'] = '"pnp"';
    else write(signal);
    await expect(inspect()).rejects.toThrow(/Plug’n’Play|nodeLinker/);
  });

  it('rejects a Yarn install state written outside the snapshot', async () => {
    yarn(true);
    outputs['config get installStatePath --json'] = JSON.stringify(path.join(root, '..', 'state.gz'));
    await expect(inspect()).rejects.toThrow('inside the repository snapshot');
  });

  const pnpm = () => {
    fs.unlinkSync(path.join(root, 'package-lock.json'));
    write('pnpm-lock.yaml', 'lockfileVersion: 9.0');
    write('package.json', { name: 'app', packageManager: 'pnpm@10.9.0' });
    for (const setting of ['node-linker', 'virtual-store-dir', 'modules-dir', 'lockfile-dir']) outputs[`config get ${setting}`] = 'undefined';
  };
  it('uses pnpm frozen install with development dependencies and confined configured directories', async () => {
    pnpm();
    outputs['config get node-linker'] = 'isolated';
    outputs['config get modules-dir'] = 'dependencies';
    expect((await inspect()).installArgs).toEqual(['install', '--frozen-lockfile', '--prod=false']);
  });
  it('rejects pnpm PnP', async () => {
    pnpm();
    outputs['config get node-linker'] = 'pnp';
    await expect(inspect()).rejects.toThrow('Plug’n’Play');
  });
  it('rejects pnpm external virtual stores', async () => {
    pnpm();
    outputs['config get virtual-store-dir'] = '../store';
    await expect(inspect()).rejects.toThrow('inside the repository snapshot');
  });

  it.each(['npm', 'yarn1', 'yarn3', 'pnpm'])('uses native %s workspace discovery and installs at the workspace root', async manager => {
    if (manager.startsWith('yarn')) yarn(manager === 'yarn3');
    if (manager === 'pnpm') pnpm();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    write('package.json', { ...manifest, workspaces: ['apps/*', 'packages/*'] });
    write('apps/mobile/package.json', { name: 'mobile', dependencies: { shared: 'file:../../packages/shared' } });
    write('packages/shared/package.json', { name: 'shared' });
    outputs['pkg get name --workspaces --json'] = JSON.stringify({ mobile: 'mobile', shared: 'shared' });
    write('package-lock.json', { packages: { '': {}, 'apps/mobile': {}, 'packages/shared': {}, 'node_modules/other': {} } });
    if (manager !== 'npm') fs.unlinkSync(path.join(root, 'package-lock.json'));
    outputs['--silent workspaces info --json'] = JSON.stringify({ type: 'log', data: JSON.stringify({ mobile: { location: 'apps/mobile' }, shared: { location: 'packages/shared' } }) });
    outputs['workspaces list --json'] = [JSON.stringify({ location: '.' }), JSON.stringify({ location: 'apps/mobile' }), JSON.stringify({ location: 'packages/shared' })].join('\n');
    outputs['list --recursive --depth -1 --json'] = JSON.stringify([{ path: root }, { path: path.join(root, 'apps/mobile') }, { path: path.join(root, 'packages/shared') }]);
    const plan = await inspect('apps/mobile');
    expect(plan.installRoot).toBe(root);
    expect(plan.projectRoot).toBe(path.join(root, 'apps/mobile'));
    expect(plan.inputFiles).toContain(path.join(root, 'packages/shared/package.json'));
  });

  it('delegates pnpm YAML workspace parsing to pnpm without parsing YAML itself', async () => {
    pnpm();
    write('pnpm-workspace.yaml', 'packages: ["apps/*"]');
    write('apps/mobile/package.json', { name: 'mobile' });
    outputs['list --recursive --depth -1 --json'] = JSON.stringify([{ path: path.join(root, 'apps/mobile') }]);
    expect((await inspect('apps/mobile')).installRoot).toBe(root);
  });

  it.each([
    ['nested roots', () => write('apps/mobile/package.json', { workspaces: [] }), 'Nested workspace'],
    ['nested lock', () => write('apps/mobile/package-lock.json'), 'own lockfile'],
    ['manager mismatch', () => write('apps/mobile/package.json', { packageManager: 'npm@9.0.0' }), 'different package-manager'],
    ['old npm lock', () => write('package-lock.json', { lockfileVersion: 1 }), 'v2 or newer'],
    ['unlocked workspace', () => { outputs['pkg get name --workspaces --json'] = '{"other":"other"}'; }, 'declarations and the npm lockfile disagree'],
    ['nonmember app', () => write('package-lock.json', { packages: {} }), 'not a member'],
  ])('rejects ambiguous workspaces: %s', async (_label, prepare, message) => {
    write('package.json', { workspaces: ['apps/*'] });
    write('apps/mobile/package.json');
    write('package-lock.json', { packages: { 'apps/mobile': {} } });
    outputs['pkg get name --workspaces --json'] = '{}';
    prepare();
    await expect(inspect('apps/mobile')).rejects.toThrow(message);
  });

  it('supports classic workspace JSON without log envelopes', async () => {
    yarn(false);
    write('package.json', { workspaces: ['apps/*'] });
    write('apps/mobile/package.json');
    outputs['--silent workspaces info --json'] = JSON.stringify({ mobile: { location: 'apps/mobile' } }, null, 2);
    outputs['config get yarn-path --json'] = '{"type":"inspect","data":null}';
    expect((await inspect('apps/mobile')).projectRoot).toBe(path.join(root, 'apps/mobile'));
  });

  it('accepts Yarn Classic JSON event streams', async () => {
    yarn(false);
    outputs['config get yarn-path --json'] = '{"type":"info","data":"configuration"}\n{"type":"log","data":"undefined"}\n';
    await expect(inspect()).resolves.toHaveProperty('packageManager.name', 'yarn');
  });

  it.each(['file:../outside', 'link:../outside', 'portal:../outside', 'workspace:../outside', '../outside', 'file:%2e%2e/outside', '/outside'])('rejects escaped local dependencies: %s', async specifier => {
    write('package.json', { dependencies: { local: specifier } });
    await expect(inspect()).rejects.toThrow('inside the repository snapshot');
  });
  it('rejects home-directory dependencies', async () => {
    write('package.json', { peerDependencies: { local: 'file:~/other' } });
    await expect(inspect()).rejects.toThrow('outside the repository snapshot');
  });
  it('validates nested dependency overrides and accepts repository-local files', async () => {
    write('package.json', { dependencies: { local: './local', other: '^1.0.0' }, overrides: { x: { y: 'file:local' } }, pnpm: { setting: true }, resolutions: null });
    write('local/package.json');
    await expect(inspect()).resolves.toHaveProperty('installRoot', root);
  });
  it('rejects symlinked configuration and local dependencies outside the snapshot', async () => {
    fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
    write('package.json', { dependencies: { local: 'file:outside' } });
    await expect(inspect()).rejects.toThrow('inside the repository snapshot');
  });
  it.each(['npm', 'yarn1', 'yarn3', 'pnpm'])('tracks transitive local package manifests with %s and handles cycles', async manager => {
    if (manager.startsWith('yarn')) yarn(manager === 'yarn3');
    if (manager === 'pnpm') pnpm();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    write('package.json', { ...manifest, dependencies: { local: 'file:packages/local' } });
    write('packages/local/package.json', { dependencies: { nested: 'file:../nested' } });
    write('packages/nested/package.json', { dependencies: { local: 'link:../local' } });
    const plan = await inspect();
    expect(plan.inputFiles).toEqual(expect.arrayContaining([
      path.join(root, 'packages/local/package.json'), path.join(root, 'packages/nested/package.json'),
    ]));
    expect(plan.inputFiles.filter(file => file.endsWith('/packages/local/package.json'))).toHaveLength(1);
    run.mockImplementationOnce(async () => {
      write('packages/nested/package.json', { changed: true });
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await expect(installDependencies(plan)).rejects.toThrow('modified a comparison input');
  });
  it('rejects external references in transitive local manifests', async () => {
    write('package.json', { dependencies: { local: 'file:packages/local' } });
    write('packages/local/package.json', { dependencies: { outside: 'file:../../../outside' } });
    await expect(inspect()).rejects.toThrow('inside the repository snapshot');
  });
  it('rejects local Git dependencies before installing', async () => {
    write('package.json', { dependencies: { local: `git+file://${root}/vendor/repo` } });
    await expect(inspect()).rejects.toThrow('Local Git dependencies are not supported');
  });
  it.each([
    { packages: { '../outside': {} } },
    { packages: { 'node_modules/local': { link: true, resolved: '../outside' } } },
    { packages: { 'node_modules/local': { resolved: 'file:../outside.tgz' } } },
    { dependencies: { parent: { resolved: 'https://registry.example/parent.tgz', dependencies: { local: { version: 'file:../outside' } } } } },
    { dependencies: { local: { resolved: 'file:../outside' } } },
  ])('rejects external local npm lock inputs: %j', async lock => {
    write('package-lock.json', lock);
    await expect(inspect()).rejects.toThrow('inside the repository snapshot');
  });
  it('retains repository-local vendor tarballs and locked local package inputs', async () => {
    write('vendor/sdk.tgz', 'fixture archive');
    write('vendor/local/package.json');
    write('package-lock.json', { packages: {
      '': {},
      'node_modules/sdk': { resolved: 'file:vendor/sdk.tgz' },
      'node_modules/local': { link: true, resolved: 'vendor/local' },
      'node_modules/registry': { resolved: 'https://registry.example/registry.tgz' },
    } });
    expect((await inspect()).inputFiles).toContain(path.join(root, 'vendor/local/package.json'));
  });
  it('rejects a real npm lock with an external transitive prepare script before it can run', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-outside-dependency-'));
    const marker = path.join(outside, 'prepare-ran');
    const actualRun = jest.requireActual<typeof import('../../../../CLI/scripts/sight-compare/process')>('../../../../CLI/scripts/sight-compare/process').runComparisonProcess;
    try {
      write('package.json', { name: 'app', version: '1.0.0', dependencies: { local: 'file:packages/local' } });
      write('packages/local/package.json', { name: 'local', version: '1.0.0', dependencies: { outside: `file:${outside}` } });
      fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'outside', version: '1.0.0', scripts: {
        prepare: `node -e "require('fs').writeFileSync('prepare-ran', 'yes')"`,
      } }));
      await actualRun({ command: 'npm', args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: root, phase: 'Create local dependency fixture lock' });
      run.mockImplementation(actualRun);
      await expect(inspect()).rejects.toThrow('inside the repository snapshot');
      expect(fs.existsSync(marker)).toBe(false);
      expect(run.mock.calls.some(([options]) => options.args.includes('ci'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('rejects a project outside its snapshot', async () => {
    await expect(inspect('../outside')).rejects.toThrow('inside the repository snapshot');
  });

  it.each(['changed', 'deleted'])('rejects %s install inputs and propagates installation errors', async change => {
    const plan = await inspect();
    run.mockImplementationOnce(async () => {
      if (change === 'changed') write('package-lock.json', { changed: true });
      else fs.unlinkSync(path.join(root, 'package-lock.json'));
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await expect(installDependencies(plan)).rejects.toThrow('modified a comparison input');
  });
  it('propagates install failure without retrying a mutable install', async () => {
    const plan = await inspect();
    run.mockRejectedValueOnce(new Error('locked dependency mismatch'));
    await expect(installDependencies(plan)).rejects.toThrow('locked dependency mismatch');
  });

  it('validates declared Node ranges with a dependency-free offline npm dry-run and removes the probe', async () => {
    write('package.json', { engines: { node: '>=20 || ^18.19.0' }, scripts: { prepare: 'should never execute' }, dependencies: { example: '^1.0.0' } });
    let probeRoot = '';
    run.mockImplementation(async options => {
      if (options.args.includes('--dry-run')) {
        probeRoot = options.cwd;
        expect(JSON.parse(fs.readFileSync(path.join(probeRoot, 'package.json'), 'utf8'))).toEqual({ name: 'bundle-drop-sight-engine-check', version: '1.0.0', private: true, engines: { node: '>=20 || ^18.19.0' } });
        expect(options.command).toBe('npm');
        expect(options.args).toEqual(expect.arrayContaining(['--offline', '--engine-strict', '--force=false', '--ignore-scripts', '--package-lock=false']));
      }
      return { stdout: outputs[options.args.join(' ')] ?? '', stderr: '', exitCode: 0 };
    });
    await inspect();
    expect(probeRoot).not.toBe('');
    expect(fs.existsSync(probeRoot)).toBe(false);
  });

  it('rejects invalid engine field types without installing', async () => {
    write('package.json', { engines: { node: 22 } });
    await expect(inspect()).rejects.toThrow('version-range string');
  });

  it.each(['compatible', 'incompatible'])('uses real npm engine checking for a %s Node range', async compatibility => {
    write('package.json', { engines: { node: compatibility === 'compatible' ? `>=${process.versions.node.split('.')[0]}.0.0 <99` : '>=99' } });
    const actualRun = jest.requireActual<typeof import('../../../../CLI/scripts/sight-compare/process')>('../../../../CLI/scripts/sight-compare/process').runComparisonProcess;
    let probeRoot = '';
    run.mockImplementation(async options => {
      if (options.args.includes('--dry-run')) {
        probeRoot = options.cwd;
        return actualRun(options);
      }
      return { stdout: outputs[options.args.join(' ')] ?? '', stderr: '', exitCode: 0 };
    });
    if (compatibility === 'compatible') await expect(inspect()).resolves.toHaveProperty('installRoot', root);
    else await expect(inspect()).rejects.toThrow(/EBADENGINE|Unsupported engine/);
    expect(fs.existsSync(probeRoot)).toBe(false);
  });
});
