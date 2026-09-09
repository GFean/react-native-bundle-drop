import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import prompts from 'prompts';
import chalk from 'chalk';
import { buildBundleDropLogo } from '../../logo';
import type { MobilePlatform } from '../../../expo';
import type { SightCommandOptions } from '../sight-cli';
import { generateSightArtifacts } from '../sight-artifacts';
import { measureSightOta } from '../sight-ota';
import { openSightInBrowser, startSightSession } from '../sight-session';
import { inspectDependencyPlan, installDependencies, type DependencyPlan } from './dependencies';
import { inspectSightProject } from './inspect-project';
import { writeComparisonMetadata } from './metadata';
import { collectComparisonAssets, writeComparisonAssetManifest } from './assets';
import { runComparisonProcess } from './process';
import { createComparisonSnapshots } from './snapshot';
import type { ComparisonArtifacts, ComparisonAssetEntry, ComparisonSide, SightOtaMeasurement } from './types';

const SIGHT_URL = 'https://bundledrop.app/sight';

export function comparisonEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'INIT_CWD', 'PWD', 'NODE_PATH',
  ]) delete env[name];
  return env;
}

function configurationFingerprint(plan: DependencyPlan): string {
  const hash = createHash('sha256');
  const files = new Set(plan.inputFiles);
  for (const directory of new Set([plan.installRoot, plan.projectRoot])) {
    for (const name of fs.readdirSync(directory)) {
      if (/^(?:(?:metro|babel|app)\.config\.[cm]?[jt]s|bundle\.drop\.config\.js|app\.json|tsconfig\.json|\.babelrc(?:\.json|\.[cm]?js)?)$/.test(name)) {
        const file = path.join(directory, name);
        if (fs.statSync(file).isFile()) files.add(file);
      }
    }
  }
  for (const file of [...files].sort()) {
    hash.update(path.relative(plan.snapshotRoot, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function selectPlatform(projectRoot: string, platform?: MobilePlatform): Promise<MobilePlatform> {
  if (platform) return platform;
  const available = (['ios', 'android'] as const).filter(name => fs.existsSync(path.join(projectRoot, name)));
  if (available.length === 1) return available[0];
  if (!process.stdin.isTTY) throw new Error('Pass --platform ios or --platform android for noninteractive comparison.');
  const answer = await prompts({
    type: 'select', name: 'platform', message: 'Which platform should Sight compare?',
    choices: [{ title: 'iOS', value: 'ios' }, { title: 'Android', value: 'android' }],
  });
  if (!answer.platform) throw new Error('No platform was selected.');
  return answer.platform;
}

function outputDirectory(projectRoot: string, requested?: string): string {
  if (!requested) return fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-sight-comparison-'));
  const directory = path.resolve(projectRoot, requested);
  if (fs.existsSync(directory)) {
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() || fs.readdirSync(directory).length) {
      throw new Error('Sight comparison output must be an empty real directory.');
    }
  } else fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function manualInstructions(artifacts: ComparisonArtifacts): void {
  console.log(chalk.green(`\nComparison files: ${artifacts.outputDirectory}`));
  console.log(`  Metadata:     ${artifacts.metadataPath}`);
  console.log(`  Assets:       ${artifacts.assetManifestPath}`);
  console.log(`  Baseline:     ${artifacts.baseline.bundlePath}`);
  console.log(`                ${artifacts.baseline.sourceMapPath}`);
  console.log(`  Current:      ${artifacts.current.bundlePath}`);
  console.log(`                ${artifacts.current.sourceMapPath}`);
  console.log(`Open ${SIGHT_URL}, choose Compare, and attach the four bundle/map files for a JavaScript-only comparison.`);
  console.log('Git labels, build context and asset sizes are included through automatic CLI loading.');
}

export async function runSightComparison(options: SightCommandOptions): Promise<void> {
  if (!options.compare?.trim()) throw new Error('--compare requires a Git ref.');
  const projectRoot = process.cwd();
  const platform = await selectPlatform(projectRoot, options.platform);
  const environment = comparisonEnvironment(process.env);
  const buildEnvironment = { ...environment, NODE_ENV: 'production', BUNDLE_DROP_OTA_BUILD: '1' };
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Sight comparison cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const diagnostics = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-sight-logs-'));
  let snapshots: Awaited<ReturnType<typeof createComparisonSnapshots>> | undefined;
  let artifacts: ComparisonArtifacts | undefined;
  let directory: string | undefined;
  let complete = false;
  let succeeded = false;
  try {
    console.log(buildBundleDropLogo());
    console.log(chalk.bold.cyan('\nBundle Drop Sight — Compare'));
    snapshots = await createComparisonSnapshots({
      projectRoot, compareRef: options.compare, fetch: options.fetch,
      include: options.include, signal: controller.signal,
    });
    console.log(chalk.gray(`Baseline: ${snapshots.baselineLabel} → ${snapshots.baselineCommit}`));
    console.log(chalk.gray(`Current: ${snapshots.currentLabel} → ${snapshots.currentCommit}${snapshots.currentDirty ? ' + working-tree changes' : ''}`));
    console.log(chalk.gray(`Platform: ${platform} · production · minified JavaScript`));
    console.log(chalk.gray('Metric: raw JavaScript bytes'));
    console.log(chalk.gray('Assets: emitted file bytes, measured separately'));
    console.log(chalk.green('✓ Captured current source files'));
    const relativeApp = path.relative(snapshots.currentRoot, snapshots.currentProjectRoot);
    const common = { signal: controller.signal, env: environment };
    const plans: Record<'baseline' | 'current', DependencyPlan> = {
      baseline: await inspectDependencyPlan({ ...common, snapshotRoot: snapshots.baselineRoot, projectRelativePath: relativeApp }),
      current: await inspectDependencyPlan({ ...common, snapshotRoot: snapshots.currentRoot, projectRelativePath: relativeApp }),
    };
    const configuration = {
      baseline: configurationFingerprint(plans.baseline),
      current: configurationFingerprint(plans.current),
    };
    directory = outputDirectory(projectRoot, options.output);
    console.log(chalk.yellow('Dependency installs may download packages and run project scripts.'));
    for (const side of ['baseline', 'current'] as const) {
      await snapshots.assertIdentity();
      await installDependencies(plans[side], { ...common, logPath: path.join(diagnostics, `${side}-install.log`) });
      await snapshots.assertIdentity();
      console.log(chalk.green(`✓ Installed ${side} dependencies`));
    }
    const current = await inspectSightProject({
      snapshotRoot: snapshots.currentRoot, projectRoot: snapshots.currentProjectRoot, platform,
      explicitType: options.projectType, entryFile: options.entryFile,
    }, { ...common, env: buildEnvironment });
    const baseline = await inspectSightProject({
      snapshotRoot: snapshots.baselineRoot, projectRoot: snapshots.baselineProjectRoot, platform,
      explicitType: options.projectType, logicalEntry: current.entry,
    }, { ...common, env: buildEnvironment });
    if (baseline.projectType !== current.projectType) throw new Error('Baseline and current have different project types; Sight cannot compare these builds.');
    const inspected = { baseline, current };
    const pairs = {} as Pick<ComparisonArtifacts, 'baseline' | 'current'>;
    const sides = {} as Record<'baseline' | 'current', ComparisonSide>;
    const assetEntries = {} as Record<'baseline' | 'current', ComparisonAssetEntry[]>;
    const ota = {} as Record<'baseline' | 'current', SightOtaMeasurement>;
    for (const side of ['baseline', 'current'] as const) {
      const plan = plans[side];
      const temp = path.join(snapshots.directory, `${side}-cache`);
      const assetsDirectory = path.join(snapshots.directory, `${side}-assets`);
      fs.mkdirSync(temp, { recursive: true });
      const env = { ...buildEnvironment, TMPDIR: temp, TMP: temp, TEMP: temp };
      await snapshots.assertIdentity();
      pairs[side] = await generateSightArtifacts({
        projectRoot: plan.projectRoot, projectType: inspected[side].projectType, platform,
        entryFile: inspected[side].resolvedEntryFile, output: path.join(directory, side),
        sourceMapRoot: plan.snapshotRoot,
        assetsDirectory,
        runCommand: async (cwd, command, args) => {
          await runComparisonProcess({
            command: process.execPath, args: [command, ...args], cwd, env,
            phase: `Build ${side}`, signal: controller.signal,
            logPath: path.join(diagnostics, `${side}-build.log`),
          });
        },
      });
      await snapshots.assertIdentity();
      if (configurationFingerprint(plan) !== configuration[side]) {
        throw new Error(`The ${side} build modified its dependency or build configuration inputs.`);
      }
      assetEntries[side] = await collectComparisonAssets(assetsDirectory, controller.signal);
      console.log(chalk.gray(`Measuring ${side} Bundle Drop OTA archive with its JavaScript engine…`));
      ota[side] = await measureSightOta({
        projectRoot: plan.projectRoot, snapshotRoot: plan.snapshotRoot,
        projectType: inspected[side].projectType, platform,
        entryFile: inspected[side].resolvedEntryFile,
        bundlePath: pairs[side].bundlePath, sourceMapPath: pairs[side].sourceMapPath,
        assetsDirectory, workDirectory: snapshots.directory,
      }, { signal: controller.signal, env, logPath: path.join(diagnostics, `${side}-ota.log`) });
      await snapshots.assertIdentity();
      if (configurationFingerprint(plan) !== configuration[side]) {
        throw new Error(`The ${side} OTA measurement modified its dependency or build configuration inputs.`);
      }
      const measurement = ota[side];
      console.log(measurement.status === 'available'
        ? chalk.green(`✓ ${side} Bundle Drop OTA size: ${measurement.zipBytes} bytes (${measurement.engine})`)
        : chalk.yellow(`${side} Bundle Drop OTA size unavailable: ${measurement.reason}`));
      fs.rmSync(assetsDirectory, { recursive: true, force: true });
      sides[side] = {
        label: side === 'baseline' ? snapshots.baselineLabel : snapshots.currentLabel,
        commit: side === 'baseline' ? snapshots.baselineCommit : snapshots.currentCommit,
        branch: side === 'current' ? snapshots.currentBranch : null,
        dirty: side === 'current' && snapshots.currentDirty,
        projectType: inspected[side].projectType, versions: inspected[side].versions,
        packageManager: plan.packageManager, builtAt: new Date().toISOString(),
        inputFingerprint: side === 'current' ? snapshots.snapshotHash : createHash('sha256').update(snapshots.baselineInputFingerprint).digest('hex'),
        configFingerprint: configuration[side],
        sourceContext: {
          repositoryRoot: plan.snapshotRoot, projectRelativePath: relativeApp.split(path.sep).join('/'),
          sourcesBase: inspected[side].sourceMapBase,
          pathConvention: inspected[side].sourcePathConvention,
        },
      };
      console.log(chalk.green(`✓ Generated ${side} bundle, matching source map and inventory of ${assetEntries[side].length} emitted assets`));
    }
    artifacts = {
      ...pairs, outputDirectory: directory, metadataPath: path.join(directory, 'comparison.json'),
      assetManifestPath: path.join(directory, 'comparison-assets.json'),
    };
    writeComparisonAssetManifest(artifacts.assetManifestPath!, {
      version: 1, metric: 'emitted-asset-bytes', ...assetEntries, ota,
    });
    const warnings = [
      'Both builds use detached HEAD; original staging partitions are not reproduced.',
      ...(JSON.stringify(baseline.versions) !== JSON.stringify(current.versions) ? ['Framework or bundler versions differ between builds.'] : []),
      ...(sides.baseline.configFingerprint !== sides.current.configFingerprint ? ['Dependency or build configuration inputs differ between builds.'] : []),
    ];
    writeComparisonMetadata(artifacts, {
      version: 2, mode: 'compare', metric: 'javascript-utf8-bytes',
      settings: { platform, dev: false, minify: true, nodeVersion: process.version, entryPoint: current.entry },
      ...sides, includedPaths: snapshots.includedPaths, warnings,
    });
    complete = true;
    const shouldOpen = options.open !== false && process.stdin.isTTY && (await prompts({
      type: 'confirm', name: 'openSight', message: 'Open Bundle Drop Sight and start the local comparison?', initial: true,
    })).openSight === true;
    controller.signal.throwIfAborted();
    if (!shouldOpen) {
      manualInstructions(artifacts);
      succeeded = true;
      return;
    }
    const session = await startSightSession({
      comparison: artifacts, sightPageUrl: process.env.BUNDLE_DROP_SIGHT_URL || SIGHT_URL, signal: controller.signal,
    });
    try {
      try { await openSightInBrowser(session.sightUrl); }
      catch { console.log(chalk.yellow(`Open this one-time URL manually:\n${session.sightUrl}`)); }
      await session.waitForTransfer();
      console.log(chalk.green('✓ Comparison files loaded into Sight'));
      if (!options.keep && !options.output) fs.rmSync(directory, { recursive: true, force: true });
      else manualInstructions(artifacts);
    } finally { await session.close(); }
    succeeded = true;
  } catch (error) {
    if (complete && artifacts) manualInstructions(artifacts);
    console.error(`Comparison diagnostics: ${diagnostics}`);
    throw error;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    try { await snapshots?.cleanup(); }
    catch (error) {
      const message = `Could not remove comparison worktrees at ${snapshots?.directory}: ${String(error)}`;
      console.error(message);
      if (succeeded) {
        console.error(`Comparison diagnostics: ${diagnostics}`);
        throw new Error(message);
      }
    }
    if (!complete && directory && !options.output) fs.rmSync(directory, { recursive: true, force: true });
    if (succeeded) fs.rmSync(diagnostics, { recursive: true, force: true });
  }
}
