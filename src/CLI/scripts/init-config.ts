import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import prompts from 'prompts';

import type { ProjectType } from '../../expo';

const DOCS_PROJECT_CREATION_URL = 'https://bundledrop.app/docs/project-creation';
const DOCS_INSTALLATION_URL = 'https://bundledrop.app/docs/installation';

type Project = { name: string; slug: string; orgId: string };
type Org = { slug: string; orgId: string; name: string };
type ProjectCredentials = { projectSlug?: string; downloadApiKey?: string; downloadKeyHint?: string };

type BundleDropConfigValues = {
  projectType?: ProjectType;
  serverUrl: string;
  orgSlug: string;
  projectName: string;
  projectSlug: string;
  apiKey: string;
};

function normalizeServerUrl(url: string): string {
  return url.replace(/\/$/, '');
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
  projectSlug: string;
  authToken: string;
}): Promise<ProjectCredentials | null> {
  const baseUrl = normalizeServerUrl(params.serverUrl);
  const url = `${baseUrl}/projects/${encodeURIComponent(params.projectSlug)}/credentials`;
  try {
    const res = await axios.get<ProjectCredentials>(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${params.authToken}`,
      },
      timeout: 15000,
    });
    return res.data || null;
  } catch (err) {
    console.log(
      chalk.yellow(
        `⚠️ Failed to fetch project credentials from ${url}. Please verify login and project access.\n` +
          `If the project is not set up yet, see ${DOCS_PROJECT_CREATION_URL}`,
      ),
    );
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

  if (fs.existsSync(configPath)) {
    console.log(
      chalk.yellow(
        `ℹ️ bundle.drop.config.js already exists at ${configPath}. If this is accidental, delete it and rerun the init/login.\n` +
          `See ${DOCS_INSTALLATION_URL}`,
      ),
    );
    return {
      configPath,
      content: fs.readFileSync(configPath, 'utf8'),
      created: false,
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
  let apiKey = params.downloadApiKey || '';
  if (projectSlug && params.authToken) {
    const credentials = await fetchProjectCredentials({
      serverUrl: resolvedServerUrl,
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
    await fs.writeFile(configPath, content, 'utf8');
    console.log(chalk.green(`✅ Created bundle.drop.config.js at ${configPath}`));
  }
  return {
    configPath,
    content,
    created: !params.dryRun,
    serverUrl: resolvedServerUrl,
    orgSlug,
    projectSlug,
  };
}

export default initConfig;
