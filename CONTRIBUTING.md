# Contributing to Bundle Drop

Thanks for helping improve Bundle Drop. Focused bug reports, documentation fixes,
tests, and implementation changes are welcome.

## Before You Start

- Use Node.js 20.19.4 or newer.
- Search existing issues before opening a new one.
- Report vulnerabilities privately through [SECURITY.md](SECURITY.md), not in a public issue.
- Never commit credentials, signing material, customer data, or generated auth/build receipts.

## Local Development

Install dependencies and build the package:

```bash
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
formatting or generated files. By contributing, you agree that your contribution is
licensed under this repository's ISC license.
