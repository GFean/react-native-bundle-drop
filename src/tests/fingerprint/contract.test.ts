import fs from 'fs';
import os from 'os';
import path from 'path';

const { checkFingerprintContract, checkPackagedFingerprintContract } = require('../../../scripts/check-fingerprint-contract.cjs');
const repository = path.resolve(__dirname, '../../..');
const contractPath = 'third_party/expo-fingerprint/scheme-1-contract.json';
const contract = JSON.parse(fs.readFileSync(path.join(repository, contractPath), 'utf8'));

describe('frozen scheme-1 release guard', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-scheme1-contract-'));
    const files = new Set([contractPath, 'package.json', 'yarn.lock',
      ...Object.keys(contract.sourceFiles), ...Object.keys(contract.packagedFiles)]);
    for (const file of files) {
      const destination = path.join(root, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repository, file), destination);
    }
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts the complete source and packaged baseline', () => {
    expect(checkFingerprintContract(root).schemeVersion).toBe(1);
  });
  it('rejects a change to a supporting helper rather than only pinning the collector entry point', () => {
    fs.appendFileSync(path.join(root, 'third_party/expo-fingerprint/src/Options.ts'), '\n// changed\n');
    expect(() => checkFingerprintContract(root)).toThrow(/Scheme 1 file changed/);
  });
  it('rejects an added unpinned collector helper', () => {
    fs.writeFileSync(path.join(root, 'src/fingerprint/unpinned.ts'), 'export const input = 1;');
    expect(() => checkFingerprintContract(root)).toThrow(/inventory changed/);
  });
  it('rejects dependency-lock drift', () => {
    fs.appendFileSync(path.join(root, 'yarn.lock'), '\n');
    expect(() => checkFingerprintContract(root)).toThrow(/dependency-lock changes/);
  });
  it('rejects tampered shipped code without access to repository sources', () => {
    const file = 'third_party/expo-fingerprint/build/Options.js';
    fs.appendFileSync(path.join(root, file), '\n// changed\n');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(() => checkPackagedFingerprintContract(packageJson, contract,
      (name: string) => fs.readFileSync(path.join(root, name)))).toThrow(/Scheme 1 file changed/);
  });
  it('rejects changed package dependency declarations', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    packageJson.dependencies.glob = '999.0.0';
    expect(() => checkPackagedFingerprintContract(packageJson, contract,
      (name: string) => fs.readFileSync(path.join(root, name)))).toThrow(/dependency changes/);
  });
});
