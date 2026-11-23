# Finite approval lifetimes and revocation

Approvals authorize a **first durable dispatch claim**, not unlimited future action. This is a trusted local-operator feature: it adds no network identity, login, remote clock or isolation from malicious Node/OS code.

## Operator commands and API

```sh
node src/cli.ts propose .intentos/manual task1 'Draft release notes'
# Review the exact payload, cost and digest; then copy the displayed digest.
HASH='paste-the-displayed-hash-here'
node src/cli.ts approve .intentos/manual task1 "$HASH" 60
# Before a dispatch claim, this prevents execution:
node src/cli.ts revoke .intentos/manual task1 "$HASH"
node src/cli.ts execute .intentos/manual task1  # nonzero: Approval revoked
```

CLI lifetime is in seconds. Omit it for **five minutes**. Host API lifetimes are integer milliseconds, from 1 through 86,400,000 (24 hours). Zero, fractional milliseconds, infinity, overflow and longer lifetimes are refused. The trusted operator chooses the lifetime; planner/verifier agents cannot approve, extend or revoke it.

```ts
const host = new IntentHost(runtimePath, servicePath, 12, {
  approvalLifetimeMs: 300_000, // optional default
  clock: Date.now            // optional trusted host clock, milliseconds since epoch
});
const operator = host.operator('local-operator', 'demo/');
operator.decide(id, exactHash, true, 60_000);
operator.revoke(id, exactHash);
```

The host-side `Runtime` constructor accepts the same fourth argument. The injected clock is for deterministic tests or an independently trusted host implementation; never take it from agent proposals or untrusted requests. Defaults preserve existing demo call signatures. The runtime, approval digest and fixed execution cost remain separate from any real provider billing.

Returned immutable intent views add `approvalExpiresAt`, `approvalRevokedAt`, and `dispatchClaimedAt` as epoch milliseconds or `null`. A stored job state of `approved` records the original decision, not a promise that authorization is still live; inspect the lifetime/revocation metadata and rely on the dispatch gate. Host `inspect()` also returns `approvalTerms` and `revocations`. No new authority is exposed on planner or verifier capabilities.

## Atomic dispatch boundary

`approval_terms` binds the exact intent hash to approval time, expiry time and an initially null claim time. `approval_revocations` independently records the exact hash, operator and revocation time. Lifetime issuance, claim and revocation are audited in the runtime transaction that records them.

For **both** adapters, the transaction that changes an approved job into an execution attempt:

1. Checks the trusted clock and exact finite approval.
2. Rejects a persisted revocation or a deadline where `now >= expiresAt`.
3. Records the claim timestamp.
4. Charges the shared integer budget and records the dispatch intent atomically.

A denied claim has no debit, effect or committed claim record. A budget failure rolls back the claim as well. Competing revocation and dispatch transactions serialize through SQLite: revocation committed first blocks dispatch; a dispatch claim committed first remains authorized even if revocation commits before the actual service call. **The durable claim is the boundary, not the instant bytes reach the service.** A process may have paused after its claim. Revocation cannot safely pretend that work was never dispatched.

Expiry/revocation do not undo committed claims, refund spend, cancel a service write, or erase evidence. The original adapter may finish its idempotent replay after a crash even when the approval has since expired or been revoked. The queue still never redispatches an existing attempt; its verifier may reconcile it. Revocation audit details distinguish `blocked-before-dispatch` from `already-dispatched-no-undo`. A second revocation is idempotent. Pending and denied intents cannot be revoked as though they had been approved.

For a modern intent whose approval expires or is revoked before dispatch, create a **new intent ID** and obtain new explicit approval. Reusing the same digest does not extend the lifetime or clear revocation. Review unresolved older work before creating any replacement business action.

## Trusted clock behavior

Authorization uses a host-supplied synchronous integer clock; the default is `Date.now`. A durable `approval_clock` high-water mark rejects observed backward movement, including after process restart. A denied expired dispatch still persists its observed high-water mark in the denial transaction, so moving the clock backward after that denial does not resurrect the approval. Read-only inspection and reconciliation do not need a new time-based authorization check.

This is not authenticated time or protection against a compromised administrator. The clock can stall or be wrong without a previously observed backward step; forward jumps may expire approvals early. If clock validation fails, new approvals/claims still fail closed. Exact operator revocation remains available: it uses the durable clock high-water mark if the clock moves backwards, returns an invalid value or throws. The audit marks `clockStatus: durable-high-water-fallback`; `approvalRevokedAt` then represents that logical high-water value, not a claim about current wall time. This only removes authority and never permits a new claim. A corrupt/missing durable clock record still refuses the operation. Correct the trusted host's time configuration rather than editing approval records. Audit/clock persistence still relies on the same SQLite and disk guarantees; if persistence itself fails, the operation fails and no successful authorization is claimed.

## Explicit storage upgrade and old approvals

This feature introduces **storage format 2**. Existing format-1 pairs are refused by normal startup until the operator stops all workers and upgrades:

```sh
# First preserve a complete stopped-worker backup with the previous release.
node src/storage-cli.ts upgrade-approvals ./old-state --confirm-stopped-workers
node src/storage-cli.ts check ./old-state
```

The upgrade validates the paired identities and format-1 schemas, writes an `upgrading` anchor, creates empty approval tables, upgrades both metadata versions and marks the anchor ready. Existing approval hashes, attempts, spend, effects and audit are preserved. Existing format-1 lifetime tables are refused rather than silently trusted. An interrupted upgrade remains refused; restore the pre-upgrade complete backup into a new directory, not a single file.

**No old approval receives an invented lifetime.** An old `approved` intent without a modern lifetime cannot claim dispatch. The operator may review that exact old intent again and call `approve` to record a new finite decision; this narrowly allowed legacy review is audited. Revoked legacy approvals cannot be renewed. Existing `executing`, `uncertain` or later states represent claims already committed by the prior release and retain their original recovery/reconciliation semantics. They do not need a new approval to verify historical effects.

Conservative unversioned adoption still rejects any dispatch/spend/effects. It now produces format 2 with empty lifetime tables, so even an adopted old approval needs explicit review before first dispatch. Restoring a complete format-1 backup similarly produces format 2 without authorizing old decisions. Format-2 backup/restore preserves exact expiry times, revocations, claims and clock high-water marks; it never starts a new lifetime at restore time. The backup manifest format stays 1, with `storageVersion` indicating the database format.

## Demonstration and limits

```sh
npm run demo:approvals
npm test
```

The temporary offline demo uses a deliberately synthetic trusted clock. It proves an expired approval and a withdrawn approval are blocked before dispatch, then reconciles an already-saved queue record after revocation. Machine-checkable output reports both blocks, one verified in-flight outcome, three credits spent, valid audit and no live service.

Tests cover the exact expiry boundary, valid last-millisecond claim, stale digests, role/scope failures, finite limits, backward/invalid clocks, physical restart, simultaneous revoke/execute order, process death before/after effects, queue no-resend behavior, explicit legacy review, format-1 upgrade/restore, and preservation of format-2 revocations/expiry through backup.

All prior [storage limitations](STORAGE.md) remain. In particular, restoring an **older** snapshot can restore state from before a later revocation or clock observation. Absolute expiry is retained, but there is no external revocation witness or anti-rollback authority to recover events absent from that snapshot. Do not resume a stale backup as an active controller without reconciling subsequent operator decisions and business effects. The local operator and application composition remain trusted; this is not production multi-user authentication or a sandbox.
