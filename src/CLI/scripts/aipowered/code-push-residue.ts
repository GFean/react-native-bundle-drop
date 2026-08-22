import fs from 'fs-extra';
import type { Dirent, Stats } from 'fs';
import path from 'path';

const MAX_VISITED_ENTRIES = 20_000;
const MAX_CANDIDATE_FILES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

const SKIPPED_DIRECTORIES = new Set([
  '.bundle-drop',
  '.bundledrop-backup',
  '.expo',
  '.git',
  '.gradle',
  'build',
  'coverage',
  'deriveddata',
  'dist',
  'generated',
  'lib',
  'node_modules',
  'pods',
  'vendor',
]);

const JS_SOURCE_EXTENSION = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i;
const CODE_PUSH_REFERENCE = /\b(?:react-native-code-push|code[\s_.-]*push|com\.microsoft\.codepush\.react)/i;

const toPosix = (filePath: string) => filePath.split(path.sep).join('/');

const isCodePushResidueCandidate = (relativePath: string) => {
  const parts = relativePath.split('/');
  const basename = parts[parts.length - 1];

  if (JS_SOURCE_EXTENSION.test(basename)) return true;

  if (parts[0] === 'android') {
    if (/^MainApplication\.(?:java|kt)$/i.test(basename)) return false;
    return /\.(?:gradle|gradle\.kts|java|kt|properties|xml)$/i.test(basename);
  }

  if (parts[0] === 'ios') {
    if (/^AppDelegate\.(?:m|mm|swift)$/i.test(basename)) return false;
    return basename === 'Podfile' ||
      /\.(?:h|m|mm|pbxproj|plist|podspec|swift|xcconfig)$/i.test(basename);
  }

  return false;
};

const scanLimitError = (detail: string) => new Error(
  `CodePush residue validation could not safely complete (${detail}). ` +
    'Clean up CodePush manually or reduce the project scan surface, then retry. No files changed.',
);

/**
 * Finds CodePush ownership outside package files and provider-patched native entrypoints.
 * Only relative paths are returned; file contents never leave this local validation boundary.
 */
export function findCodePushResiduePaths(projectRoot: string): string[] {
  const pendingDirectories = [''];
  const residuePaths: string[] = [];
  let visitedEntries = 0;
  let candidateFiles = 0;
  let totalBytes = 0;

  while (pendingDirectories.length) {
    const relativeDirectory = pendingDirectories.pop()!;
    const absoluteDirectory = path.join(projectRoot, relativeDirectory);
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
    } catch {
      throw scanLimitError(`cannot inspect ${toPosix(relativeDirectory) || '.'}`);
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_VISITED_ENTRIES) {
        throw scanLimitError(`more than ${MAX_VISITED_ENTRIES} filesystem entries`);
      }

      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = path.join(projectRoot, relativePath);
      let stat: Stats;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch {
        throw scanLimitError(`cannot inspect ${toPosix(relativePath)}`);
      }
      if (SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (stat.isSymbolicLink()) {
        throw scanLimitError(
          `relevant project path ${toPosix(relativePath)} is a symbolic link`,
        );
      }

      if (stat.isDirectory()) {
        pendingDirectories.push(relativePath);
        continue;
      }
      if (!stat.isFile()) continue;

      const posixPath = toPosix(relativePath);
      if (!isCodePushResidueCandidate(posixPath)) continue;

      candidateFiles += 1;
      if (candidateFiles > MAX_CANDIDATE_FILES) {
        throw scanLimitError(`more than ${MAX_CANDIDATE_FILES} relevant files`);
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw scanLimitError(`${posixPath} exceeds the per-file limit`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw scanLimitError(`relevant files exceed ${MAX_TOTAL_BYTES} bytes`);
      }

      let content: string;
      try {
        content = fs.readFileSync(absolutePath, 'utf8');
      } catch {
        throw scanLimitError(`cannot read ${posixPath}`);
      }
      if (CODE_PUSH_REFERENCE.test(content)) residuePaths.push(posixPath);
    }
  }

  return residuePaths.sort();
}
