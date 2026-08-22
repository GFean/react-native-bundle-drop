# Changelog

All notable changes to this package are documented here.

This project uses [Conventional Commits](https://www.conventionalcommits.org/) and
[release-please](https://github.com/googleapis/release-please) to prepare releases.

## [0.6.0](https://github.com/GFean/react-native-bundle-drop/compare/v0.5.1...v0.6.0) (2026-08-22)

### Managed Runtime Delivery and Safer Project Setup

This release makes managed runtime delivery the standard Bundle Drop path, strengthens native
verification and download safety, and substantially improves automated and manual project setup.

#### Managed runtime delivery

- Added signed, identity-bound runtime manifests and publisher authority leases.
- Added local manifest resolution for public rollout decisions.
- Private user-property targeting remains securely evaluated by the Bundle Drop resolver.
- Added fresh artifact authorization before managed downloads and patch application.
- Added revocation-aware rollback and safe native-bundle recovery.
- Added bounded manifest and artifact downloads, signature verification, generation checks, and
  integrity validation.
- Added privacy-safe runtime delivery diagnostic counters.

#### Simplified configuration

- Added `bundle-drop sync` to generate or repair the public runtime trust bootstrap.
- Runtime delivery no longer requires a public mode/version flag.
- `bundle.drop.config.js` remains the project identity source and is safe to commit.
- `.bundle-drop/runtime-delivery.generated.json` contains public verification material and should
  also be committed.
- Deleting the generated bootstrap is recoverable by running `bundle-drop sync`.
- Transient `.bundle-drop/generated/*` Metro files remain ignored and are recreated automatically.

#### Safer setup and migrations

- Improved automatic Expo and bare React Native project detection.
- Added strict startup-path validation for supported Android, Swift, and Objective-C React Native
  templates.
- Improved CodePush and Expo Updates migration handling.
- Native and dynamic Expo configuration patches remain review-only.
- Added path, symlink, stale-hash, credential, and terminal-output protections.
- Ambiguous or unsupported project structures fail safely to documented manual setup.
- Expanded `bundle-drop doctor` validation and actionable diagnostics.
- Added a complete no-AI manual setup flow.

#### Metro and Expo integration

- Added package-managed Metro wrappers for bare React Native and Expo.
- Preserves supported existing Metro configuration and export flow.
- Improved Expo dynamic configuration preservation and plugin authority validation.
- Added safer dependency migration and prebuild rollback handling.

#### Native runtime

- Added native SHA-256 and ES256 verification support.
- Added bounded native download handling on Android and iOS.
- Strengthened native bundle selection, integrity checks, and rollback behavior.
- Native package revision is now `0.5.0`.

#### Upgrade instructions

1. Upgrade `@gfean/react-native-bundle-drop`.
2. If the package-managed Metro wrapper is not already installed, run:

   ```bash
   npx bundle-drop init
   ```

3. Generate or repair the public runtime trust bootstrap:

   ```bash
   npx bundle-drop sync
   ```

4. Commit `.bundle-drop/runtime-delivery.generated.json` with the project configuration.
5. Refresh CocoaPods or Expo prebuild as appropriate and ship a new native binary for native
   package revision `0.5.0`.
6. Validate the completed setup:

   ```bash
   npx bundle-drop doctor
   ```

See [#28](https://github.com/GFean/react-native-bundle-drop/pull/28) and
[`cba0725`](https://github.com/GFean/react-native-bundle-drop/commit/cba0725597a0938cdc641965735f4afb812b76a8)
for the merged implementation.

## [0.5.1](https://github.com/GFean/react-native-bundle-drop/compare/v0.5.0...v0.5.1) (2026-08-09)


### Bug Fixes

* publish verified tarballs by local path ([#26](https://github.com/GFean/react-native-bundle-drop/issues/26)) ([ca3a0f7](https://github.com/GFean/react-native-bundle-drop/commit/ca3a0f7e850e345ede3879b8247739cdc9f0de1e))

## [0.5.0](https://github.com/GFean/react-native-bundle-drop/compare/v0.4.6...v0.5.0) (2026-08-09)


### Features

* add Sight CLI ([#22](https://github.com/GFean/react-native-bundle-drop/issues/22)) ([e1218c5](https://github.com/GFean/react-native-bundle-drop/commit/e1218c5d01204a326947698c674023cc5d5951aa))

## [0.4.6](https://github.com/GFean/react-native-bundle-drop/releases/tag/v0.4.6) (2026-08-04)

- Established the first public npm release baseline for
  `@gfean/react-native-bundle-drop`.
- Added bounded JavaScript, Android, and iOS release verification.
- Added the public repository governance and dependency-maintenance baseline.
