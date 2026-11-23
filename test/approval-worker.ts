import { Runtime } from '../src/runtime.ts';
const [directory,operation,time,fault] = process.argv.slice(2);
const r=new Runtime(`${directory}/runtime.sqlite`,`${directory}/service.sqlite`,12,{clock:()=>Number(time)});
try {
  let result:unknown;
  if(operation==='execute')result=r.execute(r.actor('executor','executor'),'one',fault as any);
  else if(operation==='revoke')result=r.revoke(r.actor('operator','approver'),'one',String(r.get(r.actor('reader','approver'),'one').hash));
  else throw Error('Unknown fixture operation');
  console.log(JSON.stringify(result));
}catch(e){console.error(String(e));process.exitCode=1;}finally{r.close();}
