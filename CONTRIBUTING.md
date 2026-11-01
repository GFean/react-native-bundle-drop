# Contributing to Bundle Drop

Thanks for helping improve Bundle Drop. Focused bug reports, documentation fixes,
tests, and implementation changes are welcome.

## Before You Start

- Use Node.js 22.13.0 for development, matching `.nvmrc`. The package requires
  Node.js 20.19.4 or newer.
- Search existing issues before opening a new one.
- Use [GitHub Discussions](https://github.com/GFean/react-native-bundle-drop/discussions)
  for questions and early-stage ideas.
- Report vulnerabilities privately through [SECURITY.md](SECURITY.md), not in a public issue.
- Never commit credentials, signing material, customer data, or generated auth/build receipts.

Focused bug fixes, tests, and documentation improvements may be proposed directly.
Open an issue or Discussion and wait for maintainer agreement before implementing a
major feature, architectural change, breaking change, or backend-contract change.

## Local Development

Install dependencies and build the package:

```bash
nvm use
corepack yarn install
yarn build
```

Add or update focused tests with behavior changes. The main verification commands are:

```bash
yarn verify:quick
yarn verify:native
yarn verify:release
```

`verify:native` requires the local Android and iOS toolchains. Run the complete
release gate when your change affects native integration, OTA resolution, install,
apply, rollback, runtime identity, or package contents. Do not lower coverage
thresholds to make a change pass.

## Pull Requests

Keep pull requests focused and explain the user-visible behavior, compatibility
impact, and verification performed. Include tests for bug fixes and avoid unrelated
formatting or generated files.

Use a [Conventional Commit](https://www.conventionalcommits.org/) title because the
repository uses the squash-merge title as its commit message. Examples include
`fix(runtime): retain the active bundle after restart` and
`docs: clarify Expo Release build requirements`.

For changes to OTA resolution, download, apply, rollback, native integration, or
package contents, run the complete release gate. Android and iOS CI is deliberately
limited to the repository's bounded host-side native tests. Device behavior needs
separate native verification.

Do not lower coverage thresholds or weaken a failing validation gate. If a focused
change exposes an unrelated defect, report it separately instead of expanding the
pull request.

Native fingerprint scheme 1 has a frozen calculation contract and goldens; see
[the contract and limitations](docs/native-fingerprint.md). Run
`yarn fingerprint:check` after building. Never update scheme 1 vectors to accept
changed identities for unchanged inputs; introduce a new scheme while retaining
scheme 1 behavior. Dependency maintenance must demonstrate unchanged calculation
behavior before a reviewed contract pin is updated.

By contributing, you agree that your contribution is licensed under this
repository's ISC license. The project does not require a separate contributor
license agreement or Developer Certificate of Origin at this time.
