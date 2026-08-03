import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';

import { createTempProjectDir, removeTempDir } from './utils/tempDir';

const mockResolveExpoMetroRuntimeVersion = jest.fn();

jest.mock('../expo', () => ({
  resolveExpoMetroRuntimeVersion: (...args: unknown[]) => mockResolveExpoMetroRuntimeVersion(...args),
}));

import { withBundleDropExpo } from '../metro';
import type { ExpoBuildIdentity } from '../expo';

const identity = (platform: 'ios' | 'android'): ExpoBuildIdentity => {
  const withoutHash: Omit<ExpoBuildIdentity, 'identityHash'> = {
    platform,
    runtimeVersion: `${platform}-runtime`,
    runtimeVersionPolicy: 'literal',
    expoSdkVersion: '57.0.0',
    reactNativeVersion: '0.86.0',
    javaScriptEngine: 'hermes',
    appVersion: '2.0.0',
    nativeVersion: platform === 'ios' ? '2.0.0(12)' : '2.0.0(34)',
  };
  return {
    ...withoutHash,
    identityHash: crypto.createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex'),
  };
};

describe('withBundleDropExpo', () => {
  const roots: string[] = [];

  const fixture = () => {
    const root = createTempProjectDir();
    roots.push(root);
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://api.example.com' };\n",
    );
    return root;
  };

  beforeEach(() => {
    mockResolveExpoMetroRuntimeVersion.mockImplementation(
      async (_root: string, platform: 'ios' | 'android') => identity(platform).runtimeVersion,
    );
  });

  it('embeds a native runtime sentinel when EAS owns the remote build version', async () => {
    const root = fixture();
    mockResolveExpoMetroRuntimeVersion.mockImplementation(
      async (_root: string, platform: 'ios' | 'android') =>
        platform === 'ios' ? { source: 'nativeVersion' } : 'android-runtime',
    );
    await withBundleDropExpo({}, { projectRoot: root });
    const generated = fs.readFileSync(
      path.join(root, '.bundle-drop/generated/bundle.drop.config.js'),
      'utf8',
    );
    expect(generated).toContain(
      'runtimeVersion: {"ios":{"source":"nativeVersion"},"android":"android-runtime"}',
    );
  });

  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDir(root);
  });

  it('preserves Expo Metro config and writes only concrete runtime configuration', async () => {
    const root = fixture();
    const result = await withBundleDropExpo(
      Promise.resolve({
        transformer: { minifierPath: 'custom' },
        resolver: {
          sourceExts: ['js', 'tsx'],
          extraNodeModules: { existing: '/modules/existing' },
        },
      }),
      { projectRoot: root },
    );

    const generatedPath = path.join(root, '.bundle-drop/generated/bundle.drop.config.js');
    expect(result).toEqual({
      transformer: { minifierPath: 'custom' },
      resolver: {
        sourceExts: ['js', 'tsx'],
        extraNodeModules: {
          existing: '/modules/existing',
          'bundle-drop-config': generatedPath,
        },
      },
    });
    expect(fs.readFileSync(generatedPath, 'utf8')).toContain(
      'runtimeVersion: {"ios":"ios-runtime","android":"android-runtime"}',
    );
    expect(fs.existsSync(path.join(root, '.bundle-drop/build-identity.json'))).toBe(false);
  });

  it('never writes a build receipt for native-looking or EAS environments', async () => {
    const root = fixture();
    const previous = { ...process.env };
    Object.assign(process.env, {
      CONFIGURATION_BUILD_DIR: '/tmp/ios-build',
      BUILT_PRODUCTS_DIR: '/tmp/products',
      BUNDLE_BUILD_VARIANT: 'release',
      GRADLE_BUILD_ACTION: 'bundleRelease',
      EAS_BUILD_ID: 'eas-id',
    });
    try {
      await withBundleDropExpo({}, { projectRoot: root });
      expect(fs.existsSync(path.join(root, '.bundle-drop/build-identity.json'))).toBe(false);
    } finally {
      process.env = previous;
    }
  });

  it('fails before returning when Bundle Drop config is absent', async () => {
    const root = fixture();
    fs.removeSync(path.join(root, 'bundle.drop.config.js'));
    await expect(withBundleDropExpo({}, { projectRoot: root })).rejects.toThrow(
      'requires bundle.drop.config.js',
    );
  });

  it('uses the current project as the default root', async () => {
    const root = fixture();
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const result = await withBundleDropExpo<{
        resolver?: { extraNodeModules?: Record<string, string> };
      }>({});
      expect(result.resolver?.extraNodeModules?.['bundle-drop-config']).toBe(
        path.join(root, '.bundle-drop/generated/bundle.drop.config.js'),
      );
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
