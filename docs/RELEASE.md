# Release-candidate verification

Candidate package version: **1.0.0-rc.1**. Database version: **2**. Backup-manifest version: **1**. The package remains `private: true`. This document does not authorize a tag, npm publication, deployment or merge.

## Reproduce locally from a clean source copy

Use Linux, a local filesystem and the Node version in `.node-version`. Do not copy `node_modules`, `.intentos`, SQLite files, secrets or logs from another checkout.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run demo -- .intentos/rc-verification
npm run demo -- .intentos/rc-verification
npm run demo:queue -- .intentos/rc-verification
npm run demo:queue -- .intentos/rc-verification
npm run demo:storage
npm run demo:approvals
node src/cli.ts --version
node src/storage-cli.ts --version
```

Expected demonstration evidence:

| Demo | Required result |
| --- | --- |
| Original, repeated | `verified`; repeat does not add effect or debit |
| Queue, repeated | `verified`; one dispatch attempt, one write, one record, three credits |
| Storage | both restored intents `verified`; one original effect, one queue write, six credits |
| Approvals | expired and revoked claims blocked; already-dispatched queue verified; three credits |

Typecheck must pass and no tests may be skipped or failed. Inspect subprocess stderr on contention failures; do not infer the cause from a nonzero child exit or hide it by deleting the test. CI currently targets Ubuntu 24.04 only. Adding platform coverage requires reviewing storage semantics, not merely naming another runner.

[Latest local verification record](LOCAL-VERIFICATION.md) documents the clean-copy checks; it is not a hosted CI result.

## Gates before promoting the candidate

- [ ] Verify package/lockfile/API/CLI versions all equal `1.0.0-rc.1` and the package remains private.
- [ ] Run the commands above from a clean copy and record Node/npm/platform and the exact source SHA.
- [ ] Independently review authorization, uncertain-outcome, schema/upgrade and maintenance changes.
- [ ] Confirm all existing and new tests, all four demos, and public import/type fixtures pass on that exact source.
- [ ] Confirm exact hosted CI status for the consolidated candidate SHA, including contention diagnostics. **A local pass is not a hosted pass.**
- [ ] Resolve the reported hosted concurrent-queue failure through reproducible evidence and verified checks; the bounded-wait patch addresses a reproduced contention mode, not a proven reconstruction of the old suppressed exception.
- [ ] Verify links/assets, plain-language README, CLI help/exit behavior and no machine-specific paths or secrets in deliverables.
- [ ] Review Linux-only support, stale-snapshot/revocation limits, legacy refusals and lack of hostile-host isolation with the release owner.
- [ ] Make a separate final-release decision. RC completion does not itself mean 1.0 is released.

Out of scope: live connectors, real accounts/money, cloud deployment, external identity, arbitrary plugin isolation, signed off-machine audit or revocation witnesses, live-writer backup, and npm distribution. See [security](../SECURITY.md) and [roadmap](ROADMAP.md).
