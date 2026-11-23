/** Public trusted-operator maintenance API. Stop every worker before maintenance. */
import { StorePair } from './storage.ts';
export { STORAGE_VERSION, adoptLegacyPair, upgradeApprovalState, backupPair, restorePair } from './storage.ts';
export function checkStores(runtimePath: string, servicePath: string): void {
  new StorePair(runtimePath,servicePath,12,false).assert();
}
