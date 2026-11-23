import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as api from 'intentos';
import * as maintenance from 'intentos/storage';
import type { PlannerCapability, VerifierCapability } from 'intentos/agents';
import { Runtime } from '../src/runtime.ts';
function directory(t:any){const path=mkdtempSync(join(tmpdir(),'intentos-rc-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
test('public checkout entry points provide typed capabilities without raw runtime exports',t=>{
 const dir=directory(t);assert.equal(api.VERSION,'1.0.0-rc.1');assert.equal((api as any).Runtime,undefined);assert.equal((api as any).PublishingQueue,undefined);assert.equal((maintenance as any).StorePair,undefined);
 const host=new api.IntentHost(join(dir,'runtime.sqlite'),join(dir,'service.sqlite'));
 try {const planner:PlannerCapability=host.planner('planner');const verifier:VerifierCapability=host.verifier('verifier');
 const j=planner.propose('one',{key:'demo/result',value:'public API'});host.operator('operator').decide(j.id,j.hash,true);host.executor('executor').execute(j.id);assert.equal(verifier.verify(j.id).state,'verified');
 maintenance.checkStores(join(dir,'runtime.sqlite'),join(dir,'service.sqlite'));
 }finally{host.close();}
});
for(const fault of ['backwards','not-a-number','throws'] as const)test(`revocation restricts authority even when trusted clock ${fault}`,t=>{
 const dir=directory(t);let broken=false;
 const clock=()=>{if(!broken)return 1000;if(fault==='throws')throw Error('clock unavailable');return fault==='backwards'?500:NaN;};
 const r=new Runtime(join(dir,'runtime.sqlite'),join(dir,'service.sqlite'),12,{clock});
 try {const p=r.actor('p','planner'),a=r.actor('a','approver'),e=r.actor('e','executor');const j=r.propose(p,'one',{key:'demo/result',value:'stop'});r.decide(a,j.id,j.hash,true);broken=true;
 assert.equal(r.revoke(a,j.id,j.hash).approvalRevokedAt,1000);
 const detail=JSON.parse(String(r.snapshot().audit.find(x=>x.event==='approval-revoked')!.detail));assert.equal(detail.clockStatus,'durable-high-water-fallback');
 broken=false;assert.throws(()=>r.execute(e,j.id),/revoked/);assert.equal(r.snapshot().budget!.spent,0);assert.equal(r.checkAudit(),true);
 }finally{r.close();}
});
test('CLI usage and version are stable and invalid commands do not create stores',t=>{
 const dir=directory(t),target=join(dir,'never-created');
 for(const args of [['typo',target],['execute',target],['approve',target,'one','hash','0'],['deny',target,'one','hash','60'],['--version','extra']]) {
  const run=spawnSync(process.execPath,['src/cli.ts',...args],{encoding:'utf8'});assert.equal(run.status,2,run.stderr);assert.equal(existsSync(target),false);
 }
 for(const script of ['src/cli.ts','src/storage-cli.ts']){
  const version=spawnSync(process.execPath,[script,'--version'],{encoding:'utf8'});assert.equal(version.status,0);assert.equal(version.stdout.trim(),api.VERSION);
  const help=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/Exit codes/);
 }
 const missing=spawnSync(process.execPath,['src/cli.ts','status',target],{encoding:'utf8'});assert.equal(missing.status,1);assert.equal(existsSync(target),false);assert.doesNotMatch(missing.stderr,/at .*\.ts:/);
 const storage=spawnSync(process.execPath,['src/storage-cli.ts','restore',dir,target],{encoding:'utf8'});assert.equal(storage.status,2);assert.equal(existsSync(target),false);
});
test('CLI recovery reports unresolved queue work with exit 1 and structured output',t=>{
 const dir=directory(t),r=new Runtime(join(dir,'runtime.sqlite'),join(dir,'service.sqlite'));
 try{const j=r.propose(r.actor('p','planner'),'one',{action:'queue.create',key:'demo/shop',assetFingerprint:'a'.repeat(64),dueAt:'2030-01-01T12:00:00.000Z'});r.decide(r.actor('a','approver'),j.id,j.hash,true);r.execute(r.actor('e','executor'),j.id,'lose-response');}finally{r.close();}
 const run=spawnSync(process.execPath,['src/cli.ts','recover',dir],{encoding:'utf8'});assert.equal(run.status,1,run.stderr);assert.equal(JSON.parse(run.stdout)[0].state,'uncertain');
 const verify=spawnSync(process.execPath,['src/cli.ts','verify',dir,'one'],{encoding:'utf8'});assert.equal(verify.status,0,verify.stderr);assert.equal(JSON.parse(verify.stdout).state,'verified');
});
