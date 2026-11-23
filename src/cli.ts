import { runQueueDemo } from './queue-demo.ts';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { IntentHost, VERSION } from './index.ts';
import { checkStores } from './storage-api.ts';
import { planOffline, verifyOffline } from './demo-agents.ts';
const argv=process.argv.slice(2);
const [command='help',directory='.intentos',...args]=argv;
const usage = `IntentOS ${VERSION} — trusted-local offline runtime (Node 24+)
Commands: node src/cli.ts <command> <state-directory> [arguments]
  help | --help            show commands
  --version                show release version
  demo                     propose, fixture-approve, execute and verify a fixed intent
  queue-demo               crash after a pretend write, reconcile without resend
  propose <id> <text>       propose a simulated demo/result write
  approve <id> <hash> [ttl-seconds] approve exact digest; default five minutes
  revoke <id> <hash>        withdraw before dispatch; cannot undo a dispatch
  deny <id> <hash>          reject an exact proposal
  execute <id>             perform an approved simulated operation
  verify <id>              independently read back evidence
  recover                  recover original writes; report uncertain queue work
  status                   inspect state and audit integrity
Exit codes: 0 completed, 1 refused/failed/unresolved, 2 invalid usage.
This local CLI trusts its operator; it is not user authentication.`;
const arities:Record<string,[number,number]>={demo:[0,0],'queue-demo':[0,0],propose:[2,2],approve:[2,3],revoke:[2,2],deny:[2,2],execute:[1,1],verify:[1,1],recover:[0,0],status:[0,0]};
const usageError=()=>{console.error(usage);process.exitCode=2;};
if(['help','--help','--version'].includes(command)) {
  if(argv.length>1)usageError();else console.log(command==='--version'?VERSION:usage);
} else if(!Object.hasOwn(arities,command) || (argv.length<2 && !['demo','queue-demo'].includes(command)) || args.length<arities[command][0] || args.length>arities[command][1]) {
  usageError();
} else if(command==='approve' && args[2]!==undefined && (!/^\d+(?:\.\d+)?$/.test(args[2]) || !Number.isSafeInteger(Number(args[2])*1000) || Number(args[2])*1000<1 || Number(args[2])>86400)) {
  usageError();
} else {
  let host:IntentHost|undefined;
  try {
    let result:unknown;
    if(command==='queue-demo')result=runQueueDemo(directory);
    else {
      const state=resolve(directory,'runtime.sqlite'),service=resolve(directory,'service.sqlite');
      if(['demo','propose'].includes(command))mkdirSync(directory,{recursive:true});else checkStores(state,service);
      host=new IntentHost(state,service);
      const planner=host.planner('planner'),operator=host.operator('operator'),executor=host.executor('executor'),verifier=host.verifier('verifier');
      switch(command) {
        case 'demo': {
          const j=await planOffline(planner,'hello','Hello from collaborating scoped actors');
          if(j.state==='pending')operator.decide(j.id,j.hash,true);
          executor.execute(j.id);result=verifyOffline(verifier,j.id);break;
        }
        case 'propose':result=await planOffline(planner,args[0],args[1]);break;
        case 'approve':case 'deny':result=operator.decide(args[0],args[1],command==='approve',args[2]===undefined?undefined:Number(args[2])*1000);break;
        case 'revoke':result=operator.revoke(args[0],args[1]);break;
        case 'execute':result=executor.execute(args[0]);break;
        case 'verify':result=verifyOffline(verifier,args[0]);break;
        case 'recover':result=executor.recover();break;
        case 'status':result=host.inspect();break;
      }
    }
    console.log(JSON.stringify(result,null,2));
    const unresolved=(value:unknown):boolean=>!!value && typeof value==='object' && 'state' in value && ['failed','uncertain'].includes(String(value.state));
    if(unresolved(result) || (Array.isArray(result) && result.some(unresolved)) || (result && typeof result==='object' && 'auditValid' in result && result.auditValid===false))process.exitCode=1;
  }catch(error){console.error(String(error));process.exitCode=1;}finally{host?.close();}
}
