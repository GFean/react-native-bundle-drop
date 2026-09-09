import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { runComparisonProcess } from './process';

export type ComparisonRepository = {
  repositoryRoot: string;
  appRelativePath: string;
  currentCommit: string;
  currentBranch: string | null;
  currentDirty: boolean;
  currentLabel: string;
  baselineCommit: string;
  baselineLabel: string;
  baselineInputFingerprint: string;
  refs: string;
  indexFingerprint: string;
};

/** Never inherit a caller's index/worktree overrides into an isolated Git invocation. */
export function comparisonGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete env[name];
  }
  return env;
}

export async function runComparisonGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  allowedExitCodes?: number[],
  input?: string,
): Promise<string> {
  const result = await runComparisonProcess({
    command: 'git',
    args: ['--literal-pathspecs', '-c', 'maintenance.auto=false', ...args],
    cwd,
    phase: 'Sight Git preparation',
    env: comparisonGitEnvironment(),
    signal,
    allowedExitCodes,
    input,
    inheritStdin: args.includes('fetch'),
  });
  return result.stdout;
}

export function comparisonRefs(cwd: string, signal?: AbortSignal): Promise<string> {
  return runComparisonGit(cwd, ['for-each-ref', '--sort=refname', '--format=%(refname) %(objectname)'], signal);
}

export async function comparisonIndexFingerprint(cwd: string, signal?: AbortSignal): Promise<string> {
  const indexPath = (await runComparisonGit(cwd, ['rev-parse', '--git-path', 'index'], signal)).trim();
  const absolutePath = path.resolve(cwd, indexPath);
  return createHash('sha256').update(fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath) : '').digest('hex');
}

async function refreshBaseline(repositoryRoot: string, ref: string, signal?: AbortSignal): Promise<string> {
  const remoteNames = (await runComparisonGit(repositoryRoot, ['remote'], signal)).trim().split('\n').filter(Boolean);
  const shortRef = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref;
  const matches = remoteNames.filter(remote => shortRef.startsWith(`${remote}/`));
  if (matches.length !== 1) {
    throw new Error('--fetch requires one explicit configured remote branch, such as --compare origin/main --fetch.');
  }
  const remote = matches[0];
  const branch = shortRef.slice(remote.length + 1);
  // Validate the literal branch before building a refspec; revision expressions are not refresh targets.
  await runComparisonGit(repositoryRoot, ['check-ref-format', `refs/heads/${branch}`], signal);
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  await runComparisonGit(repositoryRoot, [
    'fetch', '--no-tags', '--no-recurse-submodules', '--no-prune', '--no-auto-maintenance',
    '--no-write-commit-graph', '--refmap=', '--', remote,
    `+refs/heads/${branch}:${trackingRef}`,
  ], signal);
  return trackingRef;
}

export async function inspectComparisonRepository(
  projectRoot: string,
  compareRef: string,
  options: { fetch?: boolean; signal?: AbortSignal } = {},
): Promise<ComparisonRepository> {
  const { signal } = options;
  if (!compareRef.trim() || compareRef.includes('\0')) throw new Error('--compare requires a nonempty Git ref.');
  const repositoryRoot = (await runComparisonGit(projectRoot, ['rev-parse', '--show-toplevel'], signal)).trim();
  const appRelativePath = path.relative(repositoryRoot, fs.realpathSync(projectRoot));
  if (appRelativePath === '..' || appRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(appRelativePath)) {
    throw new Error('The comparison app must be inside its Git repository.');
  }
  const sparse = (await runComparisonGit(repositoryRoot, ['config', '--get', 'core.sparseCheckout'], signal, [0, 1])).trim();
  const partial = await runComparisonGit(repositoryRoot, ['config', '--get-regexp', '^(extensions[.]partialclone|remote[.].*[.]promisor)$'], signal, [0, 1]);
  if (sparse === 'true' || /(?:^|\n)(?:extensions\.partialclone\s+\S+|remote\..*\.promisor\s+true)(?:\n|$)/i.test(partial)) {
    throw new Error('Sight comparison requires a complete, non-sparse local checkout; sparse and partial clones are not supported.');
  }
  if ((await runComparisonGit(repositoryRoot, ['ls-files', '--unmerged', '-z'], signal)).length) {
    throw new Error('Resolve Git merge conflicts before comparing with Sight.');
  }
  let currentCommit: string;
  try {
    currentCommit = (await runComparisonGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new Error('Sight comparison requires an existing HEAD commit; commit the initial revision first.');
  }
  const baselineRef = options.fetch ? await refreshBaseline(repositoryRoot, compareRef, signal) : compareRef;
  let baselineCommit: string;
  try {
    baselineCommit = (await runComparisonGit(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${baselineRef}^{commit}`], signal)).trim();
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new Error(`Baseline "${compareRef}" is not available locally. Fetch the required ref/history with Git, or use --compare origin/main --fetch.`);
  }
  const currentBranch = (await runComparisonGit(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal, [0, 1])).trim() || null;
  const currentDirty = (await runComparisonGit(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], signal)).length > 0;
  const baselineInputFingerprint = (await runComparisonGit(repositoryRoot, ['rev-parse', `${baselineCommit}^{tree}`], signal)).trim();
  return {
    repositoryRoot,
    appRelativePath,
    currentCommit,
    currentBranch,
    currentDirty,
    currentLabel: currentBranch || `HEAD ${currentCommit.slice(0, 8)}`,
    baselineCommit,
    baselineLabel: compareRef,
    baselineInputFingerprint,
    refs: await comparisonRefs(repositoryRoot, signal),
    indexFingerprint: await comparisonIndexFingerprint(repositoryRoot, signal),
  };
}
