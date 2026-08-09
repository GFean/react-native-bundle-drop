import fs from 'fs';
import path from 'path';

import { mockAxiosNodeGet } from '../../mocks/modules/axiosNode';
import { queuePromptResponse } from '../../mocks/modules/prompts';
import { createTempProjectDir, removeTempDir } from '../../utils/tempDir';

jest.mock('axios', () => require('../../mocks/modules/axiosNode'));
jest.mock('prompts', () => require('../../mocks/modules/prompts'));

import {
  getBundleDropConfigPath,
  hasExistingBundleDropConfig,
  initConfig,
} from '../../../CLI/scripts/init-config';

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

  it('creates a config using selected org/project values and fetched project credentials', async () => {
    mockAxiosNodeGet.mockResolvedValue({
      data: {
        downloadApiKey: "download-key'value",
      },
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
      'https://api.example.com/projects/owners-app/credentials',
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
      data: {
        downloadApiKey: 'beta-key',
      },
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
      'https://api.example.com/projects/beta-app/credentials',
      expect.any(Object)
    );
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
      data: {},
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
      authToken: 'jwt-token',
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch project credentials from https://api.example.com/projects/demo-app/credentials')
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
