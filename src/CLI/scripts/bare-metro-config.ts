import { inspectProjectFile } from './safe-file-transaction';
import {
  assertCommonJsMetroConfig,
  findSingleMetroConfig,
  hasAuthoritativeMetroWrapper,
  hasExecutableMetroWrapperReference,
  newCommonJsMetroConfigFile,
} from './metro-config-authority';

const APPEND_SNIPPET = `
// Bundle Drop: merge package-managed runtime delivery bootstrap into Metro.
const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');
module.exports = withBundleDrop(module.exports || {}, { projectRoot: __dirname });
`;

const NEW_METRO_TEMPLATE = `const { getDefaultConfig } = require('@react-native/metro-config');
const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');

const config = getDefaultConfig(__dirname);
module.exports = withBundleDrop(config, { projectRoot: __dirname });
`;

export type MetroConfigChange = {
  file: string;
  original: string | null;
  updated: string;
  reason: string;
};

export function planBareMetroConfig(projectRoot: string): MetroConfigChange | null {
  const metroConfigPath = findSingleMetroConfig(projectRoot);
  if (!metroConfigPath) {
    return {
      file: newCommonJsMetroConfigFile(projectRoot),
      original: null,
      updated: `${NEW_METRO_TEMPLATE.trim()}\n`,
      reason: 'Create the bare React Native Metro wrapper for Bundle Drop.',
    };
  }

  const metroFile = inspectProjectFile(projectRoot, metroConfigPath);
  const content = metroFile.content;
  if (hasAuthoritativeMetroWrapper(content, 'withBundleDrop')) return null;
  if (hasExecutableMetroWrapperReference(content, 'withBundleDrop')) {
    throw new Error(
      `${metroConfigPath} contains a non-authoritative withBundleDrop reference. ` +
        'Remove the dead, aliased, or malformed wrapper before rerunning setup.',
    );
  }
  assertCommonJsMetroConfig(projectRoot, metroConfigPath);
  return {
    file: metroConfigPath,
    original: content,
    updated: `${content.trim()}\n${APPEND_SNIPPET}`,
    reason: content.includes('bundle-drop-config')
      ? 'Migrate the legacy Bundle Drop alias to the package-managed Metro wrapper.'
      : 'Add the Bundle Drop Metro wrapper without replacing the existing config.',
  };
}
