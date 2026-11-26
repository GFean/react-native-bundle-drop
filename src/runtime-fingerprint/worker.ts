import { readBundleDropRuntimeSelection } from '../expo/runtimeVersion';
import { collectNativeFingerprintV2 } from '../fingerprintV2/collect';

export async function runRuntimeFingerprintWorker([platform, ...extraArgs]: string[]): Promise<void> {
  if (extraArgs.length || (platform !== 'android' && platform !== 'ios')) {
    throw new Error('Usage: fingerprint worker ios|android (from the project directory)');
  }
  // The caller sets the working directory when starting the worker.
  const projectRoot = process.cwd();
  const selection = readBundleDropRuntimeSelection(projectRoot, platform);
  if (selection.source !== 'fingerprint') {
    throw new Error('Fingerprint collection requires compatibilitySource: fingerprint.');
  }
  const { nativeProjectMode, extraSources } = selection.options;
  const report = await collectNativeFingerprintV2(projectRoot, platform, { nativeProjectMode, extraSources }, selection.boundary);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

/* istanbul ignore next -- the packed CLI exercises this separate process */
if (require.main === module) {
  void runRuntimeFingerprintWorker(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
