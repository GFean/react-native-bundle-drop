import { readBundleDropRuntimeSelection } from '../expo/runtimeVersion';
import { collectNativeFingerprintV2 } from '../fingerprintV2/collect';

export async function runRuntimeFingerprintWorker([projectRoot, platform]: string[]): Promise<void> {
  if (!projectRoot || (platform !== 'android' && platform !== 'ios')) {
    throw new Error('Usage: fingerprint worker <project-root> ios|android');
  }
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
