import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, statSync, realpathSync, mkdirSync, rmdirSync, copyFileSync, constants } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { validateProposal } from './proposal.ts';
import { validateQueueProposal } from './queue.ts';
import { RUNTIME_SCHEMA, SERVICE_SCHEMA } from './schema.ts';

export const STORAGE_VERSION = 1;
const META_SQL = 'CREATE TABLE storage_meta(id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, pair_id TEXT NOT NULL, store_id TEXT NOT NULL, peer_id TEXT NOT NULL, role TEXT NOT NULL)';
type Identity = { device: string; inode: string };
type Anchor = { version: number; phase: string; pairId: string; runtimeId: string; serviceId: string; servicePath: string; runtimeFile?: Identity; serviceFile?: Identity };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (reason: string): never => { throw Error(`Storage refused: ${reason}`); };
function identity(path: string): Identity {
  if (!existsSync(path)) return fail('missing paired store');
  const stat=statSync(path,{bigint:true});
  if (!stat.isFile()) return fail('store is not a regular file');
  return {device:String(stat.dev),inode:String(stat.ino)};
}
function syncDir(path: string) {const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function durableWrite(path: string, value: unknown, exclusive=false) {
  const text=JSON.stringify(value,null,2)+'\n'; const temporary=exclusive?path:`${path}.${randomUUID()}.tmp`;
  const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
  if (!exclusive) renameSync(temporary,path);
  syncDir(dirname(path));
}
function readAnchor(path: string): Anchor {
  try{return JSON.parse(readFileSync(path,'utf8'));}catch{return fail('missing or unreadable pairing anchor');}
}
function tables(db: DatabaseSync) {return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>String(x.name));}
const expectedRuntime = {budget:['id','cap','spent'],jobs:['id','payload','hash','state','cost','approval','receipt','evidence'],queue_attempts:['id','operation_id','destination','intent_hash','acknowledged_record_id'],audit:['seq','actor','event','detail','previous','hash']};
const expectedService = {effects:['token','payload','receipt'],queue_records:['id','operation_id','intent_hash','destination','asset_fingerprint','due_at','status','sent_receipt'],queue_writes:['seq','operation_id','record_id'],queue_source:['id','authoritative','fresh']};
const normalizeDdl = (sql: string) => sql.toLowerCase().replace(/\bif\s+not\s+exists\b/g,'').replace(/\s+/g,'');
function expectedDdl(schema: string) {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(schema);
    return new Map(db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type='table'").all()
      .map(row=>[String(row.name),normalizeDdl(String(row.sql))]));
  } finally {db.close();}
}
const runtimeDdl=expectedDdl(RUNTIME_SCHEMA+' '+META_SQL);
const serviceDdl=expectedDdl(SERVICE_SCHEMA+' '+META_SQL);
function checkSchema(db: DatabaseSync,role: 'runtime'|'service',legacy=false) {
  const expected=role==='runtime'?runtimeDdl:serviceDdl;
  const rows=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
  for (const row of rows) {
    if (row.type!=='table' || expected.get(String(row.name))!==normalizeDdl(String(row.sql))) fail(role+' schema differs at '+row.name);
  }
  if (!legacy && rows.length!==expected.size) fail(role+' schema differs: missing table');
}
function metadata(db: DatabaseSync) {
  const version=db.prepare('PRAGMA user_version').get()!.user_version;
  if (version!==STORAGE_VERSION) fail(`unsupported schema version ${version}; expected ${STORAGE_VERSION}`);
  if (!tables(db).includes('storage_meta')) fail('unversioned legacy store; explicit adoption required');
  const rows=db.prepare('SELECT * FROM storage_meta').all();
  if(rows.length!==1 || rows[0].id!==1 || rows[0].schema_version!==STORAGE_VERSION) fail('invalid storage metadata');
  return rows[0];
}
function assertMetadata(db: DatabaseSync, a: Anchor, role: 'runtime'|'service') {
  const m=metadata(db);const runtime=role==='runtime';
  if(m.pair_id!==a.pairId || m.store_id!==(runtime?a.runtimeId:a.serviceId) || m.peer_id!==(runtime?a.serviceId:a.runtimeId) || m.role!==role) fail('store identities do not match the pair');
  checkSchema(db,role);
}
function stamp(db: DatabaseSync,a: Anchor,role: 'runtime'|'service') {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(META_SQL);db.prepare('INSERT INTO storage_meta VALUES(1,?,?,?,?,?)').run(STORAGE_VERSION,a.pairId,role==='runtime'?a.runtimeId:a.serviceId,role==='runtime'?a.serviceId:a.runtimeId,role);
    db.exec(`PRAGMA user_version=${STORAGE_VERSION}; COMMIT`);
  }catch(e){db.exec('ROLLBACK');throw e;}
}
function anchorFor(runtimePath: string,servicePath: string): Anchor {
  return {version:STORAGE_VERSION,phase:'initializing',pairId:randomUUID(),runtimeId:randomUUID(),serviceId:randomUUID(),servicePath:resolve(servicePath)};
}
function finishAnchor(runtimePath: string,servicePath: string,a: Anchor) {
  a.phase='ready';a.servicePath=realpathSync(servicePath);a.runtimeFile=identity(runtimePath);a.serviceFile=identity(servicePath);
  syncDir(dirname(runtimePath));syncDir(dirname(servicePath));
  durableWrite(`${runtimePath}.pair.json`,a);
}
/** The anchor detects missing/replaced files and binds both stores. It is not a hostile-host defense. */
export class StorePair {
  #runtimePath: string; #servicePath: string; #anchor: Anchor;
  constructor(runtimePath: string,servicePath: string,cap: number,initialize=true) {
    if(!Number.isSafeInteger(cap) || cap<0) fail('invalid budget cap');
    this.#runtimePath=resolve(runtimePath);this.#servicePath=resolve(servicePath);
    if(this.#runtimePath===this.#servicePath) fail('runtime and service paths must differ');
    const anchorPath=`${this.#runtimePath}.pair.json`;
    if(!existsSync(anchorPath)) {
      if(!initialize) fail('no initialized pair; check and backup never create stores');
      if(existsSync(this.#runtimePath)||existsSync(this.#servicePath)) fail('existing store has no anchor; explicit legacy adoption or backup restore required');
      const a=anchorFor(this.#runtimePath,this.#servicePath);
      durableWrite(anchorPath,a,true); // durable marker comes first: interrupted initialization cannot silently reset.
      for(const [path,role,schema] of [[this.#runtimePath,'runtime',RUNTIME_SCHEMA],[this.#servicePath,'service',SERVICE_SCHEMA]] as const) {
        const fd=openSync(path,'wx',0o600);closeSync(fd);
        const db=new DatabaseSync(path);try{
          db.exec('PRAGMA synchronous=FULL;');db.exec(schema);
          if(role==='runtime') db.prepare('INSERT INTO budget VALUES(1,?,0)').run(cap);
          stamp(db,a,role);
        }finally{db.close();}
      }
      finishAnchor(this.#runtimePath,this.#servicePath,a);
    }
    this.#anchor=readAnchor(anchorPath);this.assert();
  }
  assert() {
    const a=readAnchor(`${this.#runtimePath}.pair.json`);
    if(JSON.stringify(a)!==JSON.stringify(this.#anchor) || a.version!==STORAGE_VERSION || a.phase!=='ready') fail('anchor changed, unsupported or initialization incomplete');
    if(a.servicePath!==realpathExisting(this.#servicePath)) fail('wrong service path');
    if(JSON.stringify(identity(this.#runtimePath))!==JSON.stringify(a.runtimeFile) || JSON.stringify(identity(this.#servicePath))!==JSON.stringify(a.serviceFile)) fail('paired file was replaced; use verified offline restore');
    if(JSON.stringify(a.runtimeFile)===JSON.stringify(a.serviceFile)) fail('runtime and service cannot be the same file');
    for(const [path,role] of [[this.#runtimePath,'runtime'],[this.#servicePath,'service']] as const) {
      const db=new DatabaseSync(path,{readOnly:true});try{assertMetadata(db,a,role);}finally{db.close();}
    }
  }
}
function realpathExisting(path: string) {if(!existsSync(path)) return fail('missing paired store');return realpathSync(path);}

/** Explicit migration from unversioned local data. No dispatch history or service effects may exist. */
export function adoptLegacyPair(runtimePath: string,servicePath: string) {
  runtimePath=resolve(runtimePath);servicePath=resolve(servicePath);
  if(runtimePath===servicePath || existsSync(`${runtimePath}.pair.json`)) fail('cannot adopt a versioned or identical store pair');
  realpathExisting(runtimePath);realpathExisting(servicePath);
  if(JSON.stringify(identity(runtimePath))===JSON.stringify(identity(servicePath))) fail('legacy stores must be distinct files');
  const runtime=new DatabaseSync(runtimePath);let service: DatabaseSync|undefined;
  try {
    service=new DatabaseSync(servicePath);
    // DELETE + EXCLUSIVE requires other connections to be closed. Do not use this with workers running.
    offlineLock(runtime);offlineLock(service);
    for(const db of [runtime,service]) {
      if(db.prepare('PRAGMA user_version').get()!.user_version!==0 || tables(db).includes('storage_meta')) fail('only unversioned legacy stores can be adopted');
      if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok') fail('legacy integrity check failed');
    }
    const rt=tables(runtime),st=tables(service);
    if(!['audit','budget','jobs'].every(t=>rt.includes(t)) || rt.some(t=>!Object.hasOwn(expectedRuntime,t)) || st.some(t=>!Object.hasOwn(expectedService,t))) fail('unknown legacy schema');
    checkSchema(runtime,'runtime',true);checkSchema(service,'service',true);
    const budgets=runtime.prepare('SELECT * FROM budget').all();const b=budgets[0];
    if(budgets.length!==1 || b.id!==1 || !Number.isSafeInteger(b.cap) || Number(b.cap)<0 || b.spent!==0) fail('legacy budget is invalid or has prior spend');
    for(const row of runtime.prepare('SELECT * FROM jobs').all()) {
      if(!['pending','approved','denied'].includes(String(row.state)) || row.cost!==3 || row.receipt!==null || row.evidence!==null) fail('legacy dispatch history cannot be safely adopted');
      if(row.approval!==null && (row.state!=='approved' || row.approval!==row.hash)) fail('legacy approval mismatch');
      if(row.state==='approved' && row.approval!==row.hash) fail('legacy approval mismatch');
      const p=JSON.parse(String(row.payload));
      const normalized=Object.hasOwn(p,'action')?validateQueueProposal(p):validateProposal(p);
      if(JSON.stringify(normalized)!==row.payload) fail('legacy payload is not canonical');
      if(row.hash!==hash(JSON.stringify({id:row.id,action:p.action??'simulated.put',payload:row.payload,cost:3,policy:1}))) fail('legacy intent digest mismatch');
    }
    if(rt.includes('queue_attempts') && runtime.prepare('SELECT COUNT(*) AS n FROM queue_attempts').get()!.n!==0) fail('legacy attempts require manual review');
    let previous='genesis';
    for(const row of runtime.prepare('SELECT * FROM audit ORDER BY seq').all()) {
      if(!['proposed','approved','rejected','denied'].includes(String(row.event)) || row.previous!==previous || row.hash!==hash(JSON.stringify({actor:row.actor,event:row.event,detail:row.detail,previous}))) fail('legacy audit contains execution or invalid history');
      previous=String(row.hash);
    }
    for(const table of ['effects','queue_records','queue_writes']) if(st.includes(table) && service.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n!==0) fail('legacy service effects require manual review');
    const a=anchorFor(runtimePath,servicePath);durableWrite(`${runtimePath}.pair.json`,a,true);
    runtime.exec(RUNTIME_SCHEMA);service.exec(SERVICE_SCHEMA);
    stamp(runtime,a,'runtime');stamp(service,a,'service');
    checkSchema(runtime,'runtime');checkSchema(service,'service');finishAnchor(runtimePath,servicePath,a);
    return {storageVersion:STORAGE_VERSION,pairId:a.pairId,adopted:true};
  }finally{service?.close();runtime.close();}
}
function offlineLock(db: DatabaseSync) {
  const check=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if(check && Number(check.busy)>0) fail('workers must be closed before storage maintenance');
  const mode=db.prepare('PRAGMA journal_mode=DELETE').get();
  if(String(mode?.journal_mode).toLowerCase()!=='delete') fail('cannot acquire offline store');
  db.exec('PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
}

/** Offline snapshot only. Destination must not exist; half-finished backups have no manifest. */
export function backupPair(runtimePath: string,servicePath: string,destination: string) {
  const pair=new StorePair(runtimePath,servicePath,12,false);pair.assert();
  destination=resolve(destination);mkdirSync(destination,{recursive:false,mode:0o700});
  const runtime=new DatabaseSync(runtimePath);let service:DatabaseSync|undefined;
  try {
    service=new DatabaseSync(servicePath);offlineLock(runtime);offlineLock(service);
    const lockedAnchor=readAnchor(`${resolve(runtimePath)}.pair.json`);
    if(JSON.stringify(identity(runtimePath))!==JSON.stringify(lockedAnchor.runtimeFile) || JSON.stringify(identity(servicePath))!==JSON.stringify(lockedAnchor.serviceFile)) fail('source files changed before backup lock');
    assertMetadata(runtime,lockedAnchor,'runtime');assertMetadata(service,lockedAnchor,'service');
    runtime.prepare('VACUUM INTO ?').run(join(destination,'runtime.sqlite'));
    service.prepare('VACUUM INTO ?').run(join(destination,'service.sqlite'));
    const files:Record<string,string>={};
    for(const name of ['runtime.sqlite','service.sqlite']) {const path=join(destination,name);const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}files[name]=hash(readFileSync(path));}
    const a=readAnchor(`${resolve(runtimePath)}.pair.json`);
    durableWrite(join(destination,'backup.json'),{format:1,storageVersion:STORAGE_VERSION,pairId:a.pairId,runtimeId:a.runtimeId,serviceId:a.serviceId,files},true);
    return {backup:destination,storageVersion:STORAGE_VERSION,files};
  }finally{service?.close();runtime.close();}
}
/** Restores only a complete manifest-verified pair, into a new directory and with new pair identities. */
export function restorePair(backupDirectory: string,destination: string) {
  backupDirectory=resolve(backupDirectory);destination=join(realpathSync(dirname(resolve(destination))),basename(destination));
  if(existsSync(destination)) fail('restore destination must not exist');
  const manifest=JSON.parse(readFileSync(join(backupDirectory,'backup.json'),'utf8'));
  if(manifest.format!==1 || manifest.storageVersion!==STORAGE_VERSION) fail('unsupported backup version');
  for(const name of ['runtime.sqlite','service.sqlite']) if(hash(readFileSync(join(backupDirectory,name)))!==manifest.files?.[name]) fail('backup checksum mismatch');
  const expected:Anchor={version:STORAGE_VERSION,phase:'ready',pairId:manifest.pairId,runtimeId:manifest.runtimeId,serviceId:manifest.serviceId,servicePath:''};
  for(const [name,role] of [['runtime.sqlite','runtime'],['service.sqlite','service']] as const) {
    const db=new DatabaseSync(join(backupDirectory,name),{readOnly:true});try{assertMetadata(db,expected,role);if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok') fail('backup integrity failure');}finally{db.close();}
  }
  const stage=`${destination}.restore-${randomUUID()}`;mkdirSync(stage,{mode:0o700});
  const a=anchorFor(join(destination,'runtime.sqlite'),join(destination,'service.sqlite'));
  for(const [name,role] of [['runtime.sqlite','runtime'],['service.sqlite','service']] as const) {
    const path=join(stage,name);copyFileSync(join(backupDirectory,name),path,constants.COPYFILE_EXCL);
    if(hash(readFileSync(path))!==manifest.files[name]) fail('backup changed during restore');
    const db=new DatabaseSync(path);try{db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE; DROP TABLE storage_meta; COMMIT;');stamp(db,a,role);}finally{db.close();}
  }
  // Anchor physical identities survive the directory rename. Final service path is bound explicitly.
  a.phase='ready';a.runtimeFile=identity(join(stage,'runtime.sqlite'));a.serviceFile=identity(join(stage,'service.sqlite'));
  durableWrite(join(stage,'runtime.sqlite.pair.json'),a,true);syncDir(stage);
  // Reserve a new target exclusively. Do not replace even an empty target created concurrently.
  mkdirSync(destination,{mode:0o700});
  for (const file of ['runtime.sqlite','service.sqlite']) renameSync(join(stage,file),join(destination,file));
  syncDir(destination);
  renameSync(join(stage,'runtime.sqlite.pair.json'),join(destination,'runtime.sqlite.pair.json')); // publish readiness last
  syncDir(destination);syncDir(dirname(destination));rmdirSync(stage);
  new StorePair(join(destination,'runtime.sqlite'),join(destination,'service.sqlite'),12).assert();
  return {restored:destination,storageVersion:STORAGE_VERSION,pairId:a.pairId};
}
