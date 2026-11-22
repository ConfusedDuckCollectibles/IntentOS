import { Runtime } from './runtime.ts';
import type { IntentView, PlannerCapability, ScopedReader, VerifierCapability } from './agents.ts';
import type { Actor } from './runtime.ts';

// These are host/operator interfaces, never agent interfaces.
export interface OperatorCapability extends ScopedReader {
  decide(id: string, expectedHash: string, allow: boolean): IntentView;
}
export interface ExecutorCapability extends ScopedReader {
  execute(id: string): IntentView;
  recover(): readonly IntentView[];
}
const view = (row: any): IntentView => Object.freeze({
  id: row.id, payload: row.payload, hash: row.hash, state: row.state, cost: row.cost,
  approval: row.approval, receipt: row.receipt, evidence: row.evidence
});
const views = (rows: any[]): readonly IntentView[] => Object.freeze(rows.map(view));

// Capabilities are bound to their original receiver and expose no prototype or tokens.
// Passing the original capability to another caller delegates its authority: keep it private.
function capability<T>(methods: Record<string, (...args: any[]) => unknown>): T {
  const result = Object.create(null);
  for (const [name, invoke] of Object.entries(methods)) {
    result[name] = Object.freeze(function(this: unknown, ...args: any[]) {
      if (this !== result) throw Error('Unminted capability receiver');
      return invoke(...args);
    });
  }
  return Object.freeze(result) as T;
}

/** Trusted host entry point. Never give this object or its imports to agent integrations. */
export class IntentHost {
  #runtime: Runtime;
  #closed = false;
  constructor(runtimePath: string, servicePath: string, cap = 12) {
    this.#runtime = new Runtime(runtimePath,servicePath,cap);
  }
  #active() { if (this.#closed) throw Error('Host closed'); }
  #actor(id: string, role: Actor['role'], prefix: string): Actor {
    this.#active(); return this.#runtime.actor(id,role,prefix);
  }
  #reader(a: Actor) {
    return {
      get: (id: string) => { this.#active(); return view(this.#runtime.get(a,id)); },
      list: () => { this.#active(); return views(this.#runtime.list(a)); }
    };
  }
  planner(id: string, prefix = 'demo/'): PlannerCapability {
    const a = this.#actor(id,'planner',prefix);
    return capability({ ...this.#reader(a), propose: (id: string, input: unknown) => {
      this.#active(); return view(this.#runtime.propose(a,id,input));
    } });
  }
  verifier(id: string, prefix = 'demo/'): VerifierCapability {
    const a = this.#actor(id,'verifier',prefix);
    return capability({ ...this.#reader(a), verify: (id: string) => {
      this.#active(); this.#runtime.get(a,id); return view(this.#runtime.verify(a,id));
    } });
  }
  operator(id: string, prefix = 'demo/'): OperatorCapability {
    const a = this.#actor(id,'approver',prefix);
    return capability({ ...this.#reader(a), decide: (id: string, hash: string, allow: boolean) => {
      this.#active(); this.#runtime.get(a,id); return view(this.#runtime.decide(a,id,hash,allow));
    } });
  }
  executor(id: string, prefix = 'demo/'): ExecutorCapability {
    const a = this.#actor(id,'executor',prefix);
    return capability({ ...this.#reader(a), execute: (id: string) => {
      this.#active(); this.#runtime.get(a,id); return view(this.#runtime.execute(a,id));
    }, recover: () => { this.#active(); return views(this.#runtime.recover(a)); } });
  }
  inspect() { this.#active(); return { ...this.#runtime.snapshot(), auditValid: this.#runtime.checkAudit() }; }
  close() { if (!this.#closed) { this.#runtime.close(); this.#closed = true; } }
}
