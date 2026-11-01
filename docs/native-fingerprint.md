# Native fingerprinting (Beta)

Native fingerprinting derives a `bdfp1-` runtime identity from native
compatibility inputs instead of requiring a manually maintained runtime string.
Manual runtime literals remain the default; fingerprinting is an explicit opt-in.
It is currently Beta and intended to become the default in a future release.
Existing projects keep their selected compatibility mode.

## Enable it in a new native binary

In `bundle.drop.config.js`, enable fingerprint compatibility:

```js
runtimeVersion: {
  compatibilitySource: 'fingerprint',
},
```

The SDK detects the native workflow automatically. Keep configuration, installed
native dependencies and declared build context consistent between native builds
and OTA uploads.

You do not need to set `schemeVersion` in application configuration. Omitting it
permanently selects scheme 1; SDK upgrades never silently migrate that calculation.
The version remains in diagnostic reports and artifact metadata for reproducibility.

Rebuild and ship the native app after first enabling fingerprinting. Changing an
OTA configuration alone cannot give an older binary a native fingerprint.

- A compatible JavaScript/assets change keeps the runtime identity and may use OTA.
- A detected native change produces another identity automatically. An old binary
  refuses that OTA; ship a new native binary containing the native change.
- Optional `ios`/`android` strings beside the selector add manual compatibility
  boundaries. Omitted boundaries are `null`; supplied strings are trimmed.

For hybrid control, keep an explicit runtime boundary alongside fingerprinting:

```js
runtimeVersion: {
  compatibilitySource: 'fingerprint',
  ios: '1.0.0',
  android: '1.0.0',
},
```

Both the explicit boundary and detected native inputs must match. Changing either
requires a matching native binary. To return to manual compatibility, remove the
fingerprint selector/options and keep the platform runtime strings, then rebuild.

A collection error aborts build/upload calculation. It does not reuse an older
receipt or silently fall back to manual runtime mode. The embedded native identity
remains authoritative after an OTA replaces JavaScript. Fingerprinting does not
change update policies, manual apply control, revocation rules or native recovery.

## Inspect the calculation

```sh
bundle-drop fingerprint --platform android --output report.json
bundle-drop fingerprint --platform android --compare report.json --json
```

Reports contain source IDs/digests and `status: "stable"`. Earlier experimental
reports remain usable for source comparison. Report status, reasons, debug fields
and this release's descriptive text are not extra runtime-domain fields.
Source IDs and diagnostics may expose project paths; review reports before sharing.
Explicit environment values are represented by digests rather than plaintext.

## Bundle metadata and dashboard display

New artifacts explicitly include `compatibilitySource: 'manual'` or
`'fingerprint'` in their metadata. Missing configuration selectors remain manual;
legacy bundles with no mode metadata are displayed as manual without inferring
the mode from a runtime string. Explicit Expo-owned runtime resolution continues
to supply an opaque runtime and is not labeled Bundle Drop scheme-1 fingerprinting.

Fingerprint metadata retains the full derived identity, internal scheme version
and optional manual boundary. The dashboard shows that boundary in Runtime, or
Automatic when no boundary was declared, and a separate compact Fingerprint
column with the full value available to inspect and copy. Manual Runtime values
remain literal. Scheme versions are diagnostic metadata, not a dashboard column.

The authoritative `runtimeVersion` remains the complete existing identity in
manifests, uploads, native checks and patch lanes. Display metadata never changes
compatibility or permits cross-runtime patches. It is included in the canonical
file manifest and changes artifact hashes as ordinary metadata bytes do; it does
not change the frozen native fingerprint calculation. The backend must support
these metadata fields before the dashboard can display them for new uploads.

Optional `buildNumber` metadata records Android `versionCode` or iOS
`CFBundleVersion`, displayed as `1.0.0 (122132)`. Expo uses the resolved build
identity, including official versions from an existing local/EAS receipt when
applicable. Bare uploads read recognized literal values from the selected Gradle
file or `--plist-file`; the standard Xcode build variable is resolved only when
the project/settings agree. Flavor-dependent or computed values stay unknown.
Custom bare build systems can explicitly pass `--build-number 122132`. An Expo
override must equal its resolved identity. This field describes export context;
it is not proof that every compatible device has that build number, and never
narrows runtime or patch matching. Old bundles remain version-only.

## Frozen calculation contract

Version 0.11.0 revises the pre-release scheme 1 baseline to use patched minimatch
11.0.3 and glob 14.0.3. Some ignore-pattern matches differ from earlier Beta
previews. Rebuild existing Beta apps and generate their updates with the same
SDK version and dependency lock. Earlier preview calculators and this release
are not interchangeable, even though both use the `bdfp1-` prefix.

The complete executable baseline is
`third_party/expo-fingerprint/scheme-1-contract.json`. It pins the first-party
collector, selector, process adapters, normalization, complete maintained Expo
adaptation and supporting helpers, generated package files, build configuration,
production dependency declarations and repository dependency lock. The original
Expo implementation is `@expo/fingerprint` 0.21.5 at commit
`d7a68affbace544d36250aa6bdb06e34bda9e8ea`; its notices/provenance ship with the SDK.

Scheme 1 uses physical checkout roots, SHA-256, strict collection, one selected
platform, file-based native-module/config-plugin sources and the fixed options in
`src/fingerprint/collect.ts`. Source ordering/deduplication and individual source
hashing follow the pinned adaptation. Required applicable discovery fails closed.
The source native hash is wrapped as follows, with this exact property order:

```js
'bdfp1-' + sha256Utf8(JSON.stringify({
  domain: 'bundle-drop-native-fingerprint',
  schemeVersion: 1,
  platform, // 'ios' or 'android'
  manualBoundary, // trimmed explicit string or null
  nativeHash,
}))
```

An omitted `schemeVersion` permanently selects scheme 1. Unsupported schemes fail
closed. A future change to input selection, normalization, options, ordering,
hashing, environment handling, helper behavior or dependencies that changes
identities for unchanged supported inputs requires a new scheme and retained
scheme-1 support. Do not rewrite old vectors to bless calculation drift. Byte-only
maintenance must demonstrate unchanged behavior before updating a reviewed pin.
There is no automatic baseline-update command.

`yarn fingerprint:check` checks both source and packaged helper inventories/hashes
and the dependency lock; it is included in `verify:quick`/`verify:release`.
Tarball inspection independently checks the shipped helper hashes and dependency
declarations. `src/tests/fingerprint/scheme-1-golden.json` retains the original
Android vector and Android/iOS mutation/boundary vectors.
Consumer projects must retain their own dependency lock and matching toolchain;
this release baseline does not make every consumer's transitive dependency
resolution or arbitrary external tool identical. Existing application locks
must also refresh Axios's `follow-redirects` resolution to 1.16.2 or newer for
GHSA-8r9p-f939-6h3c, GHSA-q3jh-wrc6-jgq8 and GHSA-mrwp-f3q8-3g9p.
A library's root Yarn resolutions do not override every consumer's existing lock.
The transport patch leaves all scheme-1 calculation helper bytes/goldens unchanged.

## Inputs and stability

Inherited Expo discovery includes native directories, autolinked packages, package
scripts, evaluated Expo config and config-plugin files. In CNG mode generated
native directories are excluded; express native changes through config/plugins
or explicit sources. `.fingerprintignore` remains effective. Reducing coverage
through ignores is the application's responsibility; keep ignore rules identical
between build and upload checkouts.

Bundle Drop adds explicit selection/boundaries, native embedding and authority,
extra inputs, domain hashing and generated-output exclusions. It excludes generated
Bundle Drop identities/artifacts, runtime-delivery metadata, local SDK paths,
debug keystores, output metadata and Android/Kotlin compiler session directories.
The exact exclusions are pinned, including inherited Expo defaults.

Android build-number normalization supports only recognized integer literal
`versionCode 1` / `versionCode = 1` statements in known `defaultConfig` and
`productFlavors` scopes. Bare iOS normalization supports numeric literal
`CURRENT_PROJECT_VERSION` in Xcode `buildSettings` dictionaries. Computed values,
ambiguous syntax, conditional keys, comments and other fields retain their bytes.
No arbitrary Gradle, Xcode script or plist interpretation is attempted.

## Build context and explicit inputs

Selecting a different existing Android flavor or Xcode configuration may leave
source files unchanged. Declare native context explicitly when it matters:

```js
fingerprint: {
  extraSources: [
    { id: 'variant', type: 'environment', value: 'APP_NATIVE_VARIANT', platforms: ['android'] },
    { id: 'configuration', type: 'environment', value: 'CONFIGURATION', platforms: ['ios'] },
    { id: 'native-settings', type: 'file', value: 'native/settings.json' },
  ],
},
```

Use the same values during the actual native build and independent upload.
Bind the Android context to the selected build task. Xcode exports `CONFIGURATION`
during builds; supply it to standalone calculation and relevant Pod installation.
Missing required values fail calculation. `file`, `dir` and `environment` extra
sources are supported; optional absence is itself a hashed input.

## Coverage and limitations

- React Native core is inherited package-name/version identity. An in-place core
  patch needs an explicit input; it is not universally detected automatically.
- Other autolinked packages can contribute whole package trees. Tooling/JS-only
  package changes may therefore conservatively create incompatibility.
- Resolved Gradle artifact digests, installed CocoaPods/SwiftPM contents, arbitrary
  compiler settings and disposable CNG projections are not added by scheme 1.
- Dependencies that modify their own native files during builds require the same
  persistent patch in both checkouts. The upload collector does not run Gradle
  or repair dependencies. The masked-view 0.3.2 manifest rewrite was one such case.
- Environment-dependent configuration must be reproducible. The worker uses
  development only when `NODE_ENV` is explicitly `development`, otherwise production.
- Native-module addition changes the identity within this documented coverage.
  It still requires a new store binary; fingerprinting does not deliver native code.

