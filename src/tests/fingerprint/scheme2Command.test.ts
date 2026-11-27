import fs from 'fs';
import os from 'os';
import path from 'path';
import { runFingerprintCommand } from '../../CLI/scripts/fingerprint-command';
import { calculateRuntimeFingerprint } from '../../runtime-fingerprint/calculate';
import type { RuntimeFingerprint } from '../../runtime-fingerprint/calculate';

jest.mock('../../runtime-fingerprint/calculate');

const report: RuntimeFingerprint = {
  status: 'stable', schemeVersion: 2, platform: 'ios',
  runtimeVersion: 'bdfp2-test', nativeHash: 'hash', manualBoundary: null,
  sources: [
    { type: 'file', id: 'unchanged', hash: 'same', reasons: [] },
    { type: 'file', id: 'added', hash: 'new', reasons: [] },
  ],
};

describe('Scheme 2 fingerprint command', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-command-'));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.mocked(calculateRuntimeFingerprint).mockReturnValue(report);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('prints Scheme 2 output and validates the requested platform', () => {
    runFingerprintCommand({ platform: 'ios' });
    expect(calculateRuntimeFingerprint).toHaveBeenCalledWith(process.cwd(), 'ios');
    expect(console.log).toHaveBeenLastCalledWith('bdfp2-test\nScheme 2.');
    expect(() => runFingerprintCommand({ platform: 'windows' })).toThrow('ios or android');
  });

  it('writes a report and compares a legacy report without treating drift as a command error', () => {
    const output = path.join(directory, 'nested', 'report.json');
    const compare = path.join(directory, 'previous.json');
    fs.writeFileSync(compare, JSON.stringify({ ...report, schemeVersion: 1, runtimeVersion: 'bdfp1-old', sources: [
      report.sources[0], { type: 'file', id: 'removed', hash: 'old', reasons: [] },
    ] }));
    const changes = [
      { id: 'file:added', before: null, after: 'new' },
      { id: 'file:removed', before: 'old', after: null },
    ];
    expect(runFingerprintCommand({ platform: 'ios', output, compare, json: true })).toBe(report);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(report);
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify({ ...report, changes }));
    runFingerprintCommand({ platform: 'ios', compare });
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('file:removed'));
    runFingerprintCommand({ platform: 'ios' });
    expect(console.log).toHaveBeenLastCalledWith('bdfp2-test\nScheme 2.');
    runFingerprintCommand({ platform: 'ios', json: true });
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify(report));
  });

  it.each([{}, null])('rejects an invalid saved report %j', value => {
    const compare = path.join(directory, 'invalid.json');
    fs.writeFileSync(compare, JSON.stringify(value));
    expect(() => runFingerprintCommand({ platform: 'ios', compare })).toThrow('Invalid fingerprint report');
  });
});
