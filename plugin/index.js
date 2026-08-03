'use strict';

const { createRunOncePlugin } = require('expo/config-plugins');
const packageJson = require('../package.json');
const withBundleDrop = require('./withBundleDrop');

module.exports = createRunOncePlugin(
  withBundleDrop,
  packageJson.name,
  packageJson.version,
);
