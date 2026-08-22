import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type InspectedFile = {
  exists: boolean;
  content: string;
  mode: number;
};

const assertSafeRelativePath = (relativePath: string) => {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').includes('..')
  ) {
    throw new Error(`Refusing unsafe transaction path: ${relativePath}`);
  }
};

const assertRegularDirectory = (directory: string) => {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing symlinked or non-directory transaction path: ${directory}`);
  }
};

const lstatIfPresent = (targetPath: string) => {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const ensureSafeParentDirectory = (root: string, relativePath: string) => {
  assertSafeRelativePath(relativePath);
  assertRegularDirectory(root);
  const parentParts = path.dirname(relativePath).split('/').filter(part => part !== '.');
  let current = root;
  for (const part of parentParts) {
    current = path.join(current, part);
    if (!lstatIfPresent(current)) {
      fs.mkdirSync(current);
    }
    assertRegularDirectory(current);
  }
};

const hasSafeParentDirectory = (root: string, relativePath: string) => {
  assertSafeRelativePath(relativePath);
  assertRegularDirectory(root);
  const parentParts = path.dirname(relativePath).split('/').filter(part => part !== '.');
  let current = root;
  for (const part of parentParts) {
    current = path.join(current, part);
    if (!lstatIfPresent(current)) return false;
    assertRegularDirectory(current);
  }
  return true;
};

const readRegularFile = (filePath: string) => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`Refusing symlinked or non-regular transaction target: ${filePath}`);
    }
    return {
      content: fs.readFileSync(descriptor, 'utf8'),
      mode: stat.mode & 0o777,
    };
  } finally {
    fs.closeSync(descriptor);
  }
};

export const inspectProjectFile = (root: string, relativePath: string): InspectedFile => {
  if (!hasSafeParentDirectory(root, relativePath)) {
    return { exists: false, content: '', mode: 0o666 };
  }
  const filePath = path.join(root, relativePath);
  const stat = lstatIfPresent(filePath);
  if (!stat) return { exists: false, content: '', mode: 0o666 };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing symlinked or non-regular transaction target: ${relativePath}`);
  }
  return { exists: true, ...readRegularFile(filePath) };
};

export const inspectProjectDirectory = (root: string, relativePath: string) => {
  if (!hasSafeParentDirectory(root, relativePath)) return false;
  const directoryPath = path.join(root, relativePath);
  const stat = lstatIfPresent(directoryPath);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing symlinked or non-directory transaction target: ${relativePath}`);
  }
  return true;
};

const writeExclusiveFile = (
  filePath: string,
  content: string,
  mode: number,
) => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    mode,
  );
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

export const writeProjectFileAtomically = (
  root: string,
  relativePath: string,
  content: string,
  mode = 0o666,
) => {
  const current = inspectProjectFile(root, relativePath);
  ensureSafeParentDirectory(root, relativePath);
  const targetPath = path.join(root, relativePath);
  const temporaryName =
    `.${path.basename(relativePath)}.bundledrop-${crypto.randomBytes(12).toString('hex')}.tmp`;
  const temporaryPath = path.join(path.dirname(targetPath), temporaryName);
  writeExclusiveFile(temporaryPath, content, current.exists ? current.mode : mode);
  try {
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (lstatIfPresent(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
};

export const createSafeBackupDirectory = (projectRoot: string, label: string) => {
  ensureSafeParentDirectory(projectRoot, '.bundledrop-backup/transaction');
  const backupRoot = path.join(projectRoot, '.bundledrop-backup');
  const backupDirectory = fs.mkdtempSync(path.join(backupRoot, `${label}-`));
  assertRegularDirectory(backupDirectory);
  return backupDirectory;
};

export const writeBackupFile = (
  backupRoot: string,
  relativePath: string,
  content: string,
  mode: number,
) => {
  ensureSafeParentDirectory(backupRoot, relativePath);
  writeExclusiveFile(path.join(backupRoot, relativePath), content, mode);
};

export const restoreProjectFile = (
  projectRoot: string,
  backupRoot: string,
  relativePath: string,
) => {
  const backup = inspectProjectFile(backupRoot, relativePath);
  if (!backup.exists) throw new Error(`Missing transaction backup: ${relativePath}`);
  inspectProjectFile(projectRoot, relativePath);
  writeProjectFileAtomically(
    projectRoot,
    relativePath,
    backup.content,
    backup.mode,
  );
};

export const removeProjectFile = (projectRoot: string, relativePath: string) => {
  const target = inspectProjectFile(projectRoot, relativePath);
  if (target.exists) fs.unlinkSync(path.join(projectRoot, relativePath));
};
