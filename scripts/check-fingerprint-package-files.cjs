const requiredFiles = [
  'lib/CLI/scripts/fingerprint-command.js',
  'lib/runtime-fingerprint/calculate.js',
  'lib/runtime-fingerprint/selection.js',
  'lib/runtime-fingerprint/worker.js',
  'lib/fingerprintV2/collect.js',
  'lib/fingerprintV2/cocoapodsLock.js',
  'lib/fingerprintV2/dependencies.js',
  'lib/fingerprintV2/files.js',
  'lib/fingerprint/normalizeBuildNumber.js',
  'lib/fingerprint/normalizeIosBuildNumber.js',
  'third_party/expo-fingerprint/build/Options.js',
  'third_party/expo-fingerprint/build/sourcer/SourceSkips.js',
  'third_party/expo-fingerprint/build/sourcer/Sourcer.js',
  'third_party/expo-fingerprint/build/utils/Path.js',
  'third_party/expo-fingerprint/LICENSE',
  'third_party/expo-fingerprint/NOTICE',
  'third_party/expo-fingerprint/PROVENANCE.md',
  'third_party/expo-fingerprint/upstream-files.json',
];

const retiredFiles = [
  /^lib\/CLI\/scripts\/fingerprint-cli\.(?:js|d\.ts)$/,
  /^lib\/fingerprint\/(?:client|collect|config|worker)\.(?:js|d\.ts)$/,
  /^third_party\/expo-fingerprint\/scheme-1-contract\.json$/,
];

function checkFingerprintPackageFiles(entries) {
  const files = new Set(entries);
  const missing = requiredFiles.filter(file => !files.has(file));
  if (missing.length > 0) {
    throw new Error(`missing fingerprint files: ${missing.join(', ')}`);
  }
  const retired = [...files].filter(file => retiredFiles.some(pattern => pattern.test(file)));
  if (retired.length > 0) {
    throw new Error(`retired Scheme 1 files: ${retired.join(', ')}`);
  }
}

module.exports = { checkFingerprintPackageFiles };
