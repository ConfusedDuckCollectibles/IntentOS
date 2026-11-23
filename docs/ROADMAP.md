# Actionable roadmap

1. **Host/agent API separation — cooperative API implemented.** Immutable planner/verifier capabilities now provide scoped reads and writes, with approval/execution/provisioning retained by the host. Behavioral tests cover copied capabilities, cross-scope access and verifier inability to execute. Next: authenticated principal bindings, explicit revocation and separately designed process isolation for untrusted plugins; the current API is not a JavaScript/OS sandbox.
2. **Type and schema discipline.** Add pinned TypeScript and Node type development dependencies, strict typechecking, versioned database migrations, and CI on supported Node versions. Acceptance: fresh install and upgrade fixtures pass typecheck and recovery tests.
3. **Stronger recovery coverage.** Add subprocess contention on the same intent, disk-full/lock failures, corrupted/missing stores, and approval revocation before execution. Acceptance: no unauthorized effect, overspend, or false verification in each fault fixture.
4. **Adapter contract.** Introduce durable adapter registration/versioning, resource preconditions, tenant-namespaced idempotency keys and reconciliation for unknown outcomes. Acceptance: a second offline service independently implements the effect and read-back contract and passes common conformance tests.
5. **Approvals and budget lifecycle.** Add authenticated approvers, expiry, revocation, configurable fixed tariffs, per-intent caps, conservative reservations, and explicit operator remediation. Acceptance: concurrent stale approvals and revoked principals fail closed.
6. **Audit hardening.** Signed external checkpoints, export/redaction, retention policy, recovery manifests, and backup/restore validation. Acceptance: truncation and full-chain rewrite are detected against an independent checkpoint.
7. **Optional providers.** Explicit opt-in transports with timeout/body limits, secret injection, provider-version fixtures and separate inference budgets. Acceptance: mocked network failures cannot reach execution or silently retry billable calls; live testing requires separate authorization.
8. **Human interface.** Add a Vue 3 read-only audit/approval review UI only after authentication and exact approval semantics are implemented. Acceptance: the UI shows precise action, cost, scope and digest and cannot broaden a reviewed intent.

Keep the default path offline. Defer autonomous shell execution, broad network connectors, real payments, deployment and multi-tenant hosting until their threat models and approvals are independently reviewed.

## Implemented next slice: issue #2

The second offline connector is a non-deduplicating publishing queue with durable dispatch reservation, one conservative debit, independent read-only reconciliation, unresolved human-review state, and known-draft evidence checks. Tests cover actual process loss after commit, competing dispatchers, missing/ambiguous/stale evidence and false positives. See [queue recovery](QUEUE-RECOVERY.md). Remaining connector work: authenticated source contracts, persistent service identity, coordinated backup/restore, tenant namespace handling, and explicit operator remediation. No live connector or general exactly-once guarantee is implied.

## Storage release gate implemented

Format-1 paired store identities, a local file anchor, fail-closed schema/version checks, conservative no-dispatch legacy adoption, stopped-worker checksummed backup and new-directory restore are implemented and tested. Recovery tests retain queue uncertainty and original-adapter idempotency after restoring complete pairs. Remaining: arbitrary legacy execution-state migration, external anti-rollback witnesses, broader filesystem/power-loss testing and a live-service restore/reconciliation design. See [storage](STORAGE.md).
