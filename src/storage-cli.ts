import { resolve } from 'node:path';
import { adoptLegacyPair, upgradeApprovalState, backupPair, restorePair, checkStores, STORAGE_VERSION } from './storage-api.ts';
import { VERSION } from './index.ts';
const argv=process.argv.slice(2);
const [command='help',directory,target,confirmation]=argv;
const usage=`IntentOS ${VERSION} storage maintenance
node src/storage-cli.ts check <directory>
node src/storage-cli.ts adopt-legacy|upgrade-approvals <directory> --confirm-stopped-workers
node src/storage-cli.ts backup|restore <source-directory> <new-destination> --confirm-stopped-workers
Exit codes: 0 completed, 1 refused/failed, 2 invalid usage. Stop all workers before maintenance.`;
const valid=command==='check'?argv.length===2:
  ['adopt-legacy','upgrade-approvals'].includes(command)?argv.length===3 && target==='--confirm-stopped-workers':
  ['backup','restore'].includes(command)?argv.length===4 && confirmation==='--confirm-stopped-workers':false;
if(['help','--help','--version'].includes(command) && argv.length<=1)console.log(command==='--version'?VERSION:usage);
else if(!valid){console.error(usage);process.exitCode=2;}
else {
  try {
    const runtime=resolve(directory,'runtime.sqlite'),service=resolve(directory,'service.sqlite');let result:unknown;
    switch(command) {
      case 'check':checkStores(runtime,service);result={valid:true,storageVersion:STORAGE_VERSION};break;
      case 'adopt-legacy':result=adoptLegacyPair(runtime,service);break;
      case 'upgrade-approvals':result=upgradeApprovalState(runtime,service);break;
      case 'backup':result=backupPair(runtime,service,target);break;
      case 'restore':result=restorePair(directory,target);break;
    }
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(String(error));process.exitCode=1;}
}
