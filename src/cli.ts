import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { IntentHost } from './host.ts';
import { planOffline, verifyOffline } from './demo-agents.ts';
const [command = 'help', directory = '.intentos', ...args] = process.argv.slice(2);
if (command === 'help') {
  console.log(`IntentOS — offline simulated runtime (Node 24+)\nCommands: node src/cli.ts <command> <state-directory> [arguments]\n  demo                     propose, explicitly approve, execute, verify a fixed demo\n  propose <id> <text>       propose a simulated demo/result write\n  approve <id> <hash>       approve the exact displayed digest\n  deny <id> <hash>          reject the exact displayed digest\n  execute <id>             perform an approved simulated operation\n  verify <id>              independently read back evidence\n  recover                  replay interrupted executions\n  status                   inspect state and audit integrity\nThis local CLI is a trusted operator interface; it is not user authentication.`);
} else {
  mkdirSync(directory,{recursive:true});
  const r = new IntentHost(resolve(directory,'runtime.sqlite'),resolve(directory,'service.sqlite'));
  const planner = r.planner('planner'), approver = r.operator('operator');
  const executor = r.executor('executor'), verifier = r.verifier('verifier');
  try {
    let result: unknown;
    switch(command) {
      case 'demo': {
        const j = await planOffline(planner,'hello','Hello from collaborating scoped actors');
        if (j.state === 'pending') approver.decide(j.id,j.hash,true);
        executor.execute(j.id); result = verifyOffline(verifier,j.id); break;
      }
      case 'propose': result = await planOffline(planner,args[0],args[1]); break;
      case 'approve': case 'deny': result = approver.decide(args[0],args[1],command === 'approve'); break;
      case 'execute': result = executor.execute(args[0]); break;
      case 'verify': result = verifyOffline(verifier,args[0]); break;
      case 'recover': result = executor.recover(); break;
      case 'status': result = r.inspect(); break;
      default: throw Error('Unknown command; run help');
    }
    console.log(JSON.stringify(result,null,2));
    if (result && typeof result === 'object' && 'state' in result && result.state === 'failed') process.exitCode = 1;
  } catch(e) { console.error(String(e)); process.exitCode = 1; } finally { r.close(); }
}
