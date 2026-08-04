# Post-visibility checklist

Complete this checklist immediately after a human changes the repository visibility.
Do not announce the repository until every applicable item passes.

## Repository protections

- [ ] Activate the `main` ruleset if private-repository enforcement was unavailable.
- [ ] Require the successful `CI / PR title`, `CI / JavaScript`, `CI / Android`, and `CI / iOS` contexts.
- [ ] Require pull requests, resolved conversations, an up-to-date branch, and linear history.
- [ ] Block force pushes and deletion of `main`.
- [ ] Activate the `v*` tag rule after the initial `v0.4.5` tag exists.

## Security features

- [ ] Enable the dependency graph.
- [ ] Enable Dependabot alerts, security updates, and grouped security updates.
- [ ] Enable secret scanning and push protection.
- [ ] Enable private vulnerability reporting and verify the link in `SECURITY.md`.
- [ ] Enable Dependency Review, let it complete successfully, then require its exact check context.
- [ ] Enable CodeQL default setup, resolve its initial findings, then require its exact clean check context.

Do not require Dependency Review or CodeQL before the feature has produced a successful check.

## Collaboration and public presentation

- [ ] Review every collaborator and grant the minimum required repository role.
- [ ] Verify and record collaborator 2FA privately; personal repositories cannot enforce an organization-wide 2FA policy.
- [ ] Verify the README, website, topics, license, community files, badges, Discussions, and issue forms as an anonymous visitor.
- [ ] Verify private security reporting without opening a public issue.
- [ ] Verify fork pull requests receive bounded CI without access to repository secrets.
- [ ] Verify the curated public history and immutable `v0.4.5` release remain intact.
