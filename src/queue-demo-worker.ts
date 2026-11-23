// Trusted fault-injection harness, not an agent API. No shell or network action.
import { Runtime } from './runtime.ts';
import { resolve } from 'node:path';
const [directory,id='queue-hello',fault='after-effect'] = process.argv.slice(2);
if (!directory || !['after-effect','before-effect','before-commit','lose-response','none'].includes(fault)) throw Error('Invalid fixture invocation');
const runtime=new Runtime(resolve(directory,'runtime.sqlite'),resolve(directory,'service.sqlite'));
try { runtime.execute(runtime.actor('queue-executor','executor'),id,fault==='none'?undefined:fault as any); }
finally {runtime.close();}
