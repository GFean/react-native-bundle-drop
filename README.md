# Bundle Drop

[![npm version](https://img.shields.io/npm/v/%40gfean%2Freact-native-bundle-drop?color=2b7fff&label=npm)](https://www.npmjs.com/package/@gfean/react-native-bundle-drop)
[![CI](https://github.com/GFean/react-native-bundle-drop/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/GFean/react-native-bundle-drop/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-ISC-84cc16)](#license)
[![website](https://img.shields.io/badge/website-bundledrop.app-2563eb)](https://bundledrop.app)
[![docs](https://img.shields.io/badge/docs-bundledrop.app%2Fdocs-0f766e)](https://bundledrop.app/docs)
[![dashboard](https://img.shields.io/badge/dashboard-developer.bundledrop.app-111827)](https://developer.bundledrop.app)

**Ship reliable over-the-air updates to Expo and bare React Native apps.**

Bundle Drop delivers JavaScript and asset updates to compatible iOS and Android
binaries, with channel-based releases, targeted rollouts, rollback safety, and
patch-sized downloads.

[Website](https://bundledrop.app) • [Docs](https://bundledrop.app/docs) • [Dashboard](https://developer.bundledrop.app) • [Coming from CodePush?](https://bundledrop.app/codepush-alternative)

---

## Why Bundle Drop?

Shipping a JavaScript or asset fix should not always require a new native build.

| Native release workflow | With Bundle Drop |
| --- | --- |
| Rebuild the app for every JavaScript or asset change. | Publish OTA-compatible changes from your machine or CI. |
| Wait for users to install the next store version. | Compatible devices can receive an update on their next check. |
| Leave a faulty release active until another binary ships. | Stop a rollout or return to a verified bundle quickly. |

Bundle Drop only delivers updates that match the installed app's native and
runtime identity. Native changes still require a new App Store or Play Store build.

---

## Features

- **Expo and bare React Native support** — use the Expo config plugin or native
  React Native autolinking.
- **Channel-based distribution** — ship to `develop`, `production`, `beta`, or any channel you define.
- **Targeted rollouts** — stage releases and target specific cohorts with user properties.
- **Rollback safety** — every install is a verified, immutable bundle; rollback is a local pointer switch.
- **Hybrid OTA transport** — keep full-bundle integrity while supported devices download patch-sized changes.
- **Runtime gating** — updates only reach compatible native binaries.
- **Observability metadata** — bundle hashes and source maps keep crash reports attributable to the correct release.
- **CI/CD support** — upload with a Personal Access Token from any pipeline.

## Compatibility

| Surface | Supported versions |
| --- | --- |
| Expo | SDK 54, 55, 56, and 57 |
| Bare React Native | React Native 0.71 and newer |
| Platforms | iOS and Android |
| Architectures | Legacy architecture and New Architecture |
| Node.js | 20.19.4 or newer |
| React | 17 or newer |

## Installation

### Expo

Install the package with Expo's version-aware installer:

```bash
npx expo install @gfean/react-native-bundle-drop
```

Bundle Drop's setup command registers the config plugin and preserves your existing
Expo Metro configuration.

### Bare React Native

Install with your package manager:

```bash
npm install @gfean/react-native-bundle-drop
# or
yarn add @gfean/react-native-bundle-drop
```

Then install the iOS pod:

```bash
cd ios && pod install
```

React Native autolinking handles the package on both platforms. The setup command
adds the app-entry integration that allows a Release build to start an installed OTA.

## First-Time Setup

Run these commands from your app's project root:

```bash
npx bundle-drop login
npx bundle-drop doctor
```

`login` signs you in, creates `bundle.drop.config.js` when needed, detects Expo or
bare React Native, previews the integration changes, and completes setup. `doctor`
then validates configuration, runtime identity, native integration, and startup
ownership.

Run `init` when you need to review or rerun setup. You can force project detection
for unusual repository layouts:

```bash
npx bundle-drop init
npx bundle-drop init --project-type expo
npx bundle-drop init --project-type bare
```

Run `npx bundle-drop doctor` again after changing native integration, Metro, Expo
configuration, or runtime versions.

## Initialize the Runtime

Call `BundleDrop.init` once, as early as possible in the app process.

### Expo Router

Initialize in `app/_layout.tsx`, before rendering the root layout:

```tsx
import { BundleDrop } from '@gfean/react-native-bundle-drop';
import { Stack } from 'expo-router';

BundleDrop.init({
  enabled: !__DEV__,
  environment: __DEV__ ? 'development' : 'production',
  channelName: 'develop',
  policy: 'on-next-launch',
});

export default function RootLayout() {
  return <Stack />;
}
```

### Conventional React Native entrypoint

Initialize near the top of your entry file, before registering the root component:

```tsx
import { AppRegistry } from 'react-native';
import { BundleDrop } from '@gfean/react-native-bundle-drop';

import App from './App';
import { name as appName } from './app.json';

BundleDrop.init({
  enabled: !__DEV__,
  environment: __DEV__ ? 'development' : 'production',
  channelName: 'develop',
  policy: 'on-next-launch',
});

AppRegistry.registerComponent(appName, () => App);
```

## Expo Builds and Development

Bundle Drop needs its native integration in the installed app. Expo Go does not
contain that native adapter, so the SDK remains disabled there and your app can keep
using Expo Go for normal development.

Debug builds and development clients also keep Metro as the JavaScript authority;
they do not start an installed OTA bundle. Test the OTA lifecycle with a non-Debug
Release build.

For managed/CNG projects, setup can leave `ios/` and `android/` absent. The config
plugin generates the native integration during a later prebuild, `expo run:*`, or
EAS Build. Typical local Release builds are:

```bash
npx expo run:ios --configuration Release
npx expo run:android --variant release
```

For remote builds, use your normal EAS profiles:

```bash
eas build --platform ios
eas build --platform android
```

With the default literal runtime configuration, the plugin embeds the platform's
literal in the native build and Expo uploads resolve that same literal directly from
`bundle.drop.config.js`. This normal workflow does not require a build receipt.

An advanced Expo project can explicitly make its Expo runtime policy authoritative
with `runtimeVersion: { source: 'expo' }`. In that opt-in mode, uploads require an
exact receipt from the matching local native build. For a remote EAS build, create an
authenticated receipt from the completed build and pass the returned path to upload:

```bash
npx bundle-drop eas-receipt ios --build-id <eas-build-id>
npx bundle-drop upload ios --channel develop --build-receipt <receipt-path>
```

Rebuild the native app whenever the config plugin, native dependencies, permissions,
or runtime compatibility boundary changes.

### `expo-updates` startup ownership

An active `expo-updates` installation can also own native startup, so it cannot be
active in the same binary as Bundle Drop. Setup and `doctor` stop when they detect
that conflict. To migrate intentionally, review the proposed changes and run:

```bash
npx bundle-drop init --project-type expo --migrate-expo-updates
```

This removes the active `expo-updates` integration and requires a new native binary.
Do not publish a Bundle Drop update until that replacement binary has been built and
distributed.

## Runtime Versions

`bundle.drop.config.js` defines literal runtime versions shared by Expo and bare
React Native projects:

```js
module.exports = {
  // ...project configuration
  runtimeVersion: {
    ios: '1.0.0',
    android: '1.0.0',
  },
};
```

Keep a platform's literal unchanged for OTA-compatible JavaScript and asset updates.
The upload will then target binaries built with that same runtime value.

When native code or native configuration changes, bump the affected platform's
literal and build a new binary before uploading updates for that runtime. For
example, an iOS-only native change should bump `runtimeVersion.ios`; Android can keep
its existing value. This makes the compatibility boundary explicit and prevents an
update from reaching a binary that cannot run it.

## Upload an Update

With the default literal runtime configuration, Expo uploads resolve the app version
through the Expo project and the runtime through `bundle.drop.config.js`. They do not
need `--version`, `--plist-file`, or Gradle-path options:

```bash
npx bundle-drop upload ios --channel develop
npx bundle-drop upload android --channel develop
```

Bare React Native uploads specify or resolve the app version explicitly:

```bash
npx bundle-drop upload android --version 1.2.3 --channel develop
npx bundle-drop upload ios --plist-file ios/Info.plist --channel develop
```

Add `--sourcemap` to produce source maps for error tracking. In CI/CD, pass a
Personal Access Token with `--token <PAT>` instead of using an interactive login.

## Update Policies

`policy` controls what happens after Bundle Drop hydrates its local state on startup:

| Policy | Behavior |
| --- | --- |
| `manual` | Check only when you call the APIs yourself. Default. |
| `immediate` | Download and apply a new bundle right away. |
| `on-next-launch` | Stage the update now, then apply it on the next cold launch. |

`on-next-launch` is a good default for most apps: users do not see a reload in the
middle of a session, and the update is ready for the next launch.

## Driving Updates Manually

For custom update UI, use the `useBundleDrop()` hook. It subscribes to the singleton
runtime and exposes actions plus live state:

```tsx
import { Button } from 'react-native';
import { useBundleDrop } from '@gfean/react-native-bundle-drop';

function UpdateBanner() {
  const { checkLatest, downloadUpdate, applyUpdate, pendingApply, isBusy } =
    useBundleDrop();

  if (pendingApply) {
    return <Button title="Restart to update" onPress={applyUpdate} />;
  }

  return (
    <Button
      title="Check for updates"
      disabled={isBusy}
      onPress={async () => {
        await checkLatest();
        await downloadUpdate();
      }}
    />
  );
}
```

The same actions are available as standalone functions (`checkForUpdate`,
`downloadUpdate`, `applyUpdate`, `setChannel`, `reportHealthy`, and others) for use
outside React.

## Targeted Rollouts

Attach user properties to target specific cohorts when you stage a release:

```ts
import { setUserProperty } from '@gfean/react-native-bundle-drop';

await setUserProperty('plan', 'pro');
await setUserProperty('age', 33);
await setUserProperty('beta', true);
```

Property values must be strings, finite numbers, or booleans. Keys are trimmed and
must be non-empty, 128 characters or fewer, and cannot start with `$`, contain `.`,
contain a null byte, or use reserved prototype names.

## Hybrid OTA Delivery

Bundle Drop installs complete, immutable bundle folders, each identified by a
canonical `bundleHash` for the reconstructed file tree. Patch transport is a download
optimization: the SDK reconstructs the complete target folder, validates the
manifest, verifies file hashes and sizes, and only then promotes the bundle.

- The SDK supports `asset-only-v1` patch sets and advertises `xdelta3-vcdiff` when
  native xdelta support passes its probe.
- If patch transport is unavailable or fails, the SDK falls back to the signed
  full ZIP.
- Rollback remains a local pointer switch between verified bundle hashes.

The production manifest contract is `manifestVersion: 1`. `jsBundleHash` is retained
as metadata only.

## Observability

Every bundle has a unique hash, and `bundle-drop upload --sourcemap` produces source
maps so stack traces remain attributable across updates. Use
`getObservabilityContext()` to tag error reports with the running bundle:

```ts
import { getObservabilityContext } from '@gfean/react-native-bundle-drop';

const context = await getObservabilityContext();
```

This works with Sentry, Bugsnag, Datadog, and other error trackers. See the
[observability guide](https://bundledrop.app/docs/observability). Apps on
`@sentry/react-native` 7.8.x that combine Sentry's Metro wrapper with Hermes should
follow the guide's
[Sentry/Hermes OTA setup](https://bundledrop.app/docs/observability#sentry-and-hermes-ota-builds)
to keep content-derived Debug IDs from inflating binary patches.

## API Reference

Import the runtime API from `@gfean/react-native-bundle-drop`.

**Runtime controller**

| Export | Description |
| --- | --- |
| `BundleDrop.init(options)` | Initialize the runtime for the app process. |
| `BundleDrop.setChannel(name)` / `setChannel` | Change the active channel for singleton actions. |
| `BundleDrop.getChannelName()` / `getChannelName` | Read the active channel. |
| `BundleDrop.reportHealthy()` / `reportHealthy` | Mark the running OTA candidate healthy for this device. |

**`BundleDrop.init(options)`**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `environment` | `string` | Required | App environment shown in analytics, such as `production`, `staging`, or `development`. |
| `enabled` | `boolean` | `true` | When `false`, the SDK stays configured but does not check, download, or apply. |
| `channelName` | `string` | Config `defaultChannel` (`develop`) | Initial OTA channel for this process. |
| `policy` | `'manual' \| 'immediate' \| 'on-next-launch'` | `'manual'` | Startup behavior after hydration. |
| `checkOnly` | `boolean` | `false` | Startup resolves updates without downloading or applying them. |
| `onStatusUpdate` | `(status: string) => void` | — | Listener for human-readable status messages. |

**Update actions** — `checkForUpdate`, `downloadUpdate`, `installBundle`,
`applyUpdate`, `getUpdateState`, `getInstalledBundleInfo`, `getAvailableBundles`,
`getAvailableChannels`.

**React** — `useBundleDrop()` returns live state (`status`, `isEnabled`, `isBusy`,
`channelName`, `installedInfo`, `pendingApply`, `hasBundle`, `availableChannels`)
plus update actions.

**User properties** — `setUserProperty`, `removeUserProperty`, `getUserProperties`,
`getCurrentUserProperties`, `resetUserProperties`.

**Errors** — `BundleDropError`, `isBundleDropError`.

**Metro** — import `withBundleDropExpo` from
`@gfean/react-native-bundle-drop/metro` when configuring Expo Metro manually.

**CLI** (`npx bundle-drop <command>`) — `login`, `logout`, `whoami`, `init`,
`doctor`, `eas-receipt <ios|android>`, and `upload <ios|android>`.

## Good to Know

- **OTA covers JavaScript and assets, not native code.** Native modules, native
  dependency upgrades, permissions, native configuration, and React Native upgrades
  require a new store binary.
- **Follow store policies.** Use OTA delivery for changes that remain within Apple
  and Google requirements and the purpose of the reviewed app.
- **Compatibility checks are deliberate.** A device does not receive an update
  built for a different app or runtime version.
- **Release builds run installed OTAs.** Expo Go, Debug builds, and development
  clients continue to use their development JavaScript source.
- **Bundle Drop complements crash reporting.** It provides release identity and
  source-map support; it does not replace an error tracker.

## Docs and Links

- Website: [bundledrop.app](https://bundledrop.app)
- Docs: [bundledrop.app/docs](https://bundledrop.app/docs)
- Dashboard: [developer.bundledrop.app](https://developer.bundledrop.app)
- Migrating from CodePush: [bundledrop.app/codepush-alternative](https://bundledrop.app/codepush-alternative)
- Issues: [github.com/GFean/react-native-bundle-drop/issues](https://github.com/GFean/react-native-bundle-drop/issues)
- Security: [SECURITY.md](SECURITY.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)

## License

ISC
