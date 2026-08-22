import fs from 'fs';
import type { Stats } from 'fs';
import path from 'path';

import {
  createSafeBackupDirectory,
  inspectProjectDirectory,
  inspectProjectFile,
  removeProjectFile,
  restoreProjectFile,
  writeBackupFile,
  writeProjectFileAtomically,
} from '../../../CLI/scripts/safe-file-transaction';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

describe('CLI/scripts/safe-file-transaction', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = createTempProjectDir();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    removeTempDir(projectRoot);
  });

  it('inspects missing and regular project paths without creating anything', () => {
    expect(inspectProjectFile(projectRoot, 'missing/file.txt')).toEqual({
      exists: false,
      content: '',
      mode: 0o666,
    });
    expect(inspectProjectDirectory(projectRoot, 'missing/directory')).toBe(false);

    fs.mkdirSync(path.join(projectRoot, 'config'));
    fs.writeFileSync(path.join(projectRoot, 'config/value.txt'), 'value');
    fs.chmodSync(path.join(projectRoot, 'config/value.txt'), 0o640);

    expect(inspectProjectDirectory(projectRoot, 'config')).toBe(true);
    expect(inspectProjectFile(projectRoot, 'config/value.txt')).toEqual({
      exists: true,
      content: 'value',
      mode: 0o640,
    });
  });

  it.each(['', '/absolute.txt', '../outside.txt', 'nested\\file.txt'])(
    'rejects unsafe relative path %p',
    relativePath => {
      expect(() => inspectProjectFile(projectRoot, relativePath)).toThrow(
        'Refusing unsafe transaction path',
      );
    },
  );

  it('rejects non-directory roots, symlinked parents, and non-regular targets', () => {
    const rootFile = path.join(projectRoot, 'root-file');
    fs.writeFileSync(rootFile, 'not a directory');
    expect(() => inspectProjectFile(rootFile, 'child.txt')).toThrow(
      'Refusing symlinked or non-directory transaction path',
    );

    const realDirectory = path.join(projectRoot, 'real');
    fs.mkdirSync(realDirectory);
    fs.symlinkSync(realDirectory, path.join(projectRoot, 'linked'));
    expect(() => inspectProjectFile(projectRoot, 'linked/file.txt')).toThrow(
      'Refusing symlinked or non-directory transaction path',
    );

    fs.mkdirSync(path.join(projectRoot, 'directory-target'));
    expect(() => inspectProjectFile(projectRoot, 'directory-target')).toThrow(
      'Refusing symlinked or non-regular transaction target',
    );
    expect(() => inspectProjectDirectory(projectRoot, 'root-file')).toThrow(
      'Refusing symlinked or non-directory transaction target',
    );
  });

  it('propagates unexpected filesystem inspection failures', () => {
    const realLstat = fs.lstatSync.bind(fs);
    const lstat = jest.spyOn(fs, 'lstatSync').mockImplementation(targetPath => {
      if (String(targetPath).endsWith(`${path.sep}blocked.txt`)) {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return realLstat(targetPath);
    });

    expect(() => inspectProjectFile(projectRoot, 'blocked.txt')).toThrow('permission denied');
    lstat.mockRestore();
  });

  it('rejects a target that changes away from a regular file after opening', () => {
    fs.writeFileSync(path.join(projectRoot, 'value.txt'), 'value');
    jest.spyOn(fs, 'fstatSync').mockReturnValueOnce({
      isFile: () => false,
    } as Stats);

    expect(() => inspectProjectFile(projectRoot, 'value.txt')).toThrow(
      'Refusing symlinked or non-regular transaction target',
    );
  });

  it('creates and replaces files atomically while preserving the existing mode', () => {
    writeProjectFileAtomically(projectRoot, 'nested/value.txt', 'first', 0o600);
    expect(fs.readFileSync(path.join(projectRoot, 'nested/value.txt'), 'utf8')).toBe('first');
    expect(fs.statSync(path.join(projectRoot, 'nested/value.txt')).mode & 0o777).toBe(0o600);

    writeProjectFileAtomically(projectRoot, 'nested/value.txt', 'second', 0o666);
    expect(fs.readFileSync(path.join(projectRoot, 'nested/value.txt'), 'utf8')).toBe('second');
    expect(fs.statSync(path.join(projectRoot, 'nested/value.txt')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(projectRoot, 'nested'))).toEqual(['value.txt']);
  });

  it('cleans the exclusive temporary file when the final rename fails', () => {
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    expect(() => writeProjectFileAtomically(projectRoot, 'value.txt', 'content')).toThrow(
      'rename failed',
    );
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(projectRoot).filter(file => file.includes('.bundledrop-'))).toEqual([]);
  });

  it('backs up, restores, and removes project files with exact content and mode', () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), 'original');
    fs.chmodSync(path.join(projectRoot, 'package.json'), 0o640);
    const backupRoot = createSafeBackupDirectory(projectRoot, 'dependency');

    writeBackupFile(backupRoot, 'package.json', 'original', 0o640);
    writeProjectFileAtomically(projectRoot, 'package.json', 'changed');
    restoreProjectFile(projectRoot, backupRoot, 'package.json');

    expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe('original');
    expect(fs.statSync(path.join(projectRoot, 'package.json')).mode & 0o777).toBe(0o640);
    expect(() => writeBackupFile(backupRoot, 'package.json', 'duplicate', 0o600)).toThrow();

    removeProjectFile(projectRoot, 'package.json');
    removeProjectFile(projectRoot, 'package.json');
    expect(fs.existsSync(path.join(projectRoot, 'package.json'))).toBe(false);
  });

  it('refuses restore when the requested backup is absent', () => {
    const backupRoot = createSafeBackupDirectory(projectRoot, 'missing');

    expect(() => restoreProjectFile(projectRoot, backupRoot, 'package.json')).toThrow(
      'Missing transaction backup: package.json',
    );
  });
});
