import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime.ts';
import { IntentHost } from '../src/host.ts';
import { PublishingQueue, queueOperationId, validateQueueProposal } from '../src/queue.ts';
const proposal={action:'queue.create',key:'demo/shop',assetFingerprint:'a'.repeat(64),dueAt:'2030-01-01T12:00:00.000Z'} as const;
function setup(t:any,cap=12) {
  const dir=mkdtempSync(join(tmpdir(),'intentos-queue-')); const state=join(dir,'runtime.sqlite'),service=join(dir,'service.sqlite');
  const r=new Runtime(state,service,cap);
  t.after(()=>{r.close();rmSync(dir,{recursive:true,force:true});});
  const p=r.actor('p','planner'),a=r.actor('a','approver'),e=r.actor('e','executor'),v=r.actor('v','verifier');
  const approve=(id='one',payload:any=proposal)=>{const j=r.propose(p,id,payload);r.decide(a,id,j.hash,true);return j;};
  const mutate=(sql:string)=>{const db=new DatabaseSync(service);try{db.exec(sql);}finally{db.close();}};
  const counts=()=>{const db=new DatabaseSync(service);const main=new DatabaseSync(state);try{return {
    attempts:main.prepare('SELECT COUNT(*) AS n FROM queue_attempts').get()!.n,
    writes:db.prepare('SELECT COUNT(*) AS n FROM queue_writes').get()!.n,
    records:db.prepare('SELECT COUNT(*) AS n FROM queue_records').get()!.n,spent:r.snapshot().budget!.spent
  };}finally{db.close();main.close();}};
  return {dir,state,service,r,p,a,e,v,approve,mutate,counts};
}
const worker=(dir:string,point:string,id='one')=>spawnSync(process.execPath,['src/queue-demo-worker.ts',dir,id,point],{encoding:'utf8'});
test('queue genuinely does not deduplicate identical backend calls',t=>{
 const f=setup(t);const s=new PublishingQueue(f.service);try{s.write('token','hash',proposal);s.write('token','hash',proposal);}finally{s.close();}
 assert.deepEqual(f.counts(),{attempts:0,writes:2,records:2,spent:0});
});
for(const point of ['after-effect','before-commit']) test(`restart after ${point}: one attempt, write, record and debit; reconciliation only`,t=>{
 const f=setup(t);f.approve();const child=worker(f.dir,point);assert.equal(child.status,point==='after-effect'?72:73,child.stderr);
 const host=new IntentHost(f.state,f.service);try{
  assert.equal(host.planner('p').get('one').state,'uncertain');
  host.executor('e').recover();host.executor('e').execute('one');
  assert.deepEqual(f.counts(),{attempts:1,writes:1,records:1,spent:3});
  assert.equal(host.verifier('v').verify('one').state,'verified');
  assert.equal(host.inspect().auditValid,true);
 }finally{host.close();}
});
test('commit then thrown timeout remains uncertain until independent verification',t=>{
 const f=setup(t);f.approve();assert.equal(f.r.execute(f.e,'one','lose-response').state,'uncertain');
 assert.equal(f.r.execute(f.e,'one').state,'uncertain');
 assert.equal(f.r.verify(f.v,'one').state,'verified');assert.deepEqual(f.counts(),{attempts:1,writes:1,records:1,spent:3});
});
test('crash before write does not trigger resend even when fresh read finds nothing',t=>{
 const f=setup(t);new PublishingQueue(f.service).close();f.approve();assert.equal(worker(f.dir,'before-effect').status,71);
 f.r.recover(f.e);const j=f.r.verify(f.v,'one');assert.equal(j.state,'uncertain');assert.equal(JSON.parse(j.evidence).reason,'missing');
 assert.deepEqual(f.counts(),{attempts:1,writes:0,records:0,spent:3});
});
test('concurrent dispatchers and retries cannot send or debit twice',async t=>{
 const f=setup(t);f.approve();
 const run=()=>new Promise(resolve=>{const c=spawn(process.execPath,['src/queue-demo-worker.ts',f.dir,'one','none'],{stdio:'ignore'});c.on('exit',resolve);});
 assert.deepEqual(await Promise.all([run(),run(),run(),run()]),[0,0,0,0]);
 assert.equal(f.r.verify(f.v,'one').state,'verified');assert.deepEqual(f.counts(),{attempts:1,writes:1,records:1,spent:3});
});
for(const [name,sql,reason] of [
 ['wrong destination',"UPDATE queue_records SET destination='other/shop'",'record-mismatch'],
 ['wrong intent',"UPDATE queue_records SET intent_hash='wrong'",'record-mismatch'],
 ['wrong asset',"UPDATE queue_records SET asset_fingerprint='wrong'",'record-mismatch'],
 ['wrong schedule',"UPDATE queue_records SET due_at='2031-01-01T12:00:00.000Z'",'record-mismatch'],
 ['sent receipt',"UPDATE queue_records SET sent_receipt='sent-123'",'record-mismatch'],
 ['wrong status',"UPDATE queue_records SET status='draft'",'record-mismatch'],
 ['wrong operation',"UPDATE queue_records SET operation_id='wrong'",'missing'],
 ['missing row','DELETE FROM queue_records','missing'],
 ['stale read','UPDATE queue_source SET fresh=0','read-inconclusive'],
 ['non-authoritative read','UPDATE queue_source SET authoritative=0','read-inconclusive'],
 ['duplicate candidates',"INSERT INTO queue_records SELECT 'duplicate',operation_id,intent_hash,destination,asset_fingerprint,due_at,status,sent_receipt FROM queue_records",'ambiguous']
]) test(`false positive refused: ${name}`,t=>{
 const f=setup(t);f.approve();f.r.execute(f.e,'one','lose-response');f.mutate(sql);
 const j=f.r.verify(f.v,'one');assert.equal(j.state,'uncertain');const evidence=JSON.parse(j.evidence);
 assert.equal(evidence.reason,reason);assert.equal(evidence.requiresHumanReview,true);assert.equal(evidence.record,null);
 f.r.execute(f.e,'one');f.r.recover(f.e);assert.equal(f.counts().writes,1);assert.equal(f.counts().spent,3);
});
test('acknowledged stable ID remains binding across repeated inconclusive reads',t=>{
 const f=setup(t);f.approve();f.r.execute(f.e,'one');f.mutate("UPDATE queue_records SET id='replacement'");
 for(let i=0;i<2;i++) {const j=f.r.verify(f.v,'one');assert.equal(j.state,'uncertain');assert.equal(JSON.parse(j.evidence).reason,'acknowledged-record-mismatch');}
});
test('unavailable source remains reviewable; restoration can reconcile without dispatch',t=>{
 const f=setup(t);f.approve();f.r.execute(f.e,'one','lose-response');renameSync(f.service,`${f.service}.saved`);
 assert.equal(JSON.parse(f.r.verify(f.v,'one').evidence).reason,'read-unavailable');f.r.execute(f.e,'one');
 renameSync(`${f.service}.saved`,f.service);assert.equal(f.r.verify(f.v,'one').state,'verified');assert.equal(f.counts().writes,1);
});
test('known draft transition binds ID, destination and unchanged asset; retained due time is not queued',t=>{
 const f=setup(t);const s=new PublishingQueue(f.service);let id:string;try{id=s.write('seed','seed',proposal);}finally{s.close();}
 f.approve('one',{...proposal,action:'queue.draft',recordId:id});f.r.execute(f.e,'one','lose-response');
 const j=f.r.verify(f.v,'one');assert.equal(j.state,'verified');const record=JSON.parse(j.evidence).record;
 assert.equal(record.id,id);assert.equal(record.status,'draft');assert.equal(record.destination,proposal.key);
 assert.equal(record.asset_fingerprint,proposal.assetFingerprint);assert.equal(record.due_at,proposal.dueAt);assert.equal(record.sent_receipt,null);
 assert.deepEqual(f.counts(),{attempts:1,writes:2,records:1,spent:3});
});
for(const field of ['id','destination','asset_fingerprint','status','sent_receipt']) test(`draft evidence refuses altered ${field}`,t=>{
 const f=setup(t);const s=new PublishingQueue(f.service);let id:string;try{id=s.write('seed','seed',proposal);}finally{s.close();}
 f.approve('one',{...proposal,action:'queue.draft',recordId:id});f.r.execute(f.e,'one','lose-response');
 f.mutate(`UPDATE queue_records SET ${field}='changed'`);assert.equal(f.r.verify(f.v,'one').state,'uncertain');
});
test('queue enforces approval, scope, verifier separation and global budget',t=>{
 const f=setup(t,3);const j=f.r.propose(f.p,'one',proposal);assert.throws(()=>f.r.execute(f.e,'one'),/approval/);
 assert.throws(()=>f.r.decide(f.a,'one','wrong',true),/mismatch/);f.r.decide(f.a,'one',j.hash,true);
 assert.throws(()=>f.r.execute(f.v,'one'),/Unauthorized/);assert.throws(()=>f.r.verify(f.e,'one'),/Unauthorized/);
 assert.throws(()=>f.r.propose(f.p,'other',{...proposal,key:'other/shop'}),/Unauthorized/);
 f.r.execute(f.e,'one');f.approve('two');assert.throws(()=>f.r.execute(f.e,'two'),/Budget/);
 assert.equal(f.r.snapshot().budget!.spent,3);
});
test('queue input snapshots reject accessors, extra fields and invalid date/identity',()=>{
 let coercions=0;
 const objectAction={toString(){coercions++;return 'queue.create';}};
 assert.throws(()=>validateQueueProposal({...proposal,action:objectAction}),/Invalid queue proposal/);
 assert.equal(coercions,0);
 assert.throws(()=>validateQueueProposal({...proposal,['__proto__']:null}),/Invalid queue proposal/);
 let reads=0;assert.throws(()=>validateQueueProposal({...proposal,get key(){reads++;return 'demo/shop';}}));assert.equal(reads,0);
 for(const p of [{...proposal,extra:1},{...proposal,dueAt:'2030-02-31T12:00:00.000Z'},{...proposal,assetFingerprint:'x'},{...proposal,action:'queue.draft'},{...proposal,action:'live.publish'}]) assert.throws(()=>validateQueueProposal(p));
 assert.notEqual(queueOperationId('demo/shop','h'),queueOperationId('other/shop','h'));
});
test('queue CLI demo has machine-checkable proof and remains replay safe',t=>{
 const f=setup(t);
 for(let i=0;i<2;i++) {
  const child=spawnSync(process.execPath,['src/cli.ts','queue-demo',f.dir],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
  const output=JSON.parse(child.stdout);assert.equal(output.state,'verified');assert.equal(output.injectedCrash,i===0);
  assert.equal(output.dispatchAttempts,1);assert.equal(output.serviceWrites,1);assert.equal(output.serviceRecords,1);assert.equal(output.simulatedCreditsSpent,3);
  assert.equal(output.liveService,false);assert.equal(output.auditValid,true);
 }
});
test('concurrent retries of a lost response remain read-only until verifier reconciliation',async t=>{
 const f=setup(t);f.approve();f.r.execute(f.e,'one','lose-response');
 const run=()=>new Promise(resolve=>{const c=spawn(process.execPath,['src/queue-demo-worker.ts',f.dir,'one','none'],{stdio:'ignore'});c.on('exit',resolve);});
 assert.deepEqual(await Promise.all([run(),run(),run()]),[0,0,0]);
 assert.equal(f.r.get(f.p,'one').state,'uncertain');assert.deepEqual(f.counts(),{attempts:1,writes:1,records:1,spent:3});
 assert.equal(f.r.verify(f.v,'one').state,'verified');
});
test('unresolved CLI verification returns nonzero and original adapter shares queue budget',t=>{
 const f=setup(t,3);f.approve();f.r.execute(f.e,'one','lose-response');f.mutate('DELETE FROM queue_records');
 const child=spawnSync(process.execPath,['src/cli.ts','verify',f.dir,'one'],{encoding:'utf8'});
 assert.equal(child.status,1,child.stderr);assert.equal(JSON.parse(child.stdout).state,'uncertain');
 f.approve('original',{key:'demo/result',value:'original adapter'});assert.throws(()=>f.r.execute(f.e,'original'),/Budget/);
 assert.deepEqual(f.counts(),{attempts:1,writes:1,records:0,spent:3});assert.equal(f.r.checkAudit(),true);
});
