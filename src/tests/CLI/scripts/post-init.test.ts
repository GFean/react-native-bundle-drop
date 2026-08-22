type PostInitModule = typeof import('../../../CLI/scripts/post-init');

const loadPostInitModule = (implementation = jest.fn().mockResolvedValue(undefined)) => {
  jest.resetModules();
  jest.doMock('../../../CLI/scripts/aipowered/init-project-config', () => ({
    initProjectConfigAi: implementation,
  }));
  return {
    ...(require('../../../CLI/scripts/post-init') as PostInitModule),
    implementation,
  };
};

describe('CLI/scripts/post-init', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('../../../CLI/scripts/aipowered/init-project-config');
  });

  it('routes post-config setup through the unified project-aware AI flow', async () => {
    const { runPostInitPrompts, implementation } = loadPostInitModule();
    const options = {
      projectType: 'expo' as const,
      dryRun: true,
      migrateCodePush: true,
      migrateExpoUpdates: true,
      prebuild: false,
      yes: true,
    };

    await runPostInitPrompts(options);

    expect(implementation).toHaveBeenCalledWith(options);
  });

  it('uses empty options for existing login/init callers', async () => {
    const { runPostInitPrompts, implementation } = loadPostInitModule();

    await runPostInitPrompts();

    expect(implementation).toHaveBeenCalledWith({});
  });

  it('propagates setup failures so callers never report partial success', async () => {
    const implementation = jest.fn().mockRejectedValue(new Error('setup failed'));
    const { runPostInitPrompts } = loadPostInitModule(implementation);

    await expect(runPostInitPrompts()).rejects.toThrow('setup failed');
  });
});
