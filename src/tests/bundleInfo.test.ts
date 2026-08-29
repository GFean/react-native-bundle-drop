import { deleteBundleInfo, readBundleInfo, updateBundleInfo, writeBundleInfo } from '../bundleInfo';
import {
  getMockFile,
  mockUnlink,
  mockWriteFile,
  resetNativeFsMocks,
  setMockFile,
} from './mocks/native/fs';

jest.mock('../native/fs', () => require('./mocks/native/fs'));

const BUNDLE_INFO_PATH = '/mock/doc/bundle-info.json';

describe('bundleInfo', () => {
  beforeEach(() => {
    resetNativeFsMocks();
  });

  it('returns null when bundle info is missing or unreadable', async () => {
    await expect(readBundleInfo()).resolves.toBeNull();

    setMockFile(BUNDLE_INFO_PATH, '{invalid-json');
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(readBundleInfo()).resolves.toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('writes bundle info and merges partial updates', async () => {
    await writeBundleInfo({
      hash: 'hash-1',
      bundleVersion: 1,
      pendingApply: true,
    });

    expect(JSON.parse(getMockFile(BUNDLE_INFO_PATH) || '{}')).toEqual({
      hash: 'hash-1',
      bundleVersion: 1,
      pendingApply: true,
    });

    await updateBundleInfo({
      pendingApply: false,
      lastInstalledReportedHash: 'hash-1',
    });

    await expect(readBundleInfo()).resolves.toEqual({
      hash: 'hash-1',
      bundleVersion: 1,
      pendingApply: false,
      lastInstalledReportedHash: 'hash-1',
    });
  });

  it('creates bundle info from scratch when updating without an existing file', async () => {
    await updateBundleInfo({
      hash: 'hash-bootstrap',
      pendingApply: true,
    });

    await expect(readBundleInfo()).resolves.toEqual({
      hash: 'hash-bootstrap',
      pendingApply: true,
    });
  });

  it('warns when bundle info writes fail', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockWriteFile.mockRejectedValueOnce(new Error('disk full'));

    try {
      await writeBundleInfo({
        hash: 'hash-fail',
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        '⚠️ Failed to write bundle-info.json',
        expect.any(Error),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('deletes persisted bundle info and tolerates missing files and delete failures', async () => {
    setMockFile(BUNDLE_INFO_PATH, JSON.stringify({ hash: 'hash-1' }));
    await deleteBundleInfo();
    expect(getMockFile(BUNDLE_INFO_PATH)).toBeUndefined();

    await expect(deleteBundleInfo()).resolves.toBeUndefined();

    setMockFile(BUNDLE_INFO_PATH, JSON.stringify({ hash: 'hash-2' }));
    mockUnlink.mockRejectedValueOnce(new Error('disk unavailable'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(deleteBundleInfo()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        '⚠️ Failed to delete bundle-info.json',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
