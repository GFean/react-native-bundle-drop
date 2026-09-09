import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as gitTools from '../../../../CLI/scripts/sight-compare/git';
import { createComparisonSnapshots, type ComparisonSnapshots } from '../../../../CLI/scripts/sight-compare/snapshot';

jest.setTimeout(15000);

describe('Sight isolated Git snapshots', () => {
  const roots: string[] = [];
  const snapshots: ComparisonSnapshots[] = [];
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  const directory = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-snapshot-test-'));
    roots.push(root);
    return root;
  };
  const write = (root: string, name: string, content = name) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  };
  const fixture = () => {
    const root = directory();
    git(root, ['init', '--initial-branch=main']);
    git(root, ['config', 'user.email', 'sight@example.test']);
    git(root, ['config', 'user.name', 'Sight Test']);
    git(root, ['config', 'commit.gpgSign', 'false']);
    write(root, 'package.json', '{}');
    write(root, 'index.js', 'baseline');
    write(root, '.gitignore', 'node_modules/\n.env*\nignored/\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'initial']);
    git(root, ['tag', 'baseline']);
    return root;
  };
  const capture = async (root: string, options: Partial<Parameters<typeof createComparisonSnapshots>[0]> = {}) => {
    const snapshot = await createComparisonSnapshots({ projectRoot: root, compareRef: 'baseline', ...options });
    snapshots.push(snapshot);
    return snapshot;
  };
  const state = (root: string) => ({
    head: git(root, ['rev-parse', 'HEAD']),
    status: git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    index: fs.readFileSync(path.join(root, '.git', 'index')),
    config: fs.readFileSync(path.join(root, '.git', 'config')),
    refs: git(root, ['show-ref']),
    worktrees: git(root, ['worktree', 'list', '--porcelain']),
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const snapshot of snapshots.splice(0)) await snapshot.cleanup();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('freezes actual dirty source, additions/deletions and in-repo workspace inputs without changing the original', async () => {
    const root = fixture();
    write(root, 'deleted.js');
    write(root, 'unstaged-delete.js');
    write(root, 'renamed-before.js');
    write(root, 'packages/shared/index.js', 'shared source');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'current HEAD']);
    write(root, 'index.js', 'staged');
    git(root, ['add', 'index.js']);
    write(root, 'index.js', 'actual current');
    git(root, ['rm', 'deleted.js']);
    fs.unlinkSync(path.join(root, 'unstaged-delete.js'));
    git(root, ['mv', 'renamed-before.js', 'renamed-after.js']);
    write(root, 'untracked space\nand newline.js', 'untracked source');
    write(root, 'executable.sh', '#!/bin/sh\n');
    fs.chmodSync(path.join(root, 'executable.sh'), 0o755);
    write(root, 'node_modules/ignore/index.js', 'installed dependencies');
    write(root, '.env.local', 'ignored secret');
    write(root, '.bundle-drop/sight/old/bundle.js', 'old generated output');
    write(root, 'dist/tracked-build-input.js', 'valid build input');
    git(root, ['add', 'dist/tracked-build-input.js']);
    fs.symlinkSync('packages/shared/index.js', path.join(root, 'internal-link.js'));
    const before = state(root);
    const snapshot = await capture(root);
    expect(fs.readFileSync(path.join(snapshot.currentRoot, 'index.js'), 'utf8')).toBe('actual current');
    expect(fs.readFileSync(path.join(snapshot.baselineRoot, 'index.js'), 'utf8')).toBe('baseline');
    expect(fs.existsSync(path.join(snapshot.currentRoot, 'deleted.js'))).toBe(false);
    expect(fs.existsSync(path.join(snapshot.currentRoot, 'unstaged-delete.js'))).toBe(false);
    expect(fs.existsSync(path.join(snapshot.currentRoot, 'renamed-before.js'))).toBe(false);
    expect(fs.existsSync(path.join(snapshot.currentRoot, 'renamed-after.js'))).toBe(true);
    expect(fs.readlinkSync(path.join(snapshot.currentRoot, 'internal-link.js'))).toBe('packages/shared/index.js');
    expect(fs.statSync(path.join(snapshot.currentRoot, 'executable.sh')).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(snapshot.currentRoot, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(snapshot.currentRoot, '.env.local'))).toBe(false);
    expect(fs.existsSync(path.join(snapshot.currentRoot, '.bundle-drop/sight'))).toBe(false);
    expect(fs.readFileSync(path.join(snapshot.currentRoot, 'dist/tracked-build-input.js'), 'utf8')).toBe('valid build input');
    expect(snapshot.currentDirty).toBe(true);
    expect(git(snapshot.currentRoot, ['rev-parse', 'HEAD'])).toBe(before.head);
    expect(git(snapshot.baselineRoot, ['rev-parse', 'HEAD'])).toBe(git(root, ['rev-parse', 'baseline']));
    expect(git(snapshot.currentRoot, ['show-ref'])).toBe(before.refs);
    expect(git(snapshot.currentRoot, ['remote'])).toBe('');
    git(snapshot.currentRoot, ['config', 'core.hooksPath', 'private-hook-path']);
    write(snapshot.currentRoot, 'index.js', 'build writes privately');
    write(root, 'index.js', 'edited after capture');
    expect(fs.readFileSync(path.join(snapshot.currentRoot, 'index.js'), 'utf8')).toBe('build writes privately');
    write(root, 'index.js', 'actual current');
    expect(state(root)).toEqual(before);
    await snapshot.assertIdentity();
    await snapshot.cleanup();
    await snapshot.cleanup();
    expect(fs.existsSync(snapshot.directory)).toBe(false);
    expect(state(root)).toEqual(before);
  });

  it('copies explicitly included ignored files identically on both sides', async () => {
    const root = fixture();
    write(root, 'ignored/settings.json', '{"shared":true}');
    write(root, '.env.local', 'SETTING=value');
    const snapshot = await capture(root, { include: ['ignored', '.env.local', '.env.local'] });
    expect(snapshot.includedPaths).toEqual(['.env.local', 'ignored/settings.json']);
    for (const side of [snapshot.currentRoot, snapshot.baselineRoot]) {
      expect(fs.readFileSync(path.join(side, '.env.local'), 'utf8')).toBe('SETTING=value');
      expect(fs.readFileSync(path.join(side, 'ignored/settings.json'), 'utf8')).toBe('{"shared":true}');
    }
    write(root, '.env.local', 'later');
    expect(fs.readFileSync(path.join(snapshot.baselineRoot, '.env.local'), 'utf8')).toBe('SETTING=value');
  });

  it.each(['file-to-directory', 'directory-to-file'])('captures unstaged %s replacements', async replacement => {
    const root = fixture();
    const originalPath = replacement === 'file-to-directory' ? 'feature' : 'feature/index.js';
    const replacementPath = replacement === 'file-to-directory' ? 'feature/index.js' : 'feature';
    write(root, originalPath, 'original');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'original feature']);
    fs.rmSync(path.join(root, 'feature'), { recursive: true });
    write(root, replacementPath, 'replacement');
    const before = state(root);
    const snapshot = await capture(root, { compareRef: 'HEAD' });
    expect(fs.readFileSync(path.join(snapshot.currentRoot, replacementPath), 'utf8')).toBe('replacement');
    expect(fs.readFileSync(path.join(snapshot.baselineRoot, originalPath), 'utf8')).toBe('original');
    expect(state(root)).toEqual(before);
  });

  it.each(['relative', 'absolute'])('resolves baseline %s symlinks to explicitly included ignored targets', async kind => {
    const root = fixture();
    write(root, 'ignored/settings.json', '{"shared":true}');
    const target = kind === 'absolute' ? path.join(root, 'ignored/settings.json') : 'ignored/settings.json';
    fs.symlinkSync(target, path.join(root, 'settings.json'));
    git(root, ['add', 'settings.json']);
    git(root, ['commit', '-m', 'configuration symlink']);
    const snapshot = await capture(root, { compareRef: 'HEAD', include: ['ignored/settings.json'] });
    for (const side of [snapshot.currentRoot, snapshot.baselineRoot]) {
      expect(fs.readFileSync(path.join(side, 'settings.json'), 'utf8')).toBe('{"shared":true}');
      expect(fs.readlinkSync(path.join(side, 'settings.json'))).toBe('ignored/settings.json');
    }
  });

  it('produces stable fingerprints for identical input and private object storage', async () => {
    const root = fixture();
    const first = await capture(root);
    const second = await capture(root);
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.currentDirty).toBe(false);
    expect(first.baselineInputFingerprint).toBe(git(root, ['rev-parse', 'baseline^{tree}']));
    const object = first.currentCommit;
    const sourceObject = path.join(root, '.git', 'objects', object.slice(0, 2), object.slice(2));
    const privateObject = path.join(first.directory, 'repository.git', 'objects', object.slice(0, 2), object.slice(2));
    expect(fs.statSync(sourceObject).ino).not.toBe(fs.statSync(privateObject).ino);
    expect(fs.existsSync(path.join(first.directory, 'repository.git', 'objects', 'info', 'alternates'))).toBe(false);
  });

  it('preserves monorepo app paths and absolute internal symlinks as relative links', async () => {
    const root = fixture();
    write(root, 'apps/mobile/package.json', '{}');
    write(root, 'packages/shared/index.js', 'shared');
    fs.symlinkSync(path.join(root, 'packages/shared'), path.join(root, 'shared-link'));
    fs.symlinkSync(path.join(root, 'packages/shared/index.js'), path.join(root, 'shared-file-link'));
    fs.symlinkSync('packages/shared/index.js', path.join(root, 'relative-file-link'));
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'monorepo']);
    const snapshot = await capture(path.join(root, 'apps/mobile'), { compareRef: 'HEAD' });
    expect(snapshot.currentProjectRoot).toBe(path.join(snapshot.currentRoot, 'apps/mobile'));
    expect(snapshot.baselineProjectRoot).toBe(path.join(snapshot.baselineRoot, 'apps/mobile'));
    expect(fs.readlinkSync(path.join(snapshot.currentRoot, 'shared-link'))).toBe('packages/shared');
  });

  it('preserves relative symlink text and chains without making a pristine revision dirty', async () => {
    const root = fixture();
    write(root, 'target.js', 'module.exports = true;');
    fs.symlinkSync('./target.js', path.join(root, 'alias.js'));
    fs.symlinkSync('alias.js', path.join(root, 'chain.js'));
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'relative symlinks']);
    const snapshot = await capture(root, { compareRef: 'HEAD' });
    for (const side of [snapshot.currentRoot, snapshot.baselineRoot]) {
      expect(fs.readlinkSync(path.join(side, 'alias.js'))).toBe('./target.js');
      expect(fs.readlinkSync(path.join(side, 'chain.js'))).toBe('alias.js');
      expect(fs.readFileSync(path.join(side, 'chain.js'), 'utf8')).toBe('module.exports = true;');
      expect(git(side, ['status', '--porcelain=v1'])).toBe('');
    }
  });

  it('preserves Git core.symlinks=false checkout semantics', async () => {
    const root = fixture();
    fs.symlinkSync('index.js', path.join(root, 'link.js'));
    git(root, ['add', 'link.js']);
    git(root, ['commit', '-m', 'Git symlink']);
    git(root, ['config', 'core.symlinks', 'false']);
    fs.unlinkSync(path.join(root, 'link.js'));
    git(root, ['checkout-index', '--force', '--', 'link.js']);
    expect(fs.lstatSync(path.join(root, 'link.js')).isSymbolicLink()).toBe(false);
    const snapshot = await capture(root, { compareRef: 'HEAD' });
    for (const side of [snapshot.currentRoot, snapshot.baselineRoot]) {
      expect(fs.lstatSync(path.join(side, 'link.js')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(side, 'link.js'), 'utf8')).toBe('index.js');
      expect(git(side, ['status', '--porcelain=v1'])).toBe('');
    }
  });

  it.each(['', '/absolute', '../outside', '.', '.git', 'node_modules', '.bundle-drop/sight', 'package.json', 'pnpm-lock.yaml'])('rejects unsafe --include %p', async include => {
    const root = fixture();
    await expect(capture(root, { include: [include] })).rejects.toThrow(/include|Unsafe/);
  });

  it('rejects includes colliding with tracked files on either revision', async () => {
    const root = fixture();
    await expect(capture(root, { include: ['index.js'] })).rejects.toThrow('tracked input');
    git(root, ['rm', 'index.js']);
    git(root, ['commit', '-m', 'remove']);
    write(root, 'index.js', 'locally resurrected');
    await expect(capture(root, { include: ['index.js'] })).rejects.toThrow('tracked input');
  });

  it('rejects external symlinks, uncaptured link targets, LFS pointers and special files', async () => {
    const root = fixture();
    const external = directory();
    fs.symlinkSync(external, path.join(root, 'link'));
    await expect(capture(root)).rejects.toThrow('External symlink');
    fs.unlinkSync(path.join(root, 'link'));
    write(root, 'ignored/target.js', 'ignored target');
    fs.symlinkSync('ignored/target.js', path.join(root, 'link'));
    await expect(capture(root)).rejects.toThrow('target was not captured');
    fs.unlinkSync(path.join(root, 'link'));
    write(root, 'lfs.js', 'version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 4\n');
    await expect(capture(root)).rejects.toThrow('LFS pointer');
    fs.unlinkSync(path.join(root, 'lfs.js'));
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    await expect(capture(root, { include: ['pipe'] })).rejects.toThrow('regular file');
  });

  it('rejects checkout filters before they can run', async () => {
    const root = fixture();
    write(root, '.gitattributes', '*.js filter=sight-malicious\n');
    git(root, ['add', '.gitattributes']);
    git(root, ['commit', '-m', 'filter']);
    git(root, ['config', 'filter.sight-malicious.smudge', 'false']);
    const before = state(root);
    await expect(capture(root, { compareRef: 'HEAD' })).rejects.toThrow('checkout filters');
    expect(state(root)).toEqual(before);
  });

  it('rejects relevant submodules and tracked dependencies but allows an unrelated gitlink', async () => {
    const root = fixture();
    const commit = git(root, ['rev-parse', 'HEAD']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${commit},nested`]);
    await expect(capture(root)).rejects.toThrow('submodule');
    git(root, ['reset', '--', 'nested']);
    write(root, 'apps/mobile/package.json', '{}');
    git(root, ['add', '.']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${commit},docs/external`]);
    git(root, ['commit', '-m', 'unrelated docs submodule']);
    const snapshot = await capture(path.join(root, 'apps/mobile'), { compareRef: 'HEAD' });
    expect(fs.existsSync(path.join(snapshot.currentProjectRoot, 'package.json'))).toBe(true);
    write(root, 'node_modules/tracked.js');
    git(root, ['add', '-f', 'node_modules/tracked.js']);
    await expect(capture(path.join(root, 'apps/mobile'), { compareRef: 'HEAD' })).rejects.toThrow('Tracked node_modules');
  });

  it('refuses a missing baseline app and detects build changes to either HEAD or private refs', async () => {
    const root = fixture();
    write(root, 'apps/new/package.json', '{}');
    await expect(capture(path.join(root, 'apps/new'))).rejects.toThrow('missing at the baseline');
    const snapshot = await capture(root);
    git(snapshot.currentRoot, ['update-ref', 'refs/heads/unexpected', snapshot.currentCommit]);
    await expect(snapshot.assertIdentity()).rejects.toThrow('changed its Git HEAD or refs');
    git(snapshot.currentRoot, ['update-ref', '-d', 'refs/heads/unexpected']);
    git(snapshot.currentRoot, ['config', 'user.name', 'Test']);
    git(snapshot.currentRoot, ['config', 'user.email', 'sight@example.test']);
    git(snapshot.currentRoot, ['-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'bad build commit']);
    await expect(snapshot.assertIdentity()).rejects.toThrow('changed its Git HEAD or refs');
  });

  it('detects files, index or HEAD changing during capture and cleans partial temporary directories', async () => {
    for (const change of ['file', 'index', 'head']) {
      const root = fixture();
      const original = gitTools.runComparisonGit;
      let enumerations = 0;
      jest.spyOn(gitTools, 'runComparisonGit').mockImplementation(async (cwd, args, ...rest) => {
        if (args.includes('--others') && ++enumerations === 2) {
          if (change === 'file') write(root, 'index.js', 'changed mid snapshot');
          if (change === 'index') { write(root, 'other.js'); git(root, ['add', 'other.js']); }
          if (change === 'head') git(root, ['-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'moved']);
        }
        return original(cwd, args, ...rest);
      });
      await expect(capture(root)).rejects.toThrow('changed while Sight captured');
      jest.restoreAllMocks();
    }
  });

  it.each(['refs', 'abort', 'checkout'])('cleans up and preserves the checkout after %s failure', async failure => {
    const root = fixture();
    const before = state(root);
    const controller = new AbortController();
    const original = gitTools.runComparisonGit;
    let temporaryDirectory: string | undefined;
    jest.spyOn(gitTools, 'runComparisonGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args.includes('clone')) temporaryDirectory = path.dirname(args[args.length - 1]);
      if (args.includes('clone') && failure === 'refs') git(root, ['tag', 'concurrent']);
      if (args.includes('read-tree') && failure === 'abort') controller.abort();
      if (args.includes('checkout-index') && failure === 'checkout') throw new Error('checkout failed');
      return original(cwd, args, ...rest);
    });
    await expect(capture(root, { signal: controller.signal })).rejects.toThrow(failure === 'refs' ? 'Git refs changed' : failure === 'abort' ? 'cancelled' : 'checkout failed');
    expect(fs.existsSync(temporaryDirectory!)).toBe(false);
    if (failure === 'refs') git(root, ['tag', '-d', 'concurrent']);
    expect(state(root)).toEqual(before);
  });

  it('supports an empty current commit whose new app files are still untracked', async () => {
    const root = fixture();
    git(root, ['rm', '--cached', '-r', '.']);
    git(root, ['commit', '-m', 'empty tree']);
    const snapshot = await capture(root);
    expect(fs.readFileSync(path.join(snapshot.currentRoot, 'package.json'), 'utf8')).toBe('{}');
  });

  it('rejects path traversal and a parent directory replaced by a symlink during capture', async () => {
    for (const failure of ['traversal', 'parent-link']) {
      const root = fixture();
      const external = directory();
      write(root, 'nested/source.js', 'inside');
      write(external, 'source.js', 'outside');
      git(root, ['add', 'nested/source.js']);
      const original = gitTools.runComparisonGit;
      jest.spyOn(gitTools, 'runComparisonGit').mockImplementation(async (cwd, args, ...rest) => {
        const result = await original(cwd, args, ...rest);
        if (args.includes('--others')) {
          if (failure === 'traversal') return `${result}../outside\0`;
          fs.rmSync(path.join(root, 'nested'), { recursive: true });
          fs.symlinkSync(external, path.join(root, 'nested'));
        }
        return result;
      });
      await expect(capture(root)).rejects.toThrow(failure === 'traversal' ? 'Unsafe snapshot path' : 'escapes the repository');
      jest.restoreAllMocks();
    }
  });

  it('reports unreadable files and preserves both build and cleanup errors', async () => {
    const root = fixture();
    const originalLstat = fs.lstatSync;
    jest.spyOn(fs, 'lstatSync').mockImplementation(((filename: fs.PathLike, ...rest: unknown[]) => {
      if (String(filename).endsWith('/index.js')) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return (originalLstat as Function)(filename, ...rest);
    }) as typeof fs.lstatSync);
    await expect(capture(root)).rejects.toThrow('unreadable');
    jest.restoreAllMocks();
    const originalGit = gitTools.runComparisonGit;
    let temporaryDirectory = '';
    jest.spyOn(gitTools, 'runComparisonGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args.includes('clone')) { temporaryDirectory = path.dirname(args[args.length - 1]); roots.push(temporaryDirectory); }
      if (args.includes('checkout-index')) throw new Error('build preparation failed');
      return originalGit(cwd, args, ...rest);
    });
    const originalRm = fs.rmSync;
    jest.spyOn(fs, 'rmSync').mockImplementation((filename, options) => {
      if (String(filename) === temporaryDirectory) throw new Error('cleanup denied');
      return originalRm(filename, options);
    });
    await expect(capture(root)).rejects.toThrow(/build preparation failed\nCould not remove .*cleanup denied/);
  });

  it('cleans its whole private repository even if git worktree remove fails', async () => {
    const root = fixture();
    const snapshot = await capture(root);
    const original = gitTools.runComparisonGit;
    jest.spyOn(gitTools, 'runComparisonGit').mockImplementation((cwd, args, ...rest) => {
      if (args.includes('remove')) throw new Error('private Git damaged by a build');
      return original(cwd, args, ...rest);
    });
    await snapshot.cleanup();
    expect(fs.existsSync(snapshot.directory)).toBe(false);
  });

  it('dissociates a source with borrowed objects and supports an available shallow baseline', async () => {
    const source = fixture();
    const borrowed = directory();
    git(source, ['clone', '--shared', source, borrowed]);
    const snapshot = await capture(borrowed);
    expect(fs.existsSync(path.join(snapshot.directory, 'repository.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(git(snapshot.baselineRoot, ['show', 'HEAD:index.js'])).toBe('baseline');
    const shallow = directory();
    git(source, ['clone', '--depth=1', `file://${source}`, shallow]);
    const shallowSnapshot = await capture(shallow, { compareRef: 'HEAD' });
    expect(shallowSnapshot.currentCommit).toBe(shallowSnapshot.baselineCommit);
  });
});
