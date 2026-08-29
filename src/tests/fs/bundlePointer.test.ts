import { readCurrentBundleHash } from '../../fs/bundlePointer';
import { resetNativeFsMocks, setMockFile } from '../mocks/native/fs';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));

const CURRENT_POINTER_PATH = '/mock/doc/bundle-drop/current.json';
const HASH_1 = '1'.repeat(64);

describe('fs/bundlePointer passive reads', () => {
  beforeEach(() => {
    resetNativeFsMocks();
  });

  it('reads only the canonical hash from the native-managed current pointer', async () => {
    setMockFile(CURRENT_POINTER_PATH, JSON.stringify({
      hash: HASH_1,
      bundlePath: '/stale/container/current.jsbundle',
      updatedAt: '2026-03-01T00:00:00.000Z',
    }));
    await expect(readCurrentBundleHash()).resolves.toBe(HASH_1);
  });

  it('returns null for missing, malformed, and non-canonical pointers', async () => {
    await expect(readCurrentBundleHash()).resolves.toBeNull();

    setMockFile(CURRENT_POINTER_PATH, '{invalid json');
    await expect(readCurrentBundleHash()).resolves.toBeNull();

    setMockFile(CURRENT_POINTER_PATH, JSON.stringify({}));
    await expect(readCurrentBundleHash()).resolves.toBeNull();
  });
});
