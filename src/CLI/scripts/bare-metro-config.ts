import fs from 'fs-extra';
import path from 'path';

const APPEND_SNIPPET = `
// Bundle Drop: ensure bundle.drop.config.js is resolvable from node_modules
(() => {
  const path = require('path');
  module.exports = module.exports || {};
  module.exports.resolver = module.exports.resolver || {};
  module.exports.resolver.extraNodeModules = {
    ...(module.exports.resolver.extraNodeModules || {}),
    'bundle-drop-config': path.resolve(__dirname, 'bundle.drop.config.js'),
  };
})();
`;

const NEW_METRO_TEMPLATE = `const path = require('path');
const { getDefaultConfig } = require('@react-native/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver = config.resolver || {};
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  'bundle-drop-config': path.resolve(__dirname, 'bundle.drop.config.js'),
};

module.exports = config;
`;

export type MetroConfigChange = {
  file: 'metro.config.js';
  original: string | null;
  updated: string;
  reason: string;
};

export function planBareMetroConfig(projectRoot: string): MetroConfigChange | null {
  const metroPath = path.join(projectRoot, 'metro.config.js');
  if (!fs.existsSync(metroPath)) {
    return {
      file: 'metro.config.js',
      original: null,
      updated: `${NEW_METRO_TEMPLATE.trim()}\n`,
      reason: 'Create the bare React Native Metro alias for bundle.drop.config.js.',
    };
  }

  const content = fs.readFileSync(metroPath, 'utf8');
  if (content.includes('bundle-drop-config')) return null;
  return {
    file: 'metro.config.js',
    original: content,
    updated: `${content.trim()}\n${APPEND_SNIPPET}`,
    reason: 'Add the Bundle Drop alias without replacing the existing Metro config.',
  };
}
