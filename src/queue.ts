import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export type QueueProposal = { action: 'queue.create' | 'queue.draft'; key: string; assetFingerprint: string; dueAt: string; recordId?: string };
export function validateQueueProposal(input: unknown): QueueProposal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid queue proposal');
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const d = Object.getOwnPropertyDescriptor(input,key);
    if (typeof key !== 'string' || !d?.enumerable || !Object.hasOwn(d,'value')) throw Error('Invalid queue proposal');
    fields[key] = d.value;
  }
  const {action,key,assetFingerprint,dueAt,recordId} = fields;
  const expected = action === 'queue.draft' ? 'action,assetFingerprint,dueAt,key,recordId' : 'action,assetFingerprint,dueAt,key';
  if (Object.keys(fields).sort().join(',') !== expected || (action !== 'queue.create' && action !== 'queue.draft') ||
      typeof key !== 'string' || !/^[a-z][a-z0-9_-]*\/[a-z0-9_-]{1,64}$/.test(key) ||
      typeof assetFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(assetFingerprint) ||
      typeof dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(dueAt) ||
      !Number.isFinite(Date.parse(dueAt)) || new Date(dueAt).toISOString() !== dueAt ||
      (action === 'queue.draft' && (typeof recordId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(recordId)))) throw Error('Invalid queue proposal');
  return {action,key,assetFingerprint,dueAt,...(action === 'queue.draft' ? {recordId: recordId as string} : {})};
}
export const queueOperationId = (destination: string, intentHash: string): string =>
  createHash('sha256').update(JSON.stringify({connector:'synthetic-queue/v1',destination,intentHash})).digest('hex');
export type QueueRecord = { id: string; operation_id: string; intent_hash: string; destination: string; asset_fingerprint: string; due_at: string; status: string; sent_receipt: string | null };
export type QueueEvidence = { available: boolean; authoritative: boolean; fresh: boolean; records: QueueRecord[] };

/** Synthetic service deliberately has NO unique constraint on operation_id or intent_hash. */
export class PublishingQueue {
  #db: DatabaseSync;
  constructor(path: string) {
    this.#db=new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS queue_records(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, intent_hash TEXT NOT NULL, destination TEXT NOT NULL, asset_fingerprint TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL, sent_receipt TEXT);
      CREATE TABLE IF NOT EXISTS queue_writes(seq INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, record_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_source(id INTEGER PRIMARY KEY CHECK(id=1), authoritative INTEGER NOT NULL, fresh INTEGER NOT NULL);
      INSERT OR IGNORE INTO queue_source VALUES(1,1,1);`);
  }
  write(operationId: string, intentHash: string, p: QueueProposal, loseResponse=false): string {
    this.#db.exec('BEGIN IMMEDIATE');
    let id: string;
    try {
      if (p.action === 'queue.create') {
        id=randomUUID();
        this.#db.prepare('INSERT INTO queue_records VALUES(?,?,?,?,?,?,?,NULL)').run(id,operationId,intentHash,p.key,p.assetFingerprint,p.dueAt,'queued');
      } else {
        id=p.recordId!;
        const old=this.#db.prepare('SELECT * FROM queue_records WHERE id=?').get(id);
        if (!old || old.destination !== p.key || old.asset_fingerprint !== p.assetFingerprint || old.due_at !== p.dueAt || old.sent_receipt !== null || !['queued','draft'].includes(String(old.status))) throw Error('Draft precondition mismatch');
        this.#db.prepare("UPDATE queue_records SET operation_id=?,intent_hash=?,status='draft' WHERE id=?").run(operationId,intentHash,id);
      }
      this.#db.prepare('INSERT INTO queue_writes(operation_id,record_id) VALUES(?,?)').run(operationId,id);
      this.#db.exec('COMMIT');
    } catch(e) { this.#db.exec('ROLLBACK'); throw e; }
    if (loseResponse) throw Error('Synthetic response lost after commit');
    return id;
  }
  close() {this.#db.close();}
}

/** Separate read-only connection; a missing/unreadable/incomplete source cannot prove failure. */
export function readQueueEvidence(path: string, operationId: string): QueueEvidence {
  let db: DatabaseSync | undefined;
  try {
    db=new DatabaseSync(path,{readOnly:true}); db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const source=db.prepare('SELECT authoritative,fresh FROM queue_source WHERE id=1').get();
    const records=db.prepare('SELECT * FROM queue_records WHERE operation_id=? ORDER BY id').all(operationId) as QueueRecord[];
    db.exec('COMMIT');
    return {available:true,authoritative:source?.authoritative===1,fresh:source?.fresh===1,records};
  } catch { return {available:false,authoritative:false,fresh:false,records:[]}; }
  finally {db?.close();}
}
export function assessQueueEvidence(p: QueueProposal, intentHash: string, operationId: string, evidence: QueueEvidence) {
  if (!evidence.available) return {matched:false,reason:'read-unavailable'};
  if (!evidence.authoritative || !evidence.fresh) return {matched:false,reason:'read-inconclusive'};
  if (evidence.records.length !== 1) return {matched:false,reason:evidence.records.length ? 'ambiguous' : 'missing'};
  const r=evidence.records[0];
  const matched=r.operation_id===operationId && r.intent_hash===intentHash && r.destination===p.key &&
    r.asset_fingerprint===p.assetFingerprint && r.due_at===p.dueAt && r.sent_receipt===null &&
    r.status===(p.action==='queue.create'?'queued':'draft') && (p.action!=='queue.draft' || r.id===p.recordId);
  return {matched,reason:matched?'conclusive-match':'record-mismatch'};
}
