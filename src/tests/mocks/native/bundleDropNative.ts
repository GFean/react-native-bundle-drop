export const mockGetDownloadedBundlePathNative = jest.fn<Promise<string | null>, []>();
export const mockRestartReactNativeNative = jest.fn<void, []>();

export const resetBundleDropNativeMocks = () => {
  mockGetDownloadedBundlePathNative.mockReset();
  mockGetDownloadedBundlePathNative.mockResolvedValue(null);
  mockRestartReactNativeNative.mockReset();
};

resetBundleDropNativeMocks();

export const getDownloadedBundlePathNative = () => mockGetDownloadedBundlePathNative();

export const restartReactNativeNative = () => mockRestartReactNativeNative();
