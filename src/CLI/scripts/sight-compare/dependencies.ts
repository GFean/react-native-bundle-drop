import fs from 'fs';
import os from 'os';
import path from 'path';
import { runComparisonProcess } from './process';

export type ComparisonPackageManager = { name: 'npm' | 'yarn' | 'pnpm'; version: string };
export type DependencyPlan = {
  snapshotRoot: string;
  projectRoot: string;
  installRoot: string;
  packageManager: ComparisonPackageManager;
  installArgs: string[];
  inputFiles: string[];
};
export type DependencyProcessOptions = {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
};
type Manifest = {
  name?: string;
  packageManager?: string;
  workspaces?: unknown;
  installConfig?: { pnp?: boolean };
  engines?: { node?: unknown };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  resolutions?: Record<string, string>;
  overrides?: unknown;
  pnpm?: unknown;
};
const lockfiles = {
  npm: ['npm-shrinkwrap.json', 'package-lock.json'],
  yarn: ['yarn.lock'],
  pnpm: ['pnpm-lock.yaml'],
  bun: ['bun.lock', 'bun.lockb'],
};
const configFiles = ['.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml', '.pnpmfile.cjs'];

function packageManagerEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_ENABLE_NETWORK: '0' };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function confinedPath(root: string, target: string): string {
  const absolute = path.resolve(target);
  if (!inside(root, absolute) || (fs.existsSync(absolute) && !inside(root, fs.realpathSync(absolute)))) {
    throw new Error(`Comparison dependencies must stay inside the repository snapshot: ${target}`);
  }
  return absolute;
}

function readManifest(directory: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as Manifest;
}

function findInstallRoot(snapshotRoot: string, projectRoot: string): string {
  let directory = projectRoot;
  const workspaceRoots: string[] = [];
  while (true) {
    const manifestPath = path.join(directory, 'package.json');
    if ((fs.existsSync(manifestPath) && readManifest(directory).workspaces !== undefined) ||
        fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
      workspaceRoots.push(directory);
    }
    if (directory === snapshotRoot) break;
    directory = path.dirname(directory);
  }
  if (workspaceRoots.length > 1) {
    throw new Error('Nested workspace roots are not supported by Sight comparison.');
  }
  return workspaceRoots[0] || projectRoot;
}

function existingLocks(directory: string): string[] {
  return Object.values(lockfiles).flat().filter(file => fs.existsSync(path.join(directory, file)));
}

function validateLocalReferences(value: unknown, directory: string, snapshotRoot: string, localPackages: Set<string>): void {
  if (typeof value === 'string') {
    if (/^git\+file:/i.test(value)) {
      throw new Error('Local Git dependencies are not supported by Sight comparison.');
    }
    const local = value.match(/^(?:file:|link:|portal:)(.*)$/)?.[1] ?? value.match(/^workspace:(\.{1,2}[\\/].*)$/)?.[1];
    if (local !== undefined) {
      // Percent escapes are accepted by package managers in file URLs.
      const decoded = decodeURIComponent(local);
      if (decoded.startsWith('~')) throw new Error('Home-directory dependencies are outside the repository snapshot.');
      recordLocalPackage(snapshotRoot, path.resolve(directory, decoded), localPackages);
    } else if (path.isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) {
      recordLocalPackage(snapshotRoot, path.resolve(directory, value), localPackages);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) validateLocalReferences(child, directory, snapshotRoot, localPackages);
  }
}

function recordLocalPackage(snapshotRoot: string, target: string, localPackages: Set<string>): void {
  const directory = confinedPath(snapshotRoot, target);
  if (fs.existsSync(path.join(directory, 'package.json'))) {
    localPackages.add(fs.realpathSync(directory));
  }
}

function inspectNpmLock(lockPath: string, snapshotRoot: string, localPackages: Set<string>): void {
  const installRoot = path.dirname(lockPath);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
    packages?: Record<string, { link?: boolean; resolved?: string }>;
    dependencies?: unknown;
  };
  for (const [location, entry] of Object.entries(lock.packages || {})) {
    recordLocalPackage(snapshotRoot, path.resolve(installRoot, location), localPackages);
    if (entry.link && typeof entry.resolved === 'string') {
      recordLocalPackage(snapshotRoot, path.resolve(installRoot, entry.resolved), localPackages);
    } else {
      validateLocalReferences(entry.resolved, installRoot, snapshotRoot, localPackages);
    }
  }
  const inspectDependencies = (dependencies: unknown): void => {
    if (!dependencies || typeof dependencies !== 'object') return;
    for (const dependency of Object.values(dependencies) as { resolved?: unknown; version?: unknown; dependencies?: unknown }[]) {
      validateLocalReferences(dependency.resolved, installRoot, snapshotRoot, localPackages);
      validateLocalReferences(dependency.version, installRoot, snapshotRoot, localPackages);
      inspectDependencies(dependency.dependencies);
    }
  };
  inspectDependencies(lock.dependencies);
}

function parseClassicJson(output: string): unknown {
  let records: any[];
  try {
    records = [JSON.parse(output)];
  } catch {
    records = output.trim().split('\n').map(line => JSON.parse(line));
  }
  const record = records.find(item => item.type === 'inspect' || item.type === 'log');
  const data = record ? record.data : records[0];
  return typeof data === 'string' && data.startsWith('{') ? JSON.parse(data) : data;
}

async function validateNodeEngine(range: string, options: DependencyProcessOptions): Promise<void> {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-sight-engine-'));
  try {
    fs.writeFileSync(path.join(probeRoot, 'package.json'), JSON.stringify({
      name: 'bundle-drop-sight-engine-check', version: '1.0.0', private: true, engines: { node: range },
    }));
    // npm supplies the complete semver implementation. This synthetic project has
    // no dependencies or scripts, and offline dry-run cannot download packages.
    await runComparisonProcess({
      command: 'npm',
      args: ['install', '--prefix', probeRoot, '--dry-run', '--ignore-scripts', '--engine-strict', '--force=false', '--package-lock=false', '--offline', '--no-audit', '--no-fund'],
      cwd: probeRoot, phase: `Validate Node ${process.versions.node} against engines.node ${range} (requires npm)`,
      signal: options.signal, env: packageManagerEnvironment(options.env), logPath: options.logPath,
    });
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

export async function inspectDependencyPlan(
  options: { snapshotRoot: string; projectRelativePath: string } & DependencyProcessOptions,
): Promise<DependencyPlan> {
  const snapshotRoot = fs.realpathSync(options.snapshotRoot);
  const projectRoot = confinedPath(snapshotRoot, path.resolve(snapshotRoot, options.projectRelativePath));
  const installRoot = findInstallRoot(snapshotRoot, projectRoot);
  const manifest = readManifest(installRoot);
  const locks = existingLocks(installRoot);
  const families = Object.entries(lockfiles).filter(([, files]) => files.some(file => locks.includes(file)));
  if (families.length !== 1) throw new Error('Sight comparison requires exactly one package-manager lockfile family.');
  const name = families[0][0];
  if (name === 'bun') throw new Error('Bun is not supported by Sight comparison yet.');
  if (installRoot !== projectRoot && existingLocks(projectRoot).length) {
    throw new Error('A workspace app has its own lockfile. Remove the ambiguous nested lockfile before comparing.');
  }
  const declaration = manifest.packageManager;
  const declared = declaration?.match(/^(npm|yarn|pnpm)@(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\+[^\s]+)?$/);
  if (declaration && (!declared || declared[1] !== name)) {
    throw new Error('packageManager must name an exact supported version matching the lockfile.');
  }
  const appDeclaration = readManifest(projectRoot).packageManager;
  if (appDeclaration && appDeclaration !== declaration) {
    throw new Error('The app and workspace root declare different package-manager versions.');
  }
  const run = async (args: string[]) => (await runComparisonProcess({
    command: name, args, cwd: installRoot, phase: 'Inspect comparison dependencies',
    signal: options.signal, env: packageManagerEnvironment(options.env), logPath: options.logPath,
  })).stdout.trim();
  const version = await run(['--version']);
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || (declared && declared[2] !== version)) {
    throw new Error(`The available ${name} version (${version}) does not match ${declaration || 'a supported version'}. Install the required package manager and retry.`);
  }
  const packageManager = { name, version } as ComparisonPackageManager;
  const modernYarn = name === 'yarn' && Number(version.split('.')[0]) >= 2;
  const inputFiles = locks.map(file => path.join(installRoot, file));
  for (const file of configFiles) {
    const target = path.join(installRoot, file);
    if (fs.existsSync(target)) inputFiles.push(confinedPath(snapshotRoot, target));
  }
  if (name === 'yarn') {
    if (manifest.installConfig?.pnp || fs.existsSync(path.join(installRoot, '.pnp.cjs')) || fs.existsSync(path.join(installRoot, '.pnp.js'))) {
      throw new Error('Yarn Plug’n’Play is not supported by Sight comparison. Use a node_modules installation.');
    }
    if (modernYarn) {
      const linker = JSON.parse(await run(['config', 'get', 'nodeLinker', '--json']));
      if (linker !== 'node-modules') throw new Error('Sight comparison requires Yarn nodeLinker: node-modules.');
      const yarnPath = JSON.parse(await run(['config', 'get', 'yarnPath', '--json']));
      if (yarnPath) inputFiles.push(confinedPath(snapshotRoot, path.resolve(installRoot, yarnPath)));
      const statePath = JSON.parse(await run(['config', 'get', 'installStatePath', '--json']));
      confinedPath(snapshotRoot, path.resolve(installRoot, statePath));
    } else {
      const yarnPath = parseClassicJson(await run(['config', 'get', 'yarn-path', '--json']));
      if (typeof yarnPath === 'string' && yarnPath !== 'undefined') {
        inputFiles.push(confinedPath(snapshotRoot, path.resolve(installRoot, yarnPath)));
      }
    }
  }
  if (name === 'pnpm') {
    for (const setting of ['node-linker', 'virtual-store-dir', 'modules-dir', 'lockfile-dir']) {
      const value = await run(['config', 'get', setting]);
      if (setting === 'node-linker') {
        if (value === 'pnp') throw new Error('pnpm Plug’n’Play is not supported by Sight comparison.');
      } else if (value && value !== 'undefined') {
        confinedPath(snapshotRoot, path.resolve(installRoot, value));
      }
    }
  }
  let workspaceDirectories = [installRoot];
  const isWorkspace = manifest.workspaces !== undefined || fs.existsSync(path.join(installRoot, 'pnpm-workspace.yaml'));
  if (isWorkspace) {
    if (name === 'pnpm') {
      const workspaces = JSON.parse(await run(['list', '--recursive', '--depth', '-1', '--json'])) as { path: string }[];
      workspaceDirectories.push(...workspaces.map(workspace => workspace.path));
    } else if (modernYarn) {
      const workspaces = (await run(['workspaces', 'list', '--json'])).split('\n').map(line => JSON.parse(line));
      workspaceDirectories.push(...workspaces.map(workspace => path.resolve(installRoot, workspace.location)));
    } else if (name === 'yarn') {
      const workspaces = parseClassicJson(await run(['--silent', 'workspaces', 'info', '--json'])) as Record<string, { location: string }>;
      workspaceDirectories.push(...Object.values(workspaces).map(workspace => path.resolve(installRoot, workspace.location)));
    } else {
      const workspaces = JSON.parse(await run(['pkg', 'get', 'name', '--workspaces', '--json'])) as Record<string, string>;
      const lock = JSON.parse(fs.readFileSync(inputFiles[0], 'utf8')) as { packages?: Record<string, { name?: string }> };
      if (!lock.packages) throw new Error('npm workspace comparison requires a package-lock v2 or newer.');
      const locations = Object.keys(lock.packages).filter(location => location && !location.split('/').includes('node_modules'));
      workspaceDirectories.push(...locations.map(location => path.resolve(installRoot, location)));
      const lockedNames = workspaceDirectories.slice(1).map(directory => readManifest(confinedPath(snapshotRoot, directory)).name);
      if (Object.keys(workspaces).some(workspace => !lockedNames.includes(workspace))) {
        throw new Error('Workspace declarations and the npm lockfile disagree. Update the lockfile before comparing.');
      }
    }
  }
  workspaceDirectories = [...new Set(workspaceDirectories.map(directory => confinedPath(snapshotRoot, directory)))];
  if (!workspaceDirectories.includes(projectRoot)) throw new Error('The app is not a member of the detected package-manager workspace.');
  const localPackages = new Set(workspaceDirectories.map(directory => fs.realpathSync(directory)));
  if (name === 'npm') inspectNpmLock(inputFiles[0], snapshotRoot, localPackages);
  const nodeRanges = new Set<string>();
  // Set iteration also visits local packages discovered in preceding manifests.
  for (const directory of localPackages) {
    const packageFile = confinedPath(snapshotRoot, path.join(directory, 'package.json'));
    const workspace = readManifest(directory);
    const nodeRange = workspace.engines?.node;
    if (nodeRange !== undefined) {
      if (typeof nodeRange !== 'string') throw new Error('engines.node must be a version-range string.');
      nodeRanges.add(nodeRange);
    }
    for (const dependencies of [workspace.dependencies, workspace.devDependencies, workspace.optionalDependencies, workspace.peerDependencies, workspace.resolutions, workspace.overrides, workspace.pnpm]) {
      validateLocalReferences(dependencies, directory, snapshotRoot, localPackages);
    }
    inputFiles.push(packageFile);
  }
  for (const range of nodeRanges) await validateNodeEngine(range, options);
  const installArgs = name === 'npm'
    ? ['ci', '--include=dev', '--no-audit', '--no-fund']
    : name === 'pnpm'
      ? ['install', '--frozen-lockfile', '--prod=false']
      : modernYarn
        ? ['install', '--immutable']
        : ['install', '--frozen-lockfile', '--production=false', '--non-interactive'];
  return { snapshotRoot, projectRoot, installRoot, packageManager, installArgs, inputFiles: [...new Set(inputFiles)] };
}

export async function installDependencies(plan: DependencyPlan, options: DependencyProcessOptions = {}): Promise<void> {
  const before = new Map(plan.inputFiles.map(file => [file, fs.readFileSync(file)]));
  await runComparisonProcess({
    command: plan.packageManager.name, args: plan.installArgs, cwd: plan.installRoot,
    phase: 'Install comparison dependencies', signal: options.signal, logPath: options.logPath,
    env: { ...packageManagerEnvironment(options.env), NODE_ENV: 'development' },
  });
  for (const [file, contents] of before) {
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(contents)) {
      throw new Error(`Dependency installation modified a comparison input: ${path.relative(plan.snapshotRoot, file)}. A frozen install is required.`);
    }
  }
}
