#!/usr/bin/env node

import axios from 'axios';
import chalk from 'chalk';
import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import upload from './scripts/upload-cli';
import { runPostInitPrompts } from './scripts/post-init';
import type { ProjectType } from '../expo';
import { buildBundleDropLogo } from './logo';
import pkg from '../../package.json';

const logo = buildBundleDropLogo();

type StoredAuthData = {
  token?: string;
  user?: {
    email?: string;
    firstName?: string;
    lastName?: string;
  };
  projects?: unknown[];
  organizations?: unknown[];
  memberships?: unknown[];
  downloadApiKey?: string;
  serverUrl?: string;
  baseUrl?: string;
};

type CliContextResponse = {
  email?: string;
  firstName?: string;
  lastName?: string;
  projects?: unknown[];
  organizations?: unknown[];
  memberships?: unknown[];
};

const DEFAULT_SERVER_URL = 'https://api.bundledrop.app';
const DOCS_CLI_URL = 'https://bundledrop.app/docs/cli';
const DOCS_UPLOADING_URL = 'https://bundledrop.app/docs/uploading';
const DOCS_CI_CD_URL = 'https://bundledrop.app/docs/ci-cd';
const DOCS_INSTALLATION_URL = 'https://bundledrop.app/docs/installation';

const setupErrorWithManualInstallation = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\nManual installation: ${DOCS_INSTALLATION_URL}`);
};

const getTokenPath = () => path.join(os.homedir(), '.bundle-drop', 'auth.json');

const normalizeServerUrl = (url?: string) => url?.replace(/\/$/, '') || DEFAULT_SERVER_URL;

const readStoredAuthData = (): {
  tokenPath: string;
  exists: boolean;
  data: StoredAuthData | null;
  isInvalid: boolean;
} => {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return { tokenPath, exists: false, data: null, isInvalid: false };
  }

  try {
    const raw = fs.readFileSync(tokenPath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredAuthData;

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid auth payload');
    }

    return { tokenPath, exists: true, data: parsed, isInvalid: false };
  } catch {
    return { tokenPath, exists: true, data: null, isInvalid: true };
  }
};

const logInvalidAuthFile = () => {
  console.log(
    '❌ Failed to read CLI auth session. Please run `bundle-drop login` again or use --token.\n' +
      `CLI docs: ${DOCS_CLI_URL}\n` +
      `CI/CD docs: ${DOCS_CI_CD_URL}`,
  );
};

const fetchFreshAuthContext = async (params: {
  serverUrl: string;
  token: string;
}): Promise<Partial<StoredAuthData> | null> => {
  try {
    const response = await axios.get<CliContextResponse>(`${params.serverUrl}/auth/cli/context`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${params.token}`,
      },
      timeout: 15000,
    });
    const context = response.data || {};
    return {
      user:
        context.email || context.firstName || context.lastName
          ? {
              email: context.email,
              firstName: context.firstName,
              lastName: context.lastName,
            }
          : undefined,
      projects: Array.isArray(context.projects) ? context.projects : [],
      organizations: Array.isArray(context.organizations) ? context.organizations : [],
      memberships: Array.isArray(context.memberships) ? context.memberships : [],
    };
  } catch {
    console.log(chalk.yellow('⚠️ Could not refresh BundleDrop project list; using cached login context.'));
    return null;
  }
};

const writeStoredAuthData = (tokenPath: string, data: StoredAuthData) => {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(data, null, 2), 'utf8');
};

export const buildProgram = () => {
  const program = new Command();

  program
    .name('bundle-drop')
    .version(pkg.version || '0.0.0', '-v, --cli-version', 'Show CLI version');

  program.addHelpText('beforeAll', logo);

  program.addHelpText(
    'before',
    `
${chalk.magentaBright('Ship OTA Updates with Confidence\n')}
${chalk.bold.cyan('Available Commands:')}
`,
  );

  program.addHelpText(
    'afterAll',
    `
${chalk.bold.cyan('Common Usage:')}
  ${chalk.gray('bundle-drop login')}
  ${chalk.gray('bundle-drop init')}
  ${chalk.gray('bundle-drop doctor')}
  ${chalk.gray('bundle-drop doctor --project-type bare --platform android')}
  ${chalk.gray('bundle-drop upload android --version 1.2.3 --channel develop')}
  ${chalk.gray('bundle-drop upload ios --plist-file ios/Info.plist --channel develop')}
  ${chalk.gray('bundle-drop upload android --buildgradle-path android/app/build.gradle --channel develop --release-notes "Fixes"')}

${chalk.gray('Docs →')} ${chalk.underline.gray(DOCS_CLI_URL)}
${chalk.gray('Uploading →')} ${chalk.underline.gray(DOCS_UPLOADING_URL)}
${chalk.gray('CI/CD →')} ${chalk.underline.gray(DOCS_CI_CD_URL)}\n`,
  );

  program
    .command('upload <platform>')
    .option('--plist-file <path>', 'Path to Info.plist for iOS')
    .option(
      '--version <version>',
      'App version. iOS will fallback to --plist-file; Android can fallback to build.gradle when provided.'
    )
    .option('--buildgradle-path <path>', 'Optional Android build.gradle path to read versionName')
    .option('--channel <name>', 'Target channel name to associate the bundle')
    .option('--release-notes <text>', 'Release notes (max 2000 chars)')
    .option('--token <token>', 'Personal Access Token (alternative to `bundle-drop login`)')
    .option('--author <name>', 'Override the author name stored with the bundle')
    .option('--sourcemap', 'Generate source maps alongside the bundle for error tracking')
    .option('--artifact-dir <path>', 'Copy bundle, source map, and result JSON to this directory before cleanup')
    .option('--build-receipt <path>', 'Exact local/EAS Expo build identity receipt')
    .description(chalk.whiteBright('Bundle and upload an OTA zip to the server'))
    .addHelpText(
      'after',
      `
${chalk.bold('Examples:')}
  ${chalk.gray('bundle-drop upload android --version 1.2.3 --channel develop')}
  ${chalk.gray('bundle-drop upload ios --plist-file ios/Info.plist --channel develop')}
  ${chalk.gray('bundle-drop upload android --buildgradle-path android/app/build.gradle --channel beta --release-notes "Bug fixes"')}
  ${chalk.gray('bundle-drop upload android --version 1.2.3 --channel develop --token bdp_pat_xxx')}
  ${chalk.gray('bundle-drop upload android --version 1.2.3 --channel develop --sourcemap --artifact-dir ./build/bundledrop')}

${chalk.gray('Uploading docs →')} ${chalk.underline.gray(DOCS_UPLOADING_URL)}
${chalk.gray('CI/CD docs →')} ${chalk.underline.gray(DOCS_CI_CD_URL)}
`,
    )
    .action(upload);

  program
    .command('logout')
    .description('Log out of the CLI')
    .action(() => {
      const tokenPath = getTokenPath();

      if (fs.existsSync(tokenPath)) {
        fs.unlinkSync(tokenPath);
        console.log('🚪 Logged out.');
      } else {
        console.log('ℹ️ Not logged in.');
      }
    });

  program
    .command('login')
    .description('Log in to the CLI')
    .action(() => require('../CLI/scripts/login-cli').default());

  program
    .command('init')
    .option('--token <token>', 'Personal Access Token (alternative to `bundle-drop login`)')
    .option('--project-type <type>', 'Force project type: expo or bare')
    .option('--dry-run', 'Preview setup and AI context without changing files')
    .option('--migrate-expo-updates', 'Explicitly remove active expo-updates configuration and dependency')
    .option('--prebuild', 'Run a layered Expo prebuild for committed native directories')
    .option('--yes', 'Approve ordinary setup changes noninteractively')
    .description('Configure Bundle Drop for Expo or bare React Native')
    .action(async (options: {
      token?: string;
      projectType?: ProjectType;
      dryRun?: boolean;
      migrateExpoUpdates?: boolean;
      prebuild?: boolean;
      yes?: boolean;
    }) => {
      try {
        if (options.projectType && !['expo', 'bare'].includes(options.projectType)) {
          throw new Error('--project-type must be expo or bare.');
        }
        if (options.token) {
          const { detectProjectType } = require('../expo');
          const projectType = detectProjectType({
            projectRoot: process.cwd(),
            explicitType: options.projectType,
          });
          const serverUrl = normalizeServerUrl(process.env.BUNDLE_DROP_SERVER_URL);
          const tokenContext = await fetchFreshAuthContext({
            serverUrl,
            token: options.token,
          });
          const initConfigModule = require('../CLI/scripts/init-config');
          const hadConfig = initConfigModule.hasExistingBundleDropConfig();
          const configResult = await initConfigModule.initConfig({
            serverUrl,
            projects: tokenContext?.projects || [],
            organizations: tokenContext?.organizations || [],
            downloadApiKey: '',
            authToken: options.token,
            dryRun: true,
            projectType,
          });

          await runPostInitPrompts({
            ...options,
            projectType,
            ...(
              !hadConfig && configResult
                ? {
                    virtualConfig: {
                      content: configResult.content,
                      serverUrl: configResult.serverUrl,
                      orgSlug: configResult.orgSlug,
                      projectSlug: configResult.projectSlug,
                      authToken: options.token,
                    },
                  }
                : {}
            ),
          });
          return;
        }

        const authState = readStoredAuthData();
        if (!authState.exists) {
          console.log(
            'ℹ️ Not logged in. Please run `bundle-drop login` or use --token.\n' +
              `CLI docs: ${DOCS_CLI_URL}\n` +
              `CI/CD docs: ${DOCS_CI_CD_URL}`,
          );
          return;
        }

        if (authState.isInvalid || !authState.data) {
          logInvalidAuthFile();
          return;
        }

        const data = authState.data;
        if (!data.token) {
          logInvalidAuthFile();
          return;
        }

        const { detectProjectType } = require('../expo');
        const projectType = detectProjectType({
          projectRoot: process.cwd(),
          explicitType: options.projectType,
        });

        const serverUrl = normalizeServerUrl(
          data.serverUrl || data.baseUrl || process.env.BUNDLE_DROP_SERVER_URL
        );
        const freshContext = await fetchFreshAuthContext({
          serverUrl,
          token: data.token,
        });
        const initData = freshContext ? { ...data, ...freshContext } : data;
        if (freshContext) {
          writeStoredAuthData(authState.tokenPath, initData);
        }

        const initConfigModule = require('../CLI/scripts/init-config');
        const hadConfig = initConfigModule.hasExistingBundleDropConfig();
        const configResult = await initConfigModule.initConfig({
          serverUrl,
          projects: initData.projects || [],
          organizations: initData.organizations || [],
          downloadApiKey: data.downloadApiKey || '',
          authToken: data.token,
          dryRun: true,
          projectType,
        });

        await runPostInitPrompts({
          ...options,
          projectType,
          ...(
            !hadConfig && configResult
              ? {
                  virtualConfig: {
                    content: configResult.content,
                    serverUrl: configResult.serverUrl,
                    orgSlug: configResult.orgSlug,
                    projectSlug: configResult.projectSlug,
                    authToken: data.token,
                  },
                }
              : {}
          ),
        });
      } catch (error) {
        throw setupErrorWithManualInstallation(error);
      }
    });

  program
    .command('doctor')
    .option('--platform <platform>', 'Limit checks to ios or android')
    .option('--project-type <type>', 'Force project type: expo or bare')
    .description('Validate Bundle Drop setup, runtime identity, and OTA startup ownership')
    .addHelpText(
      'after',
      `
${chalk.bold('Examples:')}
  ${chalk.gray('bundle-drop doctor')}
  ${chalk.gray('bundle-drop doctor --platform ios')}
  ${chalk.gray('bundle-drop doctor --project-type bare --platform android')}
`,
    )
    .action(async (options: { platform?: 'ios' | 'android'; projectType?: ProjectType }) => {
      if (options.platform && !['ios', 'android'].includes(options.platform)) {
        throw new Error('--platform must be ios or android.');
      }
      if (options.projectType && !['expo', 'bare'].includes(options.projectType)) {
        throw new Error('--project-type must be expo or bare.');
      }
      await require('./scripts/doctor').runDoctor(options);
    });

  program
    .command('eas-receipt <platform>')
    .requiredOption('--build-id <id>', 'Exact finished EAS application build ID')
    .option('--output <path>', 'Receipt path; defaults under .bundle-drop')
    .description('Create an authenticated Expo build receipt from official EAS metadata')
    .action(async (
      platform: string,
      options: { buildId: string; output?: string },
    ) => {
      if (platform !== 'ios' && platform !== 'android') {
        throw new Error('eas-receipt platform must be ios or android.');
      }
      const receiptPath = await require('./scripts/expo/write-eas-build-receipt')
        .writeEasBuildReceipt({
          projectRoot: process.cwd(),
          platform,
          easBuildId: options.buildId,
          outputPath: options.output,
        });
      console.log(chalk.green(`EAS build receipt written to ${receiptPath}`));
    });

  program
    .command('whoami')
    .description('Show currently logged in user')
    .action(() => {
      const authState = readStoredAuthData();

      if (!authState.exists) {
        console.log('ℹ️ Not logged in.');
        return;
      }

      const user = authState.data?.user;
      if (
        authState.isInvalid ||
        !user ||
        !user.firstName ||
        !user.lastName ||
        !user.email
      ) {
        logInvalidAuthFile();
        return;
      }

      console.log(
        `👤 Logged in as: ${chalk.cyan(`${user.firstName} ${user.lastName}`)} <${user.email}>`
      );
    });

  return program;
};

if (require.main === module) {
  buildProgram().parse();
}
