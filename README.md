# Bundle Drop — React Native and Expo OTA updates

[![npm version](https://img.shields.io/npm/v/%40gfean%2Freact-native-bundle-drop?color=2b7fff&label=npm)](https://www.npmjs.com/package/@gfean/react-native-bundle-drop)
[![CI](https://github.com/GFean/react-native-bundle-drop/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/GFean/react-native-bundle-drop/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-ISC-84cc16)](#license)
[![website](https://img.shields.io/badge/website-bundledrop.app-2563eb)](https://bundledrop.app)
[![docs](https://img.shields.io/badge/docs-bundledrop.app%2Fdocs-0f766e)](https://bundledrop.app/docs)
[![dashboard](https://img.shields.io/badge/dashboard-developer.bundledrop.app-111827)](https://developer.bundledrop.app)

**Bundle Drop is an over-the-air (OTA) update platform for Expo and bare React Native.** The SDK and CLI ship JavaScript and bundled assets to compatible iOS and Android release builds. Use channels and staged rollouts to control who receives an update, patch downloads to reduce transfer size, and bundle hashes to match crash reports to the code that ran.

[CodePush alternative](https://bundledrop.app/codepush-alternative) · [Bundle Drop Sight](https://bundledrop.app/sight)

## Quick start

| Requirement | Supported |
| --- | --- |
| Expo | SDK 54–58 |
| Bare React Native | 0.71+ |
| Platforms | iOS and Android, including legacy and New Architecture |
| Node.js | 20.19.4+ for package installation and CLI use |
| React | Match your app's React Native or Expo version. `useBundleDrop()` requires React 18+. |

### 1. Install the package

For Expo:

```bash
npx expo install @gfean/react-native-bundle-drop
```

For bare React Native:

```bash
npm install @gfean/react-native-bundle-drop

# iOS only
(cd ios && pod install)
```

### 2. Configure your project

Create an organization and project in the developer dashboard. Then run these commands from the app root:

```bash
npx bundle-drop login
npx bundle-drop doctor
```

Review the setup plan before applying it. The CLI detects Expo or bare React Native, sets up Metro and native integration, and writes the project's public runtime-delivery trust lockfile. Commit `.bundle-drop/runtime-delivery.lock.json` with the app. Run `npx bundle-drop init` to rerun setup. For custom projects or setup without AI assistance, follow the [manual setup guide](https://bundledrop.app/docs/manual-setup).

### 3. Initialize the SDK and build a release

Call `BundleDrop.init()` once near the app entry point. Put it before root registration in bare React Native or at module scope in the Expo Router root layout.

```tsx
import { BundleDrop } from '@gfean/react-native-bundle-drop';

BundleDrop.init({
  enabled: !__DEV__,
  environment: __DEV__ ? 'development' : 'production',
  channelName: 'develop',
  policy: 'on-next-launch',
});
```

Build and install a Release binary with the Bundle Drop integration before testing OTA delivery. Use your usual native Release build or EAS Build profile. Expo Go, Debug builds, and development clients use their development JavaScript source. [Expo setup and build guide](https://bundledrop.app/docs/expo)

### 4. Upload your first OTA update

Make a small JavaScript or bundled asset change so you can see the update on the device.

From an Expo app with the default runtime configuration:

```bash
npx bundle-drop upload ios --channel develop
npx bundle-drop upload android --channel develop
```

From a bare React Native app:

```bash
npx bundle-drop upload android --version 1.2.3 --channel develop
npx bundle-drop upload ios --plist-file ios/MyApp/Info.plist --channel develop
```

Use the same channel and runtime as the installed Release binary. The CLI prints the uploaded bundle's identity and archive size. For managed publishing, start a rollout in the dashboard to make the upload eligible. With the `on-next-launch` policy above, open the app to download the update, then cold launch it again after the download finishes to verify your change. [Upload options](https://bundledrop.app/docs/uploading#upload-options) · [CI/CD with a Personal Access Token](https://bundledrop.app/docs/ci-cd)

## Release controls and rollback

- **Runtime compatibility.** Keep a platform's configured `runtimeVersion` for compatible JavaScript and asset changes. For native code, dependency, permission, or configuration changes, update that platform's compatibility boundary and ship a new store binary. [Runtime versions](https://bundledrop.app/docs/runtime-version)
- **Native fingerprinting (Beta).** Opt in to derive runtime identity from native inputs. Use a matching SDK and dependency lock for the native build and its OTA uploads. [Native fingerprinting guide](https://bundledrop.app/docs/native-fingerprinting) · [Scheme 1 contract](https://github.com/GFean/react-native-bundle-drop/blob/main/docs/native-fingerprint.md)
- **Staged rollouts.** Enable managed publishing per channel to control eligibility by percentage and user properties. Pausing or narrowing a rollout stops new offers to excluded installations. When the SDK can identify a healthy running bundle as newer than the eligible release on the same channel and runtime, it keeps that bundle and returns `NOOP` with reason `CURRENT_BUNDLE_NEWER`. [Managed publishing](https://bundledrop.app/docs/managed-publishing) · [Staged rollouts](https://bundledrop.app/docs/staged-rollouts) · [Targeting](https://bundledrop.app/docs/targeted-rollout-properties)
- **Verified patch downloads.** Where a patch is available, the SDK reconstructs and verifies the complete target before staging it. A full bundle is available as a fallback where the resolve decision permits it. [Delivery guide](https://bundledrop.app/docs/uploading)
- **Native startup recovery.** Failed launches can quarantine the candidate and recover to a previously verified healthy OTA or the embedded bundle. Apps that define their own readiness boundary can use manual health reporting with `BundleDrop.reportHealthy()`. [Automatic recovery](https://bundledrop.app/docs/automatic-recovery) · [Rollback controls](https://bundledrop.app/docs/rollback)

## Update policies and React UI

| Policy | Behavior |
| --- | --- |
| `manual` (default) | The app calls the runtime APIs to check, download, and apply. |
| `on-next-launch` | Download and stage the update. The next cold launch can start it. |
| `immediate` | Download, apply, and reload as soon as a new compatible update is ready. |

Use `checkOnly` to limit ordinary startup activity to a check. Under the manual policy, a normal `downloadUpdate()` stages the bundle and `applyUpdate()` activates it. Confirmed revocations can trigger native safety recovery. [Update policies](https://bundledrop.app/docs/update-policies) · [Runtime APIs](https://bundledrop.app/docs/runtime-apis)

### Show an update overlay

Mount the overlay near the app root. `useBundleDrop().updatePhase` is `idle`, `checking`, `downloading`, or `applying`. Downloading includes verification and staging, and applying includes an active rollback. A staged bundle waiting for activation reports `idle` with `pendingApply: true`. Use `status` for display text and `isBusy` to disable controls while an operation runs.

```tsx
import { ActivityIndicator, Modal, View } from 'react-native';
import { useBundleDrop } from '@gfean/react-native-bundle-drop';

function UpdateOverlay() {
  const { updatePhase } = useBundleDrop();
  const visible = updatePhase === 'downloading' || updatePhase === 'applying';

  return (
    <Modal transparent visible={visible} onRequestClose={() => {}}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator accessibilityLabel="Updating app" />
      </View>
    </Modal>
  );
}
```

See the [`useBundleDrop()` reference](https://bundledrop.app/docs/use-bundle-drop) for update actions, installed bundle metadata, and manual controls.

## Observability and OTA source maps

For symbolicated OTA crashes, generate a source map at upload time and retain the matching bundle and result JSON. This example uses a bare Android project:

```bash
npx bundle-drop upload android --version 1.2.3 --channel develop \
  --sourcemap --artifact-dir ./build/bundledrop
```

Read the uploaded hash from `bundle-drop-result.json`. In the running app, use `getObservabilityContext()` inside your error-tracker setup to read the active bundle:

```ts
import { getObservabilityContext } from '@gfean/react-native-bundle-drop';

const { source, dist, tags } = await getObservabilityContext();
```

Attach `tags` to crash reports. For Sentry, use the same `release` and `dist` on runtime events and during the source-map upload. For a running OTA, `dist` is its bundle hash. For the embedded bundle, `source` and `dist` are both `embedded`. [Sentry, Bugsnag, and Datadog setup](https://bundledrop.app/docs/observability) · [Sentry with Hermes](https://bundledrop.app/docs/observability#sentry-and-hermes-ota-builds)

For delivery metrics, pass `onRuntimeDeliveryDiagnostic` to `BundleDrop.init()`. It reports process-local counters such as `manifest_hit` and `origin_fallback`, with bounded diagnostic details. Read a snapshot with `getRuntimeDeliveryDiagnosticCounters()`. [Diagnostic event names](https://github.com/GFean/react-native-bundle-drop/blob/main/src/runtime-delivery/diagnostics.ts)

## Bundle Drop Sight

Analyze production JavaScript bundles for Expo or bare React Native. Inspect which files and packages take space, compare the working tree with a Git baseline, and review emitted assets. Sight runs locally in your browser and works without a Bundle Drop account.

```bash
npx bundle-drop sight --platform android
npx bundle-drop sight --compare main --platform android
```

Sight uses source maps for attribution. When the project has the required runtime identity and compiler, it also measures the full Bundle Drop OTA archive. [Sight CLI and comparison guide](https://bundledrop.app/docs/react-native-bundle-analysis) · [Analyze a bundle and source map without the CLI](https://bundledrop.app/docs/react-native-bundle-analysis-without-cli)

## Existing apps and advanced setup

- **Moving from CodePush or App Center?** Follow the migration checklist for replacing native startup integration, setting up channels, and shipping the first Bundle Drop binary. [CodePush migration](https://bundledrop.app/docs/migrate-from-codepush)
- **Moving from EAS Update?** An active `expo-updates` integration and Bundle Drop both need native startup ownership. Review the changes from `npx bundle-drop init --project-type expo --migrate-expo-updates` and ship the replacement binary. [Expo migration and build options](https://bundledrop.app/docs/expo)
- **Using managed runtime delivery?** Setup writes the trust lockfile. Run `npx bundle-drop sync` after a key or route change and use `downloadUpdate()` or the hook's bundle-list install flow for authorized artifacts. The SDK uses signed manifests when it can resolve locally and falls back to the origin for dynamic or unavailable lanes. [CLI reference](https://bundledrop.app/docs/cli) · [Runtime APIs](https://bundledrop.app/docs/runtime-apis)

Found an issue? [Open a GitHub issue](https://github.com/GFean/react-native-bundle-drop/issues). Report security issues through the [security policy](https://github.com/GFean/react-native-bundle-drop/blob/main/SECURITY.md). See [Contributing](https://github.com/GFean/react-native-bundle-drop/blob/main/CONTRIBUTING.md) for local development and verification.

## License

ISC
