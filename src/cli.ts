import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Runtime } from './runtime.ts';
import { OfflinePlanner } from './adapters.ts';
const [command = 'help', directory = '.intentos', ...args] = process.argv.slice(2);
if (command === 'help') {
  console.log(`IntentOS — offline simulated runtime (Node 24+)\nCommands: node src/cli.ts <command> <state-directory> [arguments]\n  demo                     propose, explicitly approve, execute, verify a fixed demo\n  propose <id> <text>       propose a simulated demo/result write\n  approve <id> <hash>       approve the exact displayed digest\n  deny <id> <hash>          reject the exact displayed digest\n  execute <id>             perform an approved simulated operation\n  verify <id>              independently read back evidence\n  recover                  replay interrupted executions\n  status                   inspect state and audit integrity\nThis local CLI is a trusted operator interface; it is not user authentication.`);
} else {
  mkdirSync(directory,{recursive:true});
  const r = new Runtime(resolve(directory,'runtime.sqlite'),resolve(directory,'service.sqlite'));
  const planner = r.actor('planner','planner'), approver = r.actor('operator','approver');
  const executor = r.actor('executor','executor'), verifier = r.actor('verifier','verifier');
  try {
    let result: unknown;
    switch(command) {
      case 'demo': {
        const p = await new OfflinePlanner().propose('Hello from collaborating scoped actors');
        const j: any = r.propose(planner,'hello',p);
        if (j.state === 'pending') r.decide(approver,j.id,j.hash,true);
        r.execute(executor,j.id); result = r.verify(verifier,j.id); break;
      }
      case 'propose': result = r.propose(planner,args[0],await new OfflinePlanner().propose(args[1])); break;
      case 'approve': case 'deny': result = r.decide(approver,args[0],args[1],command === 'approve'); break;
      case 'execute': result = r.execute(executor,args[0]); break;
      case 'verify': result = r.verify(verifier,args[0]); break;
      case 'recover': result = r.recover(executor); break;
      case 'status': result = { ...r.snapshot(), auditValid: r.checkAudit() }; break;
      default: throw Error('Unknown command; run help');
    }
    console.log(JSON.stringify(result,null,2));
    if (result && typeof result === 'object' && 'state' in result && result.state === 'failed') process.exitCode = 1;
  } catch(e) { console.error(String(e)); process.exitCode = 1; } finally { r.close(); }
}
