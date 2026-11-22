import { Runtime } from '../src/runtime.ts';
const [dir,point,id='one'] = process.argv.slice(2);
const r = new Runtime(`${dir}/runtime.sqlite`,`${dir}/service.sqlite`);
r.execute(r.actor('executor','executor'),id,point === 'none' ? undefined : point as any);
r.close();
