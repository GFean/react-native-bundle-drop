import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { ExpoBuildIdentity } from '../../../../expo';
import {
  parseExpoBuildIdentityReceipt,
  resolveExpoIntegrationGeneration,
} from '../../../../expo/buildReceipt';
import * as easBuildProof from '../../../../CLI/scripts/expo/eas-build-proof';
import { writeEasBuildReceipt } from '../../../../CLI/scripts/expo/write-eas-build-receipt';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

const buildId = '11111111-1111-4111-8111-111111111111';

const identity = (): ExpoBuildIdentity => {
  const value: Omit<ExpoBuildIdentity, 'identityHash'> = {
    platform: 'ios',
    runtimeVersion: 'runtime-1',
    runtimeVersionPolicy: 'literal',
    expoSdkVersion: '57.0.0',
    reactNativeVersion: '0.86.0',
    javaScriptEngine: 'hermes',
    appVersion: '1.2.3',
    nativeVersion: '1.2.3(7)',
  };
  return {
    ...value,
    identityHash: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  };
};

describe('EAS build receipt writer', () => {
  let projectRoot = '';
  let resolveSpy: jest.SpyInstance;

  beforeEach(() => {
    projectRoot = createTempProjectDir();
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    resolveSpy = jest.spyOn(easBuildProof, 'resolveOfficialEasBuild').mockResolvedValue({
      buildId,
      identity: identity(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    removeTempDir(projectRoot);
  });

  it('writes a validated schema-v3 receipt from the officially resolved identity', async () => {
    const receiptPath = await writeEasBuildReceipt({
      projectRoot,
      platform: 'ios',
      easBuildId: buildId,
    });

    expect(receiptPath).toBe(path.join(
      projectRoot,
      '.bundle-drop',
      `eas-build-identity-ios-${buildId}.json`,
    ));
    expect(resolveSpy).toHaveBeenCalledWith({
      projectRoot,
      platform: 'ios',
      easBuildId: buildId,
    });
    const receipt = parseExpoBuildIdentityReceipt(
      JSON.parse(fs.readFileSync(receiptPath, 'utf8')),
      resolveExpoIntegrationGeneration(),
    );
    expect(receipt.identities).toEqual({ ios: identity() });
    expect(receipt.proofs).toEqual({
      ios: {
        createdAt: '2026-08-01T00:00:00.000Z',
        evidence: 'eas-official-metadata',
        integrationGeneration: resolveExpoIntegrationGeneration(),
        easBuildId: buildId,
      },
    });
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(receiptPath)).filter(name => name.endsWith('.tmp')))
      .toEqual([]);
  });

  it('supports an explicit output path without overwriting an existing receipt', async () => {
    const outputPath = path.join('.bundle-drop', 'receipts', 'ios.json');
    const receiptPath = await writeEasBuildReceipt({
      projectRoot,
      platform: 'ios',
      easBuildId: buildId,
      outputPath,
    });
    const original = fs.readFileSync(receiptPath, 'utf8');

    await expect(writeEasBuildReceipt({
      projectRoot,
      platform: 'ios',
      easBuildId: buildId,
      outputPath,
    })).rejects.toThrow('will not overwrite');
    expect(fs.readFileSync(receiptPath, 'utf8')).toBe(original);
  });

  it('validates the derived identity before creating an output file', async () => {
    resolveSpy.mockResolvedValue({
      buildId,
      identity: { ...identity(), identityHash: 'forged' },
    });

    await expect(writeEasBuildReceipt({
      projectRoot,
      platform: 'ios',
      easBuildId: buildId,
    })).rejects.toThrow('invalid ios identity hash');
    expect(fs.existsSync(path.join(projectRoot, '.bundle-drop'))).toBe(false);
  });

  it('fails closed when another process wins the atomic receipt write', async () => {
    const atomicWriteError = Object.assign(new Error('destination exists'), { code: 'EEXIST' });
    jest.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw atomicWriteError;
    });

    await expect(writeEasBuildReceipt({
      projectRoot,
      platform: 'ios',
      easBuildId: buildId,
    })).rejects.toThrow('will not overwrite');

    const outputDirectory = path.join(projectRoot, '.bundle-drop');
    expect(fs.existsSync(path.join(
      outputDirectory,
      `eas-build-identity-ios-${buildId}.json`,
    ))).toBe(false);
    expect(fs.readdirSync(outputDirectory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves unexpected atomic write failures and removes the temporary file', async () => {
    const diskError = Object.assign(new Error('disk unavailable'), { code: 'EIO' });
    jest.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw diskError;
    });

    await expect(writeEasBuildReceipt({
      projectRoot,
      platform: 'ios',
      easBuildId: buildId,
    })).rejects.toBe(diskError);

    const outputDirectory = path.join(projectRoot, '.bundle-drop');
    expect(fs.readdirSync(outputDirectory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
