# Positioning notes — 2026-11-22

IntentOS is the requested working name, not a cleared or unique brand. An existing [IntentOS agent runtime for macOS](https://intent-os.app/) uses the same name. Resolve naming before public branding; this repository makes no affiliation claim.

This MVP should not claim to invent durable agent execution or approval-controlled actions:

- [AgentAction](https://github.com/dinpd/AgentAction) is close overlap: it presents durable approvals, budget controls, independent verification, and lifecycle evidence. Compare implementation contracts and failure tests before asserting differentiation.
- [Temporal durable execution](https://docs.temporal.io/durable-execution) supplies established recovery/resumption infrastructure. Consider integrating a transaction kernel into a workflow host rather than recreating a distributed workflow engine.
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) provides checkpointing and stores for agent state and recovery. Persistence alone is not the complete approval/effect/evidence contract tested here.
- [Open Policy Agent tool calling](https://www.openpolicyagent.org/docs/agent-tool-calling) addresses policy checks in the tool-executing harness. Future policy integration should retain transactional budget and approval enforcement at the effect boundary.

The hypothesis to test is a minimal embeddable TypeScript transaction kernel with cross-agent least privilege, independently sourced evidence, and reproducible crash/reconciliation coverage. This is a proposed focus, not proven uniqueness. The current MVP demonstrates that focus only within a trusted local host and an idempotent simulated service. It does not provide exactly-once external effects or tamper-proof local audit.

Next evaluation: run the same denial, competing-budget, crash-after-effect, and false-success cases against candidate integrations; compare observable guarantees, setup complexity, and code required. Choose integration, narrowing or renaming based on those results rather than marketing claims.
