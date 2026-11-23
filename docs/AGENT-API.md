# Trusted host and agent API

Issue #1 separates cooperative agent code from privileged runtime operations. Use `IntentHost` in trusted application code and pass only a role-specific capability into each agent function. `agents.ts` contains the agent-facing TypeScript interfaces; it imports no runtime or SQLite implementation.

| Recipient | Methods | Authority |
| --- | --- | --- |
| Planner agent | `propose(id, input)`, `get(id)`, `list()` | Propose within its fixed prefix; read that scope |
| Verifier agent | `verify(id)`, `get(id)`, `list()` | Independently verify applied intents within its fixed prefix; read that scope |
| Trusted operator | `decide(id, hash, allow)`, `get(id)`, `list()` | Exact approval or denial within its provisioned scope |
| Trusted executor | `execute(id)`, `recover()`, `get(id)`, `list()` | Apply approved work and recover interrupted work within its provisioned scope |
| Trusted host | `planner`, `verifier`, `operator`, `executor`, `inspect`, `close` | Provision capabilities, own stores and inspect global state |

There is deliberately no executor or approver **agent** interface. Those capabilities stay with trusted host code. Never pass `IntentHost`, `Runtime`, raw actor tokens, database paths/connections, service instances, operator/executor capabilities or full snapshots to agent integrations.

## Example

```ts
// Trusted application composition root, never agent code:
import { IntentHost } from './src/host.ts';
import { planOffline, verifyOffline } from './src/demo-agents.ts';

const host = new IntentHost('/existing-dir/runtime.sqlite', '/existing-dir/service.sqlite');
try {
  const planner = host.planner('release-planner', 'demo/');
  const verifier = host.verifier('release-verifier', 'demo/');
  const operator = host.operator('local-operator', 'demo/');
  const executor = host.executor('local-executor', 'demo/');
  const proposal = await planOffline(planner, 'release', 'Draft release notes');
  // A real application must authenticate its approver and present the exact proposal.
  // This explicit demo approval is fixture setup, not human authentication.
  if (proposal.state === 'pending') operator.decide(proposal.id, proposal.hash, true);
  executor.execute(proposal.id);
  const evidence = verifyOffline(verifier, proposal.id);
  console.log(evidence.state);
} finally {
  host.close();
}
```

The CLI follows this same pattern. `planOffline` receives only a planner capability; `verifyOffline` receives only a verifier capability. Approval and execution remain in CLI host code. Commands, output shape, durable schema, approval digests, costs, and recovery protocol remain compatible with the original MVP.

## Capability and read semantics

Capabilities are frozen objects with null prototypes and only their documented methods. They do not expose actor identity/scope tokens or references to the host. Each call uses a host-minted actor captured privately at provisioning. The original object must be the receiver: call `planner.get(id)`, not a detached/destructured method. Copying its properties or borrowing its methods onto another receiver fails. Passing the original capability, or binding a method to that original capability, delegates its existing authority; applications must control those references. No per-capability revocation is implemented. Closing the host invalidates all of its capabilities; reopening requires explicit host provisioning.

`get` and `list` execute authenticated database queries constrained to the capability's literal prefix. Scope strings end at the namespace slash, and SQL equality is used rather than wildcard matching. `get` returns the same `Intent unavailable` error for missing and out-of-scope IDs. `list` returns only that scope, in ID order; an empty scope returns an empty list. There is no agent budget, full audit, service query or global snapshot method.

Returned intent views and list arrays are immutable detached data, not live state handles. Each view contains the existing intent fields: ID, serialized payload, hash, state, integer cost, approval digest, receipt and serialized evidence. Because these values are primitives, shallow freezing fully protects the returned structure. A later state transition requires a fresh `get` to observe it. Parsing payload/evidence yields caller-owned data and cannot change the stores.

Intents share a global ID namespace. A duplicate ID with a different payload returns `Idempotency conflict`, including a collision with an out-of-scope intent. This discloses ID occupancy, not its payload or status. Use host-assigned unique IDs if occupancy is sensitive; this API does not claim tenant-level metadata isolation. Scope membership is based on resource key, so agents assigned the same scope intentionally share its intent views.

## What must be trusted

This is a cooperative application API boundary, **not a JavaScript or OS sandbox**. Node code with unrestricted imports, filesystem access, debugging hooks, or access to privileged objects can bypass this API, instantiate a Runtime, inspect databases or change them. The host must trust application composition, module loading, actor provisioning, operator authentication, executor scheduling, filesystem ownership, and its own snapshot handling. In-process capability immutability is not protection against arbitrary malicious code in the same Node process. Use an independently designed process/OS isolation layer before running untrusted plugins.

`runtime.ts` remains a lower-level **host-only** implementation and compatibility API for existing host integrations and crash tests; its public methods are not an agent entry point. `proposal.ts` holds the shared proposal schema so planner adapters no longer import the privileged runtime. Provider planners still only propose; this change adds no network transport or live provider use.

Read denials through the runtime use the existing denial audit path. Invalid facade receivers fail before reaching the runtime and are not attributed/audited as valid actors. Successful reads do not append audit entries. Global budget limits, exact approval, conservative spend, independent read-back, idempotent effects and paired-store recovery limitations remain unchanged; see [architecture](ARCHITECTURE.md).

## Offline queue proposals

The same planner `propose` and verifier `verify` capabilities now support the strict `queue.create` and `queue.draft` proposals documented in [queue recovery](QUEUE-RECOVERY.md). The proposal's `key` remains the exact destination and scope key. Agent surfaces are unchanged: no connector, dispatch or fault-injection handles are exposed. Queue verification reconciles an uncertain write via independent evidence. Executor recovery never resends a queue attempt. Inconclusive evidence remains `uncertain` with `requiresHumanReview` in its serialized evidence; it is not a successful verification. The host must present that unresolved result clearly to the operator.
