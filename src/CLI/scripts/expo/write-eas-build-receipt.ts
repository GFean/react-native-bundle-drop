import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  parseExpoBuildIdentityReceipt,
  resolveExpoIntegrationGeneration,
} from '../../../expo/buildReceipt';
import type { ExpoBuildIdentityReceipt } from '../../../expo/buildReceipt';
import type { MobilePlatform } from '../../../expo';
import { resolveOfficialEasBuild } from './eas-build-proof';

export type WriteEasBuildReceiptOptions = {
  projectRoot: string;
  platform: MobilePlatform;
  easBuildId: string;
  outputPath?: string;
};

const defaultReceiptPath = (
  projectRoot: string,
  platform: MobilePlatform,
  easBuildId: string,
): string => path.join(
  projectRoot,
  '.bundle-drop',
  `eas-build-identity-${platform}-${easBuildId}.json`,
);

const writeJsonWithoutOverwrite = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    throw new Error(`Bundle Drop will not overwrite the existing EAS build receipt at ${filePath}.`);
  }

  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    // Linking a complete temporary file publishes it atomically while retaining
    // exclusive-create semantics if another process wrote the destination first.
    fs.linkSync(temporaryPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Bundle Drop will not overwrite the existing EAS build receipt at ${filePath}.`);
    }
    throw error;
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
};

export async function writeEasBuildReceipt(
  options: WriteEasBuildReceiptOptions,
): Promise<string> {
  const projectRoot = path.resolve(options.projectRoot);
  const resolvedBuild = await resolveOfficialEasBuild({
    projectRoot,
    platform: options.platform,
    easBuildId: options.easBuildId,
  });
  const integrationGeneration = resolveExpoIntegrationGeneration();
  const receipt: ExpoBuildIdentityReceipt = {
    schemaVersion: 3,
    identities: {
      [options.platform]: resolvedBuild.identity,
    },
    proofs: {
      [options.platform]: {
        createdAt: new Date().toISOString(),
        evidence: 'eas-official-metadata',
        integrationGeneration,
        easBuildId: resolvedBuild.buildId,
      },
    },
  };

  const validatedReceipt = parseExpoBuildIdentityReceipt(receipt, integrationGeneration);
  const receiptPath = options.outputPath
    ? path.resolve(projectRoot, options.outputPath)
    : defaultReceiptPath(projectRoot, options.platform, resolvedBuild.buildId);
  writeJsonWithoutOverwrite(receiptPath, validatedReceipt);
  return receiptPath;
}
