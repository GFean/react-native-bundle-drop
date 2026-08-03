import fs from 'fs';
import path from 'path';
import { ExpoIntegrationError } from './errors';

export type ValidatedExpoExport = {
  files: string[];
  sourceMapDebugId?: string;
};

function isInsideDirectory(rootDirectory: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDirectory, candidatePath);
  return (
    relativePath !== '' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath)
  );
}

export function assertSafeExpoExportRelativePaths(relativePaths: string[]): void {
  const collisionKeys = new Map<string, string>();
  for (const relativePath of relativePaths) {
    if (
      relativePath === '' ||
      path.isAbsolute(relativePath) ||
      relativePath.includes('\0') ||
      relativePath.includes('\\') ||
      /[\u0000-\u001f\u007f:*?"<>|]/.test(relativePath)
    ) {
      throw new ExpoIntegrationError(`Expo export produced an unsafe path: ${relativePath}.`);
    }
    const segments = relativePath.split('/');
    if (
      segments.some(
        segment =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          /[. ]$/.test(segment) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
      )
    ) {
      throw new ExpoIntegrationError(
        `Expo export produced a non-portable or traversing path: ${relativePath}.`,
      );
    }
    const collisionKey = relativePath.normalize('NFC').toLowerCase();
    const existingPath = collisionKeys.get(collisionKey);
    if (existingPath && existingPath !== relativePath) {
      throw new ExpoIntegrationError(
        `Expo export contains a case-folding or Unicode path collision: ${existingPath} and ${relativePath}.`,
      );
    }
    collisionKeys.set(collisionKey, relativePath);
  }
}

function collectFiles(outputDirectory: string): string[] {
  const files: string[] = [];
  const relativePaths: string[] = [];

  function visit(directoryPath: string): void {
    for (const directoryEntry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const absolutePath = path.join(directoryPath, directoryEntry.name);
      const relativePath = path.relative(outputDirectory, absolutePath).split(path.sep).join('/');
      relativePaths.push(relativePath);

      const stats = fs.lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new ExpoIntegrationError(`Expo export contains a symbolic link: ${relativePath}.`);
      }
      if (stats.isDirectory()) {
        visit(absolutePath);
      } else if (stats.isFile()) {
        files.push(relativePath);
      } else {
        throw new ExpoIntegrationError(
          `Expo export contains an unsupported file type: ${relativePath}.`,
        );
      }
    }
  }

  visit(outputDirectory);
  assertSafeExpoExportRelativePaths(relativePaths);
  return files.sort();
}

function requireRegularNonEmptyFile(outputDirectory: string, filePath: string, role: string): void {
  const absoluteFilePath = path.resolve(filePath);
  if (!isInsideDirectory(outputDirectory, absoluteFilePath)) {
    throw new ExpoIntegrationError(`${role} is outside the Expo export directory.`);
  }
  const stats = fs.lstatSync(absoluteFilePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
    throw new ExpoIntegrationError(`${role} must be a non-empty regular file.`);
  }
}

export function validateExpoExportOutput(options: {
  outputDirectory: string;
  bundlePath: string;
  sourceMapPath: string;
  assetsDirectory: string;
}): ValidatedExpoExport {
  const outputDirectory = path.resolve(options.outputDirectory);
  const outputStats = fs.lstatSync(outputDirectory);
  if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
    throw new ExpoIntegrationError('Expo export output must be a real directory, not a symlink.');
  }

  requireRegularNonEmptyFile(outputDirectory, options.bundlePath, 'Expo JavaScript bundle');
  requireRegularNonEmptyFile(outputDirectory, options.sourceMapPath, 'Expo source map');

  const assetsDirectory = path.resolve(options.assetsDirectory);
  if (!isInsideDirectory(outputDirectory, assetsDirectory)) {
    throw new ExpoIntegrationError('Expo assets directory is outside the export directory.');
  }
  const assetStats = fs.lstatSync(assetsDirectory);
  if (!assetStats.isDirectory() || assetStats.isSymbolicLink()) {
    throw new ExpoIntegrationError('Expo assets output must be a real directory, not a symlink.');
  }

  let sourceMap: Record<string, unknown>;
  try {
    sourceMap = JSON.parse(fs.readFileSync(options.sourceMapPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new ExpoIntegrationError('Expo produced a malformed source map.', { cause: error });
  }
  if (!sourceMap || typeof sourceMap !== 'object' || sourceMap.version !== 3) {
    throw new ExpoIntegrationError('Expo source map must be a version 3 source map object.');
  }

  const sourceMapDebugId = sourceMap.debugId ?? sourceMap.debug_id;
  if (sourceMapDebugId !== undefined && typeof sourceMapDebugId !== 'string') {
    throw new ExpoIntegrationError('Expo source map contains a malformed debug ID.');
  }

  return {
    files: collectFiles(outputDirectory),
    ...(typeof sourceMapDebugId === 'string' ? { sourceMapDebugId } : {}),
  };
}
