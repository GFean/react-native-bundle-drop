import fs from 'fs';
import os from 'os';
import path from 'path';

import { createTempProjectDir, removeTempDir } from '../utils/tempDir';
import { mockAxiosNodeGet, resetAxiosNodeMocks } from '../mocks/modules/axiosNode';

const mockUpload = jest.fn();
const mockRunPostInitPrompts = jest.fn();
const mockLogin = jest.fn();
const mockInitConfig = jest.fn();
const mockHasExistingBundleDropConfig = jest.fn(() => true);
const mockRunDoctor = jest.fn();
const mockWriteEasBuildReceipt = jest.fn();
const mockDetectProjectType = jest.fn(
  (_options?: { explicitType?: 'expo' | 'bare' }): 'expo' | 'bare' => 'bare',
);

jest.mock('../../CLI/scripts/upload-cli', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUpload(...args),
}));

jest.mock('../../CLI/scripts/post-init', () => ({
  runPostInitPrompts: (...args: unknown[]) => mockRunPostInitPrompts(...args),
}));

jest.mock('../../CLI/scripts/login-cli', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockLogin(...args),
}));

jest.mock('../../CLI/scripts/init-config', () => ({
  initConfig: (...args: unknown[]) => mockInitConfig(...args),
  hasExistingBundleDropConfig: () => mockHasExistingBundleDropConfig(),
}));

jest.mock('../../CLI/scripts/doctor', () => ({
  runDoctor: (...args: unknown[]) => mockRunDoctor(...args),
}));
jest.mock('../../CLI/scripts/expo/write-eas-build-receipt', () => ({
  writeEasBuildReceipt: (...args: unknown[]) => mockWriteEasBuildReceipt(...args),
}));
jest.mock('../../expo', () => ({
  detectProjectType: (options: unknown) => mockDetectProjectType(options),
}));
jest.mock('axios', () => require('../mocks/modules/axiosNode'));

import { buildProgram } from '../../CLI/cli';

describe('CLI/cli', () => {
  const originalEnv = { ...process.env };
  let tempHome = '';
  let homedirSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  const parseCommand = async (...args: string[]) => {
    const program = buildProgram();
    await program.parseAsync(['node', 'bundle-drop', ...args]);
  };

  beforeEach(() => {
    tempHome = createTempProjectDir();
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockUpload.mockReset();
    mockRunPostInitPrompts.mockReset().mockResolvedValue(undefined);
    mockLogin.mockReset();
    mockInitConfig.mockReset().mockResolvedValue(undefined);
    mockHasExistingBundleDropConfig.mockReset().mockReturnValue(true);
    mockRunDoctor.mockReset().mockResolvedValue(undefined);
    mockWriteEasBuildReceipt.mockReset().mockResolvedValue('/project/eas-receipt.json');
    mockDetectProjectType.mockReset().mockImplementation(
      (options?: { explicitType?: 'expo' | 'bare' }) => options?.explicitType || 'bare',
    );
    resetAxiosNodeMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    consoleLogSpy.mockRestore();
    removeTempDir(tempHome);
    process.env = { ...originalEnv };
  });

  it('routes upload arguments to the upload action', async () => {
    await parseCommand(
      'upload',
      'android',
      '--version',
      '1.2.3',
      '--channel',
      'General',
      '--token',
      'token-1',
      '--author',
      'Sam',
    );

    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload.mock.calls[0][0]).toBe('android');
    expect(mockUpload.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        version: '1.2.3',
        channel: 'General',
        token: 'token-1',
        author: 'Sam',
      }),
    );
  });

  it('routes Expo setup escape hatches and exact build receipts', async () => {
    await parseCommand(
      'init',
      '--token',
      'token-123',
      '--project-type',
      'expo',
      '--dry-run',
      '--migrate-expo-updates',
      '--prebuild',
      '--yes',
    );
    expect(mockRunPostInitPrompts).toHaveBeenCalledWith(expect.objectContaining({
      projectType: 'expo',
      dryRun: true,
      migrateExpoUpdates: true,
      prebuild: true,
      yes: true,
    }));

    await parseCommand(
      'upload',
      'ios',
      '--version',
      '1.0.0',
      '--channel',
      'General',
      '--build-receipt',
      './eas-receipt.json',
    );
    expect(mockUpload).toHaveBeenLastCalledWith(
      'ios',
      expect.objectContaining({ buildReceipt: './eas-receipt.json' }),
      expect.anything(),
    );
  });

  it('rejects an invalid init project type before setup starts', async () => {
    await expect(parseCommand('init', '--project-type', 'unknown')).rejects.toThrow(
      '--project-type must be expo or bare',
    );

    expect(mockInitConfig).not.toHaveBeenCalled();
    expect(mockRunPostInitPrompts).not.toHaveBeenCalled();
  });

  it('routes doctor platform and project type validation', async () => {
    await parseCommand('doctor', '--platform', 'android', '--project-type', 'expo');
    expect(mockRunDoctor).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'android',
      projectType: 'expo',
    }));

    await expect(parseCommand('doctor', '--platform', 'web')).rejects.toThrow(
      '--platform must be ios or android',
    );
    await expect(parseCommand('doctor', '--project-type', 'unknown')).rejects.toThrow(
      '--project-type must be expo or bare',
    );
  });

  it('includes doctor in top-level and command-specific help', () => {
    const program = buildProgram();
    let topLevelHelp = '';
    program.configureOutput({ writeOut: output => { topLevelHelp += output; } });
    program.outputHelp();
    expect(topLevelHelp).toContain('Ship OTA Updates with Confidence');
    expect(topLevelHelp).toContain('bundle-drop doctor');
    expect(topLevelHelp).not.toContain('init-native');
    expect(topLevelHelp).not.toContain('init-metro');

    const doctorCommand = program.commands.find(command => command.name() === 'doctor');
    expect(doctorCommand).toBeDefined();
    let doctorHelp = '';
    doctorCommand?.configureOutput({ writeOut: output => { doctorHelp += output; } });
    doctorCommand?.outputHelp();
    expect(doctorHelp).toContain('bundle-drop doctor --platform ios');
    expect(doctorHelp).toContain('--project-type <type>');
  });

  it('creates an authenticated receipt for an exact EAS application build', async () => {
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/project');
    try {
      await parseCommand(
        'eas-receipt',
        'ios',
        '--build-id',
        '11111111-1111-4111-8111-111111111111',
        '--output',
        './receipts/ios.json',
      );
      expect(mockWriteEasBuildReceipt).toHaveBeenCalledWith({
        projectRoot: '/project',
        platform: 'ios',
        easBuildId: '11111111-1111-4111-8111-111111111111',
        outputPath: './receipts/ios.json',
      });
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('/project/eas-receipt.json'),
      );

      await expect(parseCommand(
        'eas-receipt',
        'web',
        '--build-id',
        '11111111-1111-4111-8111-111111111111',
      )).rejects.toThrow('platform must be ios or android');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('logs out by deleting the stored auth file', async () => {
    const authDir = path.join(tempHome, '.bundle-drop');
    const authPath = path.join(authDir, 'auth.json');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ token: 'jwt-token' }), 'utf8');

    await parseCommand('logout');

    expect(fs.existsSync(authPath)).toBe(false);
    expect(consoleLogSpy).toHaveBeenCalledWith('🚪 Logged out.');
  });

  it('prints a not logged in message when logout has no stored auth', async () => {
    await parseCommand('logout');

    expect(consoleLogSpy).toHaveBeenCalledWith('ℹ️ Not logged in.');
  });

  it('detects the project type before creating a token-based config', async () => {
    process.env.BUNDLE_DROP_SERVER_URL = 'https://api.example.com/';
    mockDetectProjectType.mockReturnValue('expo');

    await parseCommand('init', '--token', 'token-123');

    expect(mockInitConfig).toHaveBeenCalledWith({
      serverUrl: 'https://api.example.com',
      projects: [],
      organizations: [],
      downloadApiKey: '',
      authToken: 'token-123',
      dryRun: true,
      projectType: 'expo',
    });
    expect(mockRunPostInitPrompts).toHaveBeenCalledWith(
      expect.objectContaining({ projectType: 'expo' }),
    );
  });

  it('points failed init runs to the manual installation guide', async () => {
    mockRunPostInitPrompts.mockRejectedValueOnce(new Error('setup planner unavailable'));

    await expect(parseCommand('init', '--token', 'token-123')).rejects.toThrow(
      'setup planner unavailable\n' +
        'Manual installation: https://bundledrop.app/docs/installation',
    );
  });

  it('passes a newly selected token-based config to setup without writing it early', async () => {
    mockHasExistingBundleDropConfig.mockReturnValue(false);
    mockInitConfig.mockResolvedValue({
      content: 'module.exports = {};',
      serverUrl: 'https://api.example.com',
      orgSlug: 'alpha-org',
      projectSlug: 'demo-app',
    });

    await parseCommand('init', '--token', 'token-123');

    expect(mockRunPostInitPrompts).toHaveBeenCalledWith(expect.objectContaining({
      virtualConfig: {
        content: 'module.exports = {};',
        serverUrl: 'https://api.example.com',
        orgSlug: 'alpha-org',
        projectSlug: 'demo-app',
        authToken: 'token-123',
      },
    }));
  });

  it('uses the default server URL for token-based init when no env override is set', async () => {
    delete process.env.BUNDLE_DROP_SERVER_URL;

    await parseCommand('init', '--token', 'token-123');

    expect(mockInitConfig).toHaveBeenCalledWith({
      serverUrl: 'https://api.bundledrop.app',
      projects: [],
      organizations: [],
      downloadApiKey: '',
      authToken: 'token-123',
      dryRun: true,
      projectType: 'bare',
    });
  });

  it('reads stored auth for init and falls back to baseUrl when present', async () => {
    const authDir = path.join(tempHome, '.bundle-drop');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify({
        token: 'jwt-token',
        projects: [{ slug: 'demo-app' }],
        organizations: [{ slug: 'alpha-org' }],
        downloadApiKey: 'download-key',
        baseUrl: 'https://legacy.example.com/',
      }),
      'utf8',
    );

    await parseCommand('init');

    expect(mockInitConfig).toHaveBeenCalledWith({
      serverUrl: 'https://legacy.example.com',
      projects: [{ slug: 'demo-app' }],
      organizations: [{ slug: 'alpha-org' }],
      downloadApiKey: 'download-key',
      authToken: 'jwt-token',
      dryRun: true,
      projectType: 'bare',
    });
    expect(mockRunPostInitPrompts).toHaveBeenCalledTimes(1);
  });

  it('passes a newly selected stored-auth config to setup without writing it early', async () => {
    const authDir = path.join(tempHome, '.bundle-drop');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify({ token: 'jwt-token' }),
      'utf8',
    );
    mockHasExistingBundleDropConfig.mockReturnValue(false);
    mockInitConfig.mockResolvedValue({
      content: 'module.exports = {};',
      serverUrl: 'https://api.bundledrop.app',
      orgSlug: 'alpha-org',
      projectSlug: 'demo-app',
    });

    await parseCommand('init');

    expect(mockRunPostInitPrompts).toHaveBeenCalledWith(expect.objectContaining({
      virtualConfig: expect.objectContaining({
        orgSlug: 'alpha-org',
        projectSlug: 'demo-app',
        authToken: 'jwt-token',
      }),
    }));
  });

  it('refreshes stored auth context before init so project choices are not stale', async () => {
    const authDir = path.join(tempHome, '.bundle-drop');
    const authPath = path.join(authDir, 'auth.json');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        token: 'jwt-token',
        projects: [{ name: 'Old App', slug: 'old-app', orgId: 'org-1' }],
        organizations: [{ name: 'Alpha', slug: 'alpha-org', orgId: 'org-1' }],
        downloadApiKey: 'download-key',
        serverUrl: 'https://api.example.com/',
      }),
      'utf8',
    );
    mockAxiosNodeGet.mockResolvedValueOnce({
      data: {
        email: 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        projects: [
          { name: 'Old App', slug: 'old-app', orgId: 'org-1' },
          { name: 'New App', slug: 'new-app', orgId: 'org-1' },
        ],
        organizations: [{ name: 'Alpha', slug: 'alpha-org', orgId: 'org-1' }],
        memberships: [{ role: 'owner' }],
      },
    });

    await parseCommand('init');

    expect(mockAxiosNodeGet).toHaveBeenCalledWith('https://api.example.com/auth/cli/context', {
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer jwt-token',
      },
      timeout: 15000,
    });
    expect(mockInitConfig).toHaveBeenCalledWith({
      serverUrl: 'https://api.example.com',
      projects: [
        { name: 'Old App', slug: 'old-app', orgId: 'org-1' },
        { name: 'New App', slug: 'new-app', orgId: 'org-1' },
      ],
      organizations: [{ name: 'Alpha', slug: 'alpha-org', orgId: 'org-1' }],
      downloadApiKey: 'download-key',
      authToken: 'jwt-token',
      dryRun: true,
      projectType: 'bare',
    });
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual(
      expect.objectContaining({
        projects: [
          { name: 'Old App', slug: 'old-app', orgId: 'org-1' },
          { name: 'New App', slug: 'new-app', orgId: 'org-1' },
        ],
      }),
    );
  });

  it('normalizes empty refreshed auth context before init', async () => {
    const authDir = path.join(tempHome, '.bundle-drop');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify({
        token: 'jwt-token',
        projects: [{ name: 'Old App', slug: 'old-app', orgId: 'org-1' }],
        organizations: [{ name: 'Alpha', slug: 'alpha-org', orgId: 'org-1' }],
        serverUrl: 'https://api.example.com/',
      }),
      'utf8',
    );
    mockAxiosNodeGet.mockResolvedValueOnce({
      data: {
        projects: null,
        organizations: null,
        memberships: null,
      },
    });

    await parseCommand('init');

    expect(mockInitConfig).toHaveBeenCalledWith({
      serverUrl: 'https://api.example.com',
      projects: [],
      organizations: [],
      downloadApiKey: '',
      authToken: 'jwt-token',
      dryRun: true,
      projectType: 'bare',
    });
  });

  it('falls back to env server URL and empty auth collections when stored auth omits them', async () => {
    const authDir = path.join(tempHome, '.bundle-drop');
    process.env.BUNDLE_DROP_SERVER_URL = 'https://env.example.com/';
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify({
        token: 'jwt-token',
      }),
      'utf8',
    );

    await parseCommand('init');

    expect(mockInitConfig).toHaveBeenCalledWith({
      serverUrl: 'https://env.example.com',
      projects: [],
      organizations: [],
      downloadApiKey: '',
      authToken: 'jwt-token',
      dryRun: true,
      projectType: 'bare',
    });
    expect(mockRunPostInitPrompts).toHaveBeenCalledTimes(1);
  });

  it('handles invalid auth payloads without crashing in init and whoami', async () => {
    const authDir = path.join(tempHome, '.bundle-drop');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'auth.json'), '{invalid json', 'utf8');

    await parseCommand('init');
    await parseCommand('whoami');

    expect(mockInitConfig).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '❌ Failed to read CLI auth session. Please run `bundle-drop login` again or use --token.\n' +
        'CLI docs: https://bundledrop.app/docs/cli\n' +
        'CI/CD docs: https://bundledrop.app/docs/ci-cd'
    );
  });

  it('treats non-object auth payloads and tokenless auth files as invalid', async () => {
    const authDir = path.join(tempHome, '.bundle-drop');
    fs.mkdirSync(authDir, { recursive: true });

    fs.writeFileSync(path.join(authDir, 'auth.json'), 'null', 'utf8');
    await parseCommand('whoami');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '❌ Failed to read CLI auth session. Please run `bundle-drop login` again or use --token.\n' +
        'CLI docs: https://bundledrop.app/docs/cli\n' +
        'CI/CD docs: https://bundledrop.app/docs/ci-cd'
    );

    consoleLogSpy.mockClear();
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify({
        projects: [{ slug: 'demo-app' }],
      }),
      'utf8',
    );
    await parseCommand('init');
    expect(mockInitConfig).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '❌ Failed to read CLI auth session. Please run `bundle-drop login` again or use --token.\n' +
        'CLI docs: https://bundledrop.app/docs/cli\n' +
        'CI/CD docs: https://bundledrop.app/docs/ci-cd'
    );
  });

  it('dispatches login through the supported setup surface', async () => {
    await parseCommand('login');

    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('waits for login failures instead of reporting command success early', async () => {
    mockLogin.mockRejectedValueOnce(new Error('login failed'));

    await expect(parseCommand('login')).rejects.toThrow('login failed');
  });

  it('prints whoami details from stored auth', async () => {
    const authDir = path.join(tempHome, '.bundle-drop');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'auth.json'),
      JSON.stringify({
        token: 'jwt-token',
        user: {
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane@example.com',
        },
      }),
      'utf8',
    );

    await parseCommand('whoami');

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('👤 Logged in as:'),
    );
  });

  it('prints a not logged in message when no auth file exists', async () => {
    await parseCommand('whoami');

    expect(consoleLogSpy).toHaveBeenCalledWith('ℹ️ Not logged in.');
  });

  it('prints the init not logged in message when auth has not been created yet', async () => {
    await parseCommand('init');

    expect(mockInitConfig).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'ℹ️ Not logged in. Please run `bundle-drop login` or use --token.\n' +
        'CLI docs: https://bundledrop.app/docs/cli\n' +
        'CI/CD docs: https://bundledrop.app/docs/ci-cd'
    );
  });
});
