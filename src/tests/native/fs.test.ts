type NativeFsModule = typeof import('../../native/fs').default;

const loadNativeFsModule = (
  configure?: (deps: { NativeModules: typeof import('react-native').NativeModules }) => void,
) => {
  jest.resetModules();
  const reactNative = require('react-native') as typeof import('react-native');
  configure?.({
    NativeModules: reactNative.NativeModules,
  });
  return {
    reactNative,
    module: require('../../native/fs').default as NativeFsModule,
  };
};

describe('native/fs', () => {
  it('exposes native directory constants and forwards file operations to the bridge', async () => {
    const { reactNative, module } = loadNativeFsModule();
    reactNative.NativeModules.BundleDrop.fsExists.mockResolvedValue(true);
    reactNative.NativeModules.BundleDrop.fsReadFile.mockResolvedValue('content');

    expect(module.DocumentDirectoryPath).toBe('/mock/doc');
    expect(module.LibraryDirectoryPath).toBe('/mock/lib');

    await expect(module.exists('/tmp/file')).resolves.toBe(true);
    await expect(module.readFile('/tmp/file', 'utf8')).resolves.toBe('content');
    await module.writeFile('/tmp/file', 'abc', 'utf8');
    await module.mkdir('/tmp/dir');
    await module.unlink('/tmp/file');
    await module.moveFile('/tmp/a', '/tmp/b');
    await module.copyFile('/tmp/c', '/tmp/d');
    await expect(module.sha256File('/tmp/file')).resolves.toBe('hash');
    await expect(module.fileSize('/tmp/file')).resolves.toBe(0);
    await module.applyXdelta('/tmp/base', '/tmp/patch', '/tmp/out');
    await expect(module.verifyBundleFiles('/tmp/bundle', '/tmp/bundle/bundle-manifest.json')).resolves.toEqual({ verified: true });
    await expect(module.supportsXdelta()).resolves.toBe(true);

    expect(reactNative.NativeModules.BundleDrop.fsWriteFile).toHaveBeenCalledWith(
      '/tmp/file',
      'abc',
      'utf8'
    );
    expect(reactNative.NativeModules.BundleDrop.fsMkdir).toHaveBeenCalledWith('/tmp/dir');
    expect(reactNative.NativeModules.BundleDrop.fsUnlink).toHaveBeenCalledWith('/tmp/file');
    expect(reactNative.NativeModules.BundleDrop.fsMoveFile).toHaveBeenCalledWith('/tmp/a', '/tmp/b');
    expect(reactNative.NativeModules.BundleDrop.fsCopyFile).toHaveBeenCalledWith('/tmp/c', '/tmp/d');
    expect(reactNative.NativeModules.BundleDrop.fsSha256File).toHaveBeenCalledWith('/tmp/file');
    expect(reactNative.NativeModules.BundleDrop.fsFileSize).toHaveBeenCalledWith('/tmp/file');
    expect(reactNative.NativeModules.BundleDrop.fsApplyXdelta).toHaveBeenCalledWith('/tmp/base', '/tmp/patch', '/tmp/out');
    expect(reactNative.NativeModules.BundleDrop.fsVerifyBundleFiles).toHaveBeenCalledWith(
      '/tmp/bundle',
      '/tmp/bundle/bundle-manifest.json',
    );

    reactNative.NativeModules.BundleDrop.fsUnzip.mockResolvedValue(['a.txt', 'b.txt']);
    await expect(module.unzip('/tmp/archive.zip', '/tmp/out')).resolves.toEqual(['a.txt', 'b.txt']);
    expect(reactNative.NativeModules.BundleDrop.fsUnzip).toHaveBeenCalledWith('/tmp/archive.zip', '/tmp/out');

    reactNative.NativeModules.BundleDrop.fsDownloadFile.mockResolvedValue(undefined);
    await expect(module.downloadFile('https://example.com/file.zip', '/tmp/file.zip')).resolves.toBeUndefined();
    expect(reactNative.NativeModules.BundleDrop.fsDownloadFile).toHaveBeenCalledWith(
      'https://example.com/file.zip',
      '/tmp/file.zip',
    );

    reactNative.NativeModules.BundleDrop.fsReadDir.mockResolvedValue(['a.txt', 'b']);
    await expect(module.readDir('/tmp/dir')).resolves.toEqual(['a.txt', 'b']);
    expect(reactNative.NativeModules.BundleDrop.fsReadDir).toHaveBeenCalledWith('/tmp/dir');
  });

  it('uses default encodings and falls back to empty directory constants when native values are missing', async () => {
    const { reactNative, module } = loadNativeFsModule(({ NativeModules }) => {
      NativeModules.BundleDrop.DocumentDirectoryPath = undefined as unknown as string;
      NativeModules.BundleDrop.LibraryDirectoryPath = undefined as unknown as string;
      NativeModules.BundleDrop.fsReadFile.mockResolvedValue('base64-content');
    });

    expect(module.DocumentDirectoryPath).toBe('');
    expect(module.LibraryDirectoryPath).toBe('');

    await expect(module.readFile('/tmp/file')).resolves.toBe('base64-content');
    await module.writeFile('/tmp/file', 'abc');

    expect(reactNative.NativeModules.BundleDrop.fsReadFile).toHaveBeenCalledWith('/tmp/file', 'utf8');
    expect(reactNative.NativeModules.BundleDrop.fsWriteFile).toHaveBeenCalledWith(
      '/tmp/file',
      'abc',
      'utf8',
    );
  });

  it('does not advertise xdelta when the bridge does not expose support probing', async () => {
    const { reactNative, module } = loadNativeFsModule(({ NativeModules }) => {
      delete (NativeModules.BundleDrop as any).fsSupportsXdelta;
    });

    await expect(module.supportsXdelta()).resolves.toBe(false);
    expect(reactNative.NativeModules.BundleDrop.fsSupportsXdelta).toBeUndefined();
  });

  it('throws a clear outdated-native error when batch verification is unavailable', async () => {
    const { reactNative, module } = loadNativeFsModule(({ NativeModules }) => {
      delete (NativeModules.BundleDrop as any).fsVerifyBundleFiles;
    });

    await expect(module.verifyBundleFiles('/tmp/bundle', '/tmp/bundle/bundle-manifest.json'))
      .rejects.toThrow('native module is outdated');
    expect(reactNative.NativeModules.BundleDrop.fsVerifyBundleFiles).toBeUndefined();
  });

  it('throws a clear error when the native module is not linked', async () => {
    const { module } = loadNativeFsModule(({ NativeModules }) => {
      NativeModules.BundleDrop = undefined as any;
    });

    await expect(module.exists('/tmp/file')).rejects.toThrow('native module is not linked');
    await expect(module.readFile('/tmp/f')).rejects.toThrow('native module is not linked');
    await expect(module.writeFile('/tmp/f', 'x')).rejects.toThrow('native module is not linked');
    await expect(module.mkdir('/tmp/d')).rejects.toThrow('native module is not linked');
    await expect(module.readDir('/tmp/d')).rejects.toThrow('native module is not linked');
    await expect(module.unlink('/tmp/f')).rejects.toThrow('native module is not linked');
    await expect(module.moveFile('/a', '/b')).rejects.toThrow('native module is not linked');
    await expect(module.copyFile('/a', '/b')).rejects.toThrow('native module is not linked');
    await expect(module.sha256File('/a')).rejects.toThrow('native module is not linked');
    await expect(module.fileSize('/a')).rejects.toThrow('native module is not linked');
    await expect(module.applyXdelta('/a', '/b', '/c')).rejects.toThrow('native module is not linked');
    await expect(module.verifyBundleFiles('/a', '/a/bundle-manifest.json')).rejects.toThrow('native module is not linked');
    await expect(module.supportsXdelta()).rejects.toThrow('native module is not linked');
    await expect(module.unzip('/a.zip', '/b')).rejects.toThrow('native module is not linked');
    await expect(module.downloadFile('https://x.com/f', '/b')).rejects.toThrow('native module is not linked');
  });
});
