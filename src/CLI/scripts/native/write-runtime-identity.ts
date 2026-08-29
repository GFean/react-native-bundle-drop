import fs from 'fs-extra';
import path from 'path';

import { resolveBundleDropRuntimeVersionAuthority } from '../../../expo';
import type { MobilePlatform } from '../../../expo';

export type NativeRuntimeIdentity =
  | {
      schemaVersion: 1;
      platform: MobilePlatform;
      source: 'bundle-drop';
      runtimeVersion: string;
    }
  | {
      schemaVersion: 1;
      platform: MobilePlatform;
      source: 'expo';
    };

export type WriteNativeRuntimeIdentityOptions = {
  projectRoot: string;
  platform: MobilePlatform;
  outputPath?: string;
};

export function resolveNativeRuntimeIdentity(
  projectRoot: string,
  platform: MobilePlatform,
): NativeRuntimeIdentity {
  const authority = resolveBundleDropRuntimeVersionAuthority(projectRoot, platform);
  if (authority.source === 'expo') {
    return { schemaVersion: 1, platform, source: 'expo' };
  }
  return {
    schemaVersion: 1,
    platform,
    source: 'bundle-drop',
    runtimeVersion: authority.runtimeVersion,
  };
}

function writeAtomically(outputPath: string, content: string): void {
  const absoluteOutputPath = path.resolve(outputPath);
  fs.ensureDirSync(path.dirname(absoluteOutputPath));
  const temporaryPath = path.join(
    path.dirname(absoluteOutputPath),
    `.${path.basename(absoluteOutputPath)}-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, content, 'utf8');
    const descriptor = fs.openSync(temporaryPath, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, absoluteOutputPath);
  } catch (error) {
    try {
      fs.removeSync(temporaryPath);
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

export function writeNativeRuntimeIdentity(
  options: WriteNativeRuntimeIdentityOptions,
): NativeRuntimeIdentity {
  const identity = resolveNativeRuntimeIdentity(options.projectRoot, options.platform);
  const content = `${JSON.stringify(identity)}\n`;
  if (options.outputPath) {
    writeAtomically(options.outputPath, content);
  }
  return identity;
}

export function parseNativeRuntimeIdentityArguments(
  argv: string[],
): WriteNativeRuntimeIdentityOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--project-root', '--platform', '--output'].includes(flag) || !value) {
      throw new Error(
        'Usage: write-runtime-identity --project-root <path> --platform ios|android [--output <path>]',
      );
    }
    if (values.has(flag)) throw new Error(`Duplicate argument ${flag}.`);
    values.set(flag, value);
  }
  const projectRoot = values.get('--project-root');
  const platform = values.get('--platform');
  if (!projectRoot || (platform !== 'ios' && platform !== 'android')) {
    throw new Error(
      'Usage: write-runtime-identity --project-root <path> --platform ios|android [--output <path>]',
    );
  }
  return {
    projectRoot,
    platform,
    ...(values.get('--output') ? { outputPath: values.get('--output') } : {}),
  };
}

/* istanbul ignore next */
if (require.main === module) {
  try {
    const identity = writeNativeRuntimeIdentity(
      parseNativeRuntimeIdentityArguments(process.argv.slice(2)),
    );
    if (!process.argv.includes('--output')) {
      process.stdout.write(`${JSON.stringify(identity)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
