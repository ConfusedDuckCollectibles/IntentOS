import { OfflinePlanner } from './adapters.ts';
import type { PlannerCapability, VerifierCapability } from './agents.ts';

// Cooperative agent code receives only its own capability, never the host or another role.
export async function planOffline(planner: PlannerCapability, id: string, text: string) {
  return planner.propose(id, await new OfflinePlanner().propose(text));
}
export function verifyOffline(verifier: VerifierCapability, id: string) {
  return verifier.verify(id);
}
