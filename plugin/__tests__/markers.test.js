'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ANDROID_ENABLED_META_DATA,
  IOS_ENABLED_INFO_PLIST_KEY,
} = require('../constants');
const { addAndroidEnabledMarker, addIosEnabledMarker } = require('../markers');

test('adds the iOS marker without mutating the existing plist', () => {
  const original = { CFBundleDisplayName: 'Example' };
  const result = addIosEnabledMarker(original);

  assert.deepEqual(result, {
    CFBundleDisplayName: 'Example',
    [IOS_ENABLED_INFO_PLIST_KEY]: true,
  });
  assert.deepEqual(original, { CFBundleDisplayName: 'Example' });
});

test('adds the Android marker through stable manifest helpers', () => {
  const application = { $: { 'android:name': '.MainApplication' } };
  const manifest = { manifest: { application: [application] } };
  const calls = [];
  const androidConfig = {
    Manifest: {
      getMainApplicationOrThrow(receivedManifest) {
        assert.equal(receivedManifest, manifest);
        return application;
      },
      addMetaDataItemToMainApplication(receivedApplication, name, value) {
        calls.push([receivedApplication, name, value]);
      },
    },
  };

  assert.equal(addAndroidEnabledMarker(androidConfig, manifest), manifest);
  assert.deepEqual(calls, [
    [application, ANDROID_ENABLED_META_DATA, 'true'],
  ]);
});
