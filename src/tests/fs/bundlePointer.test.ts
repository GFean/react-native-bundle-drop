import {
  clearCurrentBundlePointer,
  deletePreviousBundlePointer,
  readCurrentBundlePointer,
  readPreviousBundlePointer,
  rollbackToPreviousPointer,
  setCurrentBundlePointer,
} from '../../fs/bundlePointer';
import { getMockFile, setMockFile } from '../mocks/native/fs';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));

const CURRENT_POINTER_PATH = '/mock/doc/bundle-drop/current.json';
const PREVIOUS_POINTER_PATH = '/mock/doc/bundle-drop/previous.json';
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const HASH_3 = '3'.repeat(64);
const HASH_4 = '4'.repeat(64);
const bundlePath = (hash: string) => `/mock/doc/bundle-drop/bundles/${hash}/main.jsbundle`;

describe('fs/bundlePointer', () => {
  it('writes the current bundle pointer when none exists', async () => {
    await setCurrentBundlePointer('/old/container/bundles/stale/main.jsbundle', HASH_1);

    expect(await readCurrentBundlePointer()).toEqual(
      expect.objectContaining({
        hash: HASH_1,
        bundlePath: bundlePath(HASH_1),
      })
    );
    expect(JSON.parse(getMockFile(CURRENT_POINTER_PATH) ?? '{}')).toEqual({
      hash: HASH_1,
      updatedAt: expect.any(String),
    });
    expect(await readPreviousBundlePointer()).toBeNull();
  });

  it('moves the old current pointer into previous before writing the new one', async () => {
    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: HASH_1,
        bundlePath: '/old/container/bundles/hash-old/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );

    await setCurrentBundlePointer('/new/container/bundles/hash-new/main.jsbundle', HASH_2);

    expect(await readCurrentBundlePointer()).toEqual(
      expect.objectContaining({
        hash: HASH_2,
        bundlePath: bundlePath(HASH_2),
      })
    );
    expect(await readPreviousBundlePointer()).toEqual(
      expect.objectContaining({
        hash: HASH_1,
        bundlePath: bundlePath(HASH_1),
      })
    );
    expect(JSON.parse(getMockFile(PREVIOUS_POINTER_PATH) ?? '{}')).toEqual({
      hash: HASH_1,
      updatedAt: expect.any(String),
    });
  });

  it('skips writing the previous pointer when requested', async () => {
    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: HASH_1,
        bundlePath: '/bundles/hash-old/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );

    await setCurrentBundlePointer('/bundles/hash-new/main.jsbundle', HASH_2, {
      setPrevious: false,
    });

    expect(await readCurrentBundlePointer()).toEqual(
      expect.objectContaining({
        hash: HASH_2,
      })
    );
    expect(getMockFile(PREVIOUS_POINTER_PATH)).toBeUndefined();
  });

  it('rolls back to the previous pointer when available', async () => {
    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: HASH_3,
        bundlePath: '/bundles/hash-prev/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );

    await expect(rollbackToPreviousPointer()).resolves.toEqual(
      expect.objectContaining({
        hash: HASH_3,
      })
    );

    expect(await readCurrentBundlePointer()).toEqual(
      expect.objectContaining({
        hash: HASH_3,
        bundlePath: bundlePath(HASH_3),
      })
    );
  });

  it('returns null when rolling back without a previous pointer', async () => {
    await expect(rollbackToPreviousPointer()).resolves.toBeNull();
    await expect(readCurrentBundlePointer()).resolves.toBeNull();
  });

  it('clears the current pointer and ignores missing files', async () => {
    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: HASH_4,
        bundlePath: '/bundles/hash-current/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );

    await clearCurrentBundlePointer();
    await clearCurrentBundlePointer();

    expect(getMockFile(CURRENT_POINTER_PATH)).toBeUndefined();
  });

  it('deletes the previous pointer and ignores missing files', async () => {
    setMockFile(
      PREVIOUS_POINTER_PATH,
      JSON.stringify({
        hash: HASH_4,
        bundlePath: '/bundles/hash-previous/main.jsbundle',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })
    );

    await deletePreviousBundlePointer();
    await deletePreviousBundlePointer();

    expect(getMockFile(PREVIOUS_POINTER_PATH)).toBeUndefined();
  });

  it('returns null for invalid or malformed pointers', async () => {
    setMockFile(
      CURRENT_POINTER_PATH,
      JSON.stringify({
        hash: 'hash-only',
      })
    );
    setMockFile(PREVIOUS_POINTER_PATH, '{invalid json');

    await expect(readCurrentBundlePointer()).resolves.toBeNull();
    await expect(readPreviousBundlePointer()).resolves.toBeNull();
  });

  it('returns null when a pointer has no canonical hash', async () => {
    setMockFile(CURRENT_POINTER_PATH, JSON.stringify({ bundlePath: '/stale/main.jsbundle' }));

    await expect(readCurrentBundlePointer()).resolves.toBeNull();
  });

  it('rejects writes with non-canonical hashes', async () => {
    await expect(setCurrentBundlePointer('/bundles/hash/main.jsbundle', 'hash-short')).rejects.toThrow(
      'Bundle pointer hash must be a canonical 64-character lowercase SHA-256 hash',
    );
  });
});
