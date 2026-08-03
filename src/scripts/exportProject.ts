import fs from 'fs-extra';
import path from 'path';

import {
  assertExpoUpdatesDoesNotOwnStartup,
  detectProjectType,
  evaluateExpoConfig,
  exportExpoProject,
} from '../expo';
import type { ExpoBuildIdentity, MobilePlatform, ProjectType } from '../expo';
import { resolveExpoUploadIdentity } from '../CLI/scripts/expo/build-receipt';
import { buildCanonicalArtifact } from './canonicalArtifact';
import { runBundleScript } from './bundle';

const getExpoArtifactRoot = (projectRoot: string) =>
  path.join(projectRoot, '.bundle-drop', 'artifacts');

const assertExpoUpdatesDoesNotOwnExport = (projectRoot: string) => {
  const { exp } = evaluateExpoConfig(projectRoot);
  assertExpoUpdatesDoesNotOwnStartup(projectRoot, exp);
};

export type ExportProjectArtifactOptions = {
  projectRoot: string;
  platform: MobilePlatform;
  appVersion: string;
  generateSourceMap: boolean;
  projectType?: ProjectType;
  buildReceipt?: string;
  buildIdentity?: ExpoBuildIdentity;
};

export async function exportProjectArtifact(options: ExportProjectArtifactOptions) {
  const projectRoot = path.resolve(options.projectRoot);
  const projectType = detectProjectType({
    projectRoot,
    explicitType: options.projectType,
  });
  if (projectType === 'bare') {
    return {
      projectType,
      buildIdentity: undefined,
      ...runBundleScript({
        platform: options.platform,
        cwd: projectRoot,
        sourcemap: options.generateSourceMap,
      }),
    };
  }

  assertExpoUpdatesDoesNotOwnExport(projectRoot);
  const buildIdentity = options.buildIdentity || await resolveExpoUploadIdentity({
    projectRoot,
    platform: options.platform,
    receiptFile: options.buildReceipt,
  });
  if (buildIdentity.platform !== options.platform) {
    throw new Error(`Expo build receipt identity is for ${buildIdentity.platform}, not ${options.platform}.`);
  }
  if (options.appVersion !== buildIdentity.appVersion) {
    throw new Error(
      `Expo app version mismatch: upload requested ${options.appVersion}, but the proven build identity is ` +
        `${buildIdentity.appVersion}. Bundle Drop will not publish to an unproven binary identity.`,
    );
  }

  const distDir = getExpoArtifactRoot(projectRoot);
  const outputDir = path.join(distDir, `expo-artifacts-${options.platform}`);
  const expoOutput = path.join(distDir, `expo-export-${options.platform}`);
  fs.removeSync(outputDir);
  fs.removeSync(expoOutput);
  fs.ensureDirSync(outputDir);
  const exported = await exportExpoProject({
    projectRoot,
    platform: options.platform,
    outputDirectory: expoOutput,
    resetCache: true,
    buildIdentity,
  });
  const bundlePath = path.join(outputDir, 'main.jsbundle');
  const sourceMapPath = path.join(outputDir, 'main.jsbundle.map');
  fs.copyFileSync(exported.bundlePath, bundlePath);
  fs.copyFileSync(exported.sourceMapPath, sourceMapPath);

  const artifact = buildCanonicalArtifact({
    platform: options.platform,
    appVersion: buildIdentity.appVersion,
    runtimeVersion: buildIdentity.runtimeVersion,
    bundlePath,
    assetsDir: exported.assetsDirectory,
    outputDir,
    sourceMapPath,
  });
  return {
    projectType,
    projectRoot,
    buildIdentity,
    expoExportDirectory: expoOutput,
    sourceMapDebugId: exported.sourceMapDebugId,
    ...artifact,
  };
}
