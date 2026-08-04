## Summary

<!-- Explain the user-visible behavior and why this change is needed. -->

Related issue or Discussion: <!-- #123 or URL -->

## Compatibility and risk

- [ ] This change is backward compatible within the documented runtime boundary.
- [ ] Breaking behavior is clearly identified in the summary and related issue.
- [ ] Resolve, download, apply, rollback, and restart behavior were reviewed when applicable.
- [ ] `nativeVersion` was reviewed for iOS native or podspec changes.
- [ ] Backend-contract changes were agreed before implementation.

## Validation

<!-- List the exact commands and scenarios you ran. -->

- [ ] Focused tests cover the behavior change.
- [ ] `yarn verify:quick` passes.
- [ ] Relevant bounded native tests pass for Android and/or iOS.
- [ ] Coverage thresholds and existing validation gates were not weakened.

## Documentation and safety

- [ ] Public documentation and examples were updated when behavior changed.
- [ ] The PR title follows Conventional Commit format.
- [ ] No credentials, signing material, customer data, private endpoints, or generated receipts are included.
- [ ] The change is focused and contains no unrelated formatting or generated files.
