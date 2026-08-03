import { atomicWriteJson, cleanOrphanedTempZips } from '../../fs/fsUtils';
import {
  getMockFile,
  mockReadDir,
  mockUnlink,
  setMockFile,
} from '../mocks/native/fs';

jest.mock('../../native/fs', () => require('../mocks/native/fs'));

describe('fs/fsUtils', () => {
  it('falls back to direct writes when atomic moves fail', async () => {
    const nativeFs = require('../mocks/native/fs') as typeof import('../mocks/native/fs');

    nativeFs.mockMoveFile.mockRejectedValueOnce(new Error('rename failed'));
    await atomicWriteJson('/mock/doc/state.json', { ready: true });

    expect(JSON.parse(getMockFile('/mock/doc/state.json') || '{}')).toEqual({ ready: true });
  });

  describe('cleanOrphanedTempZips', () => {
    it('removes files matching _tmp_*.zip and returns the count', async () => {
      setMockFile('/mock/doc/bundles/_tmp_abc.zip', 'zip1');
      setMockFile('/mock/doc/bundles/_tmp_def.zip', 'zip2');
      setMockFile('/mock/doc/bundles/hash-1/main.jsbundle', 'bundle');

      const removed = await cleanOrphanedTempZips('/mock/doc/bundles');

      expect(removed).toBe(2);
      expect(getMockFile('/mock/doc/bundles/_tmp_abc.zip')).toBeUndefined();
      expect(getMockFile('/mock/doc/bundles/_tmp_def.zip')).toBeUndefined();
      expect(getMockFile('/mock/doc/bundles/hash-1/main.jsbundle')).toBe('bundle');
      expect(mockUnlink).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when there are no temp zips', async () => {
      setMockFile('/mock/doc/bundles/hash-1/main.jsbundle', 'bundle');

      const removed = await cleanOrphanedTempZips('/mock/doc/bundles');

      expect(removed).toBe(0);
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('returns 0 and swallows errors when readDir fails', async () => {
      mockReadDir.mockRejectedValueOnce(new Error('ENOENT'));

      const removed = await cleanOrphanedTempZips('/mock/doc/nonexistent');

      expect(removed).toBe(0);
    });
  });
});
