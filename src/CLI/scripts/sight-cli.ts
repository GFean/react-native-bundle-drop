import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import prompts from 'prompts';
import { detectProjectType } from '../../expo';
import type { MobilePlatform, ProjectType } from '../../expo';
import { generateSightArtifacts, type SightArtifacts } from './sight-artifacts';
import { openSightInBrowser, startSightSession } from './sight-session';

const DEFAULT_SIGHT_URL = 'https://bundledrop.app/sight';

export type SightCommandOptions = {
  platform?: MobilePlatform;
  projectType?: ProjectType;
  open?: boolean;
  keep?: boolean;
  output?: string;
  entryFile?: string;
};

function detectAvailablePlatforms(projectRoot: string): MobilePlatform[] {
  return (['ios', 'android'] as const).filter(platform =>
    fs.existsSync(path.join(projectRoot, platform)),
  );
}

async function resolvePlatform(
  projectRoot: string,
  explicitPlatform?: MobilePlatform,
): Promise<MobilePlatform> {
  if (explicitPlatform) {
    return explicitPlatform;
  }

  const availablePlatforms = detectAvailablePlatforms(projectRoot);
  if (availablePlatforms.length === 1) {
    return availablePlatforms[0];
  }

  const answer = await prompts({
    type: 'select',
    name: 'platform',
    message: 'Which platform should Sight analyze?',
    choices: [
      { title: 'iOS', value: 'ios' },
      { title: 'Android', value: 'android' },
    ],
  });
  if (answer.platform !== 'ios' && answer.platform !== 'android') {
    throw new Error('No platform was selected. Pass --platform ios or --platform android.');
  }
  return answer.platform;
}

function printArtifactPaths(artifacts: SightArtifacts, heading: string): void {
  console.log(chalk.green(`\n${heading}`));
  console.log(`  Bundle:     ${artifacts.bundlePath}`);
  console.log(`  Source map: ${artifacts.sourceMapPath}`);
}

function printManualInstructions(artifacts: SightArtifacts): void {
  printArtifactPaths(artifacts, 'Source files have been generated here:');
  console.log(
    chalk.cyan(`\nOpen ${DEFAULT_SIGHT_URL} and attach both files for analysis.`),
  );
}

function removeTemporaryArtifacts(artifacts: SightArtifacts): void {
  if (artifacts.temporary) {
    fs.rmSync(artifacts.outputDirectory, { recursive: true, force: true });
  }
}

export async function runSightCommand(options: SightCommandOptions): Promise<void> {
  if (options.platform && !['ios', 'android'].includes(options.platform)) {
    throw new Error('--platform must be ios or android.');
  }
  if (options.projectType && !['expo', 'bare'].includes(options.projectType)) {
    throw new Error('--project-type must be expo or bare.');
  }

  const projectRoot = process.cwd();
  const projectType = detectProjectType({
    projectRoot,
    explicitType: options.projectType,
  });
  const platform = await resolvePlatform(projectRoot, options.platform);

  console.log(chalk.bold.cyan('\nBundle Drop Sight'));
  console.log(chalk.gray(`Detected ${projectType === 'expo' ? 'Expo' : 'bare React Native'} project`));
  console.log(chalk.gray(`Generating a production ${platform} bundle and source map…`));

  const artifacts = await generateSightArtifacts({
    projectRoot,
    projectType,
    platform,
    output: options.output,
    keep: options.keep,
    entryFile: options.entryFile,
  });
  console.log(chalk.green(`✓ Generated ${platform} production bundle`));
  console.log(chalk.green('✓ Generated matching source map'));

  const shouldOpen = options.open === false
    ? false
    : (await prompts({
        type: 'confirm',
        name: 'openSight',
        message: 'Open Bundle Drop Sight and start the local analysis?',
        initial: true,
      })).openSight === true;

  if (!shouldOpen) {
    printManualInstructions(artifacts);
    return;
  }

  const sightPageUrl = process.env.BUNDLE_DROP_SIGHT_URL || DEFAULT_SIGHT_URL;
  let session: Awaited<ReturnType<typeof startSightSession>>;
  try {
    session = await startSightSession({ artifacts, sightPageUrl });
  } catch (error) {
    printManualInstructions(artifacts);
    throw error;
  }
  let transferSucceeded = false;
  try {
    console.log(chalk.gray('Opening Bundle Drop Sight…'));
    try {
      await openSightInBrowser(session.sightUrl);
    } catch {
      console.log(chalk.yellow('Could not open the browser automatically.'));
      console.log(chalk.gray(`Open this one-time URL manually:\n${session.sightUrl}`));
    }
    await session.waitForTransfer();
    transferSucceeded = true;
    console.log(chalk.green('✓ Bundle and source map loaded into Sight'));
  } finally {
    await session.close();
    if (transferSucceeded && !options.keep && !options.output) {
      removeTemporaryArtifacts(artifacts);
    } else if (transferSucceeded) {
      printArtifactPaths(artifacts, 'Generated files were kept here:');
    } else {
      printManualInstructions(artifacts);
    }
  }
}
