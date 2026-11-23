# Changelog

## 1.0.0-rc.1 — 2026-11-23

Local-first release candidate; private package, not an npm publication or final 1.0 release.

- Public typed source-checkout entry points for trusted hosts, agent contracts and offline storage maintenance.
- Scoped immutable planner/verifier capabilities; operator approval and executor authority remain with the host.
- Exact finite approvals, durable revocation, atomic debit/dispatch claims and trusted-clock high-water checks. Clock faults still permit authority-restricting revocation with an audited fallback timestamp.
- Original deduplicating simulator and a non-deduplicating publishing-queue fixture with independent reconciliation and no blind resend.
- Version-2 paired stores, conservative legacy adoption, explicit version-1 upgrade, checksummed stopped-worker backup and new-directory restore. No implicit lifetime for old approvals.
- Stable CLI usage validation, version/help output and documented exit codes; invalid commands do not create state. Unresolved recovery returns exit 1.
- Bounded SQLite busy waits applied before setup and paired reads; contention diagnostics and tests. Hosted verification of the exact RC remains a release gate.
- Pinned development dependencies/Node CI, strict typecheck, fault/restart tests, four offline demos, install/upgrade/security guides and release checklist.

### Compatibility notes

- Existing Node 24 source-checkout APIs remain available internally; public integration should use the new documented entry points.
- Runtime CLI action commands require an explicit state directory; demos retain `.intentos` default.
- Invalid CLI usage now exits 2; operational refusal/unresolved results exit 1. `status` never initializes a missing pair.
- Storage format remains 2. Older storage requires documented maintenance, not deletion/recreation.
- Linux/Node 24.22.3 is the verification target. macOS, Windows, live providers, untrusted-plugin isolation and hosted deployments are not certified.
