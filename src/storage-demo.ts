import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { Runtime } from './runtime.ts';
import { backupPair, restorePair, STORAGE_VERSION } from './storage.ts';
const directory=mkdtempSync(join(tmpdir(),'intentos-storage-demo-'));
try {
  const state=join(directory,'runtime.sqlite'),service=join(directory,'service.sqlite');
  const runtime=new Runtime(state,service);
  try {
    for(const [id,payload] of [['original',{key:'demo/result',value:'synthetic backup example'}],['queue',{action:'queue.create',key:'demo/shop',assetFingerprint:'a'.repeat(64),dueAt:'2030-01-01T12:00:00.000Z'}]] as const) {
      const j=runtime.propose(runtime.actor('fixture-planner','planner'),id,payload);
      runtime.decide(runtime.actor('fixture-operator','approver'),id,j.hash,true);
    }
  }finally{runtime.close();}
  for(const id of ['original','queue']) {
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('./queue-demo-worker.ts',import.meta.url)),directory,id,'after-effect'],{encoding:'utf8'});
    assert.equal(child.status,72,child.stderr);
  }
  const backup=join(directory,'backup'),restored=join(directory,'restored');
  backupPair(state,service,backup);restorePair(backup,restored);
  const recovered=new Runtime(join(restored,'runtime.sqlite'),join(restored,'service.sqlite'));
  try {
    const before=recovered.snapshot().jobs.map(j=>({id:j.id,state:j.state}));
    recovered.recover(recovered.actor('executor','executor'));
    for(const id of ['original','queue']) assert.equal(recovered.verify(recovered.actor('verifier','verifier'),id).state,'verified');
    const db=new DatabaseSync(join(restored,'service.sqlite'),{readOnly:true});
    let effects:unknown,writes:unknown;
    try{effects=db.prepare('SELECT COUNT(*) AS n FROM effects').get()!.n;writes=db.prepare('SELECT COUNT(*) AS n FROM queue_writes').get()!.n;}finally{db.close();}
    assert.equal(effects,1);assert.equal(writes,1);assert.equal(recovered.snapshot().budget!.spent,6);assert.equal(recovered.checkAudit(),true);
    console.log(JSON.stringify({demo:'offline-storage-recovery',storageVersion:STORAGE_VERSION,explanation:'Both pretend writes lost their replies. A complete backup restored their evidence and approvals without another write or debit.',before,after:recovered.snapshot().jobs.map(j=>({id:j.id,state:j.state})),originalEffects:effects,queueWrites:writes,simulatedCreditsSpent:6,auditValid:true,liveService:false},null,2));
  }finally{recovered.close();}
}finally{rmSync(directory,{recursive:true,force:true});}
