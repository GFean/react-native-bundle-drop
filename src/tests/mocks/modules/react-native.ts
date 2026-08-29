type PlatformOs = 'ios' | 'android';

export const Platform = {
  OS: 'android' as PlatformOs,
};

export const Image = {
  resolveAssetSource: jest.fn((source: unknown) => source),
  render: jest.fn(function (props: unknown) {
    return { props };
  }),
};

export const NativeModules = {
  BundleDropExpoIdentity: {
    appVersion: '1.2.3',
    appBuildVersion: '45',
    otaStartupEnabled: true,
  },
  BundleDrop: {
    startupRecoveryProtocolVersion: 1,
    startupRecoveryAttemptHash: null,
    startupRecoveryAttemptId: null,
    DocumentDirectoryPath: '/mock/doc',
    LibraryDirectoryPath: '/mock/lib',
    fsExists: jest.fn(async (_path: string) => false),
    fsReadFile: jest.fn(async (_path: string, _encoding?: 'utf8' | 'base64') => {
      throw new Error('ENOENT');
    }),
    fsWriteFile: jest.fn(async (_path: string, _content: string, _encoding?: 'utf8' | 'base64') => {
      return undefined;
    }),
    fsMkdir: jest.fn(async (_path: string) => undefined),
    fsReadDir: jest.fn(async (_path: string) => [] as string[]),
    fsUnlink: jest.fn(async (_path: string) => undefined),
    fsMoveFile: jest.fn(async (_src: string, _dest: string) => undefined),
    fsCopyFile: jest.fn(async (_src: string, _dest: string) => undefined),
    fsSha256File: jest.fn(async (_path: string) => 'hash'),
    fsSha256String: jest.fn(async (_value: string) => '0'.repeat(64)),
    fsVerifyEs256Signature: jest.fn(async (
      _input: string,
      _signature: string,
      _x: string,
      _y: string,
    ) => true),
    fsFileSize: jest.fn(async (_path: string) => 0),
    fsApplyXdelta: jest.fn(async (_base: string, _patch: string, _output: string) => undefined),
    fsVerifyBundleFiles: jest.fn(async (_bundleDir: string, _manifestPath: string) => ({ verified: true })),
    fsSupportsXdelta: jest.fn(async () => true),
    fsUnzip: jest.fn(async (_zipPath: string, _destPath: string) => [] as string[]),
    fsDownloadFile: jest.fn(async (_url: string, _destPath: string) => undefined),
    fsDownloadFileBounded: jest.fn(async (
      _url: string,
      _destPath: string,
      _maxBytes: number,
      _timeoutMs: number,
    ) => undefined),
    getDownloadedBundlePath: jest.fn(async () => null),
    activateStartupCandidate: jest.fn(async (hash: string) => ({
      hash,
      bundlePath: `/mock/doc/bundle-drop/bundles/${hash}/main.jsbundle`,
    })),
    markStartupHealthy: jest.fn(async () => true),
    getStartupRecoveryState: jest.fn(async () => ({
      protocolVersion: 1,
      revision: 0,
      phase: 'idle',
      quarantinedHashes: [],
      pendingRecoveryEvents: [],
    })),
    setStartupRecoveryRevokedHashes: jest.fn(async () => true),
    acknowledgeStartupRecovery: jest.fn(async () => true),
    rollbackStartupBundle: jest.fn(async (forceEmbedded: boolean) => ({
      rolledBack: true,
      toEmbedded: forceEmbedded,
      ...(forceEmbedded ? {} : { hash: 'c'.repeat(64) }),
    })),
    getImageManifestSync: jest.fn(() => null),
    getImageManifest: jest.fn(async () => null),
    restartReactNative: jest.fn(),
  },
};
