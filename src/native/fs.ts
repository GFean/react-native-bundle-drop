import { NativeModules } from 'react-native';

const { BundleDrop } = NativeModules;

function assertModule(): void {
  if (!BundleDrop) {
    throw new Error(
      'BundleDrop native module is not linked. ' +
      'Run pod install (iOS) or rebuild (Android).',
    );
  }
}

async function exists(path: string): Promise<boolean> {
  assertModule();
  return BundleDrop.fsExists(path);
}

async function readFile(path: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string> {
  assertModule();
  return BundleDrop.fsReadFile(path, encoding);
}

async function writeFile(path: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<void> {
  assertModule();
  return BundleDrop.fsWriteFile(path, content, encoding);
}

async function mkdir(path: string): Promise<void> {
  assertModule();
  return BundleDrop.fsMkdir(path);
}

async function readDir(path: string): Promise<string[]> {
  assertModule();
  return BundleDrop.fsReadDir(path);
}

async function unlink(path: string): Promise<void> {
  assertModule();
  return BundleDrop.fsUnlink(path);
}

async function moveFile(src: string, dest: string): Promise<void> {
  assertModule();
  return BundleDrop.fsMoveFile(src, dest);
}

async function unzip(zipPath: string, destPath: string): Promise<string[]> {
  assertModule();
  return BundleDrop.fsUnzip(zipPath, destPath);
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  assertModule();
  return BundleDrop.fsDownloadFile(url, destPath);
}

async function sha256File(path: string): Promise<string> {
  assertModule();
  return BundleDrop.fsSha256File(path);
}

async function fileSize(path: string): Promise<number> {
  assertModule();
  return BundleDrop.fsFileSize(path);
}

async function copyFile(src: string, dest: string): Promise<void> {
  assertModule();
  return BundleDrop.fsCopyFile(src, dest);
}

async function applyXdelta(basePath: string, patchPath: string, outputPath: string): Promise<void> {
  assertModule();
  return BundleDrop.fsApplyXdelta(basePath, patchPath, outputPath);
}

async function verifyBundleFiles(bundleDir: string, manifestPath: string): Promise<{ verified: true }> {
  assertModule();
  if (typeof BundleDrop.fsVerifyBundleFiles !== 'function') {
    throw new Error(
      'BundleDrop native module is outdated. Rebuild the app so fsVerifyBundleFiles is available.',
    );
  }
  return BundleDrop.fsVerifyBundleFiles(bundleDir, manifestPath);
}

async function supportsXdelta(): Promise<boolean> {
  assertModule();
  if (typeof BundleDrop.fsSupportsXdelta !== 'function') return false;
  return BundleDrop.fsSupportsXdelta();
}

const BundleDropFS = {
  DocumentDirectoryPath: (BundleDrop?.DocumentDirectoryPath ?? '') as string,
  LibraryDirectoryPath: (BundleDrop?.LibraryDirectoryPath ?? '') as string,
  exists,
  readFile,
  writeFile,
  mkdir,
  readDir,
  unlink,
  moveFile,
  unzip,
  downloadFile,
  sha256File,
  fileSize,
  copyFile,
  applyXdelta,
  verifyBundleFiles,
  supportsXdelta,
};

export default BundleDropFS;
