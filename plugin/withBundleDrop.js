'use strict';

const {
  AndroidConfig,
  withAndroidManifest,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const { assertExpoUpdatesDoesNotOwnStartup } = require('./expoUpdates');
const { addAndroidEnabledMarker, addIosEnabledMarker } = require('./markers');
const { ensureBundleDropBuildPhase } = require('./xcodeBuildPhase');

function withBundleDrop(config) {
  assertExpoUpdatesDoesNotOwnStartup(config);

  config = withInfoPlist(config, (modConfig) => {
    modConfig.modResults = addIosEnabledMarker(modConfig.modResults);
    return modConfig;
  });

  config = withXcodeProject(config, (modConfig) => {
    modConfig.modResults = ensureBundleDropBuildPhase(modConfig.modResults);
    return modConfig;
  });

  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = addAndroidEnabledMarker(
      AndroidConfig,
      modConfig.modResults,
    );
    return modConfig;
  });
}

module.exports = withBundleDrop;
