import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { canonicalJson, compareText, digest, posix, projectFileSources, type Source } from './files';

type PackageJson = {
  name?: string;
  version?: string;
  nativeVersion?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  pnpm?: { patchedDependencies?: Record<string, string> };
};
type NpmPackage = { name?: string; version?: string; resolved?: string; integrity?: string; link?: boolean };
type LockEntry = { name: string; version?: string; location?: string; integrity?: string };
type YarnEntry = { descriptors: string[]; version: string; location?: string; integrity?: string };
type YarnLock = {
  entries: YarnEntry[];
  installedLocators: Map<string, string | null>;
  transitiveDescriptors?: Map<string, Set<string>>;
};
type Lock = {
  root: string;
  npm?: Record<string, NpmPackage>;
  yarn?: YarnLock;
  entries: LockEntry[];
  patchFiles: string[];
};
type Dependency = { name: string; packageJson: string };
const unquote = (value: string): string => value.replace(/^(['"])(.*)\1$/, '$2');

export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function manifest(directory: string): PackageJson | undefined {
  const text = readText(path.join(directory, 'package.json'));
  return text === undefined ? undefined : JSON.parse(text) as PackageJson;
}

function parseLockFields(text: string, indentation: number): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const field = line.slice(indentation).match(/^(version|resolution|resolved|integrity|checksum|tarball|repo|commit)\s*:?\s+(.+?)\s*$/);
    if (field) fields[field[1]] = unquote(field[2]);
  }
  return fields;
}

function packageName(descriptor: string): string | undefined {
  return descriptor.match(/^(@[^/\s]+\/[^@\s]+|[^@\s]+)@/)?.[1];
}

function yarnBlocks(text: string): { header: string; body: string }[] {
  return text.replace(/\r\n/g, '\n').split(/\n(?=\S)/).flatMap(block => {
    const newline = block.indexOf('\n');
    const header = block.slice(0, newline).trim();
    return newline !== -1 && !header.startsWith('#') && header.endsWith(':')
      ? [{ header: header.slice(0, -1), body: block.slice(newline + 1) }]
      : [];
  });
}

function yarnDescriptors(header: string, modern: boolean): string[] {
  if (modern) return unquote(header).split(', ');
  // Classic quotes individual descriptors. Keep commas inside quoted URLs.
  return (header.match(/"(?:\\.|[^"\\])*"|[^,\s]+/g) ?? []).map(unquote);
}

function readYarnLock(root: string, text: string): YarnLock {
  const blocks = yarnBlocks(text);
  const modern = blocks.some(block => block.header === '__metadata');
  const entries = blocks.flatMap(({ header, body }): YarnEntry[] => {
    const descriptors = yarnDescriptors(header, modern);
    const fields = parseLockFields(body, 2);
    if (!descriptors.some(packageName) || !fields.version) return [];
    return [{
      descriptors,
      version: fields.version,
      location: fields.resolution ?? fields.resolved,
      integrity: fields.checksum ?? fields.integrity,
    }];
  });
  const installedLocators = new Map<string, string | null>();
  const state = modern ? readText(path.join(root, 'node_modules/.yarn-state.yml')) : undefined;
  for (const { header, body } of yarnBlocks(state ?? '')) {
    const locator = unquote(header).replace(/@virtual:[^#]+#/, '@');
    const locations = body.match(/^ {2}locations:\n((?: {4}- [^\n]+\n?)*)/m)?.[1] ?? '';
    for (const location of locations.matchAll(/^ {4}- (.+)$/gm)) {
      const installPath = unquote(location[1].trim());
      if (!isNodeModulesPath(installPath)) continue;
      const previous = installedLocators.get(installPath);
      installedLocators.set(installPath, previous === undefined || previous === locator ? locator : null);
    }
  }
  return { entries, installedLocators };
}

function pnpmEntries(text: string): LockEntry[] {
  const sections = text.split(/\n(?=\S)/);
  const packages = sections.find(section => section.startsWith('packages:\n'));
  if (!packages) return [];
  return packages.split(/\n(?= {2}\S)/).slice(1).flatMap(block => {
    const newline = block.indexOf('\n');
    const key = unquote(block.slice(0, newline).trim().replace(/:\s*$/, '')).replace(/^\//, '');
    const name = packageName(key);
    if (!name) return [];
    const body = block.slice(newline + 1);
    const fields = parseLockFields(body, 4);
    const resolution = parseLockFields(body, 6);
    const lookup = (field: string) => {
      const inline = fields.resolution?.match(new RegExp(`\\b${field}:\\s*('[^']*'|"[^"]*"|[^},\\s]+)`))?.[1];
      return inline ? unquote(inline) : (resolution[field] ?? fields[field]);
    };
    const locator = key.slice(name.length + 1).split('(')[0];
    const version = fields.version ?? (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(locator) ? locator : undefined);
    const commit = lookup('commit');
    const repository = lookup('repo');
    let location = lookup('tarball') ?? key;
    if (commit && repository) {
      // An exact Git object pins a file:// checkout irrespective of its host path.
      location = repository.startsWith('file:') ? `git:file#${commit}` : `${key} ${repository}#${commit}`;
    }
    return [{ name, version, location, integrity: lookup('integrity') }];
  });
}

function yamlPatchFiles(text: string): string[] {
  const section = text.split(/\n(?=\S)/).find(block => block.startsWith('patchedDependencies:\n'));
  return section?.split('\n').slice(1).flatMap(line => {
    const value = line.match(/^ {2}(?:'[^']+'|"[^"]+"|[^\s:][^:]*):\s+(.+)$/)?.[1]
      ?? line.match(/^ {4}path:\s+(.+)$/)?.[1];
    return value ? [unquote(value.trim())] : [];
  }) ?? [];
}

function yarnPatchFiles(text: string): string[] {
  return [...text.matchAll(/#([~.]?[^#:"&\s]+\.patch)(?=::|["&,\s]|$)/g)]
    .map(match => decodeURIComponent(match[1]).replace(/^~/, ''));
}

export function loadDependencyLock(projectRoot: string): Lock {
  let root = projectRoot;
  for (;;) {
    const pkg = manifest(root);
    if (pkg || root === projectRoot) {
      const npm = readText(path.join(root, 'npm-shrinkwrap.json')) ?? readText(path.join(root, 'package-lock.json'));
      const yarn = readText(path.join(root, 'yarn.lock'));
      const pnpm = readText(path.join(root, 'pnpm-lock.yaml'));
      if (npm !== undefined || yarn !== undefined || pnpm !== undefined) {
        const managers = { npm, yarn, pnpm };
        const preferred = pkg?.packageManager?.split('@')[0] as keyof typeof managers | undefined;
        const manager = preferred && managers[preferred] !== undefined
          ? preferred
          : (Object.keys(managers) as (keyof typeof managers)[]).find(name => managers[name] !== undefined)!;
        const contents = managers[manager]!;
        return {
          root,
          npm: manager === 'npm' ? (JSON.parse(contents) as { packages?: Record<string, NpmPackage> }).packages : undefined,
          yarn: manager === 'yarn' ? readYarnLock(root, contents) : undefined,
          entries: manager === 'pnpm' ? pnpmEntries(contents) : [],
          patchFiles: [
            ...Object.values(pkg?.pnpm?.patchedDependencies ?? {}),
            ...yamlPatchFiles(readText(path.join(root, 'pnpm-workspace.yaml')) ?? ''),
            ...(manager === 'pnpm' ? yamlPatchFiles(contents) : []),
            ...(manager === 'yarn' ? yarnPatchFiles(contents) : []),
          ],
        };
      }
    }
    if (fs.existsSync(path.join(root, '.git')) || path.dirname(root) === root) break;
    root = path.dirname(root);
  }
  return { root: projectRoot, entries: [], patchFiles: Object.values(manifest(projectRoot)?.pnpm?.patchedDependencies ?? {}) };
}

function localLocator(value: string | undefined): boolean {
  return !!value && /(?:^|@)(?:file:|link:|portal:|workspace:)|^\.\.?[\/\\]|^[/\\]|^[A-Za-z]:[\/\\]/.test(value);
}

function nonRegistryLocator(value: string | undefined): boolean {
  return !!value && /(?:^|@)(?:git[+:]|github:|gitlab:|bitbucket:|https?:|ssh:)|^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value);
}

const isNodeModulesPath = (file: string): boolean => posix(file).split('/').includes('node_modules');

function dependencyDeclarations(pkg: PackageJson | undefined, includeDev: boolean): Record<string, string> {
  return {
    ...(includeDev ? pkg?.devDependencies : undefined),
    ...pkg?.dependencies,
    ...pkg?.optionalDependencies,
  };
}

function resolveInstalledPackage(issuer: string, name: string): string | undefined {
  if (!/^(?:@[^/\\]+\/)?[^/\\]+$/.test(name) || name === '.' || name === '..') return undefined;
  const requireFromIssuer = createRequire(path.join(issuer, 'package.json'));
  for (const location of requireFromIssuer.resolve.paths(name) ?? []) {
    const directory = path.join(location, name);
    if (fs.existsSync(path.join(directory, 'package.json'))) return fs.realpathSync(directory);
  }
  return undefined;
}

function yarnRequestDescriptors(descriptor: string): string[] {
  const name = packageName(descriptor);
  if (!name) return [descriptor];
  const range = descriptor.slice(name.length + 1);
  return /^[a-z][\w+.-]*:/i.test(range) ? [descriptor] : [descriptor, `${name}@npm:${range}`];
}

function transitiveYarnDescriptors(projectRoot: string): Map<string, Set<string>> {
  const visited = new Set<string>();
  const pendingIssuers = [projectRoot];
  const requests = new Map<string, Set<string>>();
  while (pendingIssuers.length > 0) {
    const issuer = pendingIssuers.pop()!;
    if (visited.has(issuer)) continue;
    visited.add(issuer);
    const installedPackage = isNodeModulesPath(issuer);
    const dependencies = dependencyDeclarations(manifest(issuer), !installedPackage);
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range !== 'string') continue;
      const directory = resolveInstalledPackage(issuer, name);
      if (!directory) continue;
      pendingIssuers.push(directory);
      const descriptors = requests.get(directory) ?? new Set<string>();
      descriptors.add(`${name}@${range}`);
      requests.set(directory, descriptors);
    }
  }
  return requests;
}

function unambiguousYarnEntry(entries: YarnEntry[]): YarnEntry | undefined {
  const first = entries[0];
  if (!first?.location && !first?.integrity) return undefined;
  return entries.every(entry => entry.location === first.location && entry.integrity === first.integrity)
    ? first
    : undefined;
}

function selectedYarnEntry(
  yarn: YarnLock,
  lockRoot: string,
  projectRoot: string,
  directory: string,
  installedPath: string,
  installedVersion: string,
): YarnEntry | undefined {
  const lockPath = posix(path.relative(lockRoot, directory));
  const pathLocator = yarn.installedLocators.get(lockPath);
  const installedLocator = pathLocator === undefined
    ? yarn.installedLocators.get(posix(path.relative(lockRoot, installedPath)))
    : pathLocator;
  if (installedLocator === null) return undefined;
  const matchingVersion = yarn.entries.filter(entry => entry.version === installedVersion);
  if (installedLocator) {
    return unambiguousYarnEntry(matchingVersion.filter(entry => entry.location === installedLocator));
  }

  const name = posix(directory).match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
  if (!name) return undefined;
  const possibleInstalls = matchingVersion.filter(entry =>
    entry.descriptors.some(descriptor => packageName(descriptor) === name),
  );
  // A Classic warm install can retain old bytes after two workspaces swap
  // same-version sources. Its lock knows the requested descriptors, but it
  // cannot identify which of those sources occupies a particular install path.
  if (possibleInstalls.length > 1 && !unambiguousYarnEntry(possibleInstalls)) return undefined;

  function matchingDescriptors(requests: Iterable<string>): YarnEntry | undefined {
    const candidates: YarnEntry[] = [];
    for (const request of requests) {
      const alternatives = yarnRequestDescriptors(request);
      const matches = matchingVersion.filter(entry => entry.descriptors.some(descriptor => alternatives.includes(descriptor)));
      if (matches.length === 0) return undefined;
      candidates.push(...matches);
    }
    return unambiguousYarnEntry(candidates);
  }
  // Classic has no installed locator map. Prefer the app's request, then the
  // physical owner of a nested install, before inspecting hoisted transitive requests.
  const installationOwner = directory.slice(0, directory.lastIndexOf(path.sep + 'node_modules' + path.sep));
  for (const issuer of new Set([projectRoot, installationOwner])) {
    if (issuer === lockRoot && issuer !== projectRoot) continue;
    const range = dependencyDeclarations(manifest(issuer), !isNodeModulesPath(issuer))[name];
    if (typeof range === 'string' && resolveInstalledPackage(issuer, name) === installedPath) {
      return matchingDescriptors([`${name}@${range}`]);
    }
  }

  yarn.transitiveDescriptors ??= transitiveYarnDescriptors(projectRoot);
  const transitive = yarn.transitiveDescriptors.get(installedPath);
  if (transitive) return matchingDescriptors(transitive);
  const rootRange = dependencyDeclarations(manifest(lockRoot), true)[name];
  if (typeof rootRange === 'string' && resolveInstalledPackage(lockRoot, name) === installedPath) {
    return matchingDescriptors([`${name}@${rootRange}`]);
  }
  return undefined;
}

export function dependencySources(
  projectRoot: string,
  lock: Lock,
  dependency: Dependency,
  reasons: string[],
  skip: (relative: string, directory: boolean) => boolean,
): Source[] {
  const file = path.resolve(projectRoot, dependency.packageJson);
  const directory = path.dirname(file);
  const installed = manifest(directory);
  if (!installed?.name || !installed.version) throw new Error(`Invalid native dependency manifest: ${dependency.name}`);
  const installedPath = fs.realpathSync(directory);
  const project = manifest(projectRoot);
  const importer = manifest(lock.root);
  const declared = [project, importer].flatMap(pkg => [
    pkg?.dependencies?.[dependency.name],
    pkg?.optionalDependencies?.[dependency.name],
    pkg?.devDependencies?.[dependency.name],
  ]).find(value => value !== undefined);
  const npmEntry = lock.npm?.[posix(path.relative(lock.root, directory))];
  const yarnEntry = lock.yarn && isNodeModulesPath(installedPath)
    ? selectedYarnEntry(lock.yarn, lock.root, projectRoot, directory, installedPath, installed.version)
    : undefined;
  const matching = lock.entries.filter(entry =>
    entry.name === installed.name && (entry.version === undefined || entry.version === installed.version));
  const resolutions = yarnEntry ? [yarnEntry] : matching;
  const local = !isNodeModulesPath(directory) || !isNodeModulesPath(installedPath)
    || localLocator(declared) || npmEntry?.link || localLocator(npmEntry?.resolved)
    || resolutions.some(entry => localLocator(entry.location));
  const provenance = local ? [] : [...new Set([
    ...(npmEntry ? [canonicalJson({ location: npmEntry.resolved, integrity: npmEntry.integrity })] : []),
    ...resolutions.map(entry => canonicalJson({ location: entry.location, integrity: entry.integrity })),
  ])].sort(compareText);
  const pinKnown = provenance.some(entry => /"integrity":"[^"]+"|#[a-f0-9]{7,}|commit=[a-f0-9]{7,}/i.test(entry));
  const unresolvedYarn = lock.yarn !== undefined && yarnEntry === undefined;
  const contentHashRequired = local || unresolvedYarn
    || ((nonRegistryLocator(declared) || nonRegistryLocator(yarnEntry?.location)) && !pinKnown);
  const id = dependency.name;
  const metadata = {
    name: installed.name,
    version: installed.version,
    nativeVersion: installed.nativeVersion,
    provenance,
  };
  const outputs: Source[] = [{ type: 'package', id, hash: digest(canonicalJson(metadata)), reasons }];
  if (contentHashRequired) {
    const reason = !local && lock.yarn ? 'installedNativeDependency' : 'localNativeDependency';
    outputs.push(...projectFileSources({
      root: directory,
      directory: '',
      idPrefix: `dependency:${id}/`,
      reason,
      honorGitignore: !lock.yarn || !!local,
      skip: (relative, isDirectory) => relative === 'yalc.sig' || relative === 'package.json'
        || (installed.name === '@gfean/react-native-bundle-drop' && relative.split('/')[0] === 'dist')
        || skip(relative, isDirectory),
    }));
    // Hash module configuration independently of transport-only yalc metadata.
    const config = { ...(installed as PackageJson & { yalcSig?: string }) };
    delete config.yalcSig;
    outputs.push({
      type: 'file',
      id: `dependency:${id}/package.json`,
      hash: digest(canonicalJson(config)),
      reasons: [reason],
    });
  }
  return outputs;
}

export function patchSources(projectRoot: string, lock: Lock): Source[] {
  const rootSources = [projectRoot, ...projectRoot === lock.root ? [] : [lock.root]].flatMap(root =>
    ['patches', '.yarn/patches', 'cng-patches'].flatMap(directory => {
      if (!fs.existsSync(path.join(root, directory))) return [];
      return projectFileSources({
        root, directory, idPrefix: `patch:${posix(path.relative(projectRoot, path.join(root, directory)))}/`,
        reason: 'declaredPatch',
      });
    })
  );
  const byId = new Map(rootSources.map(source => [source.id, source]));
  for (const file of lock.patchFiles) {
    const absolute = path.resolve(lock.root, file);
    const relative = posix(path.relative(lock.root, absolute));
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('Declared native package patch must be inside the dependency lock root.');
    }
    const id = `patch:${posix(path.relative(projectRoot, absolute))}`;
    byId.set(id, {
      type: 'file', id, hash: digest(fs.readFileSync(absolute)), reasons: ['declaredPatch'],
    });
  }
  return [...byId.values()];
}
