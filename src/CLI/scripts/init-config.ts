import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs-extra';
import { createRequire } from 'module';
import path from 'path';
import prompts from 'prompts';

import type { ProjectType } from '../../expo';
import {
  createRuntimeDeliveryBootstrapLockfile,
  ensureRuntimeDeliveryBootstrapGitignore,
  normalizeRuntimeDeliveryBootstrap,
  readRuntimeDeliveryLockfile,
  removeAllRuntimeDeliveryBootstraps,
  removeLegacyRuntimeDeliveryBootstrap,
  runtimeDeliveryBootstrapPath,
  serializeRuntimeDeliveryBootstrapLockfile,
  writeRuntimeDeliveryBootstrapLockfile,
  type RuntimeDeliveryBootstrapLockfile,
} from '../../runtime-delivery/bootstrapConfig';
import {
  inspectProjectFile,
  writeProjectFileAtomically,
} from './safe-file-transaction';
import { assertMatchingServerOrigin, normalizeServerUrl } from '../serverUrl';

const DOCS_PROJECT_CREATION_URL = 'https://bundledrop.app/docs/project-creation';
const DOCS_INSTALLATION_URL = 'https://bundledrop.app/docs/installation';

type Project = { name: string; slug: string; orgId: string };
type Org = { slug: string; orgId: string; name: string };
type LegacyRuntimeDeliveryMode = 'v1' | 'shadow' | 'v2';
type ProjectCredentials = {
  projectId: string;
  projectSlug: string;
  orgId: string;
  orgSlug: string;
  /** Temporary compatibility field returned by older backends. */
  runtimeDeliveryMode?: LegacyRuntimeDeliveryMode;
  downloadApiKey?: string;
  downloadKeyHint?: string | null;
  runtimeDelivery?: unknown | null;
};

type BundleDropConfigValues = {
  projectType?: ProjectType;
  serverUrl: string;
  orgSlug: string;
  projectName: string;
  projectSlug: string;
  apiKey: string;
};

export { normalizeRuntimeDeliveryBootstrap } from '../../runtime-delivery/bootstrapConfig';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateProjectCredentials(
  value: unknown,
  expected: { orgSlug: string; projectSlug: string },
): ProjectCredentials {
  if (!isRecord(value)) {
    throw new Error(
      'Project credentials response is malformed. Existing local credentials were preserved.',
    );
  }

  const projectId = typeof value.projectId === 'string' ? value.projectId.trim() : '';
  const projectSlug = typeof value.projectSlug === 'string' ? value.projectSlug.trim() : '';
  const orgId = typeof value.orgId === 'string' ? value.orgId.trim() : '';
  const orgSlug = typeof value.orgSlug === 'string' ? value.orgSlug.trim() : '';
  const runtimeDeliveryMode = value.runtimeDeliveryMode;
  const downloadApiKey = value.downloadApiKey;
  const downloadKeyHint = value.downloadKeyHint;
  if (!projectId || !projectSlug || !orgId || !orgSlug) {
    throw new Error(
      'Project credentials response is missing its authoritative project identity. ' +
        'Existing local credentials were preserved.',
    );
  }
  if (
    runtimeDeliveryMode !== undefined &&
    !['v1', 'shadow', 'v2'].includes(runtimeDeliveryMode as string)
  ) {
    throw new Error(
      'Project credentials response contains an invalid legacy runtime delivery mode. ' +
        'Existing local credentials were preserved.',
    );
  }
  if (projectSlug !== expected.projectSlug || orgSlug !== expected.orgSlug) {
    throw new Error(
      `Project credentials identity mismatch: expected ${expected.orgSlug}/${expected.projectSlug}, ` +
        `received ${orgSlug}/${projectSlug}. Existing local credentials were preserved.`,
    );
  }
  if (downloadApiKey !== undefined && typeof downloadApiKey !== 'string') {
    throw new Error(
      'Project credentials response contains an invalid download key. Existing local credentials were preserved.',
    );
  }
  if (
    downloadKeyHint !== undefined &&
    downloadKeyHint !== null &&
    typeof downloadKeyHint !== 'string'
  ) {
    throw new Error(
      'Project credentials response contains an invalid download key hint. Existing local credentials were preserved.',
    );
  }

  return {
    projectId,
    projectSlug,
    orgId,
    orgSlug,
    runtimeDeliveryMode: runtimeDeliveryMode as LegacyRuntimeDeliveryMode | undefined,
    downloadApiKey: typeof downloadApiKey === 'string' ? downloadApiKey : undefined,
    downloadKeyHint:
      typeof downloadKeyHint === 'string'
        ? downloadKeyHint
        : downloadKeyHint === null
          ? null
          : undefined,
    runtimeDelivery: value.runtimeDelivery,
  };
}

function createBundleDropConfig(values: BundleDropConfigValues): string {
  const projectTypeConfig = values.projectType
    ? `  projectType: ${JSON.stringify(values.projectType)},\n`
    : '';

  return `module.exports = {
${projectTypeConfig}  serverUrl: ${JSON.stringify(values.serverUrl)},
  defaultChannel: 'develop',
  runtimeVersion: {
    ios: '1.0.0',
    android: '1.0.0',
  },
  org: {
    slug: ${JSON.stringify(values.orgSlug)},
  },
  project: {
    name: ${JSON.stringify(values.projectName)},
    slug: ${JSON.stringify(values.projectSlug)},
    apiKey: ${JSON.stringify(values.apiKey)},
  },
};
`;
}

function createRedactedBundleDropConfigPreview(
  values: Omit<BundleDropConfigValues, 'apiKey'>,
): string {
  const projectTypeConfig = values.projectType
    ? `  projectType: ${JSON.stringify(values.projectType)},\n`
    : '';

  return `module.exports = {
${projectTypeConfig}  serverUrl: ${JSON.stringify(values.serverUrl)},
  defaultChannel: 'develop',
  runtimeVersion: {
    ios: '1.0.0',
    android: '1.0.0',
  },
  org: {
    slug: ${JSON.stringify(values.orgSlug)},
  },
  project: {
    name: ${JSON.stringify(values.projectName)},
    slug: ${JSON.stringify(values.projectSlug)},
    apiKey: "<redacted>",
  },
};
`;
}

async function fetchProjectCredentials(params: {
  serverUrl: string;
  orgSlug: string;
  projectSlug: string;
  authToken: string;
}): Promise<ProjectCredentials | null> {
  const baseUrl = normalizeServerUrl(params.serverUrl);
  const url =
    `${baseUrl}/projects/${encodeURIComponent(params.projectSlug)}/credentials` +
    `?orgSlug=${encodeURIComponent(params.orgSlug)}`;
  let response: { data?: unknown };
  try {
    response = await axios.get<ProjectCredentials>(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${params.authToken}`,
      },
      timeout: 15000,
    });
  } catch (err) {
    console.log(
      chalk.yellow(
        `⚠️ Failed to fetch project credentials from ${url}. Please verify login and project access.\n` +
          `If the project is not set up yet, see ${DOCS_PROJECT_CREATION_URL}`,
      ),
    );
    return null;
  }
  return validateProjectCredentials(response.data, {
    orgSlug: params.orgSlug,
    projectSlug: params.projectSlug,
  });
}

type RuntimeDeliveryBootstrapResult = {
  bootstrapPath?: string;
  bootstrapContent?: string;
  bootstrap?: RuntimeDeliveryBootstrapLockfile;
  runtimeDeliveryAvailable?: boolean;
  bootstrapRetired?: boolean;
};

function createBootstrapResult(params: {
  projectRoot: string;
  serverUrl: string;
  orgSlug: string;
  projectSlug: string;
  credentials: ProjectCredentials | null;
}): RuntimeDeliveryBootstrapResult {
  if (!params.credentials) return {};
  const legacyMode = params.credentials.runtimeDeliveryMode;
  if (
    params.credentials.runtimeDelivery === null ||
    legacyMode === 'v1' ||
    legacyMode === 'shadow'
  ) {
    return {
      runtimeDeliveryAvailable: false,
      bootstrapRetired: true,
    };
  }
  const bootstrap = createRuntimeDeliveryBootstrapLockfile({
    identity: {
      serverUrl: params.serverUrl,
      orgSlug: params.orgSlug,
      projectSlug: params.projectSlug,
      projectId: params.credentials.projectId,
      orgId: params.credentials.orgId,
    },
    runtimeDelivery: params.credentials.runtimeDelivery,
  });
  if (!bootstrap) {
    return legacyMode === 'v2' || params.credentials.runtimeDelivery !== undefined
      ? { runtimeDeliveryAvailable: true }
      : {};
  }
  return {
    bootstrap,
    bootstrapPath: runtimeDeliveryBootstrapPath(params.projectRoot),
    bootstrapContent: serializeRuntimeDeliveryBootstrapLockfile(bootstrap),
    runtimeDeliveryAvailable: true,
  };
}

async function persistBootstrap(
  projectRoot: string,
  result: RuntimeDeliveryBootstrapResult,
): Promise<void> {
  if (result.bootstrap) {
    const bootstrapPath = await writeRuntimeDeliveryBootstrapLockfile({
      projectRoot,
      bootstrap: result.bootstrap,
    });
    const persisted = readRuntimeDeliveryLockfile({
      projectRoot,
      expectedIdentity: result.bootstrap.project,
    });
    if (
      !persisted ||
      serializeRuntimeDeliveryBootstrapLockfile(persisted) !==
        serializeRuntimeDeliveryBootstrapLockfile(result.bootstrap)
    ) {
      throw new Error(
        'Runtime delivery lockfile validation failed after writing. The legacy bootstrap was preserved.',
      );
    }
    await removeLegacyRuntimeDeliveryBootstrap(projectRoot);
    await ensureRuntimeDeliveryBootstrapGitignore(projectRoot);
    console.log(chalk.green(`✅ Synced Bundle Drop runtime delivery lockfile at ${bootstrapPath}`));
    return;
  }
  if (result.bootstrapRetired) {
    const removedPaths = await removeAllRuntimeDeliveryBootstraps(projectRoot);
    console.log(
      chalk.green(
        removedPaths.length
          ? `✅ Removed runtime delivery bootstrap files because delivery is disabled for this project: ${removedPaths.join(', ')}`
          : '✅ Runtime delivery is disabled for this project; no bootstrap file is present.',
      ),
    );
  }
}

function loadExistingConfig(configPath: string, content: string): BundleDropConfigValues | null {
  try {
    const moduleLike = { exports: {} as Record<string, unknown> };
    const localRequire = createRequire(configPath);
    const load = new Function('module', 'exports', 'require', '__dirname', '__filename', content);
    load(moduleLike, moduleLike.exports, localRequire, path.dirname(configPath), configPath);
    const config = moduleLike.exports as {
      projectType?: ProjectType;
      serverUrl?: string;
      org?: { slug?: string };
      project?: { name?: string; slug?: string; apiKey?: string };
    };
    if (!config.serverUrl || !config.org?.slug || !config.project?.slug) return null;
    return {
      projectType: config.projectType,
      serverUrl: normalizeServerUrl(config.serverUrl),
      orgSlug: config.org.slug,
      projectName: config.project.name || '',
      projectSlug: config.project.slug,
      apiKey: config.project.apiKey || '',
    };
  } catch {
    return null;
  }
}

function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  const MAX_UP = 12;
  for (let i = 0; i < MAX_UP; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export function getBundleDropConfigPath(startDir: string = process.cwd()): string {
  const projectRoot = findProjectRoot(startDir);
  return path.join(projectRoot, 'bundle.drop.config.js');
}

export function hasExistingBundleDropConfig(startDir: string = process.cwd()): boolean {
  return fs.existsSync(getBundleDropConfigPath(startDir));
}

export async function initConfig(params: {
  serverUrl: string;
  projects: Project[];
  organizations: Org[];
  downloadApiKey?: string;
  authToken?: string;
  dryRun?: boolean;
  projectType?: ProjectType;
}) {
  const configPath = getBundleDropConfigPath();
  const projectRoot = path.dirname(configPath);
  const existingConfigFile = inspectProjectFile(projectRoot, 'bundle.drop.config.js');

  if (existingConfigFile.exists) {
    const existing = loadExistingConfig(configPath, existingConfigFile.content);
    let bootstrapResult: RuntimeDeliveryBootstrapResult = {};
    if (existing && params.authToken) {
      assertMatchingServerOrigin(existing.serverUrl, params.serverUrl);
      const credentials = await fetchProjectCredentials({
        serverUrl: existing.serverUrl,
        orgSlug: existing.orgSlug,
        projectSlug: existing.projectSlug,
        authToken: params.authToken,
      });
      bootstrapResult = createBootstrapResult({
        projectRoot,
        serverUrl: existing.serverUrl,
        orgSlug: existing.orgSlug,
        projectSlug: existing.projectSlug,
        credentials,
      });
      if (!params.dryRun) await persistBootstrap(projectRoot, bootstrapResult);
    }
    console.log(
      chalk.yellow(
        `ℹ️ Preserving existing bundle.drop.config.js at ${configPath}.` +
          (bootstrapResult.bootstrap
            ? ' Runtime delivery bootstrap is ready to sync.'
            : bootstrapResult.bootstrapRetired
              ? ' Runtime delivery setup is synchronized.'
              : ` No valid runtime delivery bootstrap was returned; see ${DOCS_INSTALLATION_URL}`),
      ),
    );
    return {
      configPath,
      content: existingConfigFile.content,
      created: false,
      serverUrl: existing?.serverUrl,
      orgSlug: existing?.orgSlug,
      projectSlug: existing?.projectSlug,
      ...bootstrapResult,
    };
  }

  let orgSlug = '';
  let project: Project | null = null;

  // Org selection
  if (!params.organizations || params.organizations.length === 0) {
    console.log(
      chalk.yellow(
        `⚠️ No organizations returned; org slug will be left blank.\n` +
          `Create an organization first: ${DOCS_PROJECT_CREATION_URL}`,
      ),
    );
  } else if (params.organizations.length === 1) {
    orgSlug = params.organizations[0].slug;
  } else {
    const orgChoices = params.organizations.map(o => ({
      title: `${o.name} (${o.slug})`,
      value: o.slug,
    }));
    const { chosenOrg } = await prompts({
      type: 'select',
      name: 'chosenOrg',
      message: 'Select an organization:',
      choices: orgChoices,
    });
    orgSlug = chosenOrg || '';
    if (!orgSlug) {
      console.log(chalk.yellow('⚠️ No organization selected; org slug will be left blank.'));
    }
  }

  // Project selection
  const allProjects = params.projects || [];
  const selectedOrg = orgSlug ? params.organizations.find(o => o.slug === orgSlug) : undefined;
  const projectChoices = selectedOrg
    ? allProjects.filter(p => p.orgId === selectedOrg.orgId)
    : allProjects;

  if (!projectChoices.length) {
    console.log(
      chalk.red(
        `⚠️ No projects returned; project values will be left blank.\n` +
          `Create a project first: ${DOCS_PROJECT_CREATION_URL}`,
      ),
    );
  } else if (projectChoices.length === 1) {
    project = projectChoices[0];
  } else {
    const choices = projectChoices.map(p => ({
      title: `${p.name} (${p.slug})`,
      value: p.slug,
    }));

    const { projectSlug } = await prompts({
      type: 'select',
      name: 'projectSlug',
      message: 'Select a project to target:',
      choices,
    });

    project = projectChoices.find(p => p.slug === projectSlug) || null;
    if (!project) {
      console.log(chalk.yellow('⚠️ No project selected; project values will be left blank.'));
    }
  }

  const projectName = project?.name || '';
  const projectSlug = project?.slug || '';
  if (!orgSlug && project?.orgId) {
    const org = params.organizations.find(o => o.orgId === project.orgId);
    if (org) orgSlug = org.slug;
  }

  let resolvedServerUrl = normalizeServerUrl(params.serverUrl);
  let apiKey = params.authToken ? '' : params.downloadApiKey || '';
  let credentials: ProjectCredentials | null = null;
  if (projectSlug && params.authToken) {
    credentials = await fetchProjectCredentials({
      serverUrl: resolvedServerUrl,
      orgSlug,
      projectSlug,
      authToken: params.authToken,
    });
    if (credentials?.downloadApiKey) {
      apiKey = credentials.downloadApiKey;
    } else if (!apiKey) {
      console.log(
        chalk.yellow(
          '⚠️ No project API key returned from /projects/:projectSlug/credentials; config will be created without apiKey.\n' +
            `See ${DOCS_INSTALLATION_URL}`,
        ),
      );
    }
  } else if (projectSlug && !params.authToken && !apiKey) {
    console.log(chalk.yellow('⚠️ Missing auth token; cannot fetch project API key.'));
  }

  const configValues: BundleDropConfigValues = {
    projectType: params.projectType,
    serverUrl: resolvedServerUrl,
    orgSlug,
    projectName,
    projectSlug,
    apiKey,
  };
  const content = createBundleDropConfig(configValues);

  if (params.dryRun) {
    const previewContent = createRedactedBundleDropConfigPreview({
      projectType: params.projectType,
      serverUrl: resolvedServerUrl,
      orgSlug,
      projectName,
      projectSlug,
    });
    console.log(chalk.cyan(`Dry-run bundle.drop.config.js preview:\n${previewContent}`));
  } else {
    writeProjectFileAtomically(projectRoot, 'bundle.drop.config.js', content);
    console.log(chalk.green(`✅ Created bundle.drop.config.js at ${configPath}`));
  }
  const bootstrapResult = createBootstrapResult({
    projectRoot,
    serverUrl: resolvedServerUrl,
    orgSlug,
    projectSlug,
    credentials,
  });
  if (!params.dryRun) await persistBootstrap(projectRoot, bootstrapResult);
  return {
    configPath,
    content,
    created: !params.dryRun,
    serverUrl: resolvedServerUrl,
    orgSlug,
    projectSlug,
    ...bootstrapResult,
  };
}

export default initConfig;
