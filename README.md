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

`login` signs you in, creates `bundle.drop.config.js` when needed, pins the
authenticated runtime-delivery bootstrap under `.bundle-drop/`, detects Expo or
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

When Bundle Drop rotates manifest verification keys or changes the public manifest
route, refresh the pinned client-visible bootstrap explicitly:

```bash
npx bundle-drop sync
npx bundle-drop doctor
```

Apps upgrading from an inline `runtimeDelivery` block or a direct Metro alias should
remove that stale block and run `npx bundle-drop init` once to install the
package-managed Metro wrapper. Inline delivery data is ignored: the validated
generated bootstrap is the sole trust source. After that one-time migration, `sync`
is the narrow command for refreshing trust data.

The generated bootstrap is not a secret and should be committed. Setup keeps the
generated Metro wrapper, build receipts, and other transient `.bundle-drop` files
ignored while allowing `.bundle-drop/runtime-delivery.generated.json` into source
control.

### Manual setup without AI planning

You can configure Bundle Drop without sending project files to the AI setup planner.
Create `bundle.drop.config.js` with the project identity and public project API key
shown in the developer dashboard:

```js
module.exports = {
  serverUrl: 'https://api.bundledrop.app',
  defaultChannel: 'develop',
  runtimeVersion: { ios: '1.0.0', android: '1.0.0' },
  org: { slug: 'your-org' },
  project: {
    name: 'Your App',
    slug: 'your-app',
    apiKey: 'your-public-project-key',
  },
};
```

Wrap the final exported Metro config. For bare React Native:

```js
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withBundleDrop } = require('@gfean/react-native-bundle-drop/metro');

const config = mergeConfig(getDefaultConfig(__dirname), {});
module.exports = withBundleDrop(config, { projectRoot: __dirname });
```

For Expo:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withBundleDropExpo } = require('@gfean/react-native-bundle-drop/metro');

module.exports = withBundleDropExpo(getDefaultConfig(__dirname), {
  projectRoot: __dirname,
});
```

Expo projects must also add `@gfean/react-native-bundle-drop` to the app config's
`plugins` array. Bare projects must connect Bundle Drop to the Release bundle URL in
their Android and iOS entrypoints. Follow the
[manual native setup guide](https://bundledrop.app/docs/manual-setup) because the
entrypoint shape varies across React Native versions.

Finish every manual setup by authenticating, generating the public trust bootstrap,
and validating the complete integration:

```bash
npx bundle-drop login
npx bundle-drop sync
npx bundle-drop doctor
```

`sync` creates `.bundle-drop/runtime-delivery.generated.json`, recreates it if it or
the entire `.bundle-drop` directory was deleted, and repairs the corresponding
`.gitignore` rules. The bootstrap contains public identity and verification material,
not secrets, so commit it with the application.

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

## Managed Runtime Delivery

Runtime delivery is package-managed. `bundle.drop.config.js` stays focused on
application-owned values such as project identity, channel, runtime versions, and
rollback policy; it does not contain manifest hosts, access routes, public keys, or
a delivery-mode switch.

`bundle-drop login` and `bundle-drop init` synchronize the trust bootstrap during
setup. `bundle-drop sync` performs the same narrow operation later for repair or key
rotation. Each command validates authenticated project credentials and writes the
identity-bound `.bundle-drop/runtime-delivery.generated.json`. Metro confirms that
the bootstrap belongs to the same server, organization, and project before merging
it into the runtime module. Malformed, copied, unsupported, or private-key-bearing
data is rejected.

Older apps with an inline `runtimeDelivery` block keep their ordinary project
configuration, but the inline block is ignored and should be removed during
migration. Only the identity-bound generated bootstrap can enable managed delivery.
If the server explicitly disables delivery for a project, synchronization removes a
stale bootstrap and the SDK continues through the compatible `/ota/resolve` path.

The SDK resolves a complete public lane locally. Invalid, expired, incomplete,
dynamic, unavailable, or network-failed manifests safely fall back to `/ota/resolve`.
Artifact download authorization remains API-key authenticated and uses opaque
release and artifact references rather than URLs embedded in the manifest.

Lane manifests are signed state and are not themselves the revocation clock. Every
local check also fetches a small environment-wide signed publisher lease. The SDK
verifies its key, exact manifest origin, issue time, and short absolute expiry before
it verifies or persists lane generation state. A missing, invalid, expired, or
operator-disabled lease therefore falls back to `/ota/resolve`, even when cached
manifest bytes remain cryptographically valid.

Artifact download capabilities are intentionally short-lived. If an artifact URL is
rejected with HTTP 401 or 403 during download, the SDK reauthorizes the original
signed selection once and retries only when its generation, target, transport,
artifact references, and signed hashes are unchanged. Verification, reconstruction,
and installation failures are never retried this way.

With managed delivery, install through `downloadUpdate`, or use the React hook's
`fetchBundles` and `installBundle(bundle)` list-item flow. Direct named
`installBundle(hash, url, ...)` calls are rejected because they bypass the fresh
resolve and artifact-authorization decision.

Unchanged install state is reported at most once every seven days. A current bundle
hash, app environment, or user-property change is reported immediately; successful
installs continue to use the separate idempotent installed receipt.

The manifest URL is derived from `manifestBaseUrl`, `manifestAccessId`, channel,
platform, and runtime version. `manifestAccessId` is an opaque URL-routing value,
not a signing secret. `publicKeys` contains public P-256 JWK coordinates keyed by
the manifest JWS `kid`, which permits signing-key rotation.

Pass `onRuntimeDeliveryDiagnostic` to `BundleDrop.init` to export the fast-path
signals to your metrics system. Events contain a bounded counter name, cumulative
process count, timestamp, and optional channel/reason/status metadata; they never
contain access IDs, install IDs, JWS bodies, user properties, or artifact URLs.
`getRuntimeDeliveryDiagnosticCounters()` returns a process-local snapshot. The
counter names are `manifest_hit`, `dynamic_manifest`, `origin_fallback`,
`invalid_signature`, `unknown_key`, `lane_mismatch`,
`generation_regression`, `generation_equivocation`,
`manifest_http_error`, `manifest_network_error`, `manifest_timeout`,
`manifest_too_large`, `manifest_invalid`, `manifest_stream_unavailable`,
`authority_lease_http_error`, `authority_lease_network_error`,
`authority_lease_timeout`, `authority_lease_too_large`,
`authority_lease_invalid`, `authority_lease_invalid_signature`,
`authority_lease_unknown_key`, `authority_lease_expired`,
`authority_lease_origin_mismatch`, and `authority_lease_disabled`.

Manifest responses are read incrementally and cancelled as soon as they exceed
1 MiB. A runtime without a readable response stream fails closed to `/ota/resolve`
instead of buffering an unbounded body.

Managed runtime delivery uses native SHA-256 and ES256 verification. After upgrading to
an SDK release whose `nativeVersion` includes this support (`0.5.0` or newer), run
Pods/prebuild as appropriate and ship a new native binary before enabling runtime
delivery for the project. Bundle Drop's native-version validation will reject a JavaScript/native
adapter mismatch.

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
| `onRuntimeDeliveryDiagnostic` | `(event: RuntimeDeliveryDiagnosticEvent) => void` | — | Listener for bounded runtime-delivery counter events suitable for metrics export. |

**Update actions** — `checkForUpdate`, `downloadUpdate`, `installBundle`,
`applyUpdate`, `getUpdateState`, `getInstalledBundleInfo`, `getAvailableBundles`,
`getAvailableChannels`.

**React** — `useBundleDrop()` returns live state (`status`, `isEnabled`, `isBusy`,
`channelName`, `installedInfo`, `pendingApply`, `hasBundle`, `availableChannels`)
plus update actions.

**User properties** — `setUserProperty`, `removeUserProperty`, `getUserProperties`,
`getCurrentUserProperties`, `resetUserProperties`.

**Errors** — `BundleDropError`, `isBundleDropError`.

**Runtime delivery diagnostics** — `getRuntimeDeliveryDiagnosticCounters` returns
the current process-local counter snapshot.

**Metro** — import `withBundleDropExpo` for Expo or `withBundleDrop` for bare React
Native from `@gfean/react-native-bundle-drop/metro` when configuring Metro manually.

**CLI** (`npx bundle-drop <command>`) — `login`, `logout`, `whoami`, `init`, `sync`,
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
