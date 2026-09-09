import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as subprocess from '../../../../CLI/scripts/sight-compare/process';
import {
  comparisonGitEnvironment,
  comparisonIndexFingerprint,
  inspectComparisonRepository,
} from '../../../../CLI/scripts/sight-compare/git';

describe('Sight Git baseline selection', () => {
  const roots: string[] = [];
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  const directory = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-git-test-'));
    roots.push(root);
    return root;
  };
  const fixture = (commit = true) => {
    const root = directory();
    git(root, ['init', '--initial-branch=main']);
    git(root, ['config', 'user.email', 'sight@example.test']);
    git(root, ['config', 'user.name', 'Sight Test']);
    git(root, ['config', 'commit.gpgSign', 'false']);
    if (commit) {
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'initial']);
    }
    return root;
  };
  afterEach(() => {
    jest.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves a local branch, tag and detached HEAD without consulting a remote', async () => {
    const root = fixture();
    const initial = git(root, ['rev-parse', 'HEAD']);
    git(root, ['tag', '-a', 'release', '-m', 'release']);
    git(root, ['remote', 'add', 'origin', 'https://invalid.example/repo.git']);
    git(root, ['update-ref', 'refs/remotes/origin/main', initial]);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"new"}');
    git(root, ['commit', '-am', 'next']);
    const next = git(root, ['rev-parse', 'HEAD']);
    const local = await inspectComparisonRepository(root, 'main');
    expect(local).toMatchObject({ currentCommit: next, baselineCommit: next, currentBranch: 'main', currentDirty: false, currentLabel: 'main', baselineLabel: 'main', appRelativePath: '' });
    expect((await inspectComparisonRepository(root, 'origin/main')).baselineCommit).toBe(initial);
    expect((await inspectComparisonRepository(root, 'release')).baselineCommit).toBe(initial);
    git(root, ['checkout', '--detach', initial]);
    fs.writeFileSync(path.join(root, 'untracked.js'), 'change');
    const detached = await inspectComparisonRepository(root, initial);
    expect(detached.currentBranch).toBeNull();
    expect(detached.currentLabel).toBe(`HEAD ${initial.slice(0, 8)}`);
    expect(detached.currentDirty).toBe(true);
  });

  it('rejects empty/missing refs and an unborn HEAD clearly', async () => {
    const root = fixture();
    await expect(inspectComparisonRepository(root, '')).rejects.toThrow('nonempty');
    await expect(inspectComparisonRepository(root, 'bad\0ref')).rejects.toThrow('nonempty');
    await expect(inspectComparisonRepository(root, 'missing')).rejects.toThrow('not available locally');
    await expect(inspectComparisonRepository(fixture(false), 'main')).rejects.toThrow('existing HEAD');
  });

  it('rejects sparse, partial and unmerged repositories', async () => {
    const root = fixture();
    git(root, ['config', 'core.sparseCheckout', 'true']);
    await expect(inspectComparisonRepository(root, 'main')).rejects.toThrow('sparse');
    git(root, ['config', 'core.sparseCheckout', 'false']);
    git(root, ['config', 'remote.origin.promisor', 'true']);
    await expect(inspectComparisonRepository(root, 'main')).rejects.toThrow('partial');
    git(root, ['config', '--unset', 'remote.origin.promisor']);
    git(root, ['config', 'extensions.partialclone', 'origin']);
    await expect(inspectComparisonRepository(root, 'main')).rejects.toThrow('partial');
    git(root, ['config', '--unset', 'extensions.partialclone']);
    git(root, ['branch', 'other']);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"main"}');
    git(root, ['commit', '-am', 'main']);
    git(root, ['checkout', 'other']);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"other"}');
    git(root, ['commit', '-am', 'other']);
    try { git(root, ['merge', 'main']); } catch { /* Intentional conflict. */ }
    await expect(inspectComparisonRepository(root, 'main')).rejects.toThrow('merge conflicts');
  });

  it('fetches only an explicit configured remote branch through ordinary Git', async () => {
    const remote = fixture();
    const local = fixture();
    git(local, ['remote', 'add', 'upstream', remote]);
    const before = git(local, ['rev-parse', 'HEAD']);
    git(remote, ['tag', 'do-not-fetch']);
    fs.writeFileSync(path.join(remote, 'added.js'), 'addition');
    git(remote, ['add', '.']);
    git(remote, ['commit', '-m', 'remote update']);
    const result = await inspectComparisonRepository(local, 'upstream/main', { fetch: true });
    expect(result.baselineCommit).toBe(git(remote, ['rev-parse', 'HEAD']));
    expect(git(local, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(local, ['tag'])).toBe('');
    expect(git(local, ['status', '--porcelain'])).toBe('');
    expect((await inspectComparisonRepository(local, 'refs/remotes/upstream/main', { fetch: true })).baselineCommit).toBe(result.baselineCommit);
    await expect(inspectComparisonRepository(local, 'main', { fetch: true })).rejects.toThrow('explicit configured remote');
    await expect(inspectComparisonRepository(local, 'upstream/main~1', { fetch: true })).rejects.toThrow('failed');
    await expect(inspectComparisonRepository(local, 'upstream/missing', { fetch: true })).rejects.toThrow('failed');
    git(local, ['remote', 'add', 'upstream/team', remote]);
    await expect(inspectComparisonRepository(local, 'upstream/team/main', { fetch: true })).rejects.toThrow('explicit configured remote');
  });

  it('does not refresh any remote when no fetch flag was provided', async () => {
    const root = fixture();
    const run = jest.spyOn(subprocess, 'runComparisonProcess');
    await inspectComparisonRepository(root, 'main');
    expect(run.mock.calls.some(([options]) => options.args.includes('fetch'))).toBe(false);
    expect(run.mock.calls.every(([options]) => options.env.GIT_OPTIONAL_LOCKS === '0')).toBe(true);
  });

  it('does not inherit Git filesystem overrides', () => {
    const previous = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = '/original/index';
    expect(comparisonGitEnvironment().GIT_INDEX_FILE).toBeUndefined();
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  });

  it('fingerprints a missing index and supports an app nested within the repository', async () => {
    const root = fixture(false);
    expect(await comparisonIndexFingerprint(root)).toHaveLength(64);
    fs.mkdirSync(path.join(root, 'apps', 'mobile'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'mobile', 'package.json'), '{}');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'app']);
    expect((await inspectComparisonRepository(path.join(root, 'apps', 'mobile'), 'main')).appRelativePath).toBe(path.join('apps', 'mobile'));
  });

  it('preserves abort errors while resolving commits', async () => {
    const root = fixture();
    const original = subprocess.runComparisonProcess;
    for (const ref of ['HEAD^{commit}', 'main^{commit}']) {
      jest.spyOn(subprocess, 'runComparisonProcess').mockImplementation(options => {
        if (options.args.includes(ref)) return Promise.reject(subprocess.comparisonAbortError());
        return original(options);
      });
      await expect(inspectComparisonRepository(root, 'main')).rejects.toMatchObject({ name: 'AbortError' });
      jest.restoreAllMocks();
    }
  });

  it('rejects an app whose resolved path is outside the discovered root', async () => {
    const root = fixture();
    const external = directory();
    const original = subprocess.runComparisonProcess;
    jest.spyOn(subprocess, 'runComparisonProcess').mockImplementation(options => options.args.includes('--show-toplevel')
      ? Promise.resolve({ stdout: `${external}\n`, stderr: '', exitCode: 0 })
      : original(options));
    await expect(inspectComparisonRepository(root, 'main')).rejects.toThrow('inside its Git repository');
  });
});
