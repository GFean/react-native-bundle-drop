# Pinned Expo fingerprint adaptation — scheme 1

- Upstream: https://github.com/expo/expo/tree/d7a68affbace544d36250aa6bdb06e34bda9e8ea/packages/%40expo/fingerprint
- Package: `@expo/fingerprint` 0.21.5, MIT.
- `upstream-files.json` records original file SHA-256 values before adaptation.
- `src/` is maintained source; `scripts/build-fingerprint.cjs` produces packaged `build/` files.

This is Bundle Drop scheme 1, not an Expo-compatible hash. Its complete calculation
contract is frozen in `scheme-1-contract.json`. Version 0.11.0 revises the
pre-release baseline for patched matching dependencies. Earlier Beta calculators
are not interchangeable; existing Beta apps must be rebuilt with matching build
and upload tooling. Subsequent calculation changes require a new scheme with
retained scheme 1 behavior.
See `docs/native-fingerprint.md` for supported inputs and validation limitations.

Adaptations:
- Node subprocess/environment adapters replace direct Expo utility dependencies.
- Expo config evaluates in the selected production/development environment rather than forcing development.
- Executed required config/autolinking collectors fail instead of returning an empty source set.
- React Native CLI resolves from the installed project; collection never installs a CLI via npx.
- Bundle Drop owns options and extra sources; `fingerprint.config.js` is not an alternate authority.
- Stable codepoint sorting replaces locale-sensitive ordering.
- The config-plugin capture ignores the JS-only `resolve-from` utility alongside
  upstream's existing tooling exclusions. An external upgraded CLI otherwise
  captures a project copy that an in-project CLI has already preloaded, producing
  different inputs for the same project. Evaluated config and actual plugin
  sources remain hashed; no native package source is removed by this correction.
- Generic calculation dependencies are exact versions in `package.json` with the
  complete resolution in `yarn.lock`. The revised pre-release baseline uses
  minimatch 11.0.3 and glob 14.0.3 for GHSA-g3hv-75wg-m249 and
  GHSA-3g3m-2fjr-6pw4. This intentionally adopts their updated matching semantics,
  including multi-globstar and empty trailing extglob behavior.

Input selection, build-number normalization, exclusions, and effective identity
construction live in the first-party `src/fingerprint/` modules and must be
versioned together with this adaptation and its supporting dependencies.

Inherited limitations remain: this slice does not resolve Gradle artifacts,
scan installed Pods/SwiftPM sources, interpret arbitrary build scripts, or
materialize CNG native projections. Name/version-only React Native identity is
not proof against an in-place React Native core patch.
