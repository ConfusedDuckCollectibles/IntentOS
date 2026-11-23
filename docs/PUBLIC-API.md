# Public trusted-local API: 1.0.0-rc.1

These are the supported **source-checkout** entry points. Package-name imports below use Node package self-reference from inside the checkout; equivalent relative imports work in a source embedding. No npm publication is implied. RC interfaces remain subject to review before a final 1.0 release.

| Entry | Relative file | Runtime exports |
| --- | --- | --- |
| `intentos` | `src/index.ts` | `IntentHost`, `VERSION`, default/max lifetime constants |
| `intentos/agents` | `src/agents.ts` | None; agent contracts are type-only |
| `intentos/storage` | `src/storage-api.ts` | `checkStores`, `STORAGE_VERSION`, adoption, approval upgrade, backup, restore |

The main entry also exports types: `PlannerCapability`, `VerifierCapability`, `ScopedReader`, `IntentView`, `OperatorCapability`, `ExecutorCapability`, `ApprovalPolicy`, `Proposal` and `QueueProposal`. These declarations are checked by `npm run typecheck`. Runtime, database, synthetic service classes, raw actor issuance and fault-injection harnesses are implementation details, not public agent handles. Import maps do not sandbox code that can access source files or the OS.

## Host composition

```ts
import { mkdirSync } from 'node:fs';
import { IntentHost } from 'intentos';
import type { PlannerCapability, VerifierCapability } from 'intentos/agents';

mkdirSync('.intentos/example', { recursive: true });
const host = new IntentHost(
  '.intentos/example/runtime.sqlite',
  '.intentos/example/service.sqlite',
  12,
  { approvalLifetimeMs: 300_000, clock: Date.now }
);
try {
  const planner: PlannerCapability = host.planner('planner', 'demo/');
  const verifier: VerifierCapability = host.verifier('verifier', 'demo/');
  const proposal = planner.propose('example', { key: 'demo/result', value: 'offline example' });
  // These two handles stay with trusted host/operator code, never agents.
  if (proposal.state === 'pending') host.operator('operator').decide(proposal.id, proposal.hash, true, 60_000);
  host.executor('executor').execute(proposal.id);
  console.log(verifier.verify(proposal.id));
} finally {
  host.close();
}
```

This is explicit fixture approval, not a substitute for authenticating an operator. Agent integrations should receive only their role's capability. Methods are synchronous except separately invoked proposal providers; capabilities and returned views are frozen and receiver-bound. They are intentionally not serializable credentials. See [agent contracts](AGENT-API.md) for exact methods, scopes and delegation limitations.

Approvals and execution use integer simulation credits. Deadlines and clock options use integer epoch milliseconds; the operator may revoke an exact approval, including when clock failure requires the audited high-water fallback. A dispatch claim already committed can still complete/reconcile. [Approval semantics](APPROVALS.md) define the ordering and upgrade behavior.

## Maintenance

```ts
import { checkStores, backupPair, restorePair } from 'intentos/storage';
// Stop all workers before calling backup/restore, not just this host instance.
checkStores('state/runtime.sqlite', 'state/service.sqlite'); // never initializes
backupPair('state/runtime.sqlite', 'state/service.sqlite', 'new-backup-directory');
restorePair('new-backup-directory', 'new-restored-directory');
```

`adoptLegacyPair(runtimePath, servicePath)` and `upgradeApprovalState(runtimePath, servicePath)` are explicit stopped-worker procedures, not startup fallbacks. Read [storage](STORAGE.md) first. Errors throw synchronously; callers must not interpret them as permission to recreate stores or resend uncertain actions. Error-message wording and raw host diagnostic/audit rows are not a stable machine protocol. The named capability methods, documented view fields and CLI exit codes are the RC compatibility surface.
