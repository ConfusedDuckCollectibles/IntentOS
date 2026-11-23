import { resolve } from 'node:path';
import { adoptLegacyPair, backupPair, restorePair, StorePair, STORAGE_VERSION } from './storage.ts';
const [command,directory,target,confirmation]=process.argv.slice(2);
try {
  if(!directory) throw Error('Usage: node src/storage-cli.ts check|adopt-legacy|backup|restore <directory> [destination] [--confirm-stopped-workers]');
  const runtime=resolve(directory,'runtime.sqlite'),service=resolve(directory,'service.sqlite');
  let result: unknown;
  switch(command) {
    case 'check': new StorePair(runtime,service,12,false).assert(); result={valid:true,storageVersion:STORAGE_VERSION};break;
    case 'adopt-legacy':
      if(target!=='--confirm-stopped-workers') throw Error('Adoption requires --confirm-stopped-workers and operator review of the original pair');
      result=adoptLegacyPair(runtime,service);break;
    case 'backup':
      if(!target || confirmation!=='--confirm-stopped-workers') throw Error('Backup requires a new destination and --confirm-stopped-workers');
      result=backupPair(runtime,service,target);break;
    case 'restore':
      if(!target || confirmation!=='--confirm-stopped-workers') throw Error('Restore requires a new destination and --confirm-stopped-workers');
      result=restorePair(directory,target);break;
    default: throw Error('Unknown storage command');
  }
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error(String(e));process.exitCode=1;}
