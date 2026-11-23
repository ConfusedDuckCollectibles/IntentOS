# Roadmap after the local release candidate

## Implemented and awaiting exact release verification

The local scope now includes typed host/agent entry points, scoped immutable capabilities, exact finite approval and revocation, atomic simulation budgets, two offline adapters, independent evidence, unknown-outcome review, paired version-2 stores, conservative upgrade, stopped-worker backup/restore, strict typechecking and four runnable demos. The [release gates](RELEASE.md) determine readiness; hosted checks must pass on the exact consolidated candidate.

## Future work, not current guarantees

1. **Operational fault coverage:** expand disk-full, real power-loss, corruption and long-running contention testing. Add macOS/Windows only after validating storage behavior and running their test matrix.
2. **Authenticated operators and isolation:** independently design principal binding, capability revocation and process/OS isolation before untrusted plugins or multi-user hosting. Approval revocation already exists; capability-reference revocation is separate.
3. **External evidence and anti-rollback:** signed checkpoints, off-machine revocation/time witnesses, retention/redaction and a restore design that reconciles real external effects. Local manifests/audit are not hostile-host protection.
4. **Broader migration/remediation:** safely handle older dispatched unversioned data and operator resolution of unresolved business work without accidental duplicate intent creation.
5. **Explicit opt-in providers/connectors:** bounded transports, independently justified authoritative reads, secrets handling and separate inference budgets. Mocked proposal adapters do not establish live-service compatibility.
6. **Product interface/distribution:** consider a Vue review UI after authentication semantics; a built JavaScript package needs separate packaging tests. Keep the default path offline and obtain separate approval for any deployment or publication.

Live money, autonomous shell actions and broad default network access are outside this candidate's scope.
