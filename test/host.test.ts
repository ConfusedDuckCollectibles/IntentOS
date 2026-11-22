import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { IntentHost } from '../src/host.ts';
import { Runtime } from '../src/runtime.ts';
import { planOffline, verifyOffline } from '../src/demo-agents.ts';
function setup(t: any) {
  const dir=mkdtempSync(join(tmpdir(),'intentos-host-'));
  const host=new IntentHost(`${dir}/runtime.sqlite`,`${dir}/service.sqlite`);
  t.after(()=>{ host.close(); rmSync(dir,{recursive:true,force:true}); });
  return {dir,host};
}
const p = { key:'demo/result',value:'hello' };
test('agent surfaces are immutable and exclude host, operator, service and execution authority',t=>{
  const {host}=setup(t); const planner=host.planner('planner'), verifier=host.verifier('verifier');
  assert.deepEqual(Object.keys(planner).sort(),['get','list','propose']);
  assert.deepEqual(Object.keys(verifier).sort(),['get','list','verify']);
  for(const cap of [planner,verifier]) {
    assert.equal(Object.getPrototypeOf(cap),null); assert.ok(Object.isFrozen(cap));
    assert.deepEqual(Object.getOwnPropertySymbols(cap),[]);
    for(const key of ['actor','planner','verifier','operator','executor','execute','recover','decide','snapshot','inspect','close','runtime','service','db','prefix','role']) assert.equal((cap as any)[key],undefined);
    assert.throws(()=>Object.assign(cap,{prefix:'other/'}),TypeError);
    assert.throws(()=>Object.setPrototypeOf(cap,host),TypeError);
  }
  assert.throws(()=>(verifier as any).execute('one'),TypeError);
  assert.throws(()=>(planner as any).verify('one'),TypeError);
  assert.equal(host.inspect().budget!.spent,0);
});
test('copied, unminted and borrowed capability receivers cannot invoke methods',t=>{
  const {host}=setup(t); const planner=host.planner('planner'); const verifier=host.verifier('verifier');
  for(const receiver of [{}, {...planner}, verifier, {role:'planner',prefix:'demo/'}]) {
    assert.throws(()=>planner.propose.call(receiver as any,'one',p),/Unminted/);
    assert.throws(()=>planner.list.call(receiver as any),/Unminted/);
  }
  const detached=planner.propose; assert.throws(()=>detached('one',p),/Unminted/);
  assert.equal(host.inspect().jobs.length,0);
});
test('all role reads are scope restricted, including exact prefix boundaries and missing IDs',t=>{
  const {host}=setup(t);
  host.planner('a','a_b/').propose('private',{key:'a_b/result',value:'private'});
  host.planner('b','axb/').propose('other',{key:'axb/result',value:'other'});
  for(const cap of [host.planner('p','a_b/'),host.verifier('v','a_b/'),host.operator('o','a_b/'),host.executor('e','a_b/')]) {
    assert.deepEqual(cap.list().map(j=>j.id),['private']); assert.equal(cap.get('private').payload,JSON.stringify({key:'a_b/result',value:'private'}));
    for(const id of ['other','missing']) assert.throws(()=>cap.get(id),{message:'Intent unavailable'});
  }
  assert.deepEqual(host.planner('empty','empty/').list(),[]);
});
test('cross-scope writes, verification, approvals and execution fail without effects',t=>{
  const {host}=setup(t); const local=host.planner('p');
  const hidden=host.planner('p2','other/').propose('hidden',{key:'other/result',value:'secret'});
  assert.throws(()=>local.propose('bad',{key:'other/result',value:'overwrite'}),/Unauthorized/);
  assert.throws(()=>local.propose('hidden',p),/conflict/);
  assert.throws(()=>host.verifier('v').verify('hidden'),/unavailable/);
  assert.throws(()=>host.operator('o').decide('hidden',hidden.hash,true),/unavailable/);
  assert.throws(()=>host.executor('e').execute('hidden'),/unavailable/);
  assert.equal(host.inspect().budget!.spent,0); assert.equal(host.inspect().jobs.length,1);
  assert.equal(host.inspect().jobs[0].state,'pending');
});
test('returned views and lists are immutable detached data; agent reads contain no budget or global audit',t=>{
  const {host}=setup(t); const planner=host.planner('p'); const j=planner.propose('one',p);
  assert.ok(Object.isFrozen(j)); assert.ok(Object.isFrozen(planner.get('one')));
  const rows=planner.list(); assert.ok(Object.isFrozen(rows)); assert.ok(Object.isFrozen(rows[0]));
  assert.throws(()=>{ (j as any).state='verified'; },TypeError);
  assert.throws(()=>{ (rows as any).push({}); },TypeError);
  assert.equal((j as any).budget,undefined); assert.equal((j as any).audit,undefined);
  host.operator('o').decide('one',j.hash,true);
  assert.equal(j.state,'pending'); assert.equal(planner.get('one').state,'approved');
});
test('offline agents collaborate through narrow capabilities; host approval and replay remain exact',async t=>{
  const {host}=setup(t); const planner=host.planner('p'), verifier=host.verifier('v');
  const operator=host.operator('o'), executor=host.executor('e');
  const j=await planOffline(planner,'one','hello');
  assert.throws(()=>executor.execute(j.id),/approval/);
  assert.throws(()=>operator.decide(j.id,'wrong',true),/mismatch/);
  assert.throws(()=>verifyOffline(verifier,j.id),/not applied/);
  operator.decide(j.id,j.hash,true); executor.execute(j.id);
  assert.equal(verifyOffline(verifier,j.id).state,'verified');
  executor.execute(j.id); assert.equal(verifyOffline(verifier,j.id).state,'verified');
  assert.equal(host.inspect().budget!.spent,3); assert.equal(host.inspect().auditValid,true);
  assert.deepEqual(host.inspect().audit.filter(x=>x.event==='verified').map(x=>x.actor),['v']);
});
test('closed host invalidates existing capabilities and new provisioning',t=>{
  const {host}=setup(t); const planner=host.planner('p'), verifier=host.verifier('v'); host.close();
  assert.throws(()=>planner.list(),/Host closed/); assert.throws(()=>planner.propose('one',p),/Host closed/);
  assert.throws(()=>verifier.verify('one'),/Host closed/); assert.throws(()=>host.planner('new'),/Host closed/);
});
test('host-only scoped read primitives reject unminted and foreign runtime actors',t=>{
  const {dir}=setup(t); const r=new Runtime(`${dir}/extra.sqlite`,`${dir}/extra-service.sqlite`);
  const other=new Runtime(`${dir}/other.sqlite`,`${dir}/other-service.sqlite`);
  try {
    const minted=r.actor('p','planner');
    for(const a of [{...minted},other.actor('p','planner')]) {
      assert.throws(()=>r.get(a,'one'),/Unauthorized/); assert.throws(()=>r.list(a),/Unauthorized/);
    }
  } finally {r.close();other.close();}
});
test('host recovery preserves original crash semantics and returns only its scope',t=>{
  const {dir,host}=setup(t);
  const j=host.planner('p').propose('one',p); host.operator('o').decide(j.id,j.hash,true);
  const foreign=host.planner('p2','other/').propose('foreign',{key:'other/result',value:'x'});
  host.operator('o2','other/').decide(foreign.id,foreign.hash,true);
  const child=spawnSync(process.execPath,['test/crash-worker.ts',dir,'after-effect','one']); assert.equal(child.status,72);
  assert.deepEqual(host.executor('other','other/').recover(),[]);
  host.close(); const reopened=new IntentHost(`${dir}/runtime.sqlite`,`${dir}/service.sqlite`);
  try {
    assert.deepEqual(reopened.executor('e').recover().map(j=>j.id),['one']);
    assert.equal(reopened.verifier('v').verify('one').state,'verified');
    assert.equal(reopened.planner('other','other/').get('foreign').state,'approved');
    assert.equal(reopened.inspect().budget!.spent,3);
  } finally {reopened.close();}
});
test('CLI demo uses host boundary and is idempotent across separate processes',t=>{
  const {dir,host}=setup(t); host.close();
  for(let i=0;i<2;i++) {
    const child=spawnSync(process.execPath,['src/cli.ts','demo',dir],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr); assert.equal(JSON.parse(child.stdout).state,'verified');
  }
  const child=spawnSync(process.execPath,['src/cli.ts','status',dir],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr); const data=JSON.parse(child.stdout);
  assert.equal(data.budget.spent,3); assert.equal(data.auditValid,true);
});

test('proposal validation accepts only two enumerable snapshot data fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intentos-input-'));
  const host = new IntentHost(join(dir,'runtime.sqlite'),join(dir,'service.sqlite'));
  try {
    const planner = host.planner('planner');
    let reads = 0;
    const accessor = { key: 'demo/value', get value() { reads++; return 'data'; } };
    assert.throws(() => planner.propose('accessor', accessor), /Invalid proposal/);
    assert.equal(reads, 0);
    assert.throws(() => planner.propose('extra', { key: 'demo/value', value: 'data', [Symbol('extra')]: 1 }), /Invalid proposal/);
    assert.equal(planner.list().length, 0);
    assert.equal(planner.propose('valid', { key: 'demo/value', value: 'data' }).state, 'pending');
  } finally {
    host.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
