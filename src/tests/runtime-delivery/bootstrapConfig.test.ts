import fs from 'fs-extra';
import path from 'path';

import {
  addRuntimeDeliveryBootstrapGitignoreRules,
  createRuntimeDeliveryBootstrapLockfile,
  ensureRuntimeDeliveryBootstrapGitignore,
  inspectRuntimeDeliveryBootstrap,
  LEGACY_RUNTIME_DELIVERY_BOOTSTRAP_PATH,
  parseRuntimeDeliveryBootstrapLockfile,
  readRuntimeDeliveryBootstrap,
  removeAllRuntimeDeliveryBootstraps,
  removeRuntimeDeliveryBootstrapLockfile,
  RUNTIME_DELIVERY_BOOTSTRAP_PATH,
  writeRuntimeDeliveryBootstrapLockfile,
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
    const bootstrap = createRuntimeDeliveryBootstrapLockfile({ identity, runtimeDelivery });
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

    await writeRuntimeDeliveryBootstrapLockfile({ projectRoot, bootstrap: bootstrap! });
    expect(readRuntimeDeliveryBootstrap({
      projectRoot,
      expectedIdentity: identity,
    })).toEqual(bootstrap);
    expect(fs.readdirSync(path.join(projectRoot, '.bundle-drop'))).toEqual([
      'runtime-delivery.lock.json',
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
        '!.bundle-drop/runtime-delivery.lock.json\n',
    );
    expect(addRuntimeDeliveryBootstrapGitignoreRules(updated)).toBe(updated);
  });

  it('repairs the legacy gitignore marker without duplicating the managed block', () => {
    const legacy =
      '# Bundle Drop: commit the public trust bootstrap; ignore generated runtime artifacts.\n' +
      '!.bundle-drop/\n.bundle-drop/*\n' +
      '!.bundle-drop/runtime-delivery.generated.json\n';

    expect(addRuntimeDeliveryBootstrapGitignoreRules(legacy)).toBe(
      '# Bundle Drop: commit the public trust bootstrap; ignore generated runtime artifacts.\n' +
        '!.bundle-drop/\n.bundle-drop/*\n' +
        '!.bundle-drop/runtime-delivery.lock.json\n',
    );
  });

  it('repairs commented and shadowed rules with one canonical final managed block', () => {
    const shadowed =
      'node_modules/\n' +
      '# !.bundle-drop/runtime-delivery.lock.json\n' +
      '!.bundle-drop/runtime-delivery.lock.json\n' +
      '.bundle-drop/\n';

    const repaired = addRuntimeDeliveryBootstrapGitignoreRules(shadowed);

    expect(repaired).toBe(
      'node_modules/\n' +
        '# !.bundle-drop/runtime-delivery.lock.json\n' +
        '.bundle-drop/\n\n' +
        '# Bundle Drop: commit the public trust bootstrap; ignore generated runtime artifacts.\n' +
        '!.bundle-drop/\n.bundle-drop/*\n' +
        '!.bundle-drop/runtime-delivery.lock.json\n',
    );
    expect(repaired.match(/^!\.bundle-drop\/runtime-delivery\.lock\.json$/gm)).toHaveLength(1);
    expect(addRuntimeDeliveryBootstrapGitignoreRules(repaired)).toBe(repaired);
  });

  it('rejects shadow promotion, private key material, and copied project identity', () => {
    expect(createRuntimeDeliveryBootstrapLockfile({
      identity,
      runtimeDelivery: { ...runtimeDelivery, mode: 'shadow' },
    })).toBeUndefined();
    expect(createRuntimeDeliveryBootstrapLockfile({
      identity,
      runtimeDelivery: {
        ...runtimeDelivery,
        publicKeys: { key: { ...runtimeDelivery.publicKeys.key, d: 'private' } },
      },
    })).toBeUndefined();

    const bootstrap = createRuntimeDeliveryBootstrapLockfile({ identity, runtimeDelivery })!;
    expect(() => parseRuntimeDeliveryBootstrapLockfile(bootstrap, {
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
    const bootstrap = createRuntimeDeliveryBootstrapLockfile({
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
    expect(parseRuntimeDeliveryBootstrapLockfile(bootstrap, stableIdentity)).toEqual(bootstrap);
    expect(() => parseRuntimeDeliveryBootstrapLockfile(bootstrap, {
      ...stableIdentity,
      projectId: 'other-project-id',
    })).toThrow('belongs to a different');

    const legacy = createRuntimeDeliveryBootstrapLockfile({ identity, runtimeDelivery })!;
    expect(parseRuntimeDeliveryBootstrapLockfile(legacy, identity)).toEqual(legacy);
    expect(createRuntimeDeliveryBootstrapLockfile({
      identity: { ...identity, projectId: 'project-id-only' },
      runtimeDelivery,
    })).toBeUndefined();
  });

  it('fails closed for unsupported schemas and malformed JSON', () => {
    const projectRoot = createTempProjectDir();
    roots.push(projectRoot);
    expect(readRuntimeDeliveryBootstrap({ projectRoot })).toBeNull();
    expect(() => parseRuntimeDeliveryBootstrapLockfile({
      schemaVersion: 2,
      project: identity,
      runtimeDelivery,
    })).toThrow('schemaVersion 1');
    expect(() => parseRuntimeDeliveryBootstrapLockfile({
      schemaVersion: 1,
      runtimeDelivery,
    })).toThrow('missing its project identity');
    expect(() => parseRuntimeDeliveryBootstrapLockfile({
      schemaVersion: 1,
      project: { serverUrl: 7, orgSlug: null, projectSlug: [] },
      runtimeDelivery,
    })).toThrow('invalid trust configuration');
    expect(() => parseRuntimeDeliveryBootstrapLockfile({
      schemaVersion: 1,
      project: { ...identity, projectId: 'project-id-1' },
      runtimeDelivery,
    })).toThrow('invalid stable project identity');
    expect(() => parseRuntimeDeliveryBootstrapLockfile({
      schemaVersion: 1,
      project: { ...identity, projectId: 7, orgId: 'org-id-1' },
      runtimeDelivery,
    })).toThrow('invalid stable project identity');

    const valid = createRuntimeDeliveryBootstrapLockfile({ identity, runtimeDelivery })!;
    expect(parseRuntimeDeliveryBootstrapLockfile(valid)).toEqual(valid);

    fs.ensureDirSync(path.join(projectRoot, '.bundle-drop'));
    fs.writeFileSync(
      path.join(projectRoot, RUNTIME_DELIVERY_BOOTSTRAP_PATH),
      '{not-json',
    );
    expect(() => readRuntimeDeliveryBootstrap({ projectRoot })).toThrow('not valid JSON');
  });

  it('rejects a symlinked bootstrap ancestor without changing external files', async () => {
    const projectRoot = createTempProjectDir();
    const outsideRoot = createTempProjectDir();
    roots.push(projectRoot, outsideRoot);
    const bootstrap = createRuntimeDeliveryBootstrapLockfile({ identity, runtimeDelivery })!;
    const sentinel = path.join(outsideRoot, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside-safe');
    fs.symlinkSync(outsideRoot, path.join(projectRoot, '.bundle-drop'));

    await expect(writeRuntimeDeliveryBootstrapLockfile({ projectRoot, bootstrap }))
      .rejects.toThrow('symlinked or non-directory');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside-safe');
  });

  it('atomically removes an existing bootstrap and tolerates an already-absent file', async () => {
    const projectRoot = createTempProjectDir();
    roots.push(projectRoot);
    const bootstrap = createRuntimeDeliveryBootstrapLockfile({ identity, runtimeDelivery })!;
    await writeRuntimeDeliveryBootstrapLockfile({ projectRoot, bootstrap });

    const bootstrapPath = await removeRuntimeDeliveryBootstrapLockfile(projectRoot);
    expect(bootstrapPath).not.toBeNull();
    expect(fs.existsSync(bootstrapPath!)).toBe(false);
    await expect(removeRuntimeDeliveryBootstrapLockfile(projectRoot)).resolves.toBeNull();
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
      path.join(projectRoot, RUNTIME_DELIVERY_BOOTSTRAP_PATH),
    );

    await expect(removeRuntimeDeliveryBootstrapLockfile(projectRoot))
      .rejects.toThrow('symlinked or non-regular');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside-safe');
  });

  it('reads legacy-only and matching dual bootstraps but rejects disagreement', async () => {
    const projectRoot = createTempProjectDir();
    roots.push(projectRoot);
    const bootstrap = createRuntimeDeliveryBootstrapLockfile({ identity, runtimeDelivery })!;
    fs.ensureDirSync(path.join(projectRoot, '.bundle-drop'));
    fs.writeJsonSync(path.join(projectRoot, LEGACY_RUNTIME_DELIVERY_BOOTSTRAP_PATH), bootstrap);

    expect(inspectRuntimeDeliveryBootstrap({ projectRoot, expectedIdentity: identity })).toEqual({
      bootstrap,
      source: 'legacy',
    });

    await writeRuntimeDeliveryBootstrapLockfile({ projectRoot, bootstrap });
    expect(inspectRuntimeDeliveryBootstrap({ projectRoot, expectedIdentity: identity })).toEqual({
      bootstrap,
      source: 'matching-dual',
    });

    const different = createRuntimeDeliveryBootstrapLockfile({
      identity,
      runtimeDelivery: { ...runtimeDelivery, manifestBaseUrl: 'https://other.example.com' },
    })!;
    fs.writeJsonSync(path.join(projectRoot, LEGACY_RUNTIME_DELIVERY_BOOTSTRAP_PATH), different);
    expect(() => inspectRuntimeDeliveryBootstrap({ projectRoot, expectedIdentity: identity }))
      .toThrow('lockfile and legacy bootstrap differ');
  });

  it('removes current and legacy bootstrap files when delivery is disabled', async () => {
    const projectRoot = createTempProjectDir();
    roots.push(projectRoot);
    const bootstrap = createRuntimeDeliveryBootstrapLockfile({ identity, runtimeDelivery })!;
    await writeRuntimeDeliveryBootstrapLockfile({ projectRoot, bootstrap });
    fs.writeJsonSync(path.join(projectRoot, LEGACY_RUNTIME_DELIVERY_BOOTSTRAP_PATH), bootstrap);

    await expect(removeAllRuntimeDeliveryBootstraps(projectRoot)).resolves.toHaveLength(2);
    expect(fs.existsSync(path.join(projectRoot, RUNTIME_DELIVERY_BOOTSTRAP_PATH))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, LEGACY_RUNTIME_DELIVERY_BOOTSTRAP_PATH))).toBe(false);
  });
});
