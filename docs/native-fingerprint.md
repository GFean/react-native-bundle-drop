# Native fingerprinting (Beta)

Native fingerprinting derives a Scheme 2 `bdfp2-` runtime identity from native
compatibility inputs. Set `compatibilitySource: 'fingerprint'` to opt in. Projects
using manual runtime literals keep their configured compatibility mode.

## Enable it in a new native binary

In `bundle.drop.config.js`, enable fingerprint compatibility:

```js
runtimeVersion: {
  compatibilitySource: 'fingerprint',
},
```

Fingerprinting defaults to Scheme 2 and also accepts an explicit `schemeVersion: 2`.
The SDK detects the native workflow
automatically. Keep configuration, installed native dependencies and declared
build context consistent between native builds and OTA uploads. The scheme
appears in diagnostic reports and artifact metadata.

Rebuild and ship the native app after first enabling fingerprinting. Devices
receive OTAs for the runtime embedded in their installed binary.

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

## Migrate from Scheme 1

Earlier SDK releases derived `bdfp1-` runtimes by default. Scheme 1 is retired in
this SDK. Remove an explicit `schemeVersion: 1` setting or change it to `2`, then
rebuild and ship the native app. Use the same SDK and lockfile for the new build
and its OTA uploads. Verify that your backend accepts Scheme 2 metadata.

To keep shipping OTAs for an installed Scheme 1 binary during the transition,
use the published `0.13.1` SDK and the original app configuration, dependency
lockfile, and native inputs. Ensure its dependency lock resolves
`follow-redirects` to `1.16.2` or later. Confirm that the calculated `bdfp1-`
runtime matches the binary before uploading. The original calculator contract
and golden vectors are available at the [`v0.13.1` tag](https://github.com/GFean/react-native-bundle-drop/tree/v0.13.1).

## Inspect the calculation

```sh
bundle-drop fingerprint --platform android --output report.json
bundle-drop fingerprint --platform android --compare report.json --json
```

Reports contain source IDs/digests and `status: "stable"`. Earlier reports remain
usable for source comparison, including Scheme 1 reports. The command calculates
the current Scheme 2 runtime and displays changes in source digests. Report status, reasons, debug fields
and this release's descriptive text are not extra runtime-domain fields.
Source IDs and diagnostics may expose project paths; review reports before sharing.
Explicit environment values are represented by digests rather than plaintext.

## Bundle metadata and dashboard display

New artifacts explicitly include `compatibilitySource: 'manual'` or
`'fingerprint'` in their metadata. Missing configuration selectors remain manual;
legacy bundles with no mode metadata are displayed as manual without inferring
the mode from a runtime string. Explicit Expo-owned runtime resolution continues
to supply an opaque runtime under its own policy.

Fingerprint metadata retains the full derived identity, internal scheme version
and optional manual boundary. The dashboard shows that boundary in Runtime, or
Automatic when no boundary was declared, and a separate compact Fingerprint
column with the full value available to inspect and copy. Manual Runtime values
remain literal. Scheme versions are diagnostic metadata, not a dashboard column.

The authoritative `runtimeVersion` remains the complete existing identity in
manifests, uploads, native checks and patch lanes. Display metadata never changes
compatibility or permits cross-runtime patches. It is included in the canonical
file manifest and changes artifact hashes as ordinary metadata bytes do. Display
metadata is independent of the native fingerprint calculation. The backend must
support these metadata fields before the dashboard can display them for new uploads.

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

## Scheme 2 inputs and stability

Scheme 2 hashes the selected platform's autolinked dependency identities and
their resolved source information from supported npm, Yarn, and pnpm locks.
For Yarn, Scheme 2 uses the installed package locator when the installer records it.
When the lock and install state cannot distinguish same-version native sources,
Scheme 2 hashes the installed package files.
Declare third-party native edits as package manager patches or patch-package files.
App-owned native source, local native packages, app codegen specs, and authored
native configuration are also inputs. React Native versions and Bundle Drop
native revisions contribute to the runtime identity.

For native iOS, Scheme 2 hashes the checked-in `Podfile.lock`. For the default
React Native prebuilt recipes that put checkout paths in CocoaPods' generated
podspecs, it uses the installed recipe and its inputs in place of those
generated checksums. The locked graph, versions, source declarations and other
checksums still contribute to the fingerprint. Declare custom generators,
environment-specific native settings and local artifact overrides with
`extraSources` when they affect compatibility.

In native workflow, use checked-in ignore rules for generated output. Use
`extraSources` for ignored files whose contents affect native compatibility,
including files already tracked in Git. Fingerprint source selection reads
checked-in ignore rules in both Git checkouts and source archives.
In Expo CNG, express changes through evaluated Expo config and config plugins or
declare the inputs explicitly. Supply custom flavor, Xcode configuration, or
environment-dependent code generation inputs wherever you calculate the
fingerprint. Native generators can run during the native build while OTA export
uses the same declared inputs from a clean checkout. Keep `.fingerprintignore`
and checked-in ignore rules identical between build and upload checkouts.

Android build-number normalization recognizes integer literal `versionCode`
statements in known `defaultConfig` and `productFlavors` scopes. Bare iOS
normalization recognizes numeric literal `CURRENT_PROJECT_VERSION` settings in
the Xcode project. Computed values, ambiguous syntax, and other native settings
retain their bytes.

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

- Registry packages normally use dependency identity and declared
  patches. Make modifications in reproducible inputs and specify custom native
  compatibility inputs under `extraSources`.
- Declare native inputs beyond the default scope explicitly, including relevant
  Gradle artifact digests, installed CocoaPods or SwiftPM contents, and arbitrary
  compiler settings. For CNG, use Expo config and plugins for native changes.
- Environment-dependent configuration must be reproducible. The worker uses
  development only when `NODE_ENV` is explicitly `development`, otherwise production.
- Native-module addition changes the identity within this documented coverage.
  It still requires a new store binary; fingerprinting does not deliver native code.

