import RNFS from '../native/fs';
import { ensureParentDir } from '../install/bundleInstallShared';
import {
  BundleManifestFile,
  normalizeManifestPath,
} from '../manifest/bundleManifest';
export {
  ASSET_ONLY_PATCH_ALGORITHM,
  XDELTA_PATCH_ALGORITHM,
} from '../patchAlgorithms';
import {
  ASSET_ONLY_PATCH_ALGORITHM,
  SUPPORTED_PATCH_ALGORITHMS,
  XDELTA_PATCH_ALGORITHM,
  type SupportedPatchAlgorithm,
} from '../patchAlgorithms';
export type { SupportedPatchAlgorithm } from '../patchAlgorithms';

type BaseFileIndex = Map<string, BundleManifestFile>;

type FullFileOperation = {
  type: 'full-file';
  sourcePath: string;
  outputPath: string;
};

type XdeltaOperation = {
  type: 'xdelta';
  basePath: string;
  patchPath: string;
  outputPath: string;
};

type CopyUnchangedOperation = {
  type: 'copy-unchanged';
  sourcePath: string;
  outputPath: string;
};

export type PatchOperation = FullFileOperation | XdeltaOperation | CopyUnchangedOperation;

const xdeltaPatchDriver = {
  id: XDELTA_PATCH_ALGORITHM,
  patchPath: (patchDir: string, filePath: string) => `${patchDir}/files/xdelta/${filePath}.vcdiff`,
  apply: async ({ basePath, patchPath, outputPath }: XdeltaOperation) => {
    await ensureParentDir(outputPath);
    await RNFS.applyXdelta(basePath, patchPath, outputPath);
  },
};

export const isSupportedPatchAlgorithm = (algorithm: string | undefined | null): algorithm is SupportedPatchAlgorithm =>
  SUPPORTED_PATCH_ALGORITHMS.includes(algorithm as SupportedPatchAlgorithm);

export const advertisedPatchAlgorithms = (supportsXdelta: boolean): SupportedPatchAlgorithm[] =>
  supportsXdelta
    ? [XDELTA_PATCH_ALGORITHM, ASSET_ONLY_PATCH_ALGORITHM]
    : [ASSET_ONLY_PATCH_ALGORITHM];

const fullFileCandidates = (patchDir: string, filePath: string) => [
  `${patchDir}/files/full/${filePath}`,
  `${patchDir}/missing-assets/${filePath}`,
];

const findExistingPath = async (paths: string[]): Promise<string | null> => {
  for (const path of paths) {
    if (await RNFS.exists(path)) {
      return path;
    }
  }
  return null;
};

export const resolvePatchOperation = async ({
  baseDir,
  patchDir,
  targetDir,
  targetFile,
  baseFilesByPath,
  algorithm,
}: {
  baseDir: string;
  patchDir: string;
  targetDir: string;
  targetFile: BundleManifestFile;
  baseFilesByPath: BaseFileIndex;
  algorithm: SupportedPatchAlgorithm;
}): Promise<PatchOperation> => {
  const filePath = normalizeManifestPath(targetFile.path);
  const outputPath = `${targetDir}/${filePath}`;
  const fullFilePath = await findExistingPath(fullFileCandidates(patchDir, filePath));
  if (fullFilePath) {
    return { type: 'full-file', sourcePath: fullFilePath, outputPath };
  }

  if (algorithm === XDELTA_PATCH_ALGORITHM) {
    const deltaFilePath = await findExistingPath([xdeltaPatchDriver.patchPath(patchDir, filePath)]);
    if (deltaFilePath) {
      return {
        type: 'xdelta',
        basePath: `${baseDir}/${filePath}`,
        patchPath: deltaFilePath,
        outputPath,
      };
    }
  }

  const baseFile = baseFilesByPath.get(filePath);
  if (baseFile && baseFile.sha256 === targetFile.sha256 && baseFile.size === targetFile.size) {
    return {
      type: 'copy-unchanged',
      sourcePath: `${baseDir}/${filePath}`,
      outputPath,
    };
  }

  throw new Error(`Patch set missing full content for changed file: ${filePath}`);
};

export const applyPatchOperation = async (operation: PatchOperation) => {
  if (operation.type === 'xdelta') {
    await xdeltaPatchDriver.apply(operation);
    return;
  }
  await ensureParentDir(operation.outputPath);
  await RNFS.copyFile(operation.sourcePath, operation.outputPath);
};
