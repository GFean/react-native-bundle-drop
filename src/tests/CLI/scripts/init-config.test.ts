import fs from 'fs';
import path from 'path';

import { mockAxiosNodeGet } from '../../mocks/modules/axiosNode';
import { queuePromptResponse } from '../../mocks/modules/prompts';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';
import * as runtimeDeliveryBootstrapConfig from '../../../runtime-delivery/bootstrapConfig';

jest.mock('axios', () => require('../../mocks/modules/axiosNode'));
jest.mock('prompts', () => require('../../mocks/modules/prompts'));

import {
  getBundleDropConfigPath,
  hasExistingBundleDropConfig,
  initConfig,
  normalizeRuntimeDeliveryBootstrap,
} from '../../../CLI/scripts/init-config';

const runtimeDeliveryBootstrap = (mode: 'v1' | 'shadow' | 'v2' = 'v2') => ({
  mode,
  manifestBaseUrl: 'https://manifests.example.com/root/',
  manifestAccessId: `mft_${'A'.repeat(43)}`,
  publicKeys: {
    'test-key': {
      kty: 'EC',
      crv: 'P-256',
      x: 'd-g4y_28QdARnFF6HO0T00laLEfHhVFXTmuWHqBWmfM',
      y: '_Z_xWbhjDp3IVMtLA_rN3guVyprP34OvBikPWpVQfUI',
    },
  },
});

const projectCredentials = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'project-1',
  projectSlug: 'demo-app',
  orgId: 'org-1',
  orgSlug: 'alpha-org',
  runtimeDeliveryMode: 'v1',
  ...overrides,
});

describe('CLI/scripts/init-config', () => {
  const originalCwd = process.cwd();
  let consoleSpy: jest.SpyInstance;
  let tempDir = '';

  beforeEach(() => {
    tempDir = createTempProjectDir();
    process.chdir(tempDir);
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    removeTempDir(tempDir);
    consoleSpy.mockRestore();
  });

  it('finds the bundle config path from nested directories and detects existing config', () => {
    const nested = path.join(tempDir, 'android', 'app');
    fs.mkdirSync(nested, { recursive: true });

    expect(getBundleDropConfigPath(nested)).toBe(path.join(tempDir, 'bundle.drop.config.js'));
    expect(hasExistingBundleDropConfig(nested)).toBe(false);
    expect(hasExistingBundleDropConfig()).toBe(false);

    fs.writeFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'module.exports = {};', 'utf8');
    expect(hasExistingBundleDropConfig(nested)).toBe(true);
  });

  it('falls back to the provided start directory when no package.json ancestor exists', () => {
    const nested = path.join(tempDir, 'android', 'app');
    fs.mkdirSync(nested, { recursive: true });
    fs.unlinkSync(path.join(tempDir, 'package.json'));

    expect(getBundleDropConfigPath(nested)).toBe(path.join(nested, 'bundle.drop.config.js'));
  });

  it('does not overwrite an existing config file', async () => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(configPath, 'module.exports = { existing: true };', 'utf8');

    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha', name: 'Alpha' }],
      projects: [{ orgId: 'org-1', slug: 'demo', name: 'Demo App' }],
      authToken: 'jwt-token',
    });

    expect(fs.readFileSync(configPath, 'utf8')).toBe('module.exports = { existing: true };');
    expect(mockAxiosNodeGet).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('preserves an existing config that cannot be evaluated', async () => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(configPath, 'module.exports = { broken:', 'utf8');

    const result = await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    });

    expect(result?.content).toBe('module.exports = { broken:');
    expect(mockAxiosNodeGet).not.toHaveBeenCalled();
  });

  it('rejects an existing or dangling config symlink without touching its external target', async () => {
    const outsideRoot = createTempProjectDir();
    const outsideConfig = path.join(outsideRoot, 'outside-config.js');
    fs.writeFileSync(outsideConfig, 'outside-safe');
    fs.symlinkSync(outsideConfig, path.join(tempDir, 'bundle.drop.config.js'));
    try {
      await expect(initConfig({
        serverUrl: 'https://api.example.com',
        organizations: [],
        projects: [],
      })).rejects.toThrow('symlinked or non-regular');
      expect(fs.readFileSync(outsideConfig, 'utf8')).toBe('outside-safe');
      expect(mockAxiosNodeGet).not.toHaveBeenCalled();

      fs.unlinkSync(path.join(tempDir, 'bundle.drop.config.js'));
      fs.unlinkSync(outsideConfig);
      fs.symlinkSync(outsideConfig, path.join(tempDir, 'bundle.drop.config.js'));
      await expect(initConfig({
        serverUrl: 'https://api.example.com',
        organizations: [],
        projects: [],
      })).rejects.toThrow('symlinked or non-regular');
      expect(fs.existsSync(outsideConfig)).toBe(false);
    } finally {
      removeTempDir(outsideRoot);
    }
  });

  it('syncs a bootstrap for an existing config without rewriting it', async () => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    const original = `module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { name: 'Demo', slug: 'demo-app', apiKey: 'existing-key' },
};\n`;
    fs.writeFileSync(configPath, original, 'utf8');
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: runtimeDeliveryBootstrap('v2'),
      }),
    });

    const result = await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    });

    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect(result?.bootstrapPath).toBe(
      path.join(fs.realpathSync(tempDir), '.bundle-drop/runtime-delivery.lock.json'),
    );
    expect(fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf8')).toContain(
      '!.bundle-drop/runtime-delivery.lock.json',
    );
    expect(mockAxiosNodeGet).toHaveBeenCalledWith(
      'https://api.example.com/projects/demo-app/credentials?orgSlug=alpha-org',
      expect.any(Object),
    );

    const lockPath = path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json');
    const firstLockfile = fs.readFileSync(lockPath, 'utf8');
    const firstGitignore = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf8');
    await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(firstLockfile);
    expect(fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf8')).toBe(firstGitignore);
  });

  it('repairs shadowed bootstrap ignore rules during sync', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'bundle.drop.config.js'),
      `module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { name: 'Demo', slug: 'demo-app', apiKey: 'existing-key' },
};\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, '.gitignore'),
      '# !.bundle-drop/runtime-delivery.lock.json\n' +
        '!.bundle-drop/runtime-delivery.lock.json\n' +
        '.bundle-drop/\n',
      'utf8',
    );
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: runtimeDeliveryBootstrap('v2'),
      }),
    });

    await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    });

    const gitignore = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('# !.bundle-drop/runtime-delivery.lock.json');
    expect(gitignore.match(/^!\.bundle-drop\/runtime-delivery\.lock\.json$/gm)).toHaveLength(1);
    expect(gitignore).toMatch(
      /# Bundle Drop: commit the public trust bootstrap; ignore generated runtime artifacts\.\n!\.bundle-drop\/\n\.bundle-drop\/\*\n!\.bundle-drop\/runtime-delivery\.lock\.json\n$/,
    );
  });

  it('rejects an auth-token origin mismatch before fetching project credentials', async () => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(
      configPath,
      `module.exports = {
  serverUrl: 'https://api.example.com',
  org: { slug: 'alpha-org' },
  project: { slug: 'demo-app' },
};\n`,
      'utf8',
    );

    await expect(
      initConfig({
        serverUrl: 'https://api-staging.example.com',
        organizations: [],
        projects: [],
        authToken: 'staging-token',
      }),
    ).rejects.toThrow(/stored CLI login belongs to/);

    expect(mockAxiosNodeGet).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, 'utf8')).toContain(
      "serverUrl: 'https://api.example.com'",
    );
  });

  it('migrates a valid legacy bootstrap only after validating the new lockfile', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { slug: 'demo-app' } };\n",
    );
    const legacyPath = path.join(tempDir, '.bundle-drop/runtime-delivery.generated.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({
      schemaVersion: 1,
      project: {
        serverUrl: 'https://api.example.com',
        orgSlug: 'alpha-org',
        projectSlug: 'demo-app',
        projectId: 'project-1',
        orgId: 'org-1',
      },
      runtimeDelivery: normalizeRuntimeDeliveryBootstrap(runtimeDeliveryBootstrap('v2')),
    }));
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: runtimeDeliveryBootstrap('v2'),
      }),
    });

    await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    });

    expect(fs.existsSync(path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json'))).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('preserves a valid legacy bootstrap when the lockfile write is rejected', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { slug: 'demo-app' } };\n",
    );
    const bootstrapDirectory = path.join(tempDir, '.bundle-drop');
    const legacyPath = path.join(bootstrapDirectory, 'runtime-delivery.generated.json');
    const outsideRoot = createTempProjectDir();
    fs.mkdirSync(bootstrapDirectory, { recursive: true });
    fs.writeFileSync(legacyPath, '{"legacy":"preserved"}\n');
    const outsideSentinel = path.join(outsideRoot, 'sentinel.json');
    fs.writeFileSync(outsideSentinel, '{"outside":"safe"}\n');
    fs.symlinkSync(outsideSentinel, path.join(bootstrapDirectory, 'runtime-delivery.lock.json'));
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: runtimeDeliveryBootstrap('v2'),
      }),
    });

    try {
      await expect(initConfig({
        serverUrl: 'https://api.example.com',
        organizations: [],
        projects: [],
        authToken: 'jwt-token',
      })).rejects.toThrow('symlinked or non-regular');
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe('{"legacy":"preserved"}\n');
      expect(fs.readFileSync(outsideSentinel, 'utf8')).toBe('{"outside":"safe"}\n');
    } finally {
      removeTempDir(outsideRoot);
    }
  });

  it('preserves the legacy bootstrap when lockfile read-back validation fails', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'bundle.drop.config.js'),
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { slug: 'demo-app' } };\n",
    );
    const legacyPath = path.join(tempDir, '.bundle-drop/runtime-delivery.generated.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '{"legacy":"preserved"}\n');
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: runtimeDeliveryBootstrap('v2'),
      }),
    });
    const readBack = jest
      .spyOn(runtimeDeliveryBootstrapConfig, 'readRuntimeDeliveryLockfile')
      .mockReturnValue(null);

    try {
      await expect(initConfig({
        serverUrl: 'https://api.example.com',
        organizations: [],
        projects: [],
        authToken: 'jwt-token',
      })).rejects.toThrow('lockfile validation failed after writing');
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe('{"legacy":"preserved"}\n');
    } finally {
      readBack.mockRestore();
    }
  });

  it('accepts the neutral credentials response and recreates deleted generated state', async () => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(
      configPath,
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { slug: 'demo-app' } };\n",
      'utf8',
    );
    fs.rmSync(path.join(tempDir, '.bundle-drop'), { recursive: true, force: true });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.bundle-drop/\n', 'utf8');
    const neutralRuntimeDelivery = runtimeDeliveryBootstrap('v2');
    delete (neutralRuntimeDelivery as { mode?: string }).mode;
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        runtimeDeliveryMode: undefined,
        runtimeDelivery: neutralRuntimeDelivery,
      }),
    });

    const result = await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    });

    expect(result).toEqual(expect.objectContaining({ runtimeDeliveryAvailable: true }));
    expect(fs.existsSync(
      path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json'),
    )).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf8')).toContain(
      '!.bundle-drop/runtime-delivery.lock.json',
    );
  });

  it('treats a null runtime delivery response as explicit retirement', async () => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(
      configPath,
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { slug: 'demo-app' } };\n",
      'utf8',
    );
    const bootstrapPath = path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json');
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(bootstrapPath, '{"lastGood":true}\n', 'utf8');
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({ runtimeDeliveryMode: undefined, runtimeDelivery: null }),
    });

    const result = await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    });

    expect(result).toEqual(expect.objectContaining({
      runtimeDeliveryAvailable: false,
      bootstrapRetired: true,
    }));
    expect(fs.existsSync(bootstrapPath)).toBe(false);
  });

  it('preserves the last good bootstrap when a refresh response is malformed', async () => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(
      configPath,
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { name: 'Demo', slug: 'demo-app' } };\n",
      'utf8',
    );
    const bootstrapPath = path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json');
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(bootstrapPath, '{"lastGood":true}\n', 'utf8');
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: { ...runtimeDeliveryBootstrap('v2'), publicKeys: {} },
      }),
    });

    await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    });

    expect(fs.readFileSync(bootstrapPath, 'utf8')).toBe('{"lastGood":true}\n');
  });

  it.each(['v1', 'shadow'] as const)(
    'atomically retires a stale bootstrap for the deprecated %s response',
    async runtimeDeliveryMode => {
      const configPath = path.join(tempDir, 'bundle.drop.config.js');
      fs.writeFileSync(
        configPath,
        "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { name: 'Demo', slug: 'demo-app' } };\n",
        'utf8',
      );
      const bootstrapPath = path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json');
      fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
      fs.writeFileSync(bootstrapPath, '{"lastGood":true}\n', 'utf8');
      mockAxiosNodeGet.mockResolvedValue({
        data: projectCredentials({ runtimeDeliveryMode }),
      });

      const result = await initConfig({
        serverUrl: 'https://api.example.com',
        organizations: [],
        projects: [],
        authToken: 'jwt-token',
      });

      expect(result).toEqual(expect.objectContaining({
        runtimeDeliveryAvailable: false,
        bootstrapRetired: true,
      }));
      expect(fs.existsSync(bootstrapPath)).toBe(false);
      expect(fs.readFileSync(configPath, 'utf8')).toContain("slug: 'demo-app'");
    },
  );

  it('previews legacy-mode convergence without deleting the current bootstrap', async () => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(
      configPath,
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { slug: 'demo-app' } };\n",
      'utf8',
    );
    const bootstrapPath = path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json');
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(bootstrapPath, '{"lastGood":true}\n', 'utf8');
    mockAxiosNodeGet.mockResolvedValue({ data: projectCredentials() });

    const result = await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
      dryRun: true,
    });

    expect(result?.bootstrapRetired).toBe(true);
    expect(fs.readFileSync(bootstrapPath, 'utf8')).toBe('{"lastGood":true}\n');
  });

  it('preserves the last-good bootstrap on transport failure or a missing delivery field', async () => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(
      configPath,
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { slug: 'demo-app' } };\n",
      'utf8',
    );
    const bootstrapPath = path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json');
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(bootstrapPath, '{"lastGood":true}\n', 'utf8');
    mockAxiosNodeGet.mockRejectedValueOnce(new Error('network down'));

    await initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    });
    expect(fs.readFileSync(bootstrapPath, 'utf8')).toBe('{"lastGood":true}\n');

    mockAxiosNodeGet.mockResolvedValueOnce({
      data: projectCredentials({ runtimeDeliveryMode: undefined }),
    });
    await expect(initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    })).resolves.toEqual(expect.not.objectContaining({ bootstrapRetired: true }));
    expect(fs.readFileSync(bootstrapPath, 'utf8')).toBe('{"lastGood":true}\n');
  });

  it.each([
    {
      label: 'non-object payload',
      response: null,
      message: 'response is malformed',
    },
    {
      label: 'invalid project ID',
      response: projectCredentials({ projectId: 7 }),
      message: 'missing its authoritative project identity',
    },
    {
      label: 'invalid project slug',
      response: projectCredentials({ projectSlug: 7 }),
      message: 'missing its authoritative project identity',
    },
    {
      label: 'invalid organization ID',
      response: projectCredentials({ orgId: 7 }),
      message: 'missing its authoritative project identity',
    },
    {
      label: 'invalid organization slug',
      response: projectCredentials({ orgSlug: 7 }),
      message: 'missing its authoritative project identity',
    },
    {
      label: 'invalid deprecated runtime delivery mode',
      response: projectCredentials({ runtimeDeliveryMode: 'preview' }),
      message: 'invalid legacy runtime delivery mode',
    },
    {
      label: 'invalid download key',
      response: projectCredentials({ downloadApiKey: 7 }),
      message: 'invalid download key',
    },
    {
      label: 'invalid download key hint',
      response: projectCredentials({ downloadKeyHint: 7 }),
      message: 'invalid download key hint',
    },
  ])('rejects a malformed credentials response and preserves local state: $label', async ({
    response,
    message,
  }) => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(
      configPath,
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { slug: 'demo-app' } };\n",
      'utf8',
    );
    const bootstrapPath = path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json');
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(bootstrapPath, '{"lastGood":true}\n', 'utf8');
    mockAxiosNodeGet.mockResolvedValue({ data: response });

    await expect(initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    })).rejects.toThrow(message);
    expect(fs.readFileSync(bootstrapPath, 'utf8')).toBe('{"lastGood":true}\n');
  });

  it.each([
    ['string', 'KEY123'],
    ['null', null],
  ] as const)('accepts a %s download key hint in an authoritative response', async (_, hint) => {
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({ downloadKeyHint: hint }),
    });

    const result = await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-1', slug: 'demo-app', name: 'Demo App' }],
      authToken: 'jwt-token',
    });

    expect(result).toEqual(expect.objectContaining({
      runtimeDeliveryAvailable: false,
      bootstrapRetired: true,
    }));
  });

  it.each([
    { orgSlug: 'other-org' },
    { projectSlug: 'other-app' },
  ])('rejects a credentials identity mismatch without replacing local state: %p', async mismatch => {
    const configPath = path.join(tempDir, 'bundle.drop.config.js');
    fs.writeFileSync(
      configPath,
      "module.exports = { serverUrl: 'https://api.example.com', org: { slug: 'alpha-org' }, project: { slug: 'demo-app' } };\n",
      'utf8',
    );
    const bootstrapPath = path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json');
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(bootstrapPath, '{"lastGood":true}\n', 'utf8');
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        ...mismatch,
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: runtimeDeliveryBootstrap(),
      }),
    });

    await expect(initConfig({
      serverUrl: 'https://api.example.com',
      organizations: [],
      projects: [],
      authToken: 'jwt-token',
    })).rejects.toThrow('Project credentials identity mismatch');
    expect(fs.readFileSync(bootstrapPath, 'utf8')).toBe('{"lastGood":true}\n');
  });

  it('creates a config using selected org/project values and fetched project credentials', async () => {
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        projectId: 'project-owners',
        projectSlug: 'owners-app',
        orgId: 'org-2',
        orgSlug: 'beta-org',
        downloadApiKey: "download-key'value",
      }),
    });
    queuePromptResponse({ chosenOrg: 'beta-org' });
    queuePromptResponse({ projectSlug: 'owners-app' });

    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [
        { orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' },
        { orgId: 'org-2', slug: 'beta-org', name: 'Beta Org' },
      ],
      projects: [
        { orgId: 'org-1', slug: 'alpha-app', name: 'Alpha App' },
        { orgId: 'org-2', slug: 'owners-app', name: "Owner's App" },
      ],
      authToken: 'jwt-token',
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');

    expect(mockAxiosNodeGet).toHaveBeenCalledWith(
      'https://api.example.com/projects/owners-app/credentials?orgSlug=beta-org',
      {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer jwt-token',
        },
        timeout: 15000,
      }
    );
    expect(content).toContain('serverUrl: "https://api.example.com"');
    expect(content).toContain('slug: "beta-org"');
    expect(content).toContain('name: "Owner\'s App"');
    expect(content).toContain('slug: "owners-app"');
    expect(content).toContain('apiKey: "download-key\'value"');
  });

  it('preserves the existing generated config exactly when runtime delivery is omitted', async () => {
    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-1', slug: 'demo-app', name: 'Demo App' }],
      downloadApiKey: 'download-key',
    });

    expect(fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8')).toBe(`module.exports = {
  serverUrl: "https://api.example.com",
  defaultChannel: 'develop',
  runtimeVersion: {
    ios: '1.0.0',
    android: '1.0.0',
  },
  org: {
    slug: "alpha-org",
  },
  project: {
    name: "Demo App",
    slug: "demo-app",
    apiKey: "download-key",
  },
};
`);
  });

  it('writes validated credentials to a version-neutral bootstrap, not the public config', async () => {
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        downloadApiKey: 'download-key',
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: runtimeDeliveryBootstrap('v2'),
      }),
    });
    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-1', slug: 'demo-app', name: 'Demo App' }],
      authToken: 'jwt-token',
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');
    expect(content).not.toContain('runtimeDelivery');
    const bootstrap = fs.readFileSync(
      path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json'),
      'utf8',
    );
    expect(bootstrap).not.toContain('"mode"');
    expect(bootstrap).toContain('"projectId": "project-1"');
    expect(bootstrap).toContain('"orgId": "org-1"');
    expect(bootstrap).toContain('"manifestBaseUrl": "https://manifests.example.com/root"');
    expect(bootstrap).toContain(`"manifestAccessId": "mft_${'A'.repeat(43)}"`);
    expect(bootstrap).toContain('"test-key": {');
    expect(bootstrap).not.toContain('"d":');

    expect(normalizeRuntimeDeliveryBootstrap(runtimeDeliveryBootstrap('v2'))).toEqual(
      expect.objectContaining({ manifestBaseUrl: 'https://manifests.example.com/root' }),
    );
  });

  it('does not promote v1, shadow, or malformed backend bootstrap values', async () => {
    expect(normalizeRuntimeDeliveryBootstrap(runtimeDeliveryBootstrap('v1'))).toBeUndefined();
    expect(normalizeRuntimeDeliveryBootstrap(runtimeDeliveryBootstrap('shadow'))).toBeUndefined();
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        downloadApiKey: 'download-key',
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: {
          ...runtimeDeliveryBootstrap('v2'),
          publicKeys: {
            'test-key': {
              ...runtimeDeliveryBootstrap('v2').publicKeys['test-key'],
              d: 'private-material-must-never-be-written',
            },
          },
        },
      }),
    });
    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-1', slug: 'demo-app', name: 'Demo App' }],
      authToken: 'jwt-token',
    });
    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');
    expect(content).not.toContain('runtimeDelivery');
    expect(content).not.toContain('private-material');
    expect(content).toContain('apiKey: "download-key"');
    expect(fs.existsSync(path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json'))).toBe(false);
  });

  it('fails closed for malformed runtime-delivery bootstrap subshapes', () => {
    const valid = runtimeDeliveryBootstrap('v2');
    const invalidValues: unknown[] = [
      null,
      [],
      'shadow',
      { ...valid, mode: 'preview' },
      { ...valid, manifestBaseUrl: '' },
      { ...valid, manifestBaseUrl: 7 },
      { ...valid, manifestBaseUrl: 'not a URL' },
      { ...valid, manifestBaseUrl: 'file:///tmp/manifests' },
      { ...valid, manifestAccessId: 7 },
      { ...valid, manifestAccessId: 'too-short' },
      { ...valid, publicKeys: null },
      { ...valid, publicKeys: [] },
      { ...valid, publicKeys: {} },
      { ...valid, publicKeys: { '': valid.publicKeys['test-key'] } },
      { ...valid, publicKeys: { key: null } },
      { ...valid, publicKeys: { key: { ...valid.publicKeys['test-key'], extra: true } } },
      { ...valid, publicKeys: { key: { ...valid.publicKeys['test-key'], kty: 'RSA' } } },
      { ...valid, publicKeys: { key: { ...valid.publicKeys['test-key'], crv: 'P-384' } } },
      { ...valid, publicKeys: { key: { ...valid.publicKeys['test-key'], x: 7 } } },
      { ...valid, publicKeys: { key: { ...valid.publicKeys['test-key'], x: 'bad' } } },
      { ...valid, publicKeys: { key: { ...valid.publicKeys['test-key'], y: '*' } } },
    ];

    for (const value of invalidValues) {
      expect(normalizeRuntimeDeliveryBootstrap(value)).toBeUndefined();
    }
    expect(normalizeRuntimeDeliveryBootstrap({
      ...valid,
      manifestBaseUrl: 'http://localhost:8787/',
    })).toEqual(expect.objectContaining({
      manifestBaseUrl: 'http://localhost:8787',
    }));
  });

  it('creates an unambiguous Expo config when the project type is known', async () => {
    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [],
      projects: [],
      projectType: 'expo',
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');

    expect(content).toContain('projectType: "expo"');
    expect(content).toContain("ios: '1.0.0'");
    expect(content).toContain("android: '1.0.0'");
    expect(content).not.toContain("runtimeVersion: { source: 'expo' }");
  });

  it('filters project choices to the selected organization', async () => {
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        projectId: 'project-beta',
        projectSlug: 'beta-app',
        orgId: 'org-2',
        orgSlug: 'beta-org',
        downloadApiKey: 'beta-key',
      }),
    });
    queuePromptResponse({ chosenOrg: 'beta-org' });

    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [
        { orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' },
        { orgId: 'org-2', slug: 'beta-org', name: 'Beta Org' },
      ],
      projects: [
        { orgId: 'org-1', slug: 'alpha-app', name: 'Alpha App' },
        { orgId: 'org-2', slug: 'beta-app', name: 'Beta App' },
      ],
      authToken: 'jwt-token',
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');

    expect(content).toContain('slug: "beta-org"');
    expect(content).toContain('slug: "beta-app"');
    expect(mockAxiosNodeGet).toHaveBeenCalledWith(
      'https://api.example.com/projects/beta-app/credentials?orgSlug=beta-org',
      expect.any(Object)
    );
  });

  it('binds the same project slug to the selected organization identity', async () => {
    mockAxiosNodeGet.mockResolvedValue({
      data: projectCredentials({
        projectId: 'project-beta-shared',
        projectSlug: 'shared-app',
        orgId: 'org-2',
        orgSlug: 'beta-org',
        runtimeDeliveryMode: 'v2',
        runtimeDelivery: runtimeDeliveryBootstrap(),
      }),
    });
    queuePromptResponse({ chosenOrg: 'beta-org' });

    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [
        { orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' },
        { orgId: 'org-2', slug: 'beta-org', name: 'Beta Org' },
      ],
      projects: [
        { orgId: 'org-1', slug: 'shared-app', name: 'Alpha App' },
        { orgId: 'org-2', slug: 'shared-app', name: 'Beta App' },
      ],
      authToken: 'jwt-token',
    });

    expect(mockAxiosNodeGet).toHaveBeenCalledWith(
      'https://api.example.com/projects/shared-app/credentials?orgSlug=beta-org',
      expect.any(Object),
    );
    expect(fs.readFileSync(
      path.join(tempDir, '.bundle-drop/runtime-delivery.lock.json'),
      'utf8',
    )).toContain('"projectId": "project-beta-shared"');
  });

  it('does not select a project from another organization', async () => {
    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-2', slug: 'beta-app', name: 'Beta App' }],
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');

    expect(content).toContain('slug: "alpha-org"');
    expect(content).toContain('name: ""');
    expect(content).not.toContain('slug: "beta-app"');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No projects returned; project values will be left blank.')
    );
  });

  it('falls back to the provided download key and derives the org slug from the selected project', async () => {
    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-9', slug: 'derived-org', name: 'Derived Org' }],
      projects: [{ orgId: 'org-9', slug: 'single-app', name: 'Single App' }],
      downloadApiKey: 'fallback-key',
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');

    expect(mockAxiosNodeGet).not.toHaveBeenCalled();
    expect(content).toContain('slug: "derived-org"');
    expect(content).toContain('slug: "single-app"');
    expect(content).toContain('apiKey: "fallback-key"');
  });

  it('creates a blank config and warns when no orgs or projects are returned', async () => {
    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [],
      projects: [],
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');

    expect(content).toContain('serverUrl: "https://api.example.com"');
    expect(content).toContain('slug: ""');
    expect(content).toContain('name: ""');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No organizations returned; org slug will be left blank.')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No projects returned; project values will be left blank.')
    );
  });

  it('handles a missing projects collection defensively', async () => {
    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
    } as never);

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');

    expect(content).toContain('slug: "alpha-org"');
    expect(content).toContain('name: ""');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No projects returned; project values will be left blank.')
    );
  });

  it('warns when the user leaves organization and project selections empty', async () => {
    queuePromptResponse({});
    queuePromptResponse({});

    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [
        { orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' },
        { orgId: 'org-2', slug: 'beta-org', name: 'Beta Org' },
      ],
      projects: [
        { orgId: 'org-1', slug: 'alpha-app', name: 'Alpha App' },
        { orgId: 'org-2', slug: 'beta-app', name: 'Beta App' },
      ],
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');

    expect(content).toContain('slug: ""');
    expect(content).toContain('name: ""');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No organization selected; org slug will be left blank.')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No project selected; project values will be left blank.')
    );
  });

  it('derives the org slug from the selected project when org selection is skipped', async () => {
    queuePromptResponse({});

    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [
        { orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' },
        { orgId: 'org-2', slug: 'beta-org', name: 'Beta Org' },
      ],
      projects: [{ orgId: 'org-2', slug: 'beta-app', name: 'Beta App' }],
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');

    expect(content).toContain('slug: "beta-org"');
    expect(content).toContain('slug: "beta-app"');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No organization selected; org slug will be left blank.')
    );
  });

  it('warns when credentials cannot be fetched or do not include a project API key', async () => {
    mockAxiosNodeGet.mockResolvedValueOnce({
      data: projectCredentials(),
    });

    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-1', slug: 'demo-app', name: 'Demo App' }],
      authToken: 'jwt-token',
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No project API key returned from /projects/:projectSlug/credentials')
    );

    removeTempDir(tempDir);
    tempDir = createTempProjectDir();
    process.chdir(tempDir);
    consoleSpy.mockClear();

    mockAxiosNodeGet.mockRejectedValueOnce(new Error('network down'));

    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-1', slug: 'demo-app', name: 'Demo App' }],
      downloadApiKey: 'stale-auth-file-key',
      authToken: 'jwt-token',
    });

    const failedFetchConfig = fs.readFileSync(
      path.join(tempDir, 'bundle.drop.config.js'),
      'utf8',
    );
    expect(failedFetchConfig).toContain('apiKey: ""');
    expect(failedFetchConfig).not.toContain('stale-auth-file-key');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch project credentials from https://api.example.com/projects/demo-app/credentials?orgSlug=alpha-org')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No project API key returned from /projects/:projectSlug/credentials')
    );
  });

  it('warns when a project is selected but no auth token is available to fetch credentials', async () => {
    await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-1', slug: 'demo-app', name: 'Demo App' }],
    });

    expect(mockAxiosNodeGet).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Missing auth token; cannot fetch project API key.')
    );
  });

  it('returns an in-memory config preview without mutating the project during dry run', async () => {
    const result = await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-1', slug: 'demo-app', name: 'Demo App' }],
      dryRun: true,
    });

    expect(fs.existsSync(path.join(tempDir, 'bundle.drop.config.js'))).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      created: false,
      serverUrl: 'https://api.example.com',
      orgSlug: 'alpha-org',
      projectSlug: 'demo-app',
    }));
    expect(result?.content).toContain('slug: "demo-app"');
  });

  it('serializes config values as inert JSON string literals', async () => {
    const serverUrl = 'https://api.example.com/"; globalThis.injected = true; // payload';
    const orgSlug = 'org\\name\nnext-line';
    const projectName = 'Project "quoted" \\ named\nnext-line';
    const projectSlug = 'project\\slug\nnext-line';
    const apiKey = 'key"; globalThis.injected = true; //\\secret\nnext-line';

    await initConfig({
      serverUrl,
      organizations: [{ orgId: 'org-1', slug: orgSlug, name: 'Organization' }],
      projects: [{ orgId: 'org-1', slug: projectSlug, name: projectName }],
      downloadApiKey: apiKey,
    });

    const content = fs.readFileSync(path.join(tempDir, 'bundle.drop.config.js'), 'utf8');
    const serializedAssignments = [
      ...content.matchAll(/^\s+(serverUrl|slug|name|apiKey): (".*"),$/gm),
    ].map(([, property, literal]) => [property, JSON.parse(literal)]);

    expect(serializedAssignments).toEqual([
      ['serverUrl', serverUrl],
      ['slug', orgSlug],
      ['name', projectName],
      ['slug', projectSlug],
      ['apiKey', apiKey],
    ]);
  });

  it('redacts the API key from dry-run console output', async () => {
    const apiKey = 'download-key-that-must-not-be-logged';
    const result = await initConfig({
      serverUrl: 'https://api.example.com/',
      organizations: [{ orgId: 'org-1', slug: 'alpha-org', name: 'Alpha Org' }],
      projects: [{ orgId: 'org-1', slug: 'demo-app', name: 'Demo App' }],
      downloadApiKey: apiKey,
      dryRun: true,
      projectType: 'expo',
    });

    const consoleOutput = consoleSpy.mock.calls.flat().join('\n');

    expect(result?.content).toContain(apiKey);
    expect(consoleOutput).toContain('projectType: "expo"');
    expect(consoleOutput).toContain('apiKey: "<redacted>"');
    expect(consoleOutput).not.toContain(apiKey);
  });
});
