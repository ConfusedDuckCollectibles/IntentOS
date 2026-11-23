# Security and trust boundary

IntentOS 1.0.0-rc.1 is a **trusted-local, offline release candidate**. It is not a multi-tenant agent platform, identity provider or sandbox for untrusted JavaScript. Its authorization gates constrain cooperative application code using the supplied capabilities.

The host must trust module loading, operator identity, capability provisioning, database ownership, the local filesystem, trusted clock configuration and executor scheduling. Anyone who can modify code, use raw Runtime APIs, write databases/anchors, inspect a process, or execute arbitrary Node/OS code can bypass application-level restrictions. Keep operator/executor handles, storage paths and global inspection out of agent integrations. Possession of a capability reference permits delegation of its existing authority.

The allowlisted defaults only mutate generated local SQLite service records. There are no default network transports, autonomous shell tools, real payments, scheduled live publishing or deployed services. Provider proposal adapters require explicitly injected transports and credentials and are tested only with mocked responses; the RC does not certify live-provider compatibility or cap model bills.

Exact approval, finite deadlines, revocation, scoped methods and integer budgets are tested at the durable dispatch boundary. Revocation committed after a claim cannot undo that claim. Uncertain queue work is never automatically resent. A broken wall clock can block new authorization but cannot prevent an exact operator revocation while a valid durable clock record exists; fallback timestamp semantics are documented in [approvals](docs/APPROVALS.md).

Storage/audit checks are not tamper-proof or external anti-rollback witnesses. Stale whole-system snapshots can omit later revocations; in-place file rewrites can evade file-identity checks. Backup requires stopped workers; restore requires complete checksum-verified pairs into new directories. No power-loss, hostile-filesystem, NFS or live external-service recovery guarantee is claimed. See [storage limits](docs/STORAGE.md).

Use generated nonsensitive data for demos and bug reports. Audit and evidence contain proposal text; no encryption/redaction layer is included. Do not submit secrets, private database contents or credential-bearing logs to public issues. A safe public reproducer may be filed through the repository's issue workflow; coordinate a private channel with maintainers before disclosing sensitive details. No private-reporting channel or response SLA is asserted here.
