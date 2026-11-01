import { mergeInstalledReportHistory } from '../../fs/installedReportHistory';
import { mockReadFile, readMockJson, setMockFile } from '../mocks/native/fs';
import { setMockConfig } from '../mocks/context';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));

const PATH = '/mock/doc/bundle-drop/installed-report-history.json';

describe('installed report history', () => {
  it('preserves valid history when reading fails, then permits a later retry', async () => {
    await mergeInstalledReportHistory('install', [], 'old');
    mockReadFile.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(mergeInstalledReportHistory('install', [], 'new')).rejects.toThrow('storage unavailable');
    expect(readMockJson(PATH)).toEqual(expect.objectContaining({ hashes: ['old'] }));
    expect(await mergeInstalledReportHistory('install', [], 'new')).toEqual(['old', 'new']);
  });

  it('bounds legacy history to fifty unique hashes and refreshes a newly acknowledged hash', async () => {
    const legacy = Array.from({ length: 55 }, (_, index) => `hash-${index}`);
    const hashes = await mergeInstalledReportHistory('install', [...legacy, 'hash-54']);
    expect(hashes).toEqual(legacy.slice(5));
    const refreshed = await mergeInstalledReportHistory('install', [], 'hash-5');
    expect(refreshed).toEqual([...legacy.slice(6), 'hash-5']);
    expect(await mergeInstalledReportHistory('install', [], 'new')).toEqual([
      ...legacy.slice(7), 'hash-5', 'new',
    ]);
  });

  it.each([
    ['installation', () => {}, 'new-install'],
    ['project', () => setMockConfig({ project: { name: 'Other', slug: 'other' } }), 'install'],
    ['organization', () => setMockConfig({ org: { slug: 'other' } }), 'install'],
    ['server', () => setMockConfig({ serverUrl: 'https://other.example.com' }), 'install'],
  ] as const)('does not inherit old or unscoped legacy history after a %s change', async (_name, change, installId) => {
    await mergeInstalledReportHistory('install', ['old']);
    change();
    expect(await mergeInstalledReportHistory(installId, ['old'])).toEqual([]);
    expect(await mergeInstalledReportHistory(installId, ['old'], 'new')).toEqual(['new']);
    expect(readMockJson(PATH)).toEqual(expect.objectContaining({ hashes: ['new'] }));
  });

  it.each([
    'null', '{}', '{"scope":1,"hashes":[]}',
    '{"scope":"scope","hashes":null}', '{"scope":"scope","hashes":[1]}', 'not-json',
  ])('recovers malformed history without importing unscoped legacy acknowledgements: %s', async raw => {
    setMockFile(PATH, raw);
    expect(await mergeInstalledReportHistory('install', ['unscoped'])).toEqual([]);
    expect(await mergeInstalledReportHistory('install', [], 'new')).toEqual(['new']);
    expect(readMockJson(PATH)).toEqual(expect.objectContaining({ hashes: ['new'] }));
  });
});
