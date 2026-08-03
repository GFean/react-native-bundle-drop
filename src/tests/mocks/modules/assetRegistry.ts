type PackagerAsset = {
  __packager_asset?: boolean;
  httpServerLocation?: string;
  name?: string;
  scales?: number[];
  type?: string;
};

const assets: PackagerAsset[] = [];

export const registerAsset = jest.fn((asset: PackagerAsset) => {
  assets.push(asset);
  return assets.length;
});

export const getAssetByID = jest.fn((assetId: number) => assets[assetId - 1]);

export const resetAssetRegistryMock = () => {
  assets.length = 0;
  registerAsset.mockClear();
  getAssetByID.mockClear();
};
