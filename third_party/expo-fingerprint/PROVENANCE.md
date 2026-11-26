# Expo fingerprint discovery adaptation

- Upstream: https://github.com/expo/expo/tree/d7a68affbace544d36250aa6bdb06e34bda9e8ea/packages/%40expo/fingerprint
- Package: `@expo/fingerprint` 0.21.5, MIT.
- `upstream-files.json` records original file SHA-256 values before adaptation.
- `src/` is maintained source; `scripts/build-fingerprint.cjs` produces packaged `build/` files.

Bundle Drop uses this adaptation to discover inputs for its own Scheme 2 runtime
identity. See `docs/native-fingerprint.md` for supported inputs and migration
guidance. The retired Scheme 1 calculator and its contract are preserved in the
`v0.13.1` release tag.

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
- Dependency declarations are in `package.json` with resolutions in `yarn.lock`.
  Compatibility tests cover the installed package and matching behavior relevant
  to Bundle Drop.

Input selection and effective identity construction live in the first-party
`src/fingerprintV2/` modules. Shared build-number normalization lives in
`src/fingerprint/`.

Inherited limitations remain: this slice does not resolve Gradle artifacts,
scan installed Pods/SwiftPM sources, interpret arbitrary build scripts, or
materialize CNG native projections. Name/version-only React Native identity is
not proof against an in-place React Native core patch.
