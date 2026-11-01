#!/usr/bin/env node
// Scheme 1 is checked against an explicit reviewed baseline; this tool never updates it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const contractPath = 'third_party/expo-fingerprint/scheme-1-contract.json';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function listFiles(root, relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const file = `${relative}/${entry.name}`;
    return entry.isDirectory() ? listFiles(root, file) : [file];
  }).sort();
}
function verifyFiles(files, readFile) {
  for (const [file, expected] of Object.entries(files)) {
    assert.equal(sha256(readFile(file)), expected, `Scheme 1 file changed: ${file}. Preserve existing behavior or introduce a new scheme.`);
  }
}
function checkPackagedFingerprintContract(packageJson, contract, readFile) {
  assert.equal(contract.schemeVersion, 1);
  assert.equal(contract.status, 'frozen');
  assert.deepEqual(packageJson.dependencies, contract.dependencies, 'Review scheme-1 dependency changes before updating the baseline');
  assert.deepEqual(packageJson.resolutions, contract.resolutions);
  verifyFiles(contract.packagedFiles, readFile);
}
function checkFingerprintContract(root) {
  const readFile = file => fs.readFileSync(path.join(root, file));
  const contract = JSON.parse(readFile(contractPath));
  const packageJson = JSON.parse(readFile('package.json'));
  checkPackagedFingerprintContract(packageJson, contract, readFile);
  for (const directory of ['src/fingerprint', 'third_party/expo-fingerprint/src']) {
    assert.equal(JSON.stringify(listFiles(root, directory)), JSON.stringify(Object.keys(contract.sourceFiles).filter(file => file.startsWith(`${directory}/`)).sort()), `Scheme 1 source inventory changed: ${directory}`);
  }
  for (const directory of ['lib/fingerprint', 'third_party/expo-fingerprint/build']) {
    assert.equal(JSON.stringify(listFiles(root, directory)), JSON.stringify(Object.keys(contract.packagedFiles).filter(file => file.startsWith(`${directory}/`)).sort()), `Scheme 1 packaged inventory changed: ${directory}`);
  }
  verifyFiles(contract.sourceFiles, readFile);
  assert.equal(sha256(readFile('yarn.lock')), contract.lockfileSha256, 'Review dependency-lock changes against retained scheme-1 compatibility');
  assert.equal(require('typescript').version, contract.typescriptVersion);
  return contract;
}
if (require.main === module) {
  const contract = checkFingerprintContract(path.resolve(__dirname, '..'));
  console.log(`Frozen scheme 1 verified: ${Object.keys(contract.sourceFiles).length} source files, ${Object.keys(contract.packagedFiles).length} packaged helpers, locked dependencies.`);
}
module.exports = { checkFingerprintContract, checkPackagedFingerprintContract };
