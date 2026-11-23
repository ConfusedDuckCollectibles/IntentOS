# Versioned local stores, upgrade and offline recovery

Storage format **2** binds the runtime ledger and synthetic service database as one pair. This release refuses an unknown pair instead of silently creating a replacement service and risking a duplicate effect or misleading verification. This is a trusted-local safety check, not protection against a malicious filesystem administrator.

## Fresh start and checks

The normal `Runtime` / `IntentHost` constructor initializes a fresh pair only when both requested database paths and the pairing anchor are absent. The parent directories must exist. It initializes all runtime and service tables, including the two offline adapters; service creation is no longer deferred until the first write.

Each database stores `PRAGMA user_version=2` and a `storage_meta` row with format version, random pair ID, random store ID, peer store ID and runtime/service role. The adjacent `runtime.sqlite.pair.json` anchor binds these identities to the configured service path and each file's local device/inode identity. Keep the anchor with the databases.

Initialization durably writes an `initializing` anchor first and promotes it to `ready` only after both stores have been initialized and synchronized. An interrupted initialization is refused on subsequent open. It is not guessed to be empty or automatically repaired. Preserve the directory for review; if it was only a disposable demo, explicitly choose a new empty state directory.

Runtime construction and runtime transactions check the pairing, supported version and expected table columns. Checks are also repeated before service writes and before global inspection. Missing files, replacement files, a wrong service path, mismatched metadata, unknown versions or unexpected schema definitions stop the operation. A retained anchor prevents automatic reinitialization if both database files disappear. An already-open runtime does not silently continue through a missing/replaced file. Storage failure occurs before the operation's transaction, so a denial cannot reliably be appended to an unsafe audit store.

```sh
node src/storage-cli.ts check .intentos
```

`check` never creates missing stores. Its JSON result reports `valid` and `storageVersion`. A refusal returns a nonzero exit status and a reason. The ordinary CLI also returns nonzero on storage refusal. A queue whose service file is unavailable retains its previous uncertain state; the storage gate refuses verification and execution rather than writing new evidence into an unsafe pair. When the **original file** is restored at the original path with the same identity, reconciliation can continue.

## Explicit legacy adoption (unversioned → format 2)

Older releases have no pairing proof. There is no automatic adoption, including when a previous demo left files in `.intentos`. **Stop all workers, preserve an offline copy of the original files and WAL sidecars, and review which two files belong together before attempting adoption.** Old programs must stay stopped and must never reopen the adopted stores; they do not understand the new gate.

```sh
node src/storage-cli.ts adopt-legacy ./old-state --confirm-stopped-workers
node src/storage-cli.ts check ./old-state
```

Adoption accepts only a conservative no-dispatch history:

- Both original files must exist, be distinct, have version zero, and have no metadata or anchor. A missing legacy service is refused; the command does not fabricate one.
- Runtime budget must have zero spent, with valid integer cap. No execution attempts may exist.
- Intents may only be pending, approved or denied, with canonical valid proposals, original matching approval digests and no receipts/evidence.
- The audit must be an intact chain containing only proposal/approval/rejection/denial events.
- The service must have no effects, queue records or queue writes; no unknown table names are accepted.

The adoption adds missing queue-era and approval-lifecycle tables, stamps both identities/version and creates the anchor. It does not issue finite lifetimes: adopted old approvals must be explicitly reviewed again before first dispatch. It preserves existing intent IDs, payloads, approval hashes, caps and audit entries. Tests exercise both original-era and queue-era legacy layouts. The explicit operator command is an assertion about provenance; unversioned data cannot prove that a legacy file was never rolled back.

Prior spend, executing/uncertain/applied/verified intents, attempt records, service effects or inconsistent history are **refused**. Do not erase those rows or reset spend to force acceptance. Preserve that pair and use its original release in an isolated offline review, or retain it as an archive and start a different empty directory. Migration of previously dispatched legacy data is not implemented. A partially completed adoption leaves an initializing anchor or partial metadata and is refused, not retried blindly.

There is no automatic downgrade. Format-1 pairs have an explicit stopped-worker upgrade to format 2; see [approvals](APPROVALS.md). No later format migration is implemented. A newer `user_version` or metadata version is refused before normal runtime operations.

## Backup: stop workers first

**Stop every process using either store and keep them stopped for the entire operation.** The flag below records this operator instruction; it is not authentication or proof that no idle process remains. SQLite maintenance locks reject an active writer but cannot establish that every application process has shut down. This is not a live-writer backup protocol.

```sh
node src/storage-cli.ts backup .intentos ./backup-2026-11-23 --confirm-stopped-workers
```

The destination must not exist. The command validates the pair, checkpoints WAL, switches to rollback-journal mode, and acquires exclusive SQLite access to each store. It writes standalone snapshots with `VACUUM INTO`, synchronizes them, and writes `backup.json` last. The manifest includes storage version, pair/store identities and SHA-256 checksums for both files. An interrupted backup without a complete manifest is not restorable. Failed maintenance can leave an incomplete destination for inspection; choose a new destination for retry after understanding the failure.

Do not copy only `.sqlite` files while WAL writers are live, or assume two independent filesystem copies are an atomic snapshot. The verified backup contains no required WAL sidecars. Once the backup completes and maintenance connections close, the original runtime may reopen and return to WAL mode. Keep backups immutable and protect access according to the sensitivity of proposal and evidence text.

## Restore: new directory, whole pair

```sh
node src/storage-cli.ts restore ./backup-2026-11-23 ./restored-state --confirm-stopped-workers
node src/storage-cli.ts check ./restored-state
node src/cli.ts status ./restored-state
node src/cli.ts recover ./restored-state
# For each applicable intent, independently verify its outcome:
node src/cli.ts verify ./restored-state INTENT_ID
```

Restore never overwrites an existing destination. It accepts supported format-1 or format-2 backups, verifies both checksums, schema, roles, pairing and SQLite integrity, and copies to staging. After rechecking the copies and assigning a new pair identity, it reserves a new directory exclusively and publishes its anchor last. An interruption before publication leaves an incomplete pair that cannot be opened. Restore preserves intent data, caps, audit and dispatch records; format-2 approval terms are not renewed, and format-1 approvals require explicit review before new dispatch. Do not run the original and restored copies as two controllers for the same work.

Original-adapter `executing` intents replay against their restored deduplication ledger. Queue `uncertain` intents remain non-dispatchable and require the same independent read-only reconciliation as before. Refused or ambiguous evidence never receives another debit or automatic resend.

Use this restore command to move a pair between directories or machines. Raw copied databases and anchors will normally fail the recorded file identity/path checks, even if their data matches. Do not hand-edit the anchor to bypass those checks.

## Reproducible verification

```sh
npm test
npm run demo:storage
```

The demo uses temporary directories, generated records and two real child-process exits after service commit. It backs up with workers closed, restores, and verifies both original and queue intents. Machine-checked output shows `originalEffects: 1`, `queueWrites: 1`, `simulatedCreditsSpent: 6`, `auditValid: true`, and both intents verified. It removes its temporary data afterward. There is no network or live account.

## Practical limits and remaining work

- Pair UUIDs and device/inode checks detect common wrong-file and replacement mistakes. They are **not** cryptographic anti-rollback protection: overwriting bytes in place with an older same-pair image, restoring a whole directory/filesystem snapshot, inode reuse plus a matching old image, or changing anchors/metadata can evade those checks. Never overwrite live files in place or restore just one store. Only use the complete manifest-verified restore procedure into a new directory. No hostile-host protection is claimed.
- If all files **and** the anchor are deleted, the runtime cannot distinguish that from a genuinely new installation. Retain backups and do not delete state as remediation for uncertain work.
- No filesystem replacement may occur concurrently with runtime calls. Path checks are not a filesystem sandbox or a race-proof defense against privileged mutation. The stores, application, local filesystem and storage synchronization semantics are trusted.
- `backup.json` checksums detect changed files, not a maliciously rewritten manifest. No signing key, external monotonic checkpoint or off-machine audit witness exists.
- Offline backup/restore is tested for the two synthetic local services only. It cannot undo or recreate external effects, and restoring old runtime state against a live external service would require a separate reconciliation design. There is no general exactly-once guarantee.
- This gate does not implement authentication, untrusted-plugin isolation, per-capability revocation, disk-full/power-loss validation, arbitrary legacy-data migration, or retention policy. The host API boundary remains cooperative.

## Format-1 approval upgrade

Run `node src/storage-cli.ts upgrade-approvals DIRECTORY --confirm-stopped-workers` only after preserving a complete backup with the prior release. It does not silently authorize existing old approvals. See [approval migration and snapshot limitations](APPROVALS.md).
