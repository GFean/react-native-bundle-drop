import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';

import { createTempProjectDir, removeTempDir } from './utils/tempDir';

const mockResolveExpoMetroRuntimeVersion = jest.fn();

jest.mock('../expo', () => ({
  resolveExpoMetroRuntimeVersion: (...args: unknown[]) => mockResolveExpoMetroRuntimeVersion(...args),
}));

import { withBundleDrop, withBundleDropExpo } from '../metro';
import type { ExpoBuildIdentity } from '../expo';
import {
  LEGACY_RUNTIME_DELIVERY_BOOTSTRAP_PATH,
  RUNTIME_DELIVERY_BOOTSTRAP_PATH,
} from '../runtime-delivery/bootstrapConfig';

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

  const readGeneratedConfig = (root: string): Record<string, unknown> => {
    const generatedPath = path.join(root, '.bundle-drop/generated/bundle.drop.config.js');
    delete require.cache[require.resolve(generatedPath)];
    return require(generatedPath) as Record<string, unknown>;
  };

  const fixture = () => {
    const root = createTempProjectDir();
    roots.push(root);
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'org' }, project: { name: 'App', slug: 'app' } };\n",
    );
    fs.ensureDirSync(path.join(root, '.bundle-drop'));
    fs.writeJsonSync(path.join(root, RUNTIME_DELIVERY_BOOTSTRAP_PATH), {
      schemaVersion: 1,
      project: {
        serverUrl: 'https://api.example.com',
        orgSlug: 'org',
        projectSlug: 'app',
      },
      runtimeDelivery: {
        manifestBaseUrl: 'https://manifests.example.com',
        manifestAccessId: `mft_${'A'.repeat(43)}`,
        publicKeys: {
          key: {
            kty: 'EC',
            crv: 'P-256',
            x: 'd-g4y_28QdARnFF6HO0T00laLEfHhVFXTmuWHqBWmfM',
            y: '_Z_xWbhjDp3IVMtLA_rN3guVyprP34OvBikPWpVQfUI',
          },
        },
      },
    });
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
    expect(fs.readFileSync(generatedPath, 'utf8').split('\n')[0]).toBe('/* eslint-disable */');
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
    expect(fs.readFileSync(generatedPath, 'utf8')).toContain(
      'runtimeDelivery: {"manifestBaseUrl":"https://manifests.example.com"',
    );
    expect(readGeneratedConfig(root)).toEqual(expect.objectContaining({
      runtimeDelivery: expect.objectContaining({
        manifestBaseUrl: 'https://manifests.example.com',
      }),
    }));
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

  it('wraps bare Metro config with the same generated trust bootstrap', () => {
    const root = fixture();
    const result = withBundleDrop(
      { resolver: { sourceExts: ['js'], extraNodeModules: { existing: '/existing' } } },
      { projectRoot: root },
    );
    const generatedPath = path.join(root, '.bundle-drop/generated/bundle.drop.config.js');
    expect(result.resolver?.extraNodeModules).toEqual({
      existing: '/existing',
      'bundle-drop-config': generatedPath,
    });
    const generated = fs.readFileSync(generatedPath, 'utf8');
    expect(generated).toContain(
      'runtimeDelivery: {"manifestBaseUrl":"https://manifests.example.com"',
    );
    expect(readGeneratedConfig(root)).toEqual(expect.objectContaining({
      runtimeDelivery: expect.objectContaining({
        manifestBaseUrl: 'https://manifests.example.com',
      }),
    }));
    expect(generated).not.toContain('runtimeVersion:');
  });

  it('uses the current project as the default bare root', () => {
    const root = fixture();
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const result = withBundleDrop<{
        resolver?: { extraNodeModules?: Record<string, string> };
      }>({});
      expect(result.resolver?.extraNodeModules?.['bundle-drop-config']).toBe(
        path.join(root, '.bundle-drop/generated/bundle.drop.config.js'),
      );
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('fails closed when generated trust belongs to another project', () => {
    const root = fixture();
    const bootstrapPath = path.join(root, RUNTIME_DELIVERY_BOOTSTRAP_PATH);
    const bootstrap = fs.readJsonSync(bootstrapPath);
    bootstrap.project.projectSlug = 'other-app';
    fs.writeJsonSync(bootstrapPath, bootstrap);
    expect(() => withBundleDrop({}, { projectRoot: root })).toThrow('belongs to a different');
  });

  it('ignores retired inline delivery authority when no generated bootstrap exists', () => {
    const root = fixture();
    fs.removeSync(path.join(root, RUNTIME_DELIVERY_BOOTSTRAP_PATH));
    fs.writeFileSync(
      path.join(root, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'org' }, project: { name: 'App', slug: 'app' }, runtimeDelivery: { mode: 'v2', manifestBaseUrl: 'https://stale.example.com' } };\n",
    );
    withBundleDrop({}, { projectRoot: root });
    const resolvedConfig = readGeneratedConfig(root) as {
      runtimeDelivery?: { mode?: string };
      serverUrl?: string;
      org?: { slug?: string };
      project?: { slug?: string };
    };
    expect(resolvedConfig).toEqual(expect.objectContaining({
      serverUrl: 'https://api.example.com',
      org: { slug: 'org' },
      project: expect.objectContaining({ slug: 'app' }),
    }));
    expect(resolvedConfig).not.toHaveProperty('runtimeDelivery');
    expect(resolvedConfig.runtimeDelivery?.mode ?? 'v1').toBe('v1');
  });

  it('rejects an incomplete base config even without a generated bootstrap', () => {
    const invalidRoot = fixture();
    fs.removeSync(path.join(invalidRoot, RUNTIME_DELIVERY_BOOTSTRAP_PATH));
    fs.writeFileSync(
      path.join(invalidRoot, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://api.example.com' };\n",
    );
    expect(() => withBundleDrop({}, { projectRoot: invalidRoot })).toThrow(
      'must define serverUrl, org.slug, and project.slug',
    );
  });

  it('accepts a legacy bootstrap without rewriting project files', () => {
    const root = fixture();
    const lockPath = path.join(root, RUNTIME_DELIVERY_BOOTSTRAP_PATH);
    const legacyPath = path.join(root, LEGACY_RUNTIME_DELIVERY_BOOTSTRAP_PATH);
    fs.moveSync(lockPath, legacyPath);

    withBundleDrop({}, { projectRoot: root });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(readGeneratedConfig(root)).toEqual(expect.objectContaining({
      runtimeDelivery: expect.objectContaining({
        manifestBaseUrl: 'https://manifests.example.com',
      }),
    }));
  });
});
