import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, renameSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Runtime } from '../src/runtime.ts';
import { StorePair, STORAGE_VERSION, adoptLegacyPair, backupPair, restorePair } from '../src/storage.ts';
import { RUNTIME_SCHEMA, SERVICE_SCHEMA } from '../src/schema.ts';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const p={key:'demo/result',value:'hello'};
const q={action:'queue.create',key:'demo/shop',assetFingerprint:'a'.repeat(64),dueAt:'2030-01-01T12:00:00.000Z'};
function setup(t:any) {const root=mkdtempSync(join(tmpdir(),'intentos-storage-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,runtime:join(root,'runtime.sqlite'),service:join(root,'service.sqlite')};}
function approve(r:Runtime,id='one',payload:unknown=p) {const j=r.propose(r.actor('p','planner'),id,payload);r.decide(r.actor('o','approver'),id,j.hash,true);return j;}
function sql(path:string,text:string) {const db=new DatabaseSync(path);try{db.exec(text);}finally{db.close();}}
function legacy(runtime:string,service:string,queueSchema=false) {
 const r=new DatabaseSync(runtime);const s=new DatabaseSync(service);
 try {
  r.exec(RUNTIME_SCHEMA);s.exec(SERVICE_SCHEMA);
  if(!queueSchema){r.exec('DROP TABLE queue_attempts');s.exec('DROP TABLE queue_records; DROP TABLE queue_writes; DROP TABLE queue_source;');}
  r.prepare('INSERT INTO budget VALUES(1,12,0)').run();
  const payload=JSON.stringify(p),hash=digest({id:'one',action:'simulated.put',payload,cost:3,policy:1});
  r.prepare("INSERT INTO jobs VALUES(?,?,?,'approved',3,?,NULL,NULL)").run('one',payload,hash,hash);
  let previous='genesis';
  for(const event of ['proposed','approved']) {const detail=JSON.stringify({id:'one',hash});const auditHash=digest({actor:'legacy-operator',event,detail,previous});r.prepare('INSERT INTO audit(actor,event,detail,previous,hash) VALUES(?,?,?,?,?)').run('legacy-operator',event,detail,previous,auditHash);previous=auditHash;}
 }finally{r.close();s.close();}
}
test('fresh initialization pairs versioned stores and retains cap on reopen',t=>{
 const f=setup(t);let r=new Runtime(f.runtime,f.service,9);assert.ok(existsSync(f.service));r.close();
 const anchor=JSON.parse(readFileSync(`${f.runtime}.pair.json`,'utf8'));assert.equal(anchor.phase,'ready');
 for(const [path,role] of [[f.runtime,'runtime'],[f.service,'service']]) {const db=new DatabaseSync(path);try{const row=db.prepare('SELECT * FROM storage_meta').get()!;assert.equal(row.schema_version,STORAGE_VERSION);assert.equal(row.role,role);assert.equal(row.pair_id,anchor.pairId);}finally{db.close();}}
 r=new Runtime(f.runtime,f.service,999);try{assert.equal(r.snapshot().budget!.cap,9);}finally{r.close();}
});
test('check and backup cannot silently initialize missing stores',t=>{
 const f=setup(t);assert.throws(()=>new StorePair(f.runtime,f.service,12,false),/no initialized pair/);
 assert.throws(()=>backupPair(f.runtime,f.service,join(f.root,'backup')),/no initialized pair/);assert.equal(existsSync(f.runtime),false);
});
for(const role of ['runtime','service']) test(`missing ${role} is refused on reopen and live calls`,t=>{
 const f=setup(t);const r=new Runtime(f.runtime,f.service);approve(r);
 const target=role==='runtime'?f.runtime:f.service;renameSync(target,`${target}.saved`);
 try {
  assert.throws(()=>r.execute(r.actor('e','executor'),'one'),/Storage refused/);
  assert.throws(()=>r.verify(r.actor('v','verifier'),'one'),/Storage refused/);
  assert.throws(()=>new Runtime(f.runtime,f.service),/Storage refused/);assert.equal(existsSync(target),false);
 }finally{renameSync(`${target}.saved`,target);r.close();}
 const reopened=new Runtime(f.runtime,f.service);try{assert.equal(reopened.snapshot().budget!.spent,0);}finally{reopened.close();}
});
test('anchor survives loss of both files and blocks silent reset',t=>{
 const f=setup(t);new Runtime(f.runtime,f.service).close();rmSync(f.runtime);rmSync(f.service);
 assert.throws(()=>new Runtime(f.runtime,f.service),/missing paired store/);assert.equal(existsSync(f.runtime),false);
});
test('wrong service and replacement files are rejected before dispatch or evidence',t=>{
 const f=setup(t);const other=join(f.root,'other');mkdirSync(other);new Runtime(join(other,'runtime.sqlite'),join(other,'service.sqlite')).close();
 const r=new Runtime(f.runtime,f.service);approve(r);const e=r.actor('e','executor');
 assert.throws(()=>new Runtime(f.runtime,join(other,'service.sqlite')),/wrong service path/);
 renameSync(f.service,`${f.service}.saved`);copyFileSync(join(other,'service.sqlite'),f.service);
 try{assert.throws(()=>r.execute(e,'one'),/file was replaced/);assert.throws(()=>r.verify(r.actor('v','verifier'),'one'),/file was replaced/);}finally{rmSync(f.service);renameSync(`${f.service}.saved`,f.service);r.close();}
});
test('copied historical file from the same pair is rejected by physical identity',t=>{
 const f=setup(t);new Runtime(f.runtime,f.service).close();copyFileSync(f.service,`${f.service}.old`);renameSync(`${f.service}.old`,f.service);
 assert.throws(()=>new Runtime(f.runtime,f.service),/file was replaced/);
});
for(const role of ['runtime','service']) test(`future schema in ${role} fails before mutation`,t=>{
 const f=setup(t);new Runtime(f.runtime,f.service).close();const path=role==='runtime'?f.runtime:f.service;sql(path,'PRAGMA user_version=99');
 const before=readFileSync(path);assert.throws(()=>new Runtime(f.runtime,f.service),/unsupported schema version/);assert.deepEqual(readFileSync(path),before);
});
test('mismatched peer metadata, missing table and unfinished initialization all fail closed',t=>{
 const f=setup(t);new Runtime(f.runtime,f.service).close();sql(f.service,"UPDATE storage_meta SET peer_id='wrong'");
 assert.throws(()=>new Runtime(f.runtime,f.service),/identities/);
 const anchor=JSON.parse(readFileSync(`${f.runtime}.pair.json`,'utf8'));sql(f.service,`UPDATE storage_meta SET peer_id='${anchor.runtimeId}'`);
 sql(f.service,'DROP TABLE effects');assert.throws(()=>new Runtime(f.runtime,f.service),/schema differs/);
 anchor.phase='initializing';writeFileSync(`${f.runtime}.pair.json`,JSON.stringify(anchor));assert.throws(()=>new Runtime(f.runtime,f.service),/initialization incomplete/);
});
for(const queueSchema of [false,true]) test(`explicit legacy upgrade preserves approval and audit (${queueSchema?'queue-era':'original-era'} schema)`,t=>{
 const f=setup(t);legacy(f.runtime,f.service,queueSchema);
 assert.throws(()=>new Runtime(f.runtime,f.service),/explicit legacy adoption/);
 const before=new DatabaseSync(f.runtime);const original=before.prepare('SELECT * FROM jobs').get();before.close();
 assert.equal(adoptLegacyPair(f.runtime,f.service).storageVersion,1);
 const r=new Runtime(f.runtime,f.service);try{assert.deepEqual(r.snapshot().jobs[0],original);assert.equal(r.checkAudit(),true);r.execute(r.actor('e','executor'),'one');assert.equal(r.verify(r.actor('v','verifier'),'one').state,'verified');assert.equal(r.snapshot().budget!.spent,3);}finally{r.close();}
 assert.throws(()=>adoptLegacyPair(f.runtime,f.service),/versioned/);
});
for(const mutation of ['spend','executing','effect','attempt','bad-audit']) test(`legacy ${mutation} is refused without an adoption anchor`,t=>{
 const f=setup(t);legacy(f.runtime,f.service,true);
 if(mutation==='spend')sql(f.runtime,'UPDATE budget SET spent=3');
 if(mutation==='executing')sql(f.runtime,"UPDATE jobs SET state='executing'");
 if(mutation==='effect')sql(f.service,"INSERT INTO effects VALUES('x','x','x')");
 if(mutation==='attempt')sql(f.runtime,"INSERT INTO queue_attempts VALUES('one','op','demo/shop','hash',NULL)");
 if(mutation==='bad-audit')sql(f.runtime,"UPDATE audit SET detail='{}'");
 assert.throws(()=>adoptLegacyPair(f.runtime,f.service),/Storage refused/);assert.equal(existsSync(`${f.runtime}.pair.json`),false);
});
test('legacy adoption refuses missing counterpart without creating it',t=>{
 const f=setup(t);legacy(f.runtime,f.service);rmSync(f.service);assert.throws(()=>adoptLegacyPair(f.runtime,f.service),/missing paired store/);assert.equal(existsSync(f.service),false);
});
for(const adapter of ['original','queue']) test(`offline backup/restore keeps ${adapter} crash recovery deterministic`,t=>{
 const f=setup(t);const r=new Runtime(f.runtime,f.service);approve(r,'one',adapter==='queue'?q:p);r.close();
 const child=spawnSync(process.execPath,['test/crash-worker.ts',f.root,'after-effect','one'],{encoding:'utf8'});assert.equal(child.status,72,child.stderr);
 const backup=join(f.root,'backup'),restored=join(f.root,'restored');backupPair(f.runtime,f.service,backup);restorePair(backup,restored);
 const recovered=new Runtime(join(restored,'runtime.sqlite'),join(restored,'service.sqlite'));
 try {
  assert.equal(recovered.snapshot().jobs[0].state,adapter==='queue'?'uncertain':'executing');
  recovered.recover(recovered.actor('e','executor'));assert.equal(recovered.verify(recovered.actor('v','verifier'),'one').state,'verified');assert.equal(recovered.snapshot().budget!.spent,3);assert.equal(recovered.checkAudit(),true);
  const service=new DatabaseSync(join(restored,'service.sqlite'));try{assert.equal(service.prepare(`SELECT COUNT(*) AS n FROM ${adapter==='queue'?'queue_records':'effects'}`).get()!.n,1);if(adapter==='queue')assert.equal(service.prepare('SELECT COUNT(*) AS n FROM queue_writes').get()!.n,1);}finally{service.close();}
 }finally{recovered.close();}
 const oldAnchor=JSON.parse(readFileSync(`${f.runtime}.pair.json`,'utf8'));const newAnchor=JSON.parse(readFileSync(join(restored,'runtime.sqlite.pair.json'),'utf8'));assert.notEqual(newAnchor.pairId,oldAnchor.pairId);
});
test('backup refuses an active writer, restore refuses modified or partial backups and existing targets',t=>{
 const f=setup(t);const r=new Runtime(f.runtime,f.service);const writer=new DatabaseSync(f.runtime);writer.exec('BEGIN IMMEDIATE');
 try{assert.throws(()=>backupPair(f.runtime,f.service,join(f.root,'busy')));}finally{writer.exec('ROLLBACK');writer.close();r.close();}
 const backup=join(f.root,'backup');backupPair(f.runtime,f.service,backup);
 assert.throws(()=>restorePair(backup,f.root),/must not exist/);
 sql(join(backup,'service.sqlite'),"UPDATE queue_source SET fresh=0");assert.throws(()=>restorePair(backup,join(f.root,'corrupt')),/checksum/);
 rmSync(join(backup,'backup.json'));assert.throws(()=>restorePair(backup,join(f.root,'partial')));assert.equal(existsSync(join(f.root,'partial')),false);
});
test('storage maintenance CLI checks, backs up, restores and checks a pair',t=>{
 const f=setup(t);new Runtime(f.runtime,f.service).close();const backup=join(f.root,'backup'),restored=join(f.root,'restored');
 for(const args of [['check',f.root],['backup',f.root,backup,'--confirm-stopped-workers'],['restore',backup,restored,'--confirm-stopped-workers'],['check',restored]]) {
  const child=spawnSync(process.execPath,['src/storage-cli.ts',...args],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).storageVersion,1);
 }
});

test('legacy adoption refuses tables with familiar names but missing constraints before writing an anchor',t=>{
 const f=setup(t);legacy(f.runtime,f.service,true);
 sql(f.service,'DROP TABLE queue_writes; CREATE TABLE queue_writes(seq INTEGER, operation_id TEXT, record_id TEXT);');
 assert.throws(()=>adoptLegacyPair(f.runtime,f.service),/schema differs at queue_writes/);
 assert.equal(existsSync(f.runtime+'.pair.json'),false);
});
test('versioned stores refuse unexpected schema objects',t=>{
 const f=setup(t);new Runtime(f.runtime,f.service).close();
 sql(f.service,'CREATE INDEX unexpected ON queue_records(destination);');
 assert.throws(()=>new Runtime(f.runtime,f.service),/schema differs at unexpected/);
});
