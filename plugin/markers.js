'use strict';

const {
  ANDROID_ENABLED_META_DATA,
  IOS_ENABLED_INFO_PLIST_KEY,
} = require('./constants');

function addIosEnabledMarker(infoPlist) {
  return {
    ...infoPlist,
    [IOS_ENABLED_INFO_PLIST_KEY]: true,
  };
}

function addAndroidEnabledMarker(androidConfig, androidManifest) {
  const mainApplication =
    androidConfig.Manifest.getMainApplicationOrThrow(androidManifest);

  androidConfig.Manifest.addMetaDataItemToMainApplication(
    mainApplication,
    ANDROID_ENABLED_META_DATA,
    'true',
  );

  return androidManifest;
}

module.exports = {
  addAndroidEnabledMarker,
  addIosEnabledMarker,
};
