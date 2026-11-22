import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Runtime, SimulatedService, validateProposal } from '../src/runtime.ts';
import { OfflinePlanner, ProviderPlanner } from '../src/adapters.ts';
function setup(t: any, cap=12) {
  const dir = mkdtempSync(join(tmpdir(),'intentos-'));
  let r = new Runtime(`${dir}/runtime.sqlite`,`${dir}/service.sqlite`,cap);
  t.after(() => { r.close(); rmSync(dir,{recursive:true,force:true}); });
  return { dir, get r() { return r; }, restart() { r.close(); r = new Runtime(`${dir}/runtime.sqlite`,`${dir}/service.sqlite`,9999); },
    actors() { return { p:r.actor('planner','planner'), a:r.actor('human','approver'), e:r.actor('executor','executor'), v:r.actor('verifier','verifier') }; } };
}
const proposal = { key:'demo/result',value:'finished' };
function approve(f: any,id='one') { const {p,a} = f.actors(); const j=f.r.propose(p,id,proposal); f.r.decide(a,id,j.hash,true); return j; }
test('offline planner, scoped actors, exact approval and independent verification',async t => {
  const f=setup(t); const {p,a,e,v}=f.actors();
  const j=f.r.propose(p,'one',await new OfflinePlanner().propose('finished'));
  assert.throws(()=>f.r.execute(e,'one'),/approval/);
  assert.throws(()=>f.r.decide(a,'one','wrong',true),/mismatch/);
  assert.throws(()=>f.r.decide(p,'one',j.hash,true),/Unauthorized/);
  assert.throws(()=>f.r.propose({...p},'fake',proposal),/Unauthorized/);
  assert.throws(()=>f.r.propose(p,'outside',{key:'private/result',value:'x'}),/Unauthorized/);
  f.r.decide(a,'one',j.hash,true);
  assert.throws(()=>f.r.verify(v,'one'),/not applied/);
  f.r.execute(e,'one');
  assert.throws(()=>f.r.verify(p,'one'),/Unauthorized/);
  assert.equal(f.r.verify(v,'one').state,'verified');
  assert.equal(JSON.parse(f.r.verify(v,'one').evidence).matched,true);
  assert.equal(f.r.checkAudit(),true);
  assert.equal(f.r.snapshot().audit.filter(x=>x.event==='denied').length,7);
});
test('immutable intents, exact rejection, idempotent replay, persisted cap',t=>{
  const f=setup(t,3); const j=approve(f); const {p,a,e}=f.actors();
  assert.throws(()=>f.r.propose(p,'one',{...proposal,value:'changed'}),/conflict/);
  assert.equal(f.r.propose(p,'one',proposal).hash,j.hash);
  f.r.execute(e,'one'); f.r.execute(e,'one');
  const denied=f.r.propose(p,'denied',proposal); f.r.decide(a,'denied',denied.hash,false);
  assert.throws(()=>f.r.execute(e,'denied'),/approval/);
  approve(f,'two'); assert.throws(()=>f.r.execute(e,'two'),/Budget/);
  f.restart(); assert.deepEqual({...f.r.snapshot().budget},{cap:3,spent:3});
  assert.throws(()=>f.r.execute(f.actors().e,'two'),/Budget/);
});
for (const point of ['before-effect','after-effect','before-commit']) test(`process death ${point}: durable recovery without duplicate charge/effect`,t=>{
  const f=setup(t); approve(f);
  const child=spawnSync(process.execPath,['test/crash-worker.ts',f.dir,point],{encoding:'utf8'});
  assert.equal(child.status,point==='before-effect'?71:point==='after-effect'?72:73,child.stderr);
  f.restart(); assert.equal(f.r.snapshot().jobs[0].state,'executing');
  f.r.recover(f.actors().e); f.r.recover(f.actors().e);
  assert.equal(f.r.verify(f.actors().v,'one').state,'verified');
  assert.equal(f.r.snapshot().budget!.spent,3);
  const db=new DatabaseSync(`${f.dir}/service.sqlite`); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM effects').get()!.n,1); db.close();
  assert.equal(f.r.checkAudit(),true);
});
test('read-back mismatch fails closed and retains conservative spend',t=>{
  const f=setup(t); approve(f); f.r.execute(f.actors().e,'one');
  const db=new DatabaseSync(`${f.dir}/service.sqlite`); db.prepare('UPDATE effects SET payload=?').run('{}'); db.close();
  assert.equal(f.r.verify(f.actors().v,'one').state,'failed');
  assert.throws(()=>f.r.execute(f.actors().e,'one'),/approval/);
  assert.equal(f.r.snapshot().budget!.spent,3);
});
test('service refuses idempotency conflict and audit detects modified event',t=>{
  const f=setup(t); const s=new SimulatedService(`${f.dir}/service.sqlite`);
  s.apply('x',proposal); assert.throws(()=>s.apply('x',{...proposal,value:'other'}),/conflict/); s.close();
  approve(f); const db=new DatabaseSync(`${f.dir}/runtime.sqlite`); db.exec("UPDATE audit SET detail='{}' WHERE seq=1"); db.close();
  assert.equal(f.r.checkAudit(),false);
});
test('concurrent processes cannot overspend a shared budget',async t=>{
  const f=setup(t,3); approve(f,'one'); approve(f,'two');
  const run=(id: string)=>new Promise(resolve=>{ const c=spawn(process.execPath,['test/crash-worker.ts',f.dir,'none',id],{stdio:'ignore'}); c.on('exit',resolve); });
  const statuses=await Promise.all([run('one'),run('two')]); assert.deepEqual(statuses.sort(),[0,1]);
  assert.equal(f.r.snapshot().budget!.spent,3); assert.equal(f.r.snapshot().jobs.filter(j=>j.state==='applied').length,1);
});
test('strict proposal and integer budget validation',t=>{
  const f=setup(t); assert.throws(()=>validateProposal({...proposal,command:'shell'}));
  assert.throws(()=>validateProposal({key:'demo/../secret',value:'x'}));
  assert.throws(()=>validateProposal({...proposal,value:'x'.repeat(4097)}));
  assert.throws(()=>new Runtime(`${f.dir}/x`,`${f.dir}/y`,1.2));
});
for(const provider of ['openai','anthropic'] as const) test(`${provider} adapter mocked HTTP contract; no execution capability`,async()=>{
  let calls=0;
  const p=new ProviderPlanner(provider,'explicit-model','mock-key',async(url,init)=>{
    calls++; assert.equal(init.method,'POST');
    assert.equal(url,provider==='openai'?'https://api.openai.com/v1/chat/completions':'https://api.anthropic.com/v1/messages');
    const body=JSON.parse(init.body); assert.equal(body.model,'explicit-model'); assert.equal(body.tools,undefined);
    assert.equal(body.messages.at(-1).content,'goal');
    assert.equal(provider==='openai'?init.headers.authorization:init.headers['x-api-key'],provider==='openai'?'Bearer mock-key':'mock-key');
    return {ok:true,json:async()=>provider==='openai'?{choices:[{message:{content:JSON.stringify(proposal)}}]}:{content:[{type:'text',text:JSON.stringify(proposal)}]}};
  });
  assert.deepEqual(await p.propose('goal'),proposal); assert.equal(calls,1);
  for(const response of [{ok:false,json:async()=>({})},{ok:true,json:async()=>({})},{ok:true,json:async()=>({choices:[{message:{content:'{"command":"rm"}'}}],content:[{type:'text',text:'{"command":"rm"}'}]})}]) {
    await assert.rejects(new ProviderPlanner(provider,'m','k',async()=>response).propose('goal'));
  }
});
test('recover authenticates before reading jobs, including empty and nonmatching scope',t=>{
  const f=setup(t);
  assert.throws(()=>f.r.recover(f.actors().p),/Unauthorized/);
  assert.throws(()=>f.r.recover({id:'forged',role:'executor',prefix:'other/'}),/Unauthorized/);
  assert.deepEqual(f.r.recover(f.r.actor('other','executor','other/')),[]);
});
test('CLI verification mismatch returns nonzero and persists failed evidence',t=>{
  const f=setup(t); approve(f); f.r.execute(f.actors().e,'one');
  const db=new DatabaseSync(`${f.dir}/service.sqlite`); db.exec('DELETE FROM effects'); db.close();
  const child=spawnSync(process.execPath,['src/cli.ts','verify',f.dir,'one'],{encoding:'utf8'});
  assert.equal(child.status,1,child.stderr); assert.equal(JSON.parse(child.stdout).state,'failed');
  assert.equal(f.r.snapshot().jobs[0].state,'failed');
});
