type InjectImageResolverModule = typeof import('../injectImageResolver');

const loadInjectImageResolverModule = (
  configure?: (deps: {
    Platform: { OS: 'ios' | 'android' };
    Image: any;
    NativeModules: any;
    AssetRegistry: {
      registerAsset: jest.Mock<number, [Record<string, unknown>]>;
      getAssetByID: jest.Mock;
    };
  }) => void
) => {
  jest.resetModules();
  const reactNative = require('react-native') as typeof import('react-native');
  const assetRegistry = require('react-native/Libraries/Image/AssetRegistry') as {
    registerAsset: jest.Mock<number, [Record<string, unknown>]>;
    getAssetByID: jest.Mock;
  };
  configure?.({
    Platform: reactNative.Platform as { OS: 'ios' | 'android' },
    Image: reactNative.Image,
    NativeModules: reactNative.NativeModules,
    AssetRegistry: assetRegistry,
  });
  return {
    reactNative,
    module: require('../injectImageResolver') as InjectImageResolverModule,
  };
};

describe('injectImageResolver', () => {
  it('warns when attempting to patch with an empty manifest', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { module } = loadInjectImageResolverModule();

    module.patchImageResolverWithManifest({});

    expect(consoleSpy).toHaveBeenCalledWith('🧩 Cannot patch image resolver — empty manifest');
  });

  it('preserves resolver output when no uri is returned and tolerates blank manifest entries', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        width: 24,
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      '': '',
      logo: 'bundle-drop/bundles/hash-1/assets/logo.png',
    });

    expect(mockImage.resolveAssetSource(42)).toEqual({
      width: 24,
    });
  });

  it('rewrites resolved asset URIs using exact extension-bearing keys', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/logo.png',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'logo.png': 'bundle-drop/bundles/hash-1/assets/logo.png',
    });

    const resolved = mockImage.resolveAssetSource(42);

    expect(resolved).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/assets/logo.png',
    });
  });

  it('prefers extension-specific matches so local PDFs are not resolved to same-name images', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/docs/terms.pdf',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      terms: 'bundle-drop/bundles/hash-1/assets/docs/terms.png',
      'docs/terms.pdf': 'bundle-drop/bundles/hash-1/assets/docs/terms.pdf',
    });

    expect(mockImage.resolveAssetSource(42)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/assets/docs/terms.pdf',
    });

    const pdfOnlyResolved = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/docs/terms.pdf',
      });
    });
    const pdfOnlyImage = pdfOnlyResolved.reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    pdfOnlyResolved.module.patchImageResolverWithManifest({
      terms: 'bundle-drop/bundles/hash-1/assets/docs/terms.png',
    });

    expect(pdfOnlyImage.resolveAssetSource(42)).toEqual({
      uri: 'asset:/docs/terms.pdf',
    });
  });

  it('does not use basename fallback for local PDFs in different directories', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource
        .mockReturnValueOnce({
          uri: 'asset:/legal/terms.pdf',
        })
        .mockReturnValueOnce({
          uri: 'asset:/legal/terms.pdf',
        })
        .mockReturnValueOnce({
          uri: 'asset:/legal/terms.pdf',
        });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'docs/terms.pdf': 'bundle-drop/bundles/hash-1/assets/docs/terms.pdf',
      terms: 'bundle-drop/bundles/hash-1/assets/legal/terms',
      'legal/terms.pdf': 'bundle-drop/bundles/hash-1/assets/legal/terms.pdf',
    });

    expect(mockImage.resolveAssetSource(42)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/assets/legal/terms.pdf',
    });

    const differentDirectory = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/legal/terms.pdf',
      });
    });
    const differentDirectoryImage = differentDirectory.reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    differentDirectory.module.patchImageResolverWithManifest({
      'docs/terms.pdf': 'bundle-drop/bundles/hash-1/assets/docs/terms.pdf',
    });

    expect(differentDirectoryImage.resolveAssetSource(42)).toEqual({
      uri: 'asset:/legal/terms.pdf',
    });

    const extensionless = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/legal/terms.pdf',
      });
    });
    const extensionlessImage = extensionless.reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    extensionless.module.patchImageResolverWithManifest({
      terms: 'bundle-drop/bundles/hash-1/assets/legal/terms',
    });

    expect(extensionlessImage.resolveAssetSource(42)).toEqual({
      uri: 'asset:/legal/terms.pdf',
    });

    const extensionlessPathKey = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/legal/terms.pdf',
      });
    });
    const extensionlessPathKeyImage = extensionlessPathKey.reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    extensionlessPathKey.module.patchImageResolverWithManifest({
      'legal/terms': 'bundle-drop/bundles/hash-1/assets/legal/terms.pdf',
    });

    expect(extensionlessPathKeyImage.resolveAssetSource(42)).toEqual({
      uri: 'asset:/legal/terms.pdf',
    });
  });

  it('requires extension-specific path matches for local audio and video assets', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource
        .mockReturnValueOnce({
          uri: 'asset:/media/intro.mp4',
        })
        .mockReturnValueOnce({
          uri: 'asset:/sounds/chime.mp3',
        })
        .mockReturnValueOnce({
          uri: 'asset:/media/intro.mp4',
        });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'media/intro.mp4': 'bundle-drop/bundles/hash-1/assets/media/intro.mp4',
      'sounds/chime': 'bundle-drop/bundles/hash-1/assets/sounds/chime.mp3',
      intro: 'bundle-drop/bundles/hash-1/assets/other/intro.mp4',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/assets/media/intro.mp4',
    });
    expect(mockImage.resolveAssetSource(2)).toEqual({
      uri: 'asset:/sounds/chime.mp3',
    });
    expect(mockImage.resolveAssetSource(3)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/assets/media/intro.mp4',
    });
  });

  it('resolves OTA-added audio assets from exact AssetRegistry metadata without basename fallback', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image, AssetRegistry }) => {
      AssetRegistry.registerAsset({
        __packager_asset: true,
        httpServerLocation: '/assets/sounds',
        name: 'chime',
        type: 'mp3',
      });
      Image.resolveAssetSource
        .mockReturnValueOnce({
          uri: 'asset:/sounds_chime',
        })
        .mockReturnValueOnce({
          uri: 'asset:/sounds_chime',
        });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'raw/sounds_chime.mp3': 'bundle-drop/bundles/hash-1/raw/sounds_chime.mp3',
      'chime.mp3': 'bundle-drop/bundles/hash-1/other/chime.mp3',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/raw/sounds_chime.mp3',
    });

    const noMetadataMatch = loadInjectImageResolverModule(({ Image, AssetRegistry }) => {
      AssetRegistry.registerAsset({
        __packager_asset: true,
        httpServerLocation: '/assets/sounds',
        name: 'chime',
        type: 'mp3',
      });
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/sounds_chime',
      });
    });
    const noMetadataMatchImage = noMetadataMatch.reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    noMetadataMatch.module.patchImageResolverWithManifest({
      'chime.mp3': 'bundle-drop/bundles/hash-1/other/chime.mp3',
    });

    expect(noMetadataMatchImage.resolveAssetSource(1)).toEqual({
      uri: 'asset:/sounds_chime',
    });
  });

  it('resolves Android drawable image assets from exact AssetRegistry metadata paths', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image, AssetRegistry }) => {
      AssetRegistry.registerAsset({
        __packager_asset: true,
        httpServerLocation: '/assets/images',
        name: 'login-background',
        scales: [1, 2, 3],
        type: 'png',
      });
      Image.resolveAssetSource.mockReturnValue({
        scale: 2,
        uri: 'asset:/images_loginbackground',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'drawable-mdpi/images_loginbackground.png': 'bundle-drop/bundles/hash-1/drawable-mdpi/images_loginbackground.png',
      'drawable-xhdpi/images_loginbackground.png': 'bundle-drop/bundles/hash-1/drawable-xhdpi/images_loginbackground.png',
      images_loginbackground: 'bundle-drop/bundles/hash-1/extensionless/images_loginbackground',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      scale: 2,
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/drawable-xhdpi/images_loginbackground.png',
    });
  });

  it('resolves Android drawable assets with custom density folders from AssetRegistry metadata', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image, AssetRegistry }) => {
      AssetRegistry.registerAsset({
        __packager_asset: true,
        httpServerLocation: '/assets/charts',
        name: 'trend',
        scales: [2.625],
        type: 'webp',
      });
      Image.resolveAssetSource.mockReturnValue({
        scale: 2.625,
        uri: 'asset:/charts_trend',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'drawable-420dpi/charts_trend.webp': 'bundle-drop/bundles/hash-1/drawable-420dpi/charts_trend.webp',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      scale: 2.625,
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/drawable-420dpi/charts_trend.webp',
    });
  });

  it('tries exact drawable and raw Android candidates for image types that moved across RN versions', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image, AssetRegistry }) => {
      AssetRegistry.registerAsset({
        __packager_asset: true,
        httpServerLocation: '/assets/icons',
        name: 'vector-logo',
        scales: [1],
        type: 'svg',
      });
      AssetRegistry.registerAsset({
        __packager_asset: true,
        httpServerLocation: '/assets/icons',
        name: 'vector-badge',
        scales: [1],
        type: 'svg',
      });
      AssetRegistry.registerAsset({
        __packager_asset: true,
        httpServerLocation: '/assets/photos',
        name: 'hero',
        scales: [2],
        type: 'heic',
      });
      AssetRegistry.registerAsset({
        __packager_asset: true,
        httpServerLocation: '/assets/photos',
        name: 'avatar',
        scales: [3],
        type: 'heif',
      });
      Image.resolveAssetSource
        .mockReturnValueOnce({
          scale: 1,
          uri: 'asset:/icons_vectorlogo',
        })
        .mockReturnValueOnce({
          scale: 1,
          uri: 'asset:/icons_vectorbadge',
        })
        .mockReturnValueOnce({
          scale: 2,
          uri: 'asset:/photos_hero',
        })
        .mockReturnValueOnce({
          scale: 3,
          uri: 'asset:/photos_avatar',
        });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'drawable-mdpi/icons_vectorlogo.svg': 'bundle-drop/bundles/hash-1/drawable-mdpi/icons_vectorlogo.svg',
      'raw/icons_vectorbadge.svg': 'bundle-drop/bundles/hash-1/raw/icons_vectorbadge.svg',
      'raw/photos_hero.heic': 'bundle-drop/bundles/hash-1/raw/photos_hero.heic',
      'drawable-xxhdpi/photos_avatar.heif': 'bundle-drop/bundles/hash-1/drawable-xxhdpi/photos_avatar.heif',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      scale: 1,
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/drawable-mdpi/icons_vectorlogo.svg',
    });
    expect(mockImage.resolveAssetSource(2)).toEqual({
      scale: 1,
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/raw/icons_vectorbadge.svg',
    });
    expect(mockImage.resolveAssetSource(3)).toEqual({
      scale: 2,
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/raw/photos_hero.heic',
    });
    expect(mockImage.resolveAssetSource(4)).toEqual({
      scale: 3,
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/drawable-xxhdpi/photos_avatar.heif',
    });
  });

  it('does not use extensionless Android resource identifiers from AssetRegistry metadata', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image, AssetRegistry }) => {
      AssetRegistry.registerAsset({
        __packager_asset: true,
        httpServerLocation: '/assets/images',
        name: 'logo',
        scales: [1],
        type: 'png',
      });
      Image.resolveAssetSource.mockReturnValue({
        scale: 1,
        uri: 'asset:/images_logo',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      images_logo: 'bundle-drop/bundles/hash-1/assets/images_logo.png',
      'logo.png': 'bundle-drop/bundles/hash-1/assets/logo.png',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      scale: 1,
      uri: 'asset:/images_logo',
    });
  });

  it('falls back to resolved URI matching when AssetRegistry metadata is unavailable', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image, AssetRegistry }) => {
      AssetRegistry.getAssetByID.mockImplementation(() => {
        throw new Error('AssetRegistry unavailable');
      });
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/sounds/chime.mp3',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'sounds/chime.mp3': 'bundle-drop/bundles/hash-1/assets/sounds/chime.mp3',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/assets/sounds/chime.mp3',
    });
  });

  it('requires complete extension-bearing paths instead of incomplete metadata fallbacks', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image, AssetRegistry }) => {
      AssetRegistry.registerAsset({
        __packager_asset: true,
        name: 'badge',
        type: 'png',
      });
      Image.resolveAssetSource
        .mockReturnValueOnce({
          uri: 'asset:/badge',
        })
        .mockReturnValueOnce({
          uri: 'asset:/legal/terms.pdf',
        })
        .mockReturnValueOnce({
          uri: 'asset:/legacy_logo',
        });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'badge.png': 'bundle-drop/bundles/hash-1/assets/badge.png',
      'legal/terms.pdf': 'bundle-drop/bundles/hash-1/assets/legal/terms.pdf',
      legacy_logo: 'bundle-drop/bundles/hash-1/assets/legacy_logo',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      uri: 'asset:/badge',
    });
    expect(mockImage.resolveAssetSource({ __packager_asset: true, uri: 'asset:/legal/terms.pdf' })).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/assets/legal/terms.pdf',
    });
    expect(mockImage.resolveAssetSource({ __packager_asset: true, uri: 'asset:/legacy_logo' })).toEqual({
      uri: 'asset:/legacy_logo',
    });
  });

  it('resolves Android-prefixed and non-image assets by exact extension-bearing path only', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource
        .mockReturnValueOnce({
          uri: 'asset:/android/drawable-hdpi/icon.png',
        })
        .mockReturnValueOnce({
          uri: 'asset:/artwork/splash.psd',
        });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'drawable-mdpi/icon.png': 'bundle-drop/bundles/hash-1/drawable-mdpi/icon.png',
      'drawable-hdpi/icon.png': 'bundle-drop/bundles/hash-1/drawable-hdpi/icon.png',
      'artwork/splash.psd': 'bundle-drop/bundles/hash-1/artwork/splash.psd',
    });

    expect(mockImage.resolveAssetSource(42)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/drawable-hdpi/icon.png',
    });
    expect(mockImage.resolveAssetSource(43)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-1/artwork/splash.psd',
    });
  });

  it('rewrites file and Android-prefixed URIs by normalized exact paths', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource
        .mockReturnValueOnce({
          uri: 'file:///data/user/0/com.demo/files/drawable-mdpi/splash.png',
        })
        .mockReturnValueOnce({
          uri: 'asset:/android/other/splash.png',
        })
        .mockReturnValueOnce({
          uri: 'asset:/android/other/different-name.png',
        });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'drawable-mdpi/splash.png': 'bundle-drop/bundles/hash-4/assets/drawable-mdpi/splash.png',
      'other/splash.png': 'bundle-drop/bundles/hash-4/assets/other/splash.png',
      'other/different-name.png': 'bundle-drop/bundles/hash-4/assets/different-name.png',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-4/assets/drawable-mdpi/splash.png',
    });
    expect(mockImage.resolveAssetSource(2)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-4/assets/other/splash.png',
    });
    expect(mockImage.resolveAssetSource(3)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-4/assets/different-name.png',
    });
  });

  it('returns the original resolved value when no manifest match exists', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource
        .mockReturnValueOnce({
          uri: 'asset:/totally/unknown.png',
        })
        .mockReturnValueOnce({
          uri: 'asset:/',
        });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      known: 'bundle-drop/bundles/hash-5/assets/known.png',
    });

    expect(mockImage.resolveAssetSource(42)).toEqual({
      uri: 'asset:/totally/unknown.png',
    });
    expect(mockImage.resolveAssetSource(99)).toEqual({
      uri: 'asset:/',
    });
  });

  it('passes through remote, data, and content URIs without rewriting', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource
        .mockReturnValueOnce({ uri: 'https://example.com/banking_conditions.pdf' })
        .mockReturnValueOnce({ uri: 'http://cdn.example.com/image.png' })
        .mockReturnValueOnce({ uri: 'data:image/png;base64,abc123' })
        .mockReturnValueOnce({ uri: 'content://com.provider/doc/123' });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'logo.png': 'bundle-drop/bundles/hash-5/assets/logo.png',
    });

    expect(mockImage.resolveAssetSource(1)).toEqual({
      uri: 'https://example.com/banking_conditions.pdf',
    });
    expect(mockImage.resolveAssetSource(2)).toEqual({
      uri: 'http://cdn.example.com/image.png',
    });
    expect(mockImage.resolveAssetSource(3)).toEqual({
      uri: 'data:image/png;base64,abc123',
    });
    expect(mockImage.resolveAssetSource(4)).toEqual({
      uri: 'content://com.provider/doc/123',
    });
  });

  it('skips resolution for non-packager-asset object sources', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'https://example.com/terms.pdf',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      terms: 'bundle-drop/bundles/hash-5/assets/terms.pdf',
    });

    const result = mockImage.resolveAssetSource({ uri: 'https://example.com/terms.pdf' });
    expect(result).toEqual({
      uri: 'https://example.com/terms.pdf',
    });
  });

  it('still rewrites packager assets passed as objects with __packager_asset flag', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/logo.png',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'logo.png': 'bundle-drop/bundles/hash-5/assets/logo.png',
    });

    const result = mockImage.resolveAssetSource({ __packager_asset: true, uri: 'asset:/logo.png' });
    expect(result).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-5/assets/logo.png',
    });
  });

  it('handles file:// URIs without a /files/ segment by falling back to the full URI as key', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'file:///var/containers/bundle-drop/logo.png',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      known: 'bundle-drop/bundles/hash-7/assets/known.png',
    });

    expect(mockImage.resolveAssetSource(42)).toEqual({
      uri: 'file:///var/containers/bundle-drop/logo.png',
    });
  });

  it('does not append extensions to manifest values', () => {
    const { reactNative, module } = loadInjectImageResolverModule(({ Image }) => {
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/icon.png',
      });
    });
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.patchImageResolverWithManifest({
      'icon.png': 'bundle-drop/bundles/hash-7/assets/icon',
    });

    expect(mockImage.resolveAssetSource(42)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-7/assets/icon',
    });
  });

  it('injects the Android manifest synchronously from the native bridge', () => {
    const { reactNative, module } = loadInjectImageResolverModule(
      ({ Platform, Image, NativeModules }) => {
        Platform.OS = 'android';
        Image.resolveAssetSource.mockReturnValue({
          uri: 'asset:/icons/logo.png',
        });
        NativeModules.BundleDrop.getImageManifestSync.mockReturnValue(
          JSON.stringify({
            'icons/logo.png': 'bundle-drop/bundles/hash-2/assets/icons/logo.png',
          })
        );
      }
    );
    const mockImage = reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    module.injectBundleDropImageResolver();
    const resolved = mockImage.resolveAssetSource(42);

    expect(resolved).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-2/assets/icons/logo.png',
    });

    const override = loadInjectImageResolverModule(({ Platform, Image, NativeModules }) => {
      Platform.OS = 'android';
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/icons/logo.png',
      });
      NativeModules.BundleDrop.getImageManifestSync.mockReturnValue(null);
    });
    const overrideImage = override.reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    override.module.injectBundleDropImageResolver({
      'icons/logo.png': 'bundle-drop/bundles/hash-override/assets/icons/logo.png',
    });

    expect(override.reactNative.NativeModules.BundleDrop.getImageManifestSync).not.toHaveBeenCalled();
    expect(overrideImage.resolveAssetSource(42)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-override/assets/icons/logo.png',
    });
  });

  it('skips synchronous injection on iOS, ignores missing manifests, and does not repatch twice', () => {
    const ios = loadInjectImageResolverModule(({ Platform, NativeModules }) => {
      Platform.OS = 'ios';
      NativeModules.BundleDrop.getImageManifestSync.mockReturnValue(
        JSON.stringify({
          'logo.png': 'bundle-drop/bundles/hash-ios/assets/logo.png',
        })
      );
    });
    ios.module.injectBundleDropImageResolver();
    expect(ios.reactNative.NativeModules.BundleDrop.getImageManifestSync).not.toHaveBeenCalled();

    const android = loadInjectImageResolverModule(({ Platform, Image, NativeModules }) => {
      Platform.OS = 'android';
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/logo.png',
      });
      NativeModules.BundleDrop.getImageManifestSync
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(
          JSON.stringify({
            'logo.png': 'bundle-drop/bundles/hash-6/assets/logo.png',
          })
        );
    });
    const mockImage = android.reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    android.module.injectBundleDropImageResolver();
    android.module.injectBundleDropImageResolver();
    android.module.injectBundleDropImageResolver();

    expect(android.reactNative.NativeModules.BundleDrop.getImageManifestSync).toHaveBeenCalledTimes(2);
    expect(mockImage.resolveAssetSource(42)).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-6/assets/logo.png',
    });
  });

  it('injects the Android manifest asynchronously and ignores iOS', async () => {
    const ios = loadInjectImageResolverModule(({ Platform, NativeModules }) => {
      Platform.OS = 'ios';
      NativeModules.BundleDrop.getImageManifest.mockResolvedValue(
        JSON.stringify({
          'logo.png': 'bundle-drop/bundles/hash-ios/assets/logo.png',
        })
      );
    });

    await ios.module.injectBundleDropImageResolverAsync();
    expect(ios.reactNative.NativeModules.BundleDrop.getImageManifest).not.toHaveBeenCalled();

    const android = loadInjectImageResolverModule(({ Platform, Image, NativeModules }) => {
      Platform.OS = 'android';
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/logo.png',
      });
      NativeModules.BundleDrop.getImageManifest.mockResolvedValue(
        JSON.stringify({
          'logo.png': 'bundle-drop/bundles/hash-3/assets/logo.png',
        })
      );
    });
    const mockImage = android.reactNative.Image as unknown as {
      resolveAssetSource: (source: unknown) => unknown;
    };

    await android.module.injectBundleDropImageResolverAsync();
    const resolved = mockImage.resolveAssetSource(42);

    expect(resolved).toEqual({
      uri: 'file:///mock/doc/bundle-drop/bundles/hash-3/assets/logo.png',
    });
  });

  it('returns early in the async injector when the manifest is missing or already patched', async () => {
    const missing = loadInjectImageResolverModule(({ Platform, NativeModules }) => {
      Platform.OS = 'android';
      NativeModules.BundleDrop.getImageManifest.mockResolvedValue(null);
    });

    await missing.module.injectBundleDropImageResolverAsync();
    expect(missing.reactNative.NativeModules.BundleDrop.getImageManifest).toHaveBeenCalledTimes(1);

    const patched = loadInjectImageResolverModule(({ Platform, Image, NativeModules }) => {
      Platform.OS = 'android';
      Image.resolveAssetSource.mockReturnValue({
        uri: 'asset:/logo.png',
      });
      NativeModules.BundleDrop.getImageManifest
        .mockResolvedValueOnce(
          JSON.stringify({
            'logo.png': 'bundle-drop/bundles/hash-8/assets/logo.png',
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            'logo.png': 'bundle-drop/bundles/hash-9/assets/logo.png',
          }),
        );
    });

    await patched.module.injectBundleDropImageResolverAsync();
    await patched.module.injectBundleDropImageResolverAsync();
    expect(patched.reactNative.NativeModules.BundleDrop.getImageManifest).toHaveBeenCalledTimes(1);
  });

  it('ignores invalid native manifest payloads in sync and async paths', async () => {
    const sync = loadInjectImageResolverModule(({ Platform, NativeModules }) => {
      Platform.OS = 'android';
      NativeModules.BundleDrop.getImageManifestSync.mockReturnValue('{invalid json');
    });

    expect(() => sync.module.injectBundleDropImageResolver()).not.toThrow();

    const async = loadInjectImageResolverModule(({ Platform, NativeModules }) => {
      Platform.OS = 'android';
      NativeModules.BundleDrop.getImageManifest.mockResolvedValue('{invalid json');
    });

    await expect(async.module.injectBundleDropImageResolverAsync()).resolves.toBeUndefined();
  });
});
