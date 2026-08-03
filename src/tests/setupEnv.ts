import { Image, NativeModules, Platform } from 'react-native';

import { resetClientApiMocks } from './mocks/api/clientApi';
import { resetContextMocks } from './mocks/context';
import { resetInstallFromZipMocks } from './mocks/install/installFromZip';
import { resetUpdateCheckMocks } from './mocks/manager/updateCheck';
import { resetImageManifestMock } from './mocks/image-manifest';
import { resetInjectImageResolverMocks } from './mocks/injectImageResolver';
import { resetNativeFsMocks } from './mocks/native/fs';
import { resetBundleDropNativeMocks } from './mocks/native/bundleDropNative';
import { resetAxiosNodeMocks } from './mocks/modules/axiosNode';
import { resetAssetRegistryMock } from './mocks/modules/assetRegistry';
import { resetPromptsMocks } from './mocks/modules/prompts';

type BundleDropConfigModule = {
  serverUrl: string;
  org: { slug: string };
  project: { name: string; slug: string; apiKey?: string };
  runtimeVersion?: { ios: string; android: string };
  defaultChannel?: string;
  rollback?: {
    maxCrashCount?: number;
    healthCheckMode?: 'auto' | 'manual';
    healthyAfterSec?: number;
  };
};

const bundleDropConfig = require('bundle-drop-config') as BundleDropConfigModule;

const resetBundleDropConfig = () => {
  Object.keys(bundleDropConfig).forEach(key => {
    delete (bundleDropConfig as Record<string, unknown>)[key];
  });

  Object.assign(bundleDropConfig, {
    serverUrl: 'https://api.example.com',
    org: { slug: 'alpha-org' },
    project: {
      name: 'Bundle Drop',
      slug: 'bundle-drop-app',
      apiKey: 'test-api-key',
    },
    runtimeVersion: {
      ios: '1.0.0',
      android: '1.0.0',
    },
    defaultChannel: 'General',
    rollback: {
      maxCrashCount: 2,
      healthCheckMode: 'auto',
      healthyAfterSec: 0,
    },
  });
};

const resetReactNativeModule = () => {
  const mockImage = Image as unknown as {
    resolveAssetSource: jest.Mock;
    render: jest.Mock;
  };

  Platform.OS = 'android';

  NativeModules.BundleDrop.DocumentDirectoryPath = '/mock/doc';
  NativeModules.BundleDrop.LibraryDirectoryPath = '/mock/lib';
  NativeModules.BundleDrop.fsExists.mockReset().mockResolvedValue(false);
  NativeModules.BundleDrop.fsReadFile.mockReset().mockRejectedValue(new Error('ENOENT'));
  NativeModules.BundleDrop.fsWriteFile.mockReset().mockResolvedValue(undefined);
  NativeModules.BundleDrop.fsMkdir.mockReset().mockResolvedValue(undefined);
  NativeModules.BundleDrop.fsReadDir.mockReset().mockResolvedValue([]);
  NativeModules.BundleDrop.fsUnlink.mockReset().mockResolvedValue(undefined);
  NativeModules.BundleDrop.fsMoveFile.mockReset().mockResolvedValue(undefined);
  NativeModules.BundleDrop.fsCopyFile.mockReset().mockResolvedValue(undefined);
  NativeModules.BundleDrop.fsSha256File.mockReset().mockResolvedValue('hash');
  NativeModules.BundleDrop.fsFileSize.mockReset().mockResolvedValue(0);
  NativeModules.BundleDrop.fsApplyXdelta.mockReset().mockResolvedValue(undefined);
  NativeModules.BundleDrop.fsVerifyBundleFiles.mockReset().mockResolvedValue({ verified: true });
  NativeModules.BundleDrop.fsSupportsXdelta.mockReset().mockResolvedValue(true);
  NativeModules.BundleDrop.fsUnzip.mockReset().mockResolvedValue([]);
  NativeModules.BundleDrop.fsDownloadFile.mockReset().mockResolvedValue(undefined);
  NativeModules.BundleDrop.getDownloadedBundlePath.mockReset().mockResolvedValue(null);
  NativeModules.BundleDrop.getImageManifestSync.mockReset().mockReturnValue(null);
  NativeModules.BundleDrop.getImageManifest.mockReset().mockResolvedValue(null);
  NativeModules.BundleDrop.restartReactNative.mockReset();
  mockImage.resolveAssetSource.mockReset().mockImplementation((source: unknown) => source);
  mockImage.render.mockReset().mockImplementation(function (props: unknown) {
    return { props };
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  resetBundleDropConfig();
  resetReactNativeModule();
  resetContextMocks();
  resetNativeFsMocks();
  resetClientApiMocks();
  resetInstallFromZipMocks();
  resetUpdateCheckMocks();
  resetAxiosNodeMocks();
  resetAssetRegistryMock();
  resetPromptsMocks();
  resetImageManifestMock();
  resetInjectImageResolverMocks();
  resetBundleDropNativeMocks();
});
