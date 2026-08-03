import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateExpoExportOutput } from '../../expo';
import {
  assertSafeExpoExportRelativePaths,
} from '../../expo/exportValidation';

function createValidExport(): {
  root: string;
  bundlePath: string;
  sourceMapPath: string;
  assetsDirectory: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-export-validation-'));
  const bundlePath = path.join(root, 'main.jsbundle');
  const sourceMapPath = path.join(root, 'main.jsbundle.map');
  const assetsDirectory = path.join(root, 'assets');
  fs.mkdirSync(assetsDirectory);
  fs.writeFileSync(bundlePath, 'bundle');
  fs.writeFileSync(sourceMapPath, JSON.stringify({ version: 3, debugId: 'debug-id' }));
  fs.writeFileSync(path.join(assetsDirectory, 'icon.png'), 'icon');
  return { root, bundlePath, sourceMapPath, assetsDirectory };
}

describe('Expo export validation', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const validExport = (): ReturnType<typeof createValidExport> => {
    const value = createValidExport();
    roots.push(value.root);
    return value;
  };

  it('accepts regular files and preserves source-map debug IDs', () => {
    const value = validExport();
    expect(
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: value.bundlePath,
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: value.assetsDirectory,
      }),
    ).toEqual({
      files: ['assets/icon.png', 'main.jsbundle', 'main.jsbundle.map'],
      sourceMapDebugId: 'debug-id',
    });

    fs.writeFileSync(value.sourceMapPath, JSON.stringify({ version: 3, debug_id: 'legacy-debug' }));
    expect(
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: value.bundlePath,
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: value.assetsDirectory,
      }).sourceMapDebugId,
    ).toBe('legacy-debug');

    fs.writeFileSync(value.sourceMapPath, JSON.stringify({ version: 3 }));
    expect(
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: value.bundlePath,
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: value.assetsDirectory,
      }).sourceMapDebugId,
    ).toBeUndefined();
  });

  it.each([
    [[''], 'unsafe path'],
    [['/absolute'], 'unsafe path'],
    [['bad\\name'], 'unsafe path'],
    [['bad\0name'], 'unsafe path'],
    [['bad:name'], 'unsafe path'],
    [['bad\u001fname'], 'unsafe path'],
    [['assets//icon.png'], 'traversing path'],
    [['assets/../icon.png'], 'traversing path'],
    [['assets/./icon.png'], 'traversing path'],
    [['assets/name.'], 'traversing path'],
    [['assets/name '], 'traversing path'],
    [['assets/CON.png'], 'traversing path'],
    [['Icon.png', 'icon.png'], 'path collision'],
    [['café.png', 'cafe\u0301.png'], 'path collision'],
  ])('rejects non-portable path set %#', (paths, message) => {
    expect(() => assertSafeExpoExportRelativePaths(paths)).toThrow(message);
  });

  it('rejects symlinks anywhere in the output', () => {
    const outputLink = validExport();
    const linkedRoot = `${outputLink.root}-link`;
    roots.push(linkedRoot);
    fs.symlinkSync(outputLink.root, linkedRoot);
    expect(() =>
      validateExpoExportOutput({
        outputDirectory: linkedRoot,
        bundlePath: path.join(linkedRoot, 'main.jsbundle'),
        sourceMapPath: path.join(linkedRoot, 'main.jsbundle.map'),
        assetsDirectory: path.join(linkedRoot, 'assets'),
      }),
    ).toThrow('not a symlink');

    const nestedLink = validExport();
    fs.symlinkSync(nestedLink.bundlePath, path.join(nestedLink.assetsDirectory, 'linked.png'));
    expect(() =>
      validateExpoExportOutput({
        outputDirectory: nestedLink.root,
        bundlePath: nestedLink.bundlePath,
        sourceMapPath: nestedLink.sourceMapPath,
        assetsDirectory: nestedLink.assetsDirectory,
      }),
    ).toThrow('contains a symbolic link');
  });

  it('rejects missing, empty, directory, symlinked, and escaping role files', () => {
    const value = validExport();
    fs.writeFileSync(value.bundlePath, '');
    expect(() =>
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: value.bundlePath,
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: value.assetsDirectory,
      }),
    ).toThrow('non-empty regular file');

    fs.rmSync(value.bundlePath);
    fs.mkdirSync(value.bundlePath);
    expect(() =>
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: value.bundlePath,
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: value.assetsDirectory,
      }),
    ).toThrow('non-empty regular file');

    expect(() =>
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: path.join(value.root, '..', 'outside.js'),
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: value.assetsDirectory,
      }),
    ).toThrow('outside the Expo export directory');
  });

  it('rejects invalid or escaping asset directories', () => {
    const value = validExport();
    expect(() =>
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: value.bundlePath,
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: path.dirname(value.root),
      }),
    ).toThrow('outside the export directory');

    fs.rmSync(value.assetsDirectory, { recursive: true });
    fs.writeFileSync(value.assetsDirectory, 'not-directory');
    expect(() =>
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: value.bundlePath,
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: value.assetsDirectory,
      }),
    ).toThrow('must be a real directory');
  });

  it.each([
    ['not-json', 'malformed source map'],
    [JSON.stringify(null), 'version 3 source map'],
    [JSON.stringify({ version: 2 }), 'version 3 source map'],
    [JSON.stringify({ version: 3, debugId: 4 }), 'malformed debug ID'],
  ])('rejects bad source map: %s', (sourceMap, message) => {
    const value = validExport();
    fs.writeFileSync(value.sourceMapPath, sourceMap);
    expect(() =>
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: value.bundlePath,
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: value.assetsDirectory,
      }),
    ).toThrow(message);
  });

  it('rejects unsupported filesystem entries', () => {
    const value = validExport();
    const fifoPath = path.join(value.assetsDirectory, 'asset.pipe');
    childProcess.execFileSync('mkfifo', [fifoPath]);
    expect(() =>
      validateExpoExportOutput({
        outputDirectory: value.root,
        bundlePath: value.bundlePath,
        sourceMapPath: value.sourceMapPath,
        assetsDirectory: value.assetsDirectory,
      }),
    ).toThrow('unsupported file type');
  });
});
