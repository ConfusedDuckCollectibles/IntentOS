/** Public trusted-local host API. Agents receive only their provisioned capability. */
export { IntentHost } from './host.ts';
export type { OperatorCapability, ExecutorCapability } from './host.ts';
export type { PlannerCapability, VerifierCapability, ScopedReader, IntentView } from './agents.ts';
export type { ApprovalPolicy } from './runtime.ts';
export type { Proposal } from './proposal.ts';
export type { QueueProposal } from './queue.ts';
export { DEFAULT_APPROVAL_LIFETIME_MS, MAX_APPROVAL_LIFETIME_MS } from './runtime.ts';
export const VERSION = '1.0.0-rc.1';
