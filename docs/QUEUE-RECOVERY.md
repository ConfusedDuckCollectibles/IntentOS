# Uncertain outcomes: synthetic publishing queue

This is a second **offline fixture**, not a live publishing integration or a claim of wire compatibility with any service. Nothing is sent to a social network. All records, fingerprints and credits in the CLI demo are synthetic.

## Run it

```sh
npm run demo:queue
npm run demo:queue
```

The first run creates an approved pretend post, exits a child process after the service commits but before the runtime receives an acknowledgment, opens the original databases again, and reads the service through a separate read-only connection. The output is readable JSON: `state` is `verified`, `dispatchAttempts`, `serviceWrites`, and `serviceRecords` are each `1`, and `simulatedCreditsSpent` is `3`. The second run keeps those counts unchanged. `explanation` says what happened; `liveService` is always `false`. Default state is `.intentos/queue-demo/`; supply a different parent directory with `node src/cli.ts queue-demo <directory>` for a fresh fixture.

The demo's child process runs a fixed local Node fault-injection harness. It is not a shell tool available to agents. Approval is explicit fixture setup, not authenticated human consent. Existing `demo`, `propose`, `approve`, `execute`, `verify`, `recover` and `status` commands retain their original purpose. For direct inspection of this demo's state use `node src/cli.ts status .intentos/queue-demo`.

## Contract

The original `simulated.put` adapter has backend deduplication and can safely replay its original token. The queue does **not** deduplicate: two direct calls with the same operation identity create two records. Recovery therefore uses a different protocol.

### Intent and identity

A queue proposal is strict snapshot data, with no accessors or extra fields:

```ts
{
  action: 'queue.create',
  key: 'demo/shop',                    // exact destination; also determines capability scope
  assetFingerprint: 'a'.repeat(64),    // synthetic asset SHA-256-shaped fingerprint
  dueAt: '2030-01-01T12:00:00.000Z'
}
```

`queue.draft` uses the same fields plus `recordId`, a known stable service ID. The approval digest binds the ID, action, canonical payload, cost (3 credits) and policy version. `queueOperationId(destination, intentHash)` also binds the connector version `synthetic-queue/v1`. This is a stable correlation identity, **not** an idempotency key honored by the service. Never infer that an arbitrary provider can enforce it.

### Authorized dispatch

One SQLite transaction checks the executor's scope, exact approval and shared remaining budget. It inserts the unique `queue_attempts` row, charges once, records `uncertain`, and appends the dispatch-intent audit entry **before** the service write. Only the invocation that inserted this row may dispatch. Other concurrent invocations, `execute` retries and `recover` calls return the current state without sending or charging again. There is no lease expiry or automatic takeover.

The service commits its queue record and a write-log row in a separate durable transaction. A returned ID can move the intent to `applied`; it is not verification. An exception after dispatch leaves `uncertain`. A crash before the actual call also leaves `uncertain`: the runtime deliberately sacrifices automatic completion rather than risk a duplicate. Acknowledgment and the acknowledged stable record ID are stored transactionally; a later read cannot substitute another record for that ID.

### Reconciliation, not resend

`verifier.verify(id)` performs reconciliation for queue intents in `uncertain` or `applied`. `executor.recover()` only reports uncertain queue work; it does not perform verification or redispatch it. This preserves the planner/verifier/host authority boundary.

`readQueueEvidence` opens a separate read-only SQLite connection and reads source metadata and candidate records in one snapshot. The synthetic source describes whether this is a fresh authoritative view; tests can mark it stale/incomplete. These local flags are fixture mechanics, not a recipe for establishing freshness of a real service. A production connector would require a separately justified authoritative-read contract.

`assessQueueEvidence` accepts exactly one candidate with matching operation identity, intent hash, exact destination, asset fingerprint, schedule, expected status and absence of a send receipt. Draft verification additionally requires the approved stable ID. If an acknowledgment was previously received, that ID must match too. Multiple candidates are ambiguous even if one looks plausible. Wrong-destination candidate contents are not returned through the scoped intent view.

Missing, unavailable, stale, incomplete, mismatched and ambiguous reads leave `uncertain` and persist evidence with `requiresHumanReview: true`. They are never evidence that a write failed. Subsequent independent verification may resolve a temporarily unavailable source, but cannot resend. `verify` returns a nonzero CLI exit status for unresolved work. No operator override/resend API is provided in this change.

### Known draft transition

The service checks a known record's ID, destination, current asset fingerprint, retained due date and absence of a send receipt before changing `queued`/`draft` to `draft`. It leaves the asset and due date unchanged. Read-back must confirm `draft`, the unchanged asset, correct destination and stable ID, and `sent_receipt: null`. A scheduled timestamp alone is not evidence of queued or sent status. The fixture has no scheduler and never actually sends anything.

## Trust and limitations

- This is one-dispatch-per-persisted-intent within the original local runtime/service database pair, **not general exactly-once effects**. If the host creates a new intent for the same business action, it may duplicate that action. Human review must consider the old unresolved attempt before authorizing new work.
- There is no automatic retry even if the service definitely appears empty. A process that paused after reserving dispatch may still resume its first call; do not manually resend based on a missing record.
- Evidence is authoritative only within this trusted synthetic fixture. There is no cryptographic proof against an OS/database administrator, external audit anchor, distributed consensus or live read freshness guarantee.
- Preserve the original paired stores. Replacing stores, partial restore, or deleting the attempt ledger invalidates the guarantee. Format-1 identity binding and a stopped-worker complete-pair restore procedure are now implemented; see [storage](STORAGE.md). This is not hostile-host anti-rollback protection.
- Spend is conservative attempted-execution accounting and is never refunded. Queue and original simulated operations use the same budget and audit when hosted in the same runtime. The CLI demo uses its own subdirectory to keep fixture counts easy to inspect.
- `verified` records historical verification at that moment, not continuous monitoring of future service mutations. Source evidence can subsequently change. No assets are downloaded or fingerprinted by this fixture; supplied fingerprints describe synthetic assets.
- Role capabilities remain a cooperative application API, not a JavaScript/OS sandbox. The raw runtime, stores, connector and fault controls are host-only.
- Schema change is additive (`queue_attempts`); original tables, approval hashes and replay semantics remain intact. A versioned storage gate and conservative legacy adoption are now implemented; see [storage](STORAGE.md). General legacy-data migration remains unsupported.

## Verification coverage

`npm test` retains the original adapter/agent tests and adds process death before write, after commit, and before acknowledgment commit; thrown post-commit response loss; concurrent writers/retries; non-deduplicating backend behavior; unavailable/restored reads; false-positive destination/intent/asset/schedule/status/receipt evidence; missing/duplicate/stale/incomplete records; stable-ID substitution; strict proposal validation; approval/scope/budget checks; and known draft transitions. The runnable CLI demo is tested twice in separate processes with machine-checked counts.

### Store failure versus uncertain service evidence

The storage gate runs before queue execution and verification. A missing or replaced database now raises `Storage refused` and leaves the existing uncertain intent unchanged; it does not fabricate evidence or recreate the service. A stale/incomplete/mismatched record in the valid paired service still follows the normal uncertain-evidence review path.
