import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export type Proposal = { key: string; value: string };
export type Role = 'planner' | 'approver' | 'executor' | 'verifier';
export type Actor = Readonly<{ id: string; role: Role; prefix: string }>;
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateProposal(input: unknown): Proposal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid proposal');
  const p = input as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'key,value' || typeof p.key !== 'string' ||
      !/^[a-z][a-z0-9_-]*\/[a-z0-9_-]{1,64}$/.test(p.key) || typeof p.value !== 'string' ||
      Buffer.byteLength(p.value) > 4096) throw Error('Invalid proposal');
  return { key: p.key, value: p.value };
}
function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  return db;
}
export class SimulatedService {
  #db: DatabaseSync;
  constructor(path: string) {
    this.#db = open(path);
    this.#db.exec('CREATE TABLE IF NOT EXISTS effects (token TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt TEXT NOT NULL);');
  }
  apply(token: string, proposal: Proposal): string {
    const payload = JSON.stringify(proposal);
    const receipt = digest({ token, payload });
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.#db.prepare('SELECT * FROM effects WHERE token=?').get(token);
      if (old && old.payload !== payload) throw Error('Idempotency conflict');
      if (!old) this.#db.prepare('INSERT INTO effects VALUES (?,?,?)').run(token, payload, receipt);
      this.#db.exec('COMMIT');
      return receipt;
    } catch (e) { this.#db.exec('ROLLBACK'); throw e; }
  }
  close() { this.#db.close(); }
}
export class Runtime {
  #db: DatabaseSync;
  #actors = new WeakSet<object>();
  #servicePath: string;
  constructor(path: string, servicePath: string, cap = 12) {
    if (!Number.isSafeInteger(cap) || cap < 0) throw Error('Budget must be a nonnegative safe integer');
    this.#db = open(path); this.#servicePath = servicePath;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), cap INTEGER NOT NULL, spent INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, cost INTEGER NOT NULL, approval TEXT, receipt TEXT, evidence TEXT);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, actor TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL);`);
    this.#db.prepare('INSERT OR IGNORE INTO budget VALUES (1,?,0)').run(cap);
    // Existing databases retain their original cap; reopening cannot increase it.
  }
  // Host trust boundary: only the embedding host may mint capabilities.
  actor(id: string, role: Role, prefix = 'demo/'): Actor {
    if (!id || !['planner','approver','executor','verifier'].includes(role) || !/^[a-z][a-z0-9_-]*\/$/.test(prefix)) throw Error('Invalid actor');
    const a = Object.freeze({ id, role, prefix }); this.#actors.add(a); return a;
  }
  #auth(a: Actor, role: Role, key: string) {
    if (!this.#actors.has(a) || a.role !== role || !key.startsWith(a.prefix)) throw Error('Unauthorized');
  }
  #event(actor: string, event: string, detail: unknown) {
    const previous = String(this.#db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get()?.hash ?? 'genesis');
    const body = JSON.stringify(detail);
    const hash = digest({ actor, event, detail: body, previous });
    this.#db.prepare('INSERT INTO audit(actor,event,detail,previous,hash) VALUES (?,?,?,?,?)').run(actor,event,body,previous,hash);
  }
  #tx<T>(a: Actor, operation: string, fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (e) {
      this.#db.exec('ROLLBACK');
      this.#db.exec('BEGIN IMMEDIATE');
      try { this.#event(this.#actors.has(a) ? a.id : 'unknown', 'denied', { operation, reason: String(e) }); this.#db.exec('COMMIT'); }
      catch { this.#db.exec('ROLLBACK'); }
      throw e;
    }
  }
  #job(id: string): any {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw Error('Unknown intent'); return row;
  }
  propose(a: Actor, id: string, input: unknown) {
    return this.#tx(a, 'propose', () => {
      const p = validateProposal(input); this.#auth(a,'planner',p.key);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw Error('Invalid intent id');
      const payload = JSON.stringify(p);
      const hash = digest({ id, action: 'simulated.put', payload, cost: 3, policy: 1 });
      const old = this.#db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if (old) { if (old.hash !== hash) throw Error('Idempotency conflict'); return old; }
      this.#db.prepare("INSERT INTO jobs(id,payload,hash,state,cost) VALUES (?,?,?,'pending',3)").run(id,payload,hash);
      this.#event(a.id,'proposed',{ id, hash }); return this.#job(id);
    });
  }
  decide(a: Actor, id: string, expectedHash: string, allow: boolean) {
    return this.#tx(a,'decide',() => {
      const j = this.#job(id); this.#auth(a,'approver',JSON.parse(j.payload).key);
      if (j.hash !== expectedHash || j.state !== 'pending' || typeof allow !== 'boolean') throw Error('Approval mismatch or invalid state');
      this.#db.prepare('UPDATE jobs SET state=?, approval=? WHERE id=?').run(allow ? 'approved' : 'denied', allow ? expectedHash : null,id);
      this.#event(a.id,allow ? 'approved' : 'rejected',{ id, hash: expectedHash }); return this.#job(id);
    });
  }
  execute(a: Actor, id: string, crash?: 'before-effect' | 'after-effect' | 'before-commit') {
    const j = this.#tx(a,'execute',() => {
      const j = this.#job(id); this.#auth(a,'executor',JSON.parse(j.payload).key);
      if (['applied','verified'].includes(j.state)) return j;
      if (!['approved','executing'].includes(j.state) || j.approval !== j.hash) throw Error('Exact approval required');
      if (j.state === 'approved') {
        const b: any = this.#db.prepare('SELECT * FROM budget WHERE id=1').get();
        if (j.cost > b.cap - b.spent) throw Error('Budget exceeded');
        this.#db.prepare('UPDATE budget SET spent=spent+? WHERE id=1').run(j.cost);
        this.#db.prepare("UPDATE jobs SET state='executing' WHERE id=?").run(id);
        this.#event(a.id,'execution-intent',{ id, cost: j.cost });
      }
      return this.#job(id);
    });
    if (['applied','verified'].includes(j.state)) return j;
    if (crash === 'before-effect') process.exit(71);
    const service = new SimulatedService(this.#servicePath);
    let receipt: string;
    try { receipt = service.apply(j.hash, JSON.parse(j.payload)); } finally { service.close(); }
    if (crash === 'after-effect') process.exit(72);
    return this.#tx(a,'acknowledge',() => {
      const current = this.#job(id);
      if (current.state !== 'executing') return current;
      this.#db.prepare("UPDATE jobs SET state='applied', receipt=? WHERE id=?").run(receipt,id);
      this.#event(a.id,'applied',{ id, receipt });
      if (crash === 'before-commit') process.exit(73);
      return this.#job(id);
    });
  }
  verify(a: Actor, id: string) {
    return this.#tx(a,'verify',() => {
      const j = this.#job(id); this.#auth(a,'verifier',JSON.parse(j.payload).key);
      if (j.state === 'verified') return j;
      if (j.state !== 'applied') throw Error('Intent is not applied');
      // Separate read-only connection. Executor success text is not evidence.
      const reader = new DatabaseSync(this.#servicePath, { readOnly: true });
      let effect: any;
      try { effect = reader.prepare('SELECT * FROM effects WHERE token=?').get(j.hash); } finally { reader.close(); }
      const ok = effect?.payload === j.payload && effect?.receipt === digest({ token: j.hash, payload: j.payload }) && effect?.receipt === j.receipt;
      const evidence = JSON.stringify({ token: j.hash, payload: effect?.payload ?? null, receipt: effect?.receipt ?? null, matched: ok });
      this.#db.prepare('UPDATE jobs SET state=?, evidence=? WHERE id=?').run(ok ? 'verified' : 'failed',evidence,id);
      this.#event(a.id,ok ? 'verified' : 'verification-failed',{ id, evidence }); return this.#job(id);
    });
  }
  recover(a: Actor) {
    this.#tx(a, 'recover', () => this.#auth(a, 'executor', a.prefix));
    const ids = this.#db.prepare("SELECT id,payload FROM jobs WHERE state='executing' ORDER BY id").all();
    return ids.filter(j => JSON.parse(String(j.payload)).key.startsWith(a.prefix)).map(j => this.execute(a,String(j.id)));
  }
  snapshot() { return { budget: this.#db.prepare('SELECT cap,spent FROM budget').get(), jobs: this.#db.prepare('SELECT * FROM jobs ORDER BY id').all(), audit: this.#db.prepare('SELECT * FROM audit ORDER BY seq').all() }; }
  checkAudit(): boolean {
    let previous = 'genesis';
    for (const row of this.snapshot().audit) {
      if (row.previous !== previous || row.hash !== digest({ actor: row.actor,event: row.event,detail: row.detail,previous })) return false;
      previous = String(row.hash);
    }
    return true;
  }
  close() { this.#db.close(); }
}
