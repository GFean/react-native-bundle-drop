type Encoding = 'utf8' | 'base64';

const files = new Map<string, string>();
const directories = new Set<string>();

const normalizePath = (value: string) => value.replace(/\/+$/, '') || '/';

const parentDirectory = (value: string) => {
  const normalized = normalizePath(value);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) {
    return '/';
  }
  return normalized.slice(0, lastSlash);
};

const ensureDirectoryPath = (value: string) => {
  const normalized = normalizePath(value);
  directories.add(normalized);

  const parent = parentDirectory(normalized);
  if (parent !== normalized) {
    ensureDirectoryPath(parent);
  }
};

const resetStores = () => {
  files.clear();
  directories.clear();
  directories.add('/');
  directories.add('/mock');
  directories.add('/mock/doc');
  directories.add('/mock/lib');
};

export const mockExists = jest.fn(async (path: string) => {
  const normalized = normalizePath(path);
  return files.has(normalized) || directories.has(normalized);
});

export const mockReadFile = jest.fn(async (path: string, encoding: Encoding = 'utf8') => {
  const normalized = normalizePath(path);
  if (!files.has(normalized)) {
    throw new Error(`ENOENT: ${normalized}`);
  }
  const content = files.get(normalized)!;
  return encoding === 'base64' ? Buffer.from(content).toString('base64') : content;
});

export const mockWriteFile = jest.fn(
  async (path: string, content: string, encoding: Encoding = 'utf8') => {
    const normalized = normalizePath(path);
    ensureDirectoryPath(parentDirectory(normalized));
    files.set(normalized, encoding === 'base64' ? Buffer.from(content, 'base64').toString() : content);
  }
);

export const mockMkdir = jest.fn(async (path: string) => {
  ensureDirectoryPath(path);
});

export const mockReadDir = jest.fn(async (path: string) => {
  const normalized = normalizePath(path);
  const entries: string[] = [];
  const prefix = normalized === '/' ? '/' : `${normalized}/`;

  for (const filePath of files.keys()) {
    if (filePath.startsWith(prefix)) {
      const relative = filePath.slice(prefix.length);
      const topLevel = relative.split('/')[0];
      if (topLevel && !entries.includes(topLevel)) {
        entries.push(topLevel);
      }
    }
  }
  for (const dirPath of directories) {
    if (dirPath.startsWith(prefix) && dirPath !== normalized) {
      const relative = dirPath.slice(prefix.length);
      const topLevel = relative.split('/')[0];
      if (topLevel && !entries.includes(topLevel)) {
        entries.push(topLevel);
      }
    }
  }
  return entries;
});

export const mockUnlink = jest.fn(async (path: string) => {
  const normalized = normalizePath(path);
  files.delete(normalized);
  for (const filePath of [...files.keys()]) {
    if (filePath.startsWith(`${normalized}/`)) {
      files.delete(filePath);
    }
  }
  for (const dirPath of [...directories]) {
    if (dirPath === normalized || dirPath.startsWith(`${normalized}/`)) {
      directories.delete(dirPath);
    }
  }
});

export const mockMoveFile = jest.fn(async (source: string, destination: string) => {
  const normalizedSource = normalizePath(source);
  const normalizedDestination = normalizePath(destination);
  const content = files.get(normalizedSource);
  if (content !== undefined) {
    ensureDirectoryPath(parentDirectory(normalizedDestination));
    files.set(normalizedDestination, content);
    files.delete(normalizedSource);
    return;
  }

  if (!directories.has(normalizedSource)) {
    throw new Error(`ENOENT: ${normalizedSource}`);
  }
  ensureDirectoryPath(normalizedDestination);
  for (const filePath of [...files.keys()]) {
    if (filePath.startsWith(`${normalizedSource}/`)) {
      const movedPath = `${normalizedDestination}${filePath.slice(normalizedSource.length)}`;
      ensureDirectoryPath(parentDirectory(movedPath));
      files.set(movedPath, files.get(filePath)!);
      files.delete(filePath);
    }
  }
  for (const dirPath of [...directories]) {
    if (dirPath.startsWith(`${normalizedSource}/`)) {
      directories.add(`${normalizedDestination}${dirPath.slice(normalizedSource.length)}`);
      directories.delete(dirPath);
    }
  }
  directories.delete(normalizedSource);
});

export const mockCopyFile = jest.fn(async (source: string, destination: string) => {
  const normalizedSource = normalizePath(source);
  const normalizedDestination = normalizePath(destination);
  const content = files.get(normalizedSource);
  if (content === undefined) {
    throw new Error(`ENOENT: ${normalizedSource}`);
  }
  ensureDirectoryPath(parentDirectory(normalizedDestination));
  files.set(normalizedDestination, content);
});

export const mockSha256File = jest.fn(async (path: string) => {
  const normalized = normalizePath(path);
  const content = files.get(normalized);
  if (content === undefined) {
    throw new Error(`ENOENT: ${normalized}`);
  }
  return require('crypto').createHash('sha256').update(Buffer.from(content)).digest('hex');
});

export const mockSha256String = jest.fn(async (value: string) =>
  require('crypto').createHash('sha256').update(value, 'utf8').digest('hex')
);

export const mockVerifyEs256Signature = jest.fn(async (
  signingInput: string,
  signatureBase64Url: string,
  xBase64Url: string,
  yBase64Url: string,
) => require('crypto').verify(
  'sha256',
  Buffer.from(signingInput, 'utf8'),
  {
    key: { kty: 'EC', crv: 'P-256', x: xBase64Url, y: yBase64Url },
    format: 'jwk',
    dsaEncoding: 'ieee-p1363',
  },
  Buffer.from(signatureBase64Url, 'base64url'),
));

export const mockFileSize = jest.fn(async (path: string) => {
  const normalized = normalizePath(path);
  const content = files.get(normalized);
  if (content === undefined) {
    throw new Error(`ENOENT: ${normalized}`);
  }
  return Buffer.byteLength(content);
});

export const mockApplyXdelta = jest.fn(async (_basePath: string, _patchPath: string, _outputPath: string) => {
  throw new Error('xdelta3-vcdiff apply is not available in the test mock');
});

const isSafeManifestPath = (path: string) =>
  !!path &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  !path.split('/').some(part => !part || part === '.' || part === '..');

const listRelativeFiles = (rootPath: string) => {
  const root = normalizePath(rootPath);
  const prefix = root === '/' ? '/' : `${root}/`;
  const relativeFiles: string[] = [];
  for (const filePath of files.keys()) {
    if (filePath.startsWith(prefix)) {
      relativeFiles.push(filePath.slice(prefix.length));
    }
  }
  return relativeFiles;
};

export const mockVerifyBundleFiles = jest.fn(async (bundleDir: string, manifestPath: string) => {
  const manifestContent = files.get(normalizePath(manifestPath));
  if (manifestContent === undefined) {
    throw new Error('Malformed bundle manifest');
  }
  const manifest = JSON.parse(manifestContent) as { files?: Array<{ path?: string; size?: number; sha256?: string }> };
  if (!Array.isArray(manifest.files)) {
    throw new Error('Bundle manifest must include files');
  }

  const allowed = new Set(['bundle-manifest.json']);
  for (const [index, file] of manifest.files.entries()) {
    const relativePath = file.path;
    if (typeof relativePath !== 'string') {
      throw new Error(`Invalid manifest file entry at index ${index}`);
    }
    if (!isSafeManifestPath(relativePath)) {
      throw new Error(`Invalid manifest path: ${relativePath}`);
    }
    if (allowed.has(relativePath)) {
      throw new Error(`Duplicate manifest file path: ${relativePath}`);
    }
    allowed.add(relativePath);

    const fullPath = normalizePath(`${bundleDir}/${relativePath}`);
    const content = files.get(fullPath);
    if (content === undefined) {
      if (directories.has(fullPath)) {
        throw new Error(`Manifest file is a directory: ${relativePath}`);
      }
      throw new Error(`Manifest file missing: ${relativePath}`);
    }
    if (Buffer.byteLength(content) !== file.size) {
      throw new Error(`Manifest file size mismatch for ${relativePath}`);
    }
    const actualHash = require('crypto').createHash('sha256').update(Buffer.from(content)).digest('hex');
    if (actualHash !== file.sha256) {
      throw new Error(`Manifest file hash mismatch for ${relativePath}`);
    }
  }

  const extraFile = listRelativeFiles(bundleDir).find(path => !allowed.has(path));
  if (extraFile) {
    throw new Error(`Unmanifested file in bundle archive: ${extraFile}`);
  }
  return { verified: true as const };
});

export const mockSupportsXdelta = jest.fn(async () => true);

let unzipEntries = new Map<string, string>();
const downloadContentsByUrl = new Map<string, string>();
const unzipEntriesByUrl = new Map<string, Map<string, string>>();
const unzipEntriesByZipPath = new Map<string, Map<string, string>>();
const downloadFailuresByUrl = new Map<string, Error>();
let strictDownloads = false;

const defaultManifestContent = (role: string) =>
  role === 'metadata' || role === 'androidImageManifest' ? '{}' : null;

const addDefaultRequiredManifestFiles = (entries: Map<string, string>, manifestJson: string) => {
  try {
    const manifest = JSON.parse(manifestJson) as { files?: Array<{ path?: string; role?: string }> };
    for (const file of manifest.files || []) {
      if (!file.path || entries.has(file.path)) {
        continue;
      }
      const defaultContent = defaultManifestContent(file.role || '');
      if (defaultContent !== null) {
        entries.set(file.path, defaultContent);
      }
    }
  } catch {
    // Malformed manifests should stay malformed for the test under inspection.
  }
};

export const configureUnzipEntries = (entries: Record<string, string>) => {
  unzipEntries.clear();
  for (const [name, content] of Object.entries(entries)) {
    unzipEntries.set(name, content);
  }
  const manifestJson = unzipEntries.get('bundle-manifest.json');
  if (manifestJson) {
    addDefaultRequiredManifestFiles(unzipEntries, manifestJson);
  }
};

export const registerMockDownload = (
  url: string,
  options: {
    content?: string;
    unzipEntries?: Record<string, string>;
  },
) => {
  downloadContentsByUrl.set(url, options.content ?? `__downloaded:${url}__`);

  if (options.unzipEntries) {
    const entries = new Map<string, string>();
    for (const [name, content] of Object.entries(options.unzipEntries)) {
      entries.set(name, content);
    }
    const manifestJson = entries.get('bundle-manifest.json');
    if (manifestJson) {
      addDefaultRequiredManifestFiles(entries, manifestJson);
    }
    unzipEntriesByUrl.set(url, entries);
  }
};

export const registerMockDownloadFailure = (url: string, error: Error | string) => {
  downloadFailuresByUrl.set(url, error instanceof Error ? error : new Error(error));
};

export const setStrictMockDownloads = (enabled: boolean) => {
  strictDownloads = enabled;
};

export const mockUnzip = jest.fn(async (_zipPath: string, destPath: string) => {
  const filenames: string[] = [];
  const entries = unzipEntriesByZipPath.get(normalizePath(_zipPath)) ?? unzipEntries;
  for (const [name, content] of entries) {
    const fullPath = normalizePath(`${destPath}/${name}`);
    ensureDirectoryPath(parentDirectory(fullPath));
    files.set(fullPath, content);
    filenames.push(name);
  }
  return filenames;
});

export const mockDownloadFile = jest.fn(async (url: string, destPath: string) => {
  const failure = downloadFailuresByUrl.get(url);
  if (failure) {
    throw failure;
  }
  if (strictDownloads && !downloadContentsByUrl.has(url)) {
    throw new Error(`No mock download registered for ${url}`);
  }

  const normalized = normalizePath(destPath);
  ensureDirectoryPath(parentDirectory(normalized));
  files.set(normalized, downloadContentsByUrl.get(url) ?? '__downloaded_zip__');

  const entries = unzipEntriesByUrl.get(url);
  if (entries) {
    unzipEntriesByZipPath.set(normalized, entries);
  }
});

export const mockDownloadFileBounded = jest.fn(async (
  url: string,
  destPath: string,
  _maxBytes: number,
  _timeoutMs: number,
) => mockDownloadFile(url, destPath));

export const resetNativeFsMocks = () => {
  mockExists.mockClear();
  mockReadFile.mockClear();
  mockWriteFile.mockClear();
  mockMkdir.mockClear();
  mockReadDir.mockClear();
  mockUnlink.mockClear();
  mockMoveFile.mockClear();
  mockCopyFile.mockClear();
  mockSha256File.mockClear();
  mockSha256String.mockClear();
  mockVerifyEs256Signature.mockClear();
  mockFileSize.mockClear();
  mockApplyXdelta.mockClear();
  mockVerifyBundleFiles.mockClear();
  mockSupportsXdelta.mockClear();
  mockSupportsXdelta.mockResolvedValue(true);
  mockUnzip.mockClear();
  mockDownloadFile.mockClear();
  mockDownloadFileBounded.mockClear();
  unzipEntries.clear();
  downloadContentsByUrl.clear();
  downloadFailuresByUrl.clear();
  unzipEntriesByUrl.clear();
  unzipEntriesByZipPath.clear();
  strictDownloads = false;
  resetStores();
};

export const setMockFile = (path: string, content: string) => {
  const normalized = normalizePath(path);
  ensureDirectoryPath(parentDirectory(normalized));
  files.set(normalized, content);
  if (normalized.endsWith('/bundle-manifest.json')) {
    const bundleDir = parentDirectory(normalized);
    const defaultEntries = new Map<string, string>();
    addDefaultRequiredManifestFiles(defaultEntries, content);
    for (const [relativePath, defaultContent] of defaultEntries) {
      const fullPath = normalizePath(`${bundleDir}/${relativePath}`);
      if (!files.has(fullPath)) {
        ensureDirectoryPath(parentDirectory(fullPath));
        files.set(fullPath, defaultContent);
      }
    }
  }
};

export const getMockFile = (path: string) => files.get(normalizePath(path));

export const readMockJson = <T>(path: string): T | null => {
  const content = getMockFile(path);
  if (!content) {
    return null;
  }
  return JSON.parse(content) as T;
};

resetNativeFsMocks();

const BundleDropFS = {
  DocumentDirectoryPath: '/mock/doc',
  LibraryDirectoryPath: '/mock/lib',
  exists: mockExists,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readDir: mockReadDir,
  unlink: mockUnlink,
  moveFile: mockMoveFile,
  copyFile: mockCopyFile,
  sha256File: mockSha256File,
  sha256String: mockSha256String,
  verifyEs256Signature: mockVerifyEs256Signature,
  fileSize: mockFileSize,
  applyXdelta: mockApplyXdelta,
  verifyBundleFiles: mockVerifyBundleFiles,
  supportsXdelta: mockSupportsXdelta,
  unzip: mockUnzip,
  downloadFile: mockDownloadFile,
  downloadFileBounded: mockDownloadFileBounded,
};

export default BundleDropFS;
