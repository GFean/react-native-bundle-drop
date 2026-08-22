import fs from 'fs-extra';
import path from 'path';

import {
  addRuntimeDeliveryBootstrapGitignoreRules,
  createGeneratedRuntimeDeliveryBootstrap,
  ensureRuntimeDeliveryBootstrapGitignore,
  parseGeneratedRuntimeDeliveryBootstrap,
  readGeneratedRuntimeDeliveryBootstrap,
  removeGeneratedRuntimeDeliveryBootstrap,
  writeGeneratedRuntimeDeliveryBootstrap,
} from '../../runtime-delivery/bootstrapConfig';
import { createTempProjectDir, removeTempDir } from '../utils/tempDir';

const runtimeDelivery = {
  mode: 'v2',
  manifestBaseUrl: 'https://manifests.example.com/root/',
  manifestAccessId: `mft_${'A'.repeat(43)}`,
  publicKeys: {
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: 'd-g4y_28QdARnFF6HO0T00laLEfHhVFXTmuWHqBWmfM',
      y: '_Z_xWbhjDp3IVMtLA_rN3guVyprP34OvBikPWpVQfUI',
    },
  },
};

const identity = {
  serverUrl: 'https://api.example.com/',
  orgSlug: 'org',
  projectSlug: 'app',
};

describe('runtime-delivery/bootstrapConfig', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDir(root);
  });

  it('creates, atomically writes, and identity-validates a neutral bootstrap', async () => {
    const projectRoot = createTempProjectDir();
    roots.push(projectRoot);
    const bootstrap = createGeneratedRuntimeDeliveryBootstrap({ identity, runtimeDelivery });
    expect(bootstrap).toEqual(expect.objectContaining({
      schemaVersion: 1,
      project: {
        serverUrl: 'https://api.example.com',
        orgSlug: 'org',
        projectSlug: 'app',
      },
      runtimeDelivery: expect.objectContaining({
        manifestBaseUrl: 'https://manifests.example.com/root',
      }),
    }));
    expect(bootstrap?.runtimeDelivery).not.toHaveProperty('mode');

    await writeGeneratedRuntimeDeliveryBootstrap({ projectRoot, bootstrap: bootstrap! });
    expect(readGeneratedRuntimeDeliveryBootstrap({
      projectRoot,
      expectedIdentity: identity,
    })).toEqual(bootstrap);
    expect(fs.readdirSync(path.join(projectRoot, '.bundle-drop'))).toEqual([
      'runtime-delivery.generated.json',
    ]);
  });

  it('keeps the bootstrap committed while ignoring the rest of its generated directory', async () => {
    const projectRoot = createTempProjectDir();
    roots.push(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules\n.bundle-drop/\n');

    await ensureRuntimeDeliveryBootstrapGitignore(projectRoot);
    const updated = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
    expect(updated).toBe(
      'node_modules\n.bundle-drop/\n\n' +
        '# Bundle Drop: commit the public trust bootstrap; ignore generated runtime artifacts.\n' +
        '!.bundle-drop/\n.bundle-drop/*\n' +
        '!.bundle-drop/runtime-delivery.generated.json\n',
    );
    expect(addRuntimeDeliveryBootstrapGitignoreRules(updated)).toBe(updated);
  });

  it('rejects shadow promotion, private key material, and copied project identity', () => {
    expect(createGeneratedRuntimeDeliveryBootstrap({
      identity,
      runtimeDelivery: { ...runtimeDelivery, mode: 'shadow' },
    })).toBeUndefined();
    expect(createGeneratedRuntimeDeliveryBootstrap({
      identity,
      runtimeDelivery: {
        ...runtimeDelivery,
        publicKeys: { key: { ...runtimeDelivery.publicKeys.key, d: 'private' } },
      },
    })).toBeUndefined();

    const bootstrap = createGeneratedRuntimeDeliveryBootstrap({ identity, runtimeDelivery })!;
    expect(() => parseGeneratedRuntimeDeliveryBootstrap(bootstrap, {
      ...identity,
      projectSlug: 'other-app',
    })).toThrow('belongs to a different');
  });

  it('persists stable backend IDs while remaining compatible with legacy schema-v1 identity', () => {
    const stableIdentity = {
      ...identity,
      projectId: 'project-id-1',
      orgId: 'org-id-1',
    };
    const bootstrap = createGeneratedRuntimeDeliveryBootstrap({
      identity: stableIdentity,
      runtimeDelivery,
    })!;

    expect(bootstrap.project).toEqual({
      serverUrl: 'https://api.example.com',
      orgSlug: 'org',
      projectSlug: 'app',
      projectId: 'project-id-1',
      orgId: 'org-id-1',
    });
    expect(parseGeneratedRuntimeDeliveryBootstrap(bootstrap, stableIdentity)).toEqual(bootstrap);
    expect(() => parseGeneratedRuntimeDeliveryBootstrap(bootstrap, {
      ...stableIdentity,
      projectId: 'other-project-id',
    })).toThrow('belongs to a different');

    const legacy = createGeneratedRuntimeDeliveryBootstrap({ identity, runtimeDelivery })!;
    expect(parseGeneratedRuntimeDeliveryBootstrap(legacy, identity)).toEqual(legacy);
    expect(createGeneratedRuntimeDeliveryBootstrap({
      identity: { ...identity, projectId: 'project-id-only' },
      runtimeDelivery,
    })).toBeUndefined();
  });

  it('fails closed for unsupported schemas and malformed JSON', () => {
    const projectRoot = createTempProjectDir();
    roots.push(projectRoot);
    expect(readGeneratedRuntimeDeliveryBootstrap({ projectRoot })).toBeNull();
    expect(() => parseGeneratedRuntimeDeliveryBootstrap({
      schemaVersion: 2,
      project: identity,
      runtimeDelivery,
    })).toThrow('schemaVersion 1');
    expect(() => parseGeneratedRuntimeDeliveryBootstrap({
      schemaVersion: 1,
      runtimeDelivery,
    })).toThrow('missing its project identity');
    expect(() => parseGeneratedRuntimeDeliveryBootstrap({
      schemaVersion: 1,
      project: { serverUrl: 7, orgSlug: null, projectSlug: [] },
      runtimeDelivery,
    })).toThrow('invalid trust configuration');
    expect(() => parseGeneratedRuntimeDeliveryBootstrap({
      schemaVersion: 1,
      project: { ...identity, projectId: 'project-id-1' },
      runtimeDelivery,
    })).toThrow('invalid stable project identity');
    expect(() => parseGeneratedRuntimeDeliveryBootstrap({
      schemaVersion: 1,
      project: { ...identity, projectId: 7, orgId: 'org-id-1' },
      runtimeDelivery,
    })).toThrow('invalid stable project identity');

    const valid = createGeneratedRuntimeDeliveryBootstrap({ identity, runtimeDelivery })!;
    expect(parseGeneratedRuntimeDeliveryBootstrap(valid)).toEqual(valid);

    fs.ensureDirSync(path.join(projectRoot, '.bundle-drop'));
    fs.writeFileSync(
      path.join(projectRoot, '.bundle-drop/runtime-delivery.generated.json'),
      '{not-json',
    );
    expect(() => readGeneratedRuntimeDeliveryBootstrap({ projectRoot })).toThrow('not valid JSON');
  });

  it('rejects a symlinked bootstrap ancestor without changing external files', async () => {
    const projectRoot = createTempProjectDir();
    const outsideRoot = createTempProjectDir();
    roots.push(projectRoot, outsideRoot);
    const bootstrap = createGeneratedRuntimeDeliveryBootstrap({ identity, runtimeDelivery })!;
    const sentinel = path.join(outsideRoot, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside-safe');
    fs.symlinkSync(outsideRoot, path.join(projectRoot, '.bundle-drop'));

    await expect(writeGeneratedRuntimeDeliveryBootstrap({ projectRoot, bootstrap }))
      .rejects.toThrow('symlinked or non-directory');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside-safe');
  });

  it('atomically removes an existing bootstrap and tolerates an already-absent file', async () => {
    const projectRoot = createTempProjectDir();
    roots.push(projectRoot);
    const bootstrap = createGeneratedRuntimeDeliveryBootstrap({ identity, runtimeDelivery })!;
    await writeGeneratedRuntimeDeliveryBootstrap({ projectRoot, bootstrap });

    const bootstrapPath = await removeGeneratedRuntimeDeliveryBootstrap(projectRoot);
    expect(bootstrapPath).not.toBeNull();
    expect(fs.existsSync(bootstrapPath!)).toBe(false);
    await expect(removeGeneratedRuntimeDeliveryBootstrap(projectRoot)).resolves.toBeNull();
  });

  it('refuses to remove a symlinked bootstrap target', async () => {
    const projectRoot = createTempProjectDir();
    const outsideRoot = createTempProjectDir();
    roots.push(projectRoot, outsideRoot);
    fs.ensureDirSync(path.join(projectRoot, '.bundle-drop'));
    const sentinel = path.join(outsideRoot, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside-safe');
    fs.symlinkSync(
      sentinel,
      path.join(projectRoot, '.bundle-drop/runtime-delivery.generated.json'),
    );

    await expect(removeGeneratedRuntimeDeliveryBootstrap(projectRoot))
      .rejects.toThrow('symlinked or non-regular');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside-safe');
  });
});
