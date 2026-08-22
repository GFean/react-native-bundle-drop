import fs from 'fs-extra';
import path from 'path';
import {
  inspectProjectFile,
  removeProjectFile,
  writeProjectFileAtomically,
} from '../CLI/scripts/safe-file-transaction';

export const RUNTIME_DELIVERY_BOOTSTRAP_SCHEMA_VERSION = 1;
export const RUNTIME_DELIVERY_BOOTSTRAP_PATH = path.join(
  '.bundle-drop',
  'runtime-delivery.generated.json',
);
export const RUNTIME_DELIVERY_BOOTSTRAP_GITIGNORE_MARKER =
  '!.bundle-drop/runtime-delivery.generated.json';

const RUNTIME_DELIVERY_BOOTSTRAP_GITIGNORE_BLOCK = [
  '# Bundle Drop: commit the public trust bootstrap; ignore generated runtime artifacts.',
  '!.bundle-drop/',
  '.bundle-drop/*',
  RUNTIME_DELIVERY_BOOTSTRAP_GITIGNORE_MARKER,
].join('\n');

export type RuntimeDeliveryPublicKey = {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
};

export type RuntimeDeliveryConfig = {
  manifestBaseUrl: string;
  manifestAccessId: string;
  publicKeys: Record<string, RuntimeDeliveryPublicKey>;
};

export type RuntimeDeliveryProjectIdentity = {
  serverUrl: string;
  orgSlug: string;
  projectSlug: string;
  projectId?: string;
  orgId?: string;
};

export type GeneratedRuntimeDeliveryBootstrap = {
  schemaVersion: typeof RUNTIME_DELIVERY_BOOTSTRAP_SCHEMA_VERSION;
  project: RuntimeDeliveryProjectIdentity;
  runtimeDelivery: RuntimeDeliveryConfig;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeUrl = (value: string): string => value.trim().replace(/\/+$/, '');

const isP256Coordinate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').length === 32;

const normalizeHttpUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return normalizeUrl(value);
  } catch {
    return null;
  }
};

const normalizePublicKeys = (
  value: unknown,
): RuntimeDeliveryConfig['publicKeys'] | null => {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length) return null;

  const publicKeys: RuntimeDeliveryConfig['publicKeys'] = {};
  for (const [kid, candidate] of entries) {
    if (!kid.trim() || !isRecord(candidate)) return null;
    if (Object.keys(candidate).sort().join(',') !== 'crv,kty,x,y') return null;
    if (
      candidate.kty !== 'EC' ||
      candidate.crv !== 'P-256' ||
      !isP256Coordinate(candidate.x) ||
      !isP256Coordinate(candidate.y)
    ) {
      return null;
    }
    publicKeys[kid] = {
      kty: 'EC',
      crv: 'P-256',
      x: candidate.x,
      y: candidate.y,
    };
  }
  return publicKeys;
};

/**
 * Accepts the current backend-authorized trust shape and the temporary legacy
 * wire shape. Explicit legacy non-authoritative modes must never create a
 * package-managed bootstrap.
 */
export function normalizeRuntimeDeliveryBootstrap(
  value: unknown,
): RuntimeDeliveryConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode !== undefined && value.mode !== 'v2') return undefined;

  const manifestBaseUrl = normalizeHttpUrl(value.manifestBaseUrl);
  if (!manifestBaseUrl) return undefined;
  if (
    typeof value.manifestAccessId !== 'string' ||
    !/^[A-Za-z0-9_-]{22,128}$/.test(value.manifestAccessId)
  ) {
    return undefined;
  }
  const publicKeys = normalizePublicKeys(value.publicKeys);
  if (!publicKeys) return undefined;

  return {
    manifestBaseUrl,
    manifestAccessId: value.manifestAccessId,
    publicKeys,
  };
}

export function createGeneratedRuntimeDeliveryBootstrap(params: {
  identity: RuntimeDeliveryProjectIdentity;
  runtimeDelivery: unknown;
}): GeneratedRuntimeDeliveryBootstrap | undefined {
  const runtimeDelivery = normalizeRuntimeDeliveryBootstrap(params.runtimeDelivery);
  const serverUrl = normalizeHttpUrl(params.identity.serverUrl);
  const orgSlug = params.identity.orgSlug.trim();
  const projectSlug = params.identity.projectSlug.trim();
  const projectId = params.identity.projectId?.trim();
  const orgId = params.identity.orgId?.trim();
  if (!runtimeDelivery || !serverUrl || !orgSlug || !projectSlug) return undefined;
  if (Boolean(projectId) !== Boolean(orgId)) return undefined;

  return {
    schemaVersion: RUNTIME_DELIVERY_BOOTSTRAP_SCHEMA_VERSION,
    project: {
      serverUrl,
      orgSlug,
      projectSlug,
      ...(projectId && orgId ? { projectId, orgId } : {}),
    },
    runtimeDelivery,
  };
}

export function parseGeneratedRuntimeDeliveryBootstrap(
  value: unknown,
  expectedIdentity?: RuntimeDeliveryProjectIdentity,
): GeneratedRuntimeDeliveryBootstrap {
  if (!isRecord(value) || value.schemaVersion !== RUNTIME_DELIVERY_BOOTSTRAP_SCHEMA_VERSION) {
    throw new Error(
      `Runtime delivery bootstrap must use schemaVersion ${RUNTIME_DELIVERY_BOOTSTRAP_SCHEMA_VERSION}.`,
    );
  }
  if (!isRecord(value.project)) {
    throw new Error('Runtime delivery bootstrap is missing its project identity.');
  }
  const hasProjectId = Object.prototype.hasOwnProperty.call(value.project, 'projectId');
  const hasOrgId = Object.prototype.hasOwnProperty.call(value.project, 'orgId');
  if (
    hasProjectId !== hasOrgId ||
    (hasProjectId &&
      (typeof value.project.projectId !== 'string' ||
        !value.project.projectId.trim() ||
        typeof value.project.orgId !== 'string' ||
        !value.project.orgId.trim()))
  ) {
    throw new Error('Runtime delivery bootstrap contains an invalid stable project identity.');
  }

  const bootstrap = createGeneratedRuntimeDeliveryBootstrap({
    identity: {
      serverUrl: typeof value.project.serverUrl === 'string' ? value.project.serverUrl : '',
      orgSlug: typeof value.project.orgSlug === 'string' ? value.project.orgSlug : '',
      projectSlug: typeof value.project.projectSlug === 'string' ? value.project.projectSlug : '',
      projectId: typeof value.project.projectId === 'string' ? value.project.projectId : undefined,
      orgId: typeof value.project.orgId === 'string' ? value.project.orgId : undefined,
    },
    runtimeDelivery: value.runtimeDelivery,
  });
  if (!bootstrap) {
    throw new Error('Runtime delivery bootstrap contains invalid trust configuration.');
  }

  if (expectedIdentity) {
    const expected = {
      serverUrl: normalizeUrl(expectedIdentity.serverUrl),
      orgSlug: expectedIdentity.orgSlug.trim(),
      projectSlug: expectedIdentity.projectSlug.trim(),
    };
    if (
      bootstrap.project.serverUrl !== expected.serverUrl ||
      bootstrap.project.orgSlug !== expected.orgSlug ||
      bootstrap.project.projectSlug !== expected.projectSlug ||
      (expectedIdentity.projectId !== undefined &&
        bootstrap.project.projectId !== expectedIdentity.projectId.trim()) ||
      (expectedIdentity.orgId !== undefined &&
        bootstrap.project.orgId !== expectedIdentity.orgId.trim())
    ) {
      throw new Error(
        'Runtime delivery bootstrap belongs to a different server, organization, or project.',
      );
    }
  }

  return bootstrap;
}

export function runtimeDeliveryBootstrapPath(projectRoot: string): string {
  return path.join(projectRoot, RUNTIME_DELIVERY_BOOTSTRAP_PATH);
}

export function addRuntimeDeliveryBootstrapGitignoreRules(content: string): string {
  if (content.includes(RUNTIME_DELIVERY_BOOTSTRAP_GITIGNORE_MARKER)) return content;
  const prefix = content.trimEnd();
  return `${prefix}${prefix ? '\n\n' : ''}${RUNTIME_DELIVERY_BOOTSTRAP_GITIGNORE_BLOCK}\n`;
}

export function readGeneratedRuntimeDeliveryBootstrap(params: {
  projectRoot: string;
  expectedIdentity?: RuntimeDeliveryProjectIdentity;
}): GeneratedRuntimeDeliveryBootstrap | null {
  const bootstrapPath = runtimeDeliveryBootstrapPath(params.projectRoot);
  if (!fs.existsSync(bootstrapPath)) return null;

  let value: unknown;
  try {
    value = fs.readJsonSync(bootstrapPath);
  } catch {
    throw new Error(`Runtime delivery bootstrap is not valid JSON: ${bootstrapPath}`);
  }
  return parseGeneratedRuntimeDeliveryBootstrap(value, params.expectedIdentity);
}

export function serializeGeneratedRuntimeDeliveryBootstrap(
  bootstrap: GeneratedRuntimeDeliveryBootstrap,
): string {
  return `${JSON.stringify(bootstrap, null, 2)}\n`;
}

export async function writeGeneratedRuntimeDeliveryBootstrap(params: {
  projectRoot: string;
  bootstrap: GeneratedRuntimeDeliveryBootstrap;
}): Promise<string> {
  const bootstrapPath = runtimeDeliveryBootstrapPath(params.projectRoot);
  writeProjectFileAtomically(
    params.projectRoot,
    RUNTIME_DELIVERY_BOOTSTRAP_PATH,
    serializeGeneratedRuntimeDeliveryBootstrap(params.bootstrap),
  );
  return bootstrapPath;
}

export async function removeGeneratedRuntimeDeliveryBootstrap(
  projectRoot: string,
): Promise<string | null> {
  const bootstrapPath = runtimeDeliveryBootstrapPath(projectRoot);
  if (!inspectProjectFile(projectRoot, RUNTIME_DELIVERY_BOOTSTRAP_PATH).exists) return null;
  removeProjectFile(projectRoot, RUNTIME_DELIVERY_BOOTSTRAP_PATH);
  return bootstrapPath;
}

export async function ensureRuntimeDeliveryBootstrapGitignore(
  projectRoot: string,
): Promise<string> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const original = fs.existsSync(gitignorePath)
    ? await fs.readFile(gitignorePath, 'utf8')
    : '';
  const updated = addRuntimeDeliveryBootstrapGitignoreRules(original);
  if (updated !== original) {
    writeProjectFileAtomically(projectRoot, '.gitignore', updated);
  }
  return gitignorePath;
}
