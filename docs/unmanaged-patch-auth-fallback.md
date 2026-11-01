# Unmanaged patch authorization fallback

Unmanaged delivery now permits one full ZIP attempt when the patch ZIP request
returns HTTP 401 or 403. Previously the SDK surfaced that response immediately.
This transport correction is independent of native fingerprinting.

The full ZIP must be explicitly supplied by the trusted resolve decision for the
same target bundle. The SDK never discovers another URL or selects another target.
Only the patch ZIP download carries this exception: a separate manifest or missing
asset denial remains a failure. Resolve and authorization API denials do not enter
the artifact fallback path.

The fallback uses the existing full-install pipeline. Manifest, file hashes,
runtime compatibility and quarantine checks still apply. A missing fallback,
denied full ZIP or failed verification fails without native activation. Successful
download follows the configured update policy; it does not grant new apply or
restart authority to manual-mode callers.

Managed delivery is unchanged: artifact capability rejection triggers at most one
reauthorization of the original signed selection. Generation, target, transport
references and signed hashes must still match. A repeated denial or changed
selection fails; this unmanaged exception never bypasses those checks.

Focused tests cover both 401 and 403, missing fallback, denied full ZIP, failed
verification, resolve/authorization denial, non-patch artifact denial, and managed
refresh bounds.
