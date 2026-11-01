const currentHash = 'a'.repeat(64);
const path = '/bundle-drop/pending-rollback.json';

function load(runtimeVersion: string | null = 'runtime-1') {
  jest.resetModules();
  const files = new Map<string, string>();
  const readCurrentBundleHash = jest.fn(async (): Promise<string | null> => currentHash);
  const fs = {
    exists: jest.fn(async (name: string) => files.has(name)),
    readFile: jest.fn(async (name: string) => files.get(name)),
    writeFile: jest.fn(async (name: string, content: string) => { files.set(name, content); }),
    unlink: jest.fn(async (name: string) => { files.delete(name); }),
    mkdir: jest.fn(async () => undefined),
    moveFile: jest.fn(async (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
  };
  jest.doMock('../../context', () => ({ BUNDLE_DROP_ROOT: '/bundle-drop', runtimeVersion: runtimeVersion ?? undefined }));
  jest.doMock('../../native/fs', () => ({ __esModule: true, default: fs }));
  jest.doMock('../../fs/bundlePointer', () => ({ readCurrentBundleHash }));
  const module = require('../../manager/pendingRollback') as typeof import('../../manager/pendingRollback');
  return { module, files, fs, readCurrentBundleHash };
}

describe('pending manual rollback intent', () => {
  afterEach(() => {
    jest.unmock('../../context');
    jest.unmock('../../native/fs');
    jest.unmock('../../fs/bundlePointer');
    jest.restoreAllMocks();
  });

  it('persists an intent separately from the current bundle and survives a module reload', async () => {
    const { module, files, fs } = load();
    expect(await module.readPendingRollback()).toBeNull();
    await module.clearPendingRollback();
    await module.stageRollback('General', 'SERVER_REQUESTED_ROLLBACK');
    expect(fs.mkdir).toHaveBeenCalledWith('/bundle-drop');
    expect(JSON.parse(files.get(path)!)).toEqual({
      schemaVersion: 1, channelName: 'General', currentHash,
      runtimeVersion: 'runtime-1', reason: 'SERVER_REQUESTED_ROLLBACK',
    });
    jest.resetModules();
    const reloaded = require('../../manager/pendingRollback') as typeof module;
    const intent = (await reloaded.readPendingRollback())!;
    expect(await reloaded.isPendingRollbackCurrent(intent, 'General')).toBe(true);
    await reloaded.clearPendingRollback();
    expect(await reloaded.readPendingRollback()).toBeNull();
    expect([...files.keys()]).toEqual([]);
  });

  it('supports embedded selection, an absent reason and legacy runtime identity', async () => {
    const { module, readCurrentBundleHash, files } = load(null);
    readCurrentBundleHash.mockResolvedValue(null);
    files.set('/bundle-drop', 'directory');
    await module.stageRollback('General');
    const intent = (await module.readPendingRollback())!;
    expect(intent).toEqual({ schemaVersion: 1, channelName: 'General', currentHash: null, runtimeVersion: null });
    expect(await module.isPendingRollbackCurrent(intent, 'General')).toBe(true);
  });

  it('rejects a stale channel, runtime or current selection', async () => {
    const { module, readCurrentBundleHash } = load();
    await module.stageRollback('General');
    const intent = (await module.readPendingRollback())!;
    expect(await module.isPendingRollbackCurrent(intent, 'Beta')).toBe(false);
    expect(await module.isPendingRollbackCurrent({ ...intent, runtimeVersion: 'old' }, 'General')).toBe(false);
    readCurrentBundleHash.mockResolvedValue('b'.repeat(64));
    expect(await module.isPendingRollbackCurrent(intent, 'General')).toBe(false);
  });

  it.each([
    null, {}, { schemaVersion: 2 }, { channelName: 7 }, { currentHash: 'bad' },
    { runtimeVersion: 5 }, { reason: false },
  ])('ignores malformed intent %j without blocking native safety recovery', async invalid => {
    const { module, files } = load();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await module.stageRollback('General');
    const intent = (await module.readPendingRollback())!;
    files.set(path, JSON.stringify(invalid === null ? null : { ...intent, ...invalid }));
    // An empty override keeps the valid record; replace it with an invalid schema.
    if (invalid && Object.keys(invalid).length === 0) files.set(path, '{}');
    expect(await module.readPendingRollback()).toBeNull();
  });

  it('ignores unreadable JSON but propagates staging and clearing failures', async () => {
    const { module, fs, files } = load();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    files.set(path, '{');
    expect(await module.readPendingRollback()).toBeNull();
    fs.unlink.mockRejectedValueOnce(new Error('disk error'));
    await expect(module.clearPendingRollback()).rejects.toThrow('disk error');
    fs.writeFile.mockRejectedValue(new Error('disk full'));
    await expect(module.stageRollback('General')).rejects.toThrow('disk full');
  });
});
