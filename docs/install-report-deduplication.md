# Installed receipt deduplication

The SDK keeps the fifty most recently acknowledged installed bundle hashes in
`installed-report-history.json`, under its app-private Bundle Drop directory.
This history survives deletion of current-bundle metadata during recovery to the
embedded app. Reinstalling a remembered target does not send another installed
receipt. Concurrent completions merge their history instead of overwriting it.

The ledger belongs to the current server, organization, project and install ID.
Changing that identity starts an empty history. On first use, the SDK migrates
the reported hashes from legacy bundle metadata. It does not import unscoped
legacy markers after a known identity change. This is bounded deduplication,
not unlimited history across project switches or application reinstalls.

Reporting remains best effort. An HTTP failure leaves the target eligible for
retry. A history persistence failure is logged; it must not block native safety
recovery. Android UTF-8 writes use a completed temporary file and same-directory
atomic rename, preserving the previous file when replacement fails. A malformed
older ledger resets to an empty scoped history without importing unscoped legacy
acknowledgements, so reporting can resume. A crash or disk failure after the server accepts a receipt but before
local persistence can still cause a later retry; the local ledger cannot provide
transactional exactly-once delivery across the network and device storage.

This correction changes reporting persistence only. Recovery to embedded still
clears current-bundle metadata and returns `null` from installed-info APIs.
Downloads, explicit manual apply, confirmed-revocation recovery, native crash
recovery and transport authorization retain their existing contracts.
