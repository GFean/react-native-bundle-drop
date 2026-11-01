# Ordinary manual rollback and safety recovery

Ordinary manual download/staging remains separate from activation, while
confirmed-revocation, crash and incompatibility recovery retain their safety behavior.

## Actual reason trace

| Source | Result | Treatment |
| --- | --- | --- |
| Backend `otaResolverService.ts`, current revoked and no safe alternative | `CURRENT_REVOKED_NO_SAFE_TARGET` or `CURRENT_REVOKED_NO_COMPATIBLE_TARGET` | Existing authoritative embedded recovery |
| Signed manifest local resolver, current revoked and no compatible target | `CURRENT_REVOKED_NO_COMPATIBLE_TARGET` | Same safety recovery |
| Managed check/artifact authorization cannot reach origin and cached verified authority confirms current revoked | `CURRENT_REVOKED_ORIGIN_UNAVAILABLE` | Same safety recovery |
| No published/compatible update, current not revoked | `NOOP`, possibly incompatible | No rollback intent |
| Other/absent `ROLLBACK` reason | Ordinary previous-or-embedded rollback | Under manual policy, stage until explicit apply |

The current backend emits only the confirmed-revocation rollback reasons above.
`SERVER_REQUESTED_ROLLBACK` is an ordinary protocol test fixture, not a newly added
backend feature or a claim about a deployed staging response.

## Observable API change

Under manual policy, `downloadUpdate()` (and bundle-list installation when its
authorization resolves an ordinary rollback) returns
`{ status: 'rollback', reason?, pendingApply: true }`. It persists a separate intent
without moving native pointers or restarting. Hook/runtime state reports pending
apply. Ordinary startup checks do not activate rollback. A persisted manual intent
is never consumed by automatic bundle application on a later startup.

`applyUpdate()` refreshes the channel decision and checks the captured channel,
runtime version and current selected hash before and after that check. If authority
changes, it clears the obsolete intent and returns
`{ status: 'blocked', reason: 'ROLLBACK_REVALIDATION_FAILED' }`. If authority is
unavailable, apply is blocked and the intent stays retryable. A completed new
download/install request supersedes the previous intent. A failed request does
not erase it. Rechecking alone does not stage or apply.

The protocol rollback has no destination hash. Staging therefore records an
intent, not a pinned fallback. At explicit apply, the existing native rollback
transaction chooses and revalidates the ledger-proven previous bundle, including
files, runtime, quarantine and known revocations. An ineligible previous bundle
falls back to embedded. It never selects an unproven arbitrary bundle. No new
native protocol, signing, fingerprint normalization or collector behavior is added.

Confirmed-revocation reasons continue to call native embedded recovery immediately,
including startup checks and explicit downloads. A refreshed ordinary intent that
becomes a confirmed-revocation decision uses that safety path. Intent cleanup
failure cannot suppress native safety recovery or its restart request. Native
crash recovery, binary/runtime compatibility checks and cold-launch revocation
protection remain independent.

The iOS embedded-reload guard ensures that
a successfully committed native rollback to embedded authorizes one reload of
the application's genuine bundled `main.jsbundle`. Missing OTA content alone
does not authorize a restart. The permit belongs to that process and ledger
revision; superseding native state invalidates it. Missing, tiny or symlinked
embedded resources are rejected. A previous destination invalidated during the
rollback transaction is reported as embedded only after that destination commits.
Ordinary manual staging/checks remain non-activating. This native fix requires
`pod install` and a rebuilt app; an OTA cannot replace the native implementation.

## Native adapter compatibility

New Architecture native constants may be exposed through getters without own
property descriptors. The JS adapter captures `startupRecoverySelectedHash` by
reading its value once, preserving the executing OTA identity even after a signed
revocation makes its downloaded path ineligible. A check still does not activate
anything; a subsequent explicit download can then retain the correct current hash
and perform the existing reason-specific safety recovery. Explicit `null` remains
embedded selection, while `undefined` identifies an older adapter.

