import { collectNativeFingerprint } from './collect';

export async function runFingerprintWorker(args: string[]): Promise<void> {
  const [projectRoot, platform] = args;
  if (!projectRoot || (platform !== 'ios' && platform !== 'android')) {
    process.stderr.write('Usage: fingerprint worker <project-root> ios|android\n');
    process.exitCode = 1;
  } else {
    try {
      const value = await collectNativeFingerprint(projectRoot, platform);
      process.stdout.write(`${JSON.stringify(value)}\n`);
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}

/* istanbul ignore next -- entry point is exercised by packaged binary experiments */
if (require.main === module) void runFingerprintWorker(process.argv.slice(2));
