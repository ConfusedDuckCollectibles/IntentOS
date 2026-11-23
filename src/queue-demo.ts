import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { IntentHost } from './host.ts';

export function runQueueDemo(baseDirectory: string) {
  const directory=resolve(baseDirectory,'queue-demo'); mkdirSync(directory,{recursive:true});
  const state=resolve(directory,'runtime.sqlite'), service=resolve(directory,'service.sqlite');
  let host=new IntentHost(state,service);
  let j=host.planner('queue-planner').propose('queue-hello',{
    action:'queue.create',key:'demo/shop',assetFingerprint:'a'.repeat(64),dueAt:'2030-01-01T12:00:00.000Z'
  });
  if (j.state==='pending') j=host.operator('fixture-operator').decide(j.id,j.hash,true);
  const crashNow=j.state==='approved'; host.close();
  if (crashNow) {
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('./queue-demo-worker.ts',import.meta.url)),directory,j.id,'after-effect'],{encoding:'utf8'});
    if(child.status!==72) throw Error(`Expected fixture exit 72; got ${child.status}: ${child.stderr}`);
  }
  host=new IntentHost(state,service);
  try {
    const before=host.planner('queue-reader').get(j.id);
    // Executor recovery only reports the pending review; it cannot redispatch this adapter.
    host.executor('queue-executor').recover();
    host.executor('queue-executor').execute(j.id);
    const verified=host.verifier('queue-verifier').verify(j.id);
    const inspect=host.inspect();
    const runtimeReader=new DatabaseSync(state,{readOnly:true});
    const serviceReader=new DatabaseSync(service,{readOnly:true});
    let attempts: unknown, writes: unknown, records: unknown;
    try {
      attempts=runtimeReader.prepare('SELECT COUNT(*) AS n FROM queue_attempts').get()!.n;
      writes=serviceReader.prepare('SELECT COUNT(*) AS n FROM queue_writes').get()!.n;
      records=serviceReader.prepare('SELECT COUNT(*) AS n FROM queue_records').get()!.n;
    } finally {runtimeReader.close();serviceReader.close();}
    return { demo:'offline-publishing-queue', explanation:crashNow?'The pretend shop saved the post, then its reply was lost. We checked its records instead of sending again.':'Reopened the same pretend shop. No extra write or debit.',
      injectedCrash:crashNow, stateBeforeReadBack:before.state,state:verified.state,
      dispatchAttempts:attempts,serviceWrites:writes,serviceRecords:records,simulatedCreditsSpent:inspect.budget!.spent,
      auditValid:inspect.auditValid,evidence:JSON.parse(verified.evidence!),liveService:false };
  } finally {host.close();}
}
