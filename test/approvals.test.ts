import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Runtime, MAX_APPROVAL_LIFETIME_MS } from '../src/runtime.ts';
import { IntentHost } from '../src/host.ts';
import { upgradeApprovalState, backupPair, restorePair, STORAGE_VERSION } from '../src/storage.ts';
const original={key:'demo/result',value:'hello'};
const queue={action:'queue.create',key:'demo/shop',assetFingerprint:'a'.repeat(64),dueAt:'2030-01-01T12:00:00.000Z'};
function setup(t:any,payload:unknown=original) {
 const dir=mkdtempSync(join(tmpdir(),'intentos-approvals-'));const state=join(dir,'runtime.sqlite'),service=join(dir,'service.sqlite');let now=1000;
 const r=new Runtime(state,service,12,{clock:()=>now});let closed=false;
 const close=()=>{if(!closed){r.close();closed=true;}};
 t.after(()=>{close();rmSync(dir,{recursive:true,force:true});});
 const p=r.actor('planner','planner'),a=r.actor('operator','approver'),e=r.actor('executor','executor'),v=r.actor('verifier','verifier');
 const j=r.propose(p,'one',payload);
 return {dir,state,service,r,p,a,e,v,j,close,setTime:(n:number)=>{now=n;},approve:(ttl=1000)=>r.decide(a,'one',j.hash,true,ttl),spent:()=>r.snapshot().budget!.spent};
}
for(const [name,payload] of [['original',original],['queue',queue]] as const) {
 test(`${name}: exact expiry boundary denies without a claim, debit or write`,t=>{
  const f=setup(t,payload);const decision=f.approve();assert.equal(decision.approvalExpiresAt,2000);
  f.setTime(2000);assert.throws(()=>f.r.execute(f.e,'one'),/expired/);
  assert.equal(f.spent(),0);assert.equal(f.r.snapshot().approvalTerms[0].claimed_at,null);
  assert.equal(f.r.get(f.p,'one').state,'approved');assert.throws(()=>f.r.decide(f.a,'one',f.j.hash,true,1000),/invalid state/);
 });
 test(`${name}: last instant before expiry may claim and later expiry cannot undo it`,t=>{
  const f=setup(t,payload);f.approve();f.setTime(1999);f.r.execute(f.e,'one');
  f.setTime(5000);f.r.execute(f.e,'one');assert.equal(f.r.verify(f.v,'one').state,'verified');assert.equal(f.spent(),3);
  assert.equal(f.r.get(f.p,'one').dispatchClaimedAt,1999);
 });
 test(`${name}: revoked approval survives physical restart and blocks first dispatch`,t=>{
  const f=setup(t,payload);f.approve();const revoked=f.r.revoke(f.a,'one',f.j.hash);assert.equal(revoked.approvalRevokedAt,1000);
  const child=spawnSync(process.execPath,['test/approval-worker.ts',f.dir,'execute','1500'],{encoding:'utf8'});
  assert.equal(child.status,1);assert.match(child.stderr,/revoked/);assert.equal(f.spent(),0);
  f.r.revoke(f.a,'one',f.j.hash);assert.equal(f.r.snapshot().revocations.length,1);assert.throws(()=>f.r.decide(f.a,'one',f.j.hash,true),/invalid state|revoked/);
 });
 test(`${name}: expired approval survives physical restart`,t=>{
  const f=setup(t,payload);f.approve();const child=spawnSync(process.execPath,['test/approval-worker.ts',f.dir,'execute','2000'],{encoding:'utf8'});
  assert.equal(child.status,1);assert.match(child.stderr,/expired/);assert.equal(f.spent(),0);
 });
 test(`${name}: claim before revocation stays recoverable after process death`,t=>{
  const f=setup(t,payload);f.approve();const child=spawnSync(process.execPath,['test/approval-worker.ts',f.dir,'execute','1500','after-effect'],{encoding:'utf8'});
  assert.equal(child.status,72,child.stderr);f.setTime(3000);f.r.revoke(f.a,'one',f.j.hash);
  f.r.recover(f.e);assert.equal(f.r.verify(f.v,'one').state,'verified');assert.equal(f.spent(),3);
  const event=f.r.snapshot().audit.find(x=>x.event==='approval-revoked')!;assert.equal(JSON.parse(String(event.detail)).effect,'already-dispatched-no-undo');
  const db=new DatabaseSync(f.service);try{assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${name==='queue'?'queue_writes':'effects'}`).get()!.n,1);}finally{db.close();}
 });
 test(`${name}: simultaneous revoke and execute obey one transaction order`,async t=>{
  const f=setup(t,payload);f.approve();
  const run=(op:string)=>new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,['test/approval-worker.ts',f.dir,op,'1500'],{stdio:'ignore'});child.on('error',reject);child.on('exit',resolve);});
  const [executed,revoked]=await Promise.all([run('execute'),run('revoke')]);assert.equal(revoked,0);assert.ok(executed===0 || executed===1);
  const audit=f.r.snapshot().audit;const rev=audit.find(x=>x.event==='approval-revoked')!;const claim=audit.find(x=>x.event==='approval-claimed');
  if(claim){assert.ok(Number(claim.seq)<Number(rev.seq));assert.equal(executed,0);assert.equal(f.spent(),3);assert.equal(f.r.verify(f.v,'one').state,'verified');}
  else{assert.equal(executed,1);assert.equal(f.spent(),0);assert.equal(f.r.get(f.p,'one').state,'approved');}
 });
}
test('original claim before-effect remains authorized recovery; queue claim before-effect never resends',t=>{
 const f=setup(t);f.approve();assert.equal(spawnSync(process.execPath,['test/approval-worker.ts',f.dir,'execute','1500','before-effect']).status,71);
 f.setTime(3000);f.r.revoke(f.a,'one',f.j.hash);f.r.recover(f.e);assert.equal(f.r.verify(f.v,'one').state,'verified');assert.equal(f.spent(),3);
});
test('queue claim with no write remains uncertain after revocation and expiry',t=>{
 const f=setup(t,queue);f.approve();assert.equal(spawnSync(process.execPath,['test/approval-worker.ts',f.dir,'execute','1500','before-effect']).status,71);
 f.setTime(3000);f.r.revoke(f.a,'one',f.j.hash);f.r.recover(f.e);assert.equal(f.r.verify(f.v,'one').state,'uncertain');assert.equal(f.spent(),3);
 const db=new DatabaseSync(f.service);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue_writes').get()!.n,0);}finally{db.close();}
});
test('revocation requires trusted operator, exact digest and correct scope',t=>{
 const f=setup(t);f.approve();assert.throws(()=>f.r.revoke(f.p,'one',f.j.hash),/Unauthorized/);assert.throws(()=>f.r.revoke(f.v,'one',f.j.hash),/Unauthorized/);
 assert.throws(()=>f.r.revoke(f.a,'one','stale'),/exact/);assert.throws(()=>f.r.revoke(f.r.actor('wrong','approver','other/'),'one',f.j.hash),/Unauthorized/);
 assert.equal(f.r.snapshot().revocations.length,0);assert.throws(()=>f.r.decide(f.a,'one',f.j.hash,true,1),/invalid state/);
});
test('finite lifetime validation rejects zero, infinity, fractional and overflow inputs',t=>{
 const f=setup(t);
 for(const ttl of [0,-1,Infinity,NaN,0.5,MAX_APPROVAL_LIFETIME_MS+1])assert.throws(()=>f.approve(ttl),/lifetime/);
 f.setTime(Number.MAX_SAFE_INTEGER);assert.throws(()=>f.approve(1),/overflow/);assert.equal(f.r.snapshot().approvalTerms.length,0);
});
test('clock rollback after denied expiry cannot resurrect an approval, including restart',t=>{
 const f=setup(t);f.approve();f.setTime(2000);assert.throws(()=>f.r.execute(f.e,'one'),/expired/);
 f.setTime(1500);assert.throws(()=>f.r.execute(f.e,'one'),/backwards/);
 const child=spawnSync(process.execPath,['test/approval-worker.ts',f.dir,'execute','1500'],{encoding:'utf8'});assert.equal(child.status,1);assert.match(child.stderr,/backwards/);assert.equal(f.spent(),0);
});
test('invalid trusted clock fails closed; insufficient budget does not consume claim',t=>{
 const f=setup(t);f.setTime(NaN);assert.throws(()=>f.approve(),/clock invalid/);f.setTime(1000);f.approve();
 const db=new DatabaseSync(f.state);try{db.exec('UPDATE budget SET cap=0');}finally{db.close();}
 assert.throws(()=>f.r.execute(f.e,'one'),/Budget/);assert.equal(f.r.snapshot().approvalTerms[0].claimed_at,null);assert.equal(f.spent(),0);
});
test('trusted host exposes immutable expiry/revocation metadata but no new agent authority',t=>{
 const f=setup(t);const host=new IntentHost(f.state,f.service,12,{clock:()=>1000,approvalLifetimeMs:500});
 try{const planner=host.planner('p'),operator=host.operator('o'),verifier=host.verifier('v');const j=operator.decide('one',f.j.hash,true);assert.equal(j.approvalExpiresAt,1500);assert.ok(Object.isFrozen(j));
 assert.equal((planner as any).revoke,undefined);assert.equal((verifier as any).revoke,undefined);operator.revoke('one',f.j.hash);assert.equal(planner.get('one').approvalRevokedAt,1000);assert.equal(verifier.get('one').approvalExpiresAt,1500);
 }finally{host.close();}
});
function downgradeFixture(f:{state:string;service:string}) {
 for(const path of [f.state,f.service]) {const db=new DatabaseSync(path);try{if(path===f.state)db.exec('DROP TABLE approval_terms; DROP TABLE approval_revocations; DROP TABLE approval_clock;');db.exec('UPDATE storage_meta SET schema_version=1; PRAGMA user_version=1;');}finally{db.close();}}
 const path=`${f.state}.pair.json`;const anchor=JSON.parse(readFileSync(path,'utf8'));anchor.version=1;writeFileSync(path,JSON.stringify(anchor));
}
test('explicit format-1 upgrade does not silently authorize an old approved decision',t=>{
 const f=setup(t);f.approve();f.close();downgradeFixture(f);
 assert.throws(()=>new Runtime(f.state,f.service),/Storage refused/);assert.equal(upgradeApprovalState(f.state,f.service).legacyApprovalsReauthorized,false);
 const r=new Runtime(f.state,f.service,12,{clock:()=>5000});try{assert.throws(()=>r.execute(r.actor('e','executor'),'one'),/Finite exact approval/);assert.equal(r.snapshot().budget!.spent,0);
 r.decide(r.actor('o','approver'),'one',f.j.hash,true,1000);r.execute(r.actor('e','executor'),'one');assert.equal(r.verify(r.actor('v','verifier'),'one').state,'verified');}finally{r.close();}
});
test('format-1 in-flight queue remains reconcilable after upgrade and revocation',t=>{
 const f=setup(t,queue);f.approve();f.r.execute(f.e,'one','lose-response');f.close();downgradeFixture(f);upgradeApprovalState(f.state,f.service);
 const r=new Runtime(f.state,f.service,12,{clock:()=>5000});try{r.revoke(r.actor('o','approver'),'one',f.j.hash);r.recover(r.actor('e','executor'));assert.equal(r.verify(r.actor('v','verifier'),'one').state,'verified');assert.equal(r.snapshot().budget!.spent,3);}finally{r.close();}
});
test('backup/restore preserves revocation and absolute expiry without renewing them',t=>{
 const f=setup(t);f.approve();f.r.revoke(f.a,'one',f.j.hash);f.close();const backup=join(f.dir,'backup'),restored=join(f.dir,'restored');backupPair(f.state,f.service,backup);restorePair(backup,restored);
 const r=new Runtime(join(restored,'runtime.sqlite'),join(restored,'service.sqlite'),12,{clock:()=>1500});try{const j=r.get(r.actor('p','planner'),'one');assert.equal(j.approvalExpiresAt,2000);assert.equal(j.approvalRevokedAt,1000);assert.throws(()=>r.execute(r.actor('e','executor'),'one'),/revoked/);assert.equal(r.snapshot().budget!.spent,0);}finally{r.close();}
});
test('format-1 backup restore upgrades without manufacturing approval lifetimes',t=>{
 const f=setup(t);f.approve();f.close();const backup=join(f.dir,'backup'),restored=join(f.dir,'restored');backupPair(f.state,f.service,backup);
 const manifest=JSON.parse(readFileSync(join(backup,'backup.json'),'utf8'));manifest.storageVersion=1;
 for(const name of ['runtime.sqlite','service.sqlite']) {const path=join(backup,name),db=new DatabaseSync(path);try{if(name==='runtime.sqlite')db.exec('DROP TABLE approval_terms; DROP TABLE approval_revocations; DROP TABLE approval_clock;');db.exec('UPDATE storage_meta SET schema_version=1; PRAGMA user_version=1;');}finally{db.close();}manifest.files[name]=createHash('sha256').update(readFileSync(path)).digest('hex');}
 writeFileSync(join(backup,'backup.json'),JSON.stringify(manifest));assert.equal(restorePair(backup,restored).storageVersion,STORAGE_VERSION);
 const r=new Runtime(join(restored,'runtime.sqlite'),join(restored,'service.sqlite'),12,{clock:()=>1500});try{assert.throws(()=>r.execute(r.actor('e','executor'),'one'),/Finite exact approval/);}finally{r.close();}
});
test('CLI approve lifetime and revoke survive independent invocations',t=>{
 const f=setup(t);const run=(...args:string[])=>spawnSync(process.execPath,['src/cli.ts',...args],{encoding:'utf8'});
 const approval=run('approve',f.dir,'one',f.j.hash,'60');assert.equal(approval.status,0,approval.stderr);const j=JSON.parse(approval.stdout);assert.ok(j.approvalExpiresAt>Date.now());
 const revoked=run('revoke',f.dir,'one',f.j.hash);assert.equal(revoked.status,0,revoked.stderr);assert.equal(run('execute',f.dir,'one').status,1);assert.equal(f.spent(),0);
});
test('format-1 upgrade refuses preexisting lifetime tables instead of retaining hidden authorization',t=>{
 const f=setup(t);f.approve();f.close();
 for(const path of [f.state,f.service]){const db=new DatabaseSync(path);try{db.exec('UPDATE storage_meta SET schema_version=1; PRAGMA user_version=1;');}finally{db.close();}}
 const path=`${f.state}.pair.json`,anchor=JSON.parse(readFileSync(path,'utf8'));anchor.version=1;writeFileSync(path,JSON.stringify(anchor));
 assert.throws(()=>upgradeApprovalState(f.state,f.service),/unsupported approval state/);
});
