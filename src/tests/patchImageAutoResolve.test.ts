type PatchImageModule = typeof import('../patchImageAutoResolve');

const loadPatchImageModule = (
  configure?: (deps: { Image: any }) => void
) => {
  jest.resetModules();
  const reactNative = require('react-native') as typeof import('react-native');
  configure?.({ Image: reactNative.Image });
  return {
    reactNative,
    module: require('../patchImageAutoResolve') as PatchImageModule,
  };
};

describe('patchImageAutoResolve', () => {
  it('patches Image.render to resolve packager assets before rendering', () => {
    const { reactNative, module } = loadPatchImageModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'file:///resolved/logo.png',
      });
      Image.render.mockImplementation(function (props: any) {
        return { props };
      });
    });
    const mockImage = reactNative.Image as unknown as {
      render: jest.Mock;
      resolveAssetSource: jest.Mock;
    };

    module.patchImageRenderToForceResolve();

    const props = {
      source: {
        __packager_asset: true,
        uri: 'asset:/logo.png',
      },
    };
    const result = mockImage.render(props);

    expect(mockImage.resolveAssetSource).toHaveBeenCalledWith({
      __packager_asset: true,
      uri: 'asset:/logo.png',
    });
    expect(result.props.source).toEqual({
      uri: 'file:///resolved/logo.png',
    });
  });

  it('does not repatch the render function or touch non-packager assets', () => {
    const { reactNative, module } = loadPatchImageModule();
    const mockImage = reactNative.Image as unknown as {
      render: jest.Mock;
      resolveAssetSource: jest.Mock;
    };

    module.patchImageRenderToForceResolve();
    const once = mockImage.render;
    module.patchImageRenderToForceResolve();

    expect(mockImage.render).toBe(once);

    const props = {
      source: {
        uri: 'https://example.com/logo.png',
      },
    };
    const result = mockImage.render(props);

    expect(mockImage.resolveAssetSource).not.toHaveBeenCalled();
    expect(result.props.source).toEqual({
      uri: 'https://example.com/logo.png',
    });
  });
});
