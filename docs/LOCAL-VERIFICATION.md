# Local RC verification record

Verified on 2026-11-23 for **1.0.0-rc.1** using Linux, Node **24.22.3**, npm **11.19.1**.

A temporary source-only copy excluded `node_modules`, `.intentos`, Git metadata and SQLite files. A normal locked install first fetched missing development packages; the subsequent clean-copy install succeeded using the populated cache with:

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run verify
```

Results: three locked development packages installed; strict TypeScript check passed; **110 tests passed, zero failed, zero skipped**. No runtime dependency was added.

All four offline demos were then run and machine-checked. Original and queue demos each ran twice against the same fresh state. Original spend remained 3; queue dispatch attempts, writes and records each remained 1 with spend 3. Storage restored two verified intents with one original effect, one queue write and spend 6. Approval output confirmed expired/revoked blocks, verified already-dispatched work and spend 3. Audit checks passed. Both CLI version outputs equaled `1.0.0-rc.1`. Local Markdown/document and image links resolved.

Public import/typed-capability tests and clock-failure revocation tests are included in that count. The parent's bounded SQLite wait/diagnostic changes and deterministic lock test are included. This does **not** prove the precise cause of the earlier hosted failure whose child stderr was suppressed.

**Pending:** independent review and hosted CI for the exact consolidated candidate commit. This local working copy has no assigned release SHA or tag. No hosted success, macOS/Windows support, final 1.0 release, npm publication or deployment is asserted. Follow the remaining [release gates](RELEASE.md).
