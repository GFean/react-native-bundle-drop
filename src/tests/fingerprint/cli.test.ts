import fs from 'fs';
import os from 'os';
import path from 'path';
import { compareFingerprintSources, runFingerprintCli } from '../../CLI/scripts/fingerprint-cli';
import { calculateFingerprintSync } from '../../fingerprint/client';
import type { NativeFingerprint } from '../../fingerprint/types';

jest.mock('../../fingerprint/client', () => ({ calculateFingerprintSync: jest.fn() }));

const report: NativeFingerprint = {
  status: 'stable', schemeVersion: 1, platform: 'android', runtimeVersion: 'bdfp1-test',
  nativeHash: 'hash', manualBoundary: null,
  sources: [{ type: 'file', id: 'native.cpp', hash: 'one', reasons: [] }],
};

describe('scheme-1 fingerprint CLI', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-fingerprint-cli-'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    (calculateFingerprintSync as jest.Mock).mockReturnValue(report);
  });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('prints the stable status and can write a digest-only report', () => {
    const output = path.join(root, 'output', 'report.json');
    expect(runFingerprintCli({ platform: 'android', output })).toBe(report);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(report);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('calculation contract frozen'));
  });

  it('prints JSON and compares added, removed and changed inputs', () => {
    const previous = { ...report, status: 'experimental', sources: [{ type: 'file', id: 'old.cpp', hash: 'old', reasons: [] }] };
    const file = path.join(root, 'old.json');
    fs.writeFileSync(file, JSON.stringify(previous));
    runFingerprintCli({ platform: 'ios', compare: file, json: true });
    expect(JSON.parse((console.log as jest.Mock).mock.calls[0][0]).changes).toEqual([
      { id: 'file:native.cpp', before: null, after: 'one' },
      { id: 'file:old.cpp', before: 'old', after: null },
    ]);
    (console.log as jest.Mock).mockClear();
    runFingerprintCli({ platform: 'android', compare: file });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('old.cpp'));
    (console.log as jest.Mock).mockClear();
    runFingerprintCli({ platform: 'android', json: true });
    expect(JSON.parse((console.log as jest.Mock).mock.calls[0][0])).toEqual(report);
  });

  it('does not report ignored directory presence as a changed hash input', () => {
    expect(compareFingerprintSources(report, { ...report, sources: [
      ...report.sources, { type: 'dir', id: 'android', hash: null, reasons: ['ignoredCng'] },
    ] })).toEqual([]);
    expect(compareFingerprintSources({ ...report, sources: [
      ...report.sources, { type: 'dir', id: 'android', hash: null, reasons: [] },
    ] }, report)).toEqual([]);
  });

  it('rejects invalid platforms and malformed comparison reports', () => {
    expect(() => runFingerprintCli({ platform: 'windows' })).toThrow('ios or android');
    expect(() => compareFingerprintSources({} as any, report)).toThrow('Invalid fingerprint report');
    expect(() => compareFingerprintSources(report, {} as any)).toThrow('Invalid fingerprint report');
  });
});
