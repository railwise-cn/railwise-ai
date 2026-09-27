# Relay Cleanup Audit Amendment

The pre-amendment `audit-candidate-execution.mjs` SHA-256 was `a8abe88662686e9810378961ffe710237eb6723be07c966425d32356392ea97e`.

The real-relay branch previously verified successful request events but did not independently require credential cleanup. It now requires `tokenRemoved === true`, no `cleanupError`, and an absent token filesystem entry. The exact token name is derived from `relay-report-<16 lowercase hex session>.json` in the same canonical directory strictly inside the declared candidate root. A reported token path, if present, must match that exact derived path. `lstat` rejects both regular leftovers and dangling symlinks without reading token contents. This does not prove that copies of a token do not exist elsewhere; candidate settings cleanup remains separate evidence.

Two focused self-checks cover successful absence and rejection of residual entries or invalid cleanup claims. They use only newly created synthetic directories in `/private/tmp`; they do not start a relay, read official settings, call the network, or rerun earlier helper tests. The main audit records the cleanup helper hash and filesystem result. Earlier retained reports remain unchanged.

Run `node --test --test-reporter=tap relay-cleanup.test.mjs` and retain its TAP output as `relay-cleanup-selfcheck.tap`. No final-candidate success is claimed until the complete configured audit is run against actual IDs and stopped relay evidence.
