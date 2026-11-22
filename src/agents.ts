// Agent-facing contracts only: no runtime imports, database paths, actor tokens or factories.
export type IntentView = Readonly<{
  id: string; payload: string; hash: string; state: string; cost: number;
  approval: string | null; receipt: string | null; evidence: string | null;
}>;
export interface ScopedReader {
  get(id: string): IntentView;
  list(): readonly IntentView[];
}
export interface PlannerCapability extends ScopedReader {
  propose(id: string, proposal: unknown): IntentView;
}
export interface VerifierCapability extends ScopedReader {
  verify(id: string): IntentView;
}
