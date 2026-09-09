import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  comparisonIndexFingerprint,
  comparisonRefs,
  inspectComparisonRepository,
  runComparisonGit,
} from './git';
import { checkComparisonAbort } from './process';

export type ComparisonSnapshotOptions = {
  projectRoot: string;
  compareRef: string;
  fetch?: boolean;
  include?: string[];
  signal?: AbortSignal;
};

export type ComparisonSnapshots = {
  directory: string;
  currentRoot: string;
  baselineRoot: string;
  currentProjectRoot: string;
  baselineProjectRoot: string;
  currentCommit: string;
  baselineCommit: string;
  currentLabel: string;
  baselineLabel: string;
  currentBranch: string | null;
  currentDirty: boolean;
  snapshotHash: string;
  baselineInputFingerprint: string;
  includedPaths: string[];
  assertIdentity: () => Promise<void>;
  cleanup: () => Promise<void>;
};

type SnapshotFile = { name: string; mode: number; hash: string; link?: string };
type TreeEntry = { name: string; mode: string };

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function forbiddenPath(name: string): boolean {
  const parts = name.split('/');
  return parts.some(part => part === '.git' || part === 'node_modules' || part === '.pnp.cjs' || part === '.pnp.loader.mjs') ||
    /(^|\/)\.bundle-drop\/sight(?:\/|$)/.test(name) ||
    /(^|\/)\.yarn\/(?:install-state\.gz|unplugged)(?:\/|$)/.test(name);
}

function parseTree(output: string): TreeEntry[] {
  return output.split('\0').filter(Boolean).map(line => {
    const separator = line.indexOf('\t');
    return { mode: line.slice(0, 6), name: line.slice(separator + 1) };
  });
}

function relevantToApp(name: string, appRelativePath: string): boolean {
  if (!appRelativePath) return true;
  const app = appRelativePath.split(path.sep).join('/');
  return name === app || name.startsWith(`${app}/`) || app.startsWith(`${name}/`);
}

function validateTree(entries: TreeEntry[], appRelativePath: string): void {
  for (const entry of entries) {
    if (entry.name.split('/').includes('node_modules')) {
      throw new Error('Tracked node_modules are not supported by Sight comparison.');
    }
    if (entry.mode === '160000' && relevantToApp(entry.name, appRelativePath)) {
      throw new Error(`Sight comparison cannot build Git submodule "${entry.name}". Use a project with its build inputs in this repository.`);
    }
  }
}

async function checkFilters(root: string, names: string[], signal?: AbortSignal): Promise<void> {
  if (!names.length) return;
  const attributes = (await runComparisonGit(root, ['check-attr', '--cached', '-z', '--stdin', 'filter'], signal, undefined, `${names.join('\0')}\0`)).split('\0');
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    if (attributes[index + 2] !== 'unspecified' && attributes[index + 2] !== 'unset') {
      throw new Error(`Sight comparison does not support Git LFS or checkout filters: ${attributes[index]}. Sight cannot establish that this path is unrelated before executing build configuration. Use a checkout without Git-filtered inputs.`);
    }
  }
}

function includeFiles(repositoryRoot: string, projectRoot: string, includes: string[]): string[] {
  const files = new Set<string>();
  const visit = (absolute: string) => {
    const name = path.relative(repositoryRoot, absolute).split(path.sep).join('/');
    const dependencyInputs = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb'];
    if (!isWithin(repositoryRoot, absolute) || !name || forbiddenPath(name) || dependencyInputs.includes(path.basename(name))) {
      throw new Error(`Unsafe --include path: ${name || '.'}. Choose source/configuration files inside the repository.`);
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) visit(path.join(absolute, child));
    } else {
      files.add(name);
    }
  };
  for (const input of includes) {
    if (!input.trim() || path.isAbsolute(input)) throw new Error('--include requires a relative file or directory inside the repository.');
    visit(path.resolve(projectRoot, input));
  }
  return [...files].sort();
}

function copyFiles(repositoryRoot: string, names: string[], destination?: string, signal?: AbortSignal): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  for (const name of names) {
    checkComparisonAbort(signal);
    const source = path.join(repositoryRoot, name);
    if (!isWithin(repositoryRoot, source) || forbiddenPath(name)) throw new Error(`Unsafe snapshot path: ${name}.`);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(source);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code)) continue;
      throw error;
    }
    // Cached Git paths can remain after an unstaged file/directory replacement.
    // The untracked listing supplies the replacement files separately.
    if (stat.isDirectory()) continue;
    if (!isWithin(repositoryRoot, fs.realpathSync(path.dirname(source)))) {
      throw new Error(`Snapshot input escapes the repository through a symlink: ${name}.`);
    }
    const target = destination && path.join(destination, name);
    if (target) fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const originalLink = fs.readlinkSync(source);
      const resolved = fs.realpathSync(path.resolve(path.dirname(source), originalLink));
      if (!isWithin(repositoryRoot, resolved)) {
        throw new Error(`External symlink is not supported by Sight comparison: ${name}.`);
      }
      const link = path.isAbsolute(originalLink) ? path.relative(path.dirname(source), resolved) : originalLink;
      if (target) fs.symlinkSync(link, target, fs.statSync(resolved).isDirectory() ? 'dir' : 'file');
      files.push({ name, mode, link, hash: createHash('sha256').update(link).digest('hex') });
    } else if (stat.isFile()) {
      const content = fs.readFileSync(source);
      if (content.subarray(0, 80).toString().startsWith('version https://git-lfs.github.com/spec/v1\n')) {
        throw new Error(`Git LFS pointer cannot be bundled: ${name}. Sight cannot establish that this path is unrelated before executing build configuration.`);
      }
      if (target) {
        fs.writeFileSync(target, content, { mode });
        fs.chmodSync(target, mode);
      }
      files.push({ name, mode, hash: createHash('sha256').update(content).digest('hex') });
    } else {
      throw new Error(`Snapshot input must be a regular file or internal symlink: ${name}.`);
    }
  }
  return files;
}

function fingerprint(files: SnapshotFile[]): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function verifyCopiedLinks(root: string, files: SnapshotFile[]): void {
  for (const file of files) {
    if (file.link !== undefined && !fs.existsSync(path.join(root, file.name))) {
      throw new Error(`Symlink target was not captured: ${file.name}. Include its ignored target explicitly with --include.`);
    }
  }
}

export async function createComparisonSnapshots(options: ComparisonSnapshotOptions): Promise<ComparisonSnapshots> {
  const { compareRef, signal, include = [] } = options;
  const projectRoot = fs.realpathSync(options.projectRoot);
  const repository = await inspectComparisonRepository(projectRoot, compareRef, options);
  const { repositoryRoot, appRelativePath, currentCommit, baselineCommit } = repository;
  const baselineTree = parseTree(await runComparisonGit(repositoryRoot, ['ls-tree', '-rz', baselineCommit], signal));
  const currentIndex = parseTree(await runComparisonGit(repositoryRoot, ['ls-files', '--stage', '-z'], signal));
  validateTree(currentIndex, appRelativePath);
  validateTree(baselineTree, appRelativePath);
  const submodules = new Set(currentIndex.filter(entry => entry.mode === '160000').map(entry => entry.name));
  const includedPaths = includeFiles(repositoryRoot, projectRoot, include);
  const trackedNames = [...currentIndex, ...baselineTree].map(entry => entry.name);
  for (const name of includedPaths) {
    if (trackedNames.some(tracked => tracked === name || tracked.startsWith(`${name}/`) || name.startsWith(`${tracked}/`))) {
      throw new Error(`--include cannot overwrite a tracked input on either side: ${name}.`);
    }
  }
  const listCurrent = async () => {
    const output = await runComparisonGit(repositoryRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal);
    return [...new Set([...output.split('\0').filter(name => name && !forbiddenPath(name) && !submodules.has(name)), ...includeFiles(repositoryRoot, projectRoot, include)])].sort();
  };
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-sight-compare-')));
  const frozenRoot = path.join(directory, 'frozen');
  const privateGit = path.join(directory, 'repository.git');
  const currentRoot = path.join(directory, 'current');
  const baselineRoot = path.join(directory, 'baseline');
  const worktrees: string[] = [];
  const disabledHooks = path.join(directory, 'disabled-hooks');
  const cleanup = async () => {
    if (!fs.existsSync(directory)) return;
    for (const root of worktrees) {
      // Even a project hook that changes private Git config cannot strand original worktrees.
      try { await runComparisonGit(privateGit, ['worktree', 'remove', '--force', root]); } catch { /* Remove the owned repository below. */ }
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    fs.mkdirSync(frozenRoot);
    fs.mkdirSync(disabledHooks);
    const names = await listCurrent();
    const files = copyFiles(repositoryRoot, names, frozenRoot, signal);
    const snapshotHash = fingerprint(files);
    if (snapshotHash !== fingerprint(copyFiles(repositoryRoot, await listCurrent(), undefined, signal)) ||
      repository.indexFingerprint !== await comparisonIndexFingerprint(repositoryRoot, signal) ||
      currentCommit !== (await runComparisonGit(repositoryRoot, ['rev-parse', 'HEAD'], signal)).trim()) {
      throw new Error('Working tree changed while Sight captured it; retry when edits settle.');
    }
    verifyCopiedLinks(frozenRoot, files);
    await runComparisonGit(repositoryRoot, ['clone', '--mirror', '--no-hardlinks', '--dissociate', '--origin', 'sight-source', '--', repositoryRoot, privateGit], signal);
    // Keep mirrored refs for versioning tools without leaving a build a remote back to the original checkout.
    await runComparisonGit(privateGit, ['config', '--local', '--remove-section', 'remote.sight-source'], signal);
    const checkoutSettings = await runComparisonGit(repositoryRoot, ['config', '--get-regexp', '^core[.](autocrlf|eol|filemode|symlinks)$'], signal, [0, 1]);
    for (const setting of checkoutSettings.trim().split('\n').filter(Boolean)) {
      const separator = setting.indexOf(' ');
      await runComparisonGit(privateGit, ['config', '--local', setting.slice(0, separator), setting.slice(separator + 1)], signal);
    }
    if (await comparisonRefs(privateGit, signal) !== repository.refs) throw new Error('Git refs changed while Sight captured the repository; retry.');
    await runComparisonGit(privateGit, ['cat-file', '-e', `${currentCommit}^{commit}`], signal);
    await runComparisonGit(privateGit, ['cat-file', '-e', `${baselineCommit}^{commit}`], signal);
    for (const [root, commit] of [[baselineRoot, baselineCommit], [currentRoot, currentCommit]]) {
      await runComparisonGit(privateGit, ['-c', `core.hooksPath=${disabledHooks}`, 'worktree', 'add', '--detach', '--no-checkout', root, commit], signal);
      worktrees.push(root);
      await runComparisonGit(root, ['read-tree', commit], signal);
      const tree = parseTree(await runComparisonGit(root, ['ls-files', '--stage', '-z'], signal));
      await checkFilters(root, tree.map(entry => entry.name), signal);
    }
    await runComparisonGit(baselineRoot, ['checkout-index', '--all', '--force'], signal);
    copyFiles(frozenRoot, includedPaths, baselineRoot, signal);
    for (const entry of baselineTree.filter(item => item.mode === '120000')) {
      const linkPath = path.join(baselineRoot, entry.name);
      if (!fs.lstatSync(linkPath).isSymbolicLink()) continue;
      const link = fs.readlinkSync(linkPath);
      if (path.isAbsolute(link) && isWithin(repositoryRoot, fs.realpathSync(link))) {
        const target = path.join(baselineRoot, path.relative(repositoryRoot, fs.realpathSync(link)));
        fs.unlinkSync(linkPath);
        fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath, fs.statSync(target).isDirectory() ? 'dir' : 'file');
      }
    }
    copyFiles(frozenRoot, files.map(file => file.name), currentRoot, signal);
    const baselineFiles = baselineTree.filter(entry => entry.mode !== '160000' && !forbiddenPath(entry.name)).map(entry => entry.name);
    copyFiles(baselineRoot, baselineFiles, undefined, signal);
    verifyCopiedLinks(baselineRoot, copyFiles(baselineRoot, [...baselineFiles, ...includedPaths], undefined, signal));
    const currentProjectRoot = path.join(currentRoot, appRelativePath);
    const baselineProjectRoot = path.join(baselineRoot, appRelativePath);
    if (!fs.existsSync(path.join(baselineProjectRoot, 'package.json'))) throw new Error('The app package.json is missing at the baseline repository-relative path.');
    const assertIdentity = async () => {
      if ((await runComparisonGit(currentRoot, ['rev-parse', 'HEAD'], signal)).trim() !== currentCommit ||
        (await runComparisonGit(baselineRoot, ['rev-parse', 'HEAD'], signal)).trim() !== baselineCommit ||
        await comparisonRefs(privateGit, signal) !== repository.refs) {
        throw new Error('A comparison build changed its Git HEAD or refs; refusing artifacts with altered revision identity.');
      }
    };
    await assertIdentity();
    return {
      directory, currentRoot, baselineRoot, currentProjectRoot, baselineProjectRoot,
      currentCommit, baselineCommit, currentLabel: repository.currentLabel, baselineLabel: repository.baselineLabel,
      currentBranch: repository.currentBranch, currentDirty: repository.currentDirty,
      baselineInputFingerprint: repository.baselineInputFingerprint, snapshotHash, includedPaths,
      assertIdentity, cleanup,
    };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new Error(`${(error as Error).message}\nCould not remove ${directory}: ${(cleanupError as Error).message}`);
    }
    throw error;
  }
}
