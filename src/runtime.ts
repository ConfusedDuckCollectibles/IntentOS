import { StorePair } from './storage.ts';
import { PublishingQueue, validateQueueProposal, queueOperationId, readQueueEvidence, assessQueueEvidence } from './queue.ts';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

import { validateProposal } from './proposal.ts';
import type { Proposal } from './proposal.ts';
export { validateProposal } from './proposal.ts';
export type { Proposal } from './proposal.ts';
export type Role = 'planner' | 'approver' | 'executor' | 'verifier';
export type Actor = Readonly<{ id: string; role: Role; prefix: string }>;
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  #pair: StorePair;
  constructor(path: string, servicePath: string, cap = 12) {
    if (!Number.isSafeInteger(cap) || cap < 0) throw Error('Budget must be a nonnegative safe integer');
    this.#pair = new StorePair(path,servicePath,cap);
    this.#db = open(path); this.#servicePath = servicePath;
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
    this.#pair.assert();
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
      const action = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input,'action') : undefined;
      const p = action ? validateQueueProposal(input) : validateProposal(input); this.#auth(a,'planner',p.key);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw Error('Invalid intent id');
      const payload = JSON.stringify(p);
      const hash = digest({ id, action: 'action' in p ? p.action : 'simulated.put', payload, cost: 3, policy: 1 });
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
  execute(a: Actor, id: string, crash?: 'before-effect' | 'after-effect' | 'before-commit' | 'lose-response') {
    const candidate = this.get(a,id);
    if (JSON.parse(String(candidate.payload)).action) return this.#executeQueue(a,id,crash);
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
    this.#pair.assert();
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
      if (JSON.parse(j.payload).action) return this.#reconcileQueue(a,j);
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
    const ids = this.#db.prepare("SELECT id,payload FROM jobs WHERE state IN ('executing','uncertain') ORDER BY id").all();
    return ids.filter(j => JSON.parse(String(j.payload)).key.startsWith(a.prefix)).map(j => this.execute(a,String(j.id)));
  }
  #executeQueue(a: Actor, id: string, fault?: string) {
    // Only the transaction which inserts the attempt may dispatch. State alone is never permission to resend.
    const prepared = this.#tx(a,'queue-dispatch',() => {
      const j=this.#job(id); const p=validateQueueProposal(JSON.parse(j.payload)); this.#auth(a,'executor',p.key);
      if (['uncertain','applied','verified'].includes(j.state)) return {job:j,dispatch:false};
      if (j.state !== 'approved' || j.approval !== j.hash) throw Error('Exact approval required');
      const b:any=this.#db.prepare('SELECT * FROM budget WHERE id=1').get();
      if (j.cost > b.cap-b.spent) throw Error('Budget exceeded');
      const operationId=queueOperationId(p.key,j.hash);
      this.#db.prepare('INSERT INTO queue_attempts(id,operation_id,destination,intent_hash) VALUES(?,?,?,?)').run(id,operationId,p.key,j.hash);
      this.#db.prepare('UPDATE budget SET spent=spent+? WHERE id=1').run(j.cost);
      this.#db.prepare("UPDATE jobs SET state='uncertain' WHERE id=?").run(id);
      this.#event(a.id,'queue-dispatch-intent',{id,operationId,destination:p.key,cost:j.cost});
      return {job:this.#job(id),dispatch:true};
    });
    if (!prepared.dispatch) return prepared.job;
    if (fault==='before-effect') process.exit(71);
    let receipt: string;
    try {
      this.#pair.assert();
      const service=new PublishingQueue(this.#servicePath);
      try { const p=validateQueueProposal(JSON.parse(prepared.job.payload)); receipt=service.write(queueOperationId(p.key,prepared.job.hash),prepared.job.hash,p,fault==='lose-response'); }
      finally {service.close();}
    } catch {
      return this.#tx(a,'queue-unknown',()=>{this.#event(a.id,'queue-outcome-unknown',{id});return this.#job(id);});
    }
    if (fault==='after-effect') process.exit(72);
    return this.#tx(a,'queue-acknowledge',()=>{
      const current=this.#job(id);
      if (current.state !== 'uncertain') return current;
      this.#db.prepare('UPDATE queue_attempts SET acknowledged_record_id=? WHERE id=?').run(receipt,id);
      this.#db.prepare("UPDATE jobs SET state='applied',receipt=? WHERE id=?").run(receipt,id);
      this.#event(a.id,'queue-acknowledged',{id,recordId:receipt});
      if (fault==='before-commit') process.exit(73);
      return this.#job(id);
    });
  }
  #reconcileQueue(a: Actor, j: any) {
    if (!['uncertain','applied'].includes(j.state)) throw Error('Intent has no dispatch attempt');
    const p=validateQueueProposal(JSON.parse(j.payload));
    const operationId=queueOperationId(p.key,j.hash);
    const attempt=this.#db.prepare('SELECT * FROM queue_attempts WHERE id=?').get(j.id);
    if (!attempt || attempt.operation_id!==operationId || attempt.destination!==p.key || attempt.intent_hash!==j.hash || j.approval!==j.hash) throw Error('Invalid dispatch authorization');
    const observed=readQueueEvidence(this.#servicePath,operationId);
    const assessment=assessQueueEvidence(p,j.hash,operationId,observed);
    if (assessment.matched && attempt.acknowledged_record_id !== null && attempt.acknowledged_record_id !== observed.records[0].id) {assessment.matched=false;assessment.reason='acknowledged-record-mismatch';}
    // Only evidence from the exact destination/operation is retained in this scope's view.
    const evidence=JSON.stringify({operationId,matched:assessment.matched,reason:assessment.reason,candidateCount:observed.records.length,
      requiresHumanReview:!assessment.matched,record:assessment.matched?observed.records[0]:null});
    this.#db.prepare('UPDATE jobs SET state=?,evidence=?,receipt=? WHERE id=?').run(assessment.matched?'verified':'uncertain',evidence,assessment.matched?observed.records[0].id:null,j.id);
    this.#event(a.id,assessment.matched?'queue-verified':'queue-review-required',{id:j.id,evidence});
    return this.#job(j.id);
  }
  // Host-only primitives used by the narrow capability facade. Never return a full snapshot.
  get(a: Actor, id: string) {
    return this.#tx(a, 'get', () => {
      this.#auth(a, a.role, a.prefix);
      const row = this.#db.prepare("SELECT * FROM jobs WHERE id=? AND substr(json_extract(payload,'$.key'),1,length(?))=?").get(id,a.prefix,a.prefix);
      // Do not reveal whether an out-of-scope ID exists.
      if (!row) throw Error('Intent unavailable');
      return row;
    });
  }
  list(a: Actor) {
    return this.#tx(a, 'list', () => {
      this.#auth(a, a.role, a.prefix);
      return this.#db.prepare("SELECT * FROM jobs WHERE substr(json_extract(payload,'$.key'),1,length(?))=? ORDER BY id").all(a.prefix,a.prefix);
    });
  }
  snapshot() { this.#pair.assert(); return { budget: this.#db.prepare('SELECT cap,spent FROM budget').get(), jobs: this.#db.prepare('SELECT * FROM jobs ORDER BY id').all(), audit: this.#db.prepare('SELECT * FROM audit ORDER BY seq').all() }; }
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
