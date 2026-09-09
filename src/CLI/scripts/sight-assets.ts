import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { generateSightArtifacts, type GenerateSightArtifactsOptions, type SightArtifacts } from './sight-artifacts';
import { collectComparisonAssets, MAX_ASSET_MANIFEST_BYTES } from './sight-compare/assets';
import { describeArtifact } from './sight-compare/metadata';
import type { ComparisonArtifact, ComparisonAssetEntry, SightOtaMeasurement } from './sight-compare/types';
import { measureSightOta } from './sight-ota';
import { checkComparisonAbort, runComparisonProcess } from './sight-compare/process';

export type SightAssetManifest = {
  version: 1;
  mode: 'analyze';
  metric: 'emitted-asset-bytes';
  artifacts: { bundle: ComparisonArtifact; sourceMap: ComparisonArtifact };
  assets: ComparisonAssetEntry[];
  ota?: SightOtaMeasurement;
};

/** Single-analysis CLI wrapper; the generic builder retains its existing defaults. */
export async function generateSightAnalysisArtifacts(options: GenerateSightArtifactsOptions): Promise<SightArtifacts> {
  const assetsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-sight-assets-'));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let artifacts: SightArtifacts | undefined;
  try {
    const env = { ...(options.env || process.env), NODE_ENV: 'production', BUNDLE_DROP_OTA_BUILD: '1' };
    const runCommand = options.runCommand ?? (async (cwd: string, command: string, args: string[]) => {
      await runComparisonProcess({
        command: process.execPath, args: [command, ...args], cwd, env,
        phase: 'Build Sight analysis', signal: controller.signal, inheritStdin: true, inheritOutput: true,
      });
    });
    artifacts = await generateSightArtifacts({ ...options, assetsDirectory, env, runCommand });
    checkComparisonAbort(controller.signal);
    const assets = await collectComparisonAssets(assetsDirectory, controller.signal);
    console.log(chalk.gray('Measuring the Bundle Drop OTA archive with the project’s JavaScript engine…'));
    const ota = await measureSightOta({
      projectRoot: options.projectRoot, projectType: options.projectType, platform: options.platform,
      entryFile: options.entryFile,
      bundlePath: artifacts.bundlePath, sourceMapPath: artifacts.sourceMapPath,
      assetsDirectory, workDirectory: artifacts.outputDirectory,
    }, { env, signal: controller.signal });
    checkComparisonAbort(controller.signal);
    console.log(ota.status === 'available'
      ? chalk.green(`✓ Bundle Drop OTA size: ${ota.zipBytes} bytes (${ota.engine})`)
      : chalk.yellow(`Bundle Drop OTA size unavailable: ${ota.reason}`));
    const manifest: SightAssetManifest = {
      version: 1, mode: 'analyze', metric: 'emitted-asset-bytes',
      artifacts: {
        bundle: describeArtifact(artifacts.outputDirectory, artifacts.bundlePath),
        sourceMap: describeArtifact(artifacts.outputDirectory, artifacts.sourceMapPath),
      },
      assets, ota,
    };
    const json = JSON.stringify(manifest) + '\n';
    if (Buffer.byteLength(json) > MAX_ASSET_MANIFEST_BYTES) throw new Error('Sight asset manifest exceeds 4 MiB.');
    const assetManifestPath = path.join(artifacts.outputDirectory, 'analysis-assets.json');
    fs.writeFileSync(assetManifestPath, json, { mode: 0o600 });
    return { ...artifacts, assetManifestPath };
  } catch (error) {
    if (artifacts?.temporary) fs.rmSync(artifacts.outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    fs.rmSync(assetsDirectory, { recursive: true, force: true });
  }
}
