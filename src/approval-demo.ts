import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Runtime } from './runtime.ts';
const directory=mkdtempSync(join(tmpdir(),'intentos-approval-demo-'));
let now=1000;
const runtime=new Runtime(join(directory,'runtime.sqlite'),join(directory,'service.sqlite'),12,{clock:()=>now});
try {
  const planner=runtime.actor('fixture-planner','planner'),operator=runtime.actor('fixture-operator','approver'),executor=runtime.actor('executor','executor'),verifier=runtime.actor('verifier','verifier');
  const expired=runtime.propose(planner,'expired',{key:'demo/result',value:'do not write after deadline'});
  runtime.decide(operator,expired.id,expired.hash,true,1000);now=2000;
  assert.throws(()=>runtime.execute(executor,expired.id),/expired/);
  const revoked=runtime.propose(planner,'revoked',{key:'demo/result',value:'do not write after withdrawal'});
  runtime.decide(operator,revoked.id,revoked.hash,true,1000);runtime.revoke(operator,revoked.id,revoked.hash);
  assert.throws(()=>runtime.execute(executor,revoked.id),/revoked/);
  const inflight=runtime.propose(planner,'inflight',{action:'queue.create',key:'demo/shop',assetFingerprint:'a'.repeat(64),dueAt:'2030-01-01T12:00:00.000Z'});
  runtime.decide(operator,inflight.id,inflight.hash,true,1000);assert.equal(runtime.execute(executor,inflight.id,'lose-response').state,'uncertain');
  now=4000;runtime.revoke(operator,inflight.id,inflight.hash);runtime.recover(executor);
  assert.equal(runtime.verify(verifier,inflight.id).state,'verified');assert.equal(runtime.snapshot().budget!.spent,3);assert.equal(runtime.checkAudit(),true);
  console.log(JSON.stringify({demo:'offline-approval-lifecycle',explanation:'Expired and withdrawn permissions stopped before dispatch. A pretend post already saved was reconciled, not undone or resent.',trustedClock:'synthetic fixture milliseconds',expiredBlocked:true,revokedBlocked:true,alreadyDispatchedState:'verified',simulatedCreditsSpent:3,auditValid:true,liveService:false},null,2));
}finally{runtime.close();rmSync(directory,{recursive:true,force:true});}
