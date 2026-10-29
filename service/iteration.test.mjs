import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,renameSync,mkdirSync,rmdirSync} from 'node:fs'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {createPool,entryVersion} from './pool.mjs'
import {versionOf,createMemoryReader} from '../adapter/src/modules/memoryReader.js'
const root=process.env.DSH_ECO_STATE;assert.ok(root,'isolated runner required')
const make=opts=>createPool({dir:mkdtempSync(join(root,'pool-')),...opts})
const content='  # 完整成果\n\n[参考](https://example.invalid) {保留括号}\n```js\nconst x = "<DSM:memory_write key=\'example\'>字面标签</DSM:memory_write>"\n```\n'+('正文😀 中间细节\n'.repeat(900))+'\n末尾  \n'

test('full artifact roundtrip preserves >2000 characters, Markdown/literal tags/whitespace and is excluded from automatic compression',async()=>{
 const pool=make({blacklist:['example']});const result=await pool.saveArtifact({name:'策划书 中文',content,requestId:'request-0001'});assert.equal(result.ok,true)
 const item=pool.pool().shared_pool[0];assert.equal(item.content,content);assert.equal(item.injectionPolicy,'manual');assert.equal(item.kind,'artifact');assert.equal(entryVersion(item),versionOf(item));assert.equal(pool.stale(0).length,0);assert.equal((await pool.stageStale(0)).staged.length,0)
 const stored=JSON.parse(readFileSync(pool.poolFile,'utf8')).shared_pool[0];assert.equal(stored.content,content);assert.equal(createPool({dir:pool.dir}).pool().shared_pool[0].content,content)
 const reader=createMemoryReader({poolPath:pool.poolFile});const e=reader.entries()[0];let text='',offset=0;do{const p=reader.read({ref:e.ref,version:e.version,offset,limit:1234});text+=p.content;offset=p.nextOffset}while(offset!==null);assert.equal(text,content)
})
test('same name requires exact-version confirmation; concurrent writes conflict, old versions and retry identity survive restart',async()=>{
 const p=make(),save=(text,id,expectedVersion)=>p.saveArtifact({name:'同名成果',content:text,requestId:id,expectedVersion});const first=await save(content,'request-one');assert.equal((await save('新版','request-two')).conflict,true);assert.equal(p.pool().shared_pool[0].content,content)
 const concurrent=await Promise.all([save('新版','request-two',first.version),save('另一个新版','request-three',first.version)]);assert.equal(concurrent.filter(v=>v.ok).length,1);assert.equal(concurrent.filter(v=>v.conflict).length,1)
 const item=p.pool().shared_pool[0];assert.equal(item.versions.length,1);assert.equal(item.versions[0].content,content);assert.equal(item.versions[0].revision,1)
 assert.equal((await save(content,'request-one')).duplicate,true);assert.equal((await save('假装是原文','request-one')).ok,false);assert.equal(item.revision,2)
 const restored=createPool({dir:p.dir});assert.equal(restored.pool().shared_pool[0].versions[0].content,content)
})
test('artifact validation refuses empty/oversize; IO failure rolls back memory and retry writes exactly once',async()=>{
 const p=make();for(const args of [{name:'',content:'x',requestId:'valid-0001'},{name:'n',content:' ',requestId:'valid-0001'},{name:'n',content:'中'.repeat(500001),requestId:'valid-0001'},{name:'n',content:'x',requestId:'bad'}])assert.equal((await p.saveArtifact(args)).ok,false)
 await p.sync({memories:[{key:'seed',content:'原有记忆'}]});const previous=readFileSync(p.poolFile,'utf8');renameSync(p.poolFile,p.poolFile+'.retained');mkdirSync(p.poolFile)
 try{await assert.rejects(p.saveArtifact({name:'IO',content,requestId:'io-retry-one'}));assert.equal(p.pool().shared_pool.length,1)}finally{rmdirSync(p.poolFile);renameSync(p.poolFile+'.retained',p.poolFile)}
 assert.equal(readFileSync(p.poolFile,'utf8'),previous);assert.equal((await p.saveArtifact({name:'IO',content,requestId:'io-retry-one'})).ok,true);assert.equal((await p.saveArtifact({name:'IO',content,requestId:'io-retry-one'})).duplicate,true);assert.equal(p.pool().shared_pool.filter(i=>i.kind==='artifact').length,1)
})
test('metadata policy uses version compare; old/new/imported default manual; updates preserve universal and compression/archival exclude it',async()=>{
 const p=make();await p.sync({memories:[{key:'general',content:'姓名信息'},{key:'ordinary',content:'普通条目'}]});await p.importDsm([{key:'imported',value:'导入值'}]);const item=p.pool().shared_pool.find(i=>i.key==='general');assert.equal(item.injectionPolicy,'manual')
 const first=entryVersion(item);assert.equal((await p.metadata({id:item.id,poolId:'shared',version:first,injectionPolicy:'universal'})).ok,true);assert.equal((await p.metadata({id:item.id,poolId:'shared',version:first,injectionPolicy:'manual'})).conflict,true)
 await p.sync({memories:[{key:'general',content:'新的姓名信息'}]});const next=p.pool().shared_pool.find(i=>i.id===item.id);assert.equal(next.injectionPolicy,'universal');assert.equal(p.stale(0).some(i=>i.id===item.id),false);const staged=await p.stageStale(0);assert.equal(staged.staged.some(i=>i.id===item.id),false);await p.rollbackStaging()
 const persisted=createPool({dir:p.dir}).pool().shared_pool;assert.equal(persisted.find(i=>i.id===item.id).injectionPolicy,'universal');assert.equal(persisted.find(i=>i.source==='dsm-import').injectionPolicy,'manual')
 const legacy={id:'old',key:'old',content:'旧项'};writeFileSync(join(p.dir,'memory.json'),JSON.stringify({shared_pool:[legacy],session_pools:{}}));const reader=createMemoryReader({poolPath:p.poolFile});assert.equal(reader.entries()[0].injectionPolicy,'manual');assert.equal(entryVersion(legacy),versionOf(legacy))
})
test('HTTP real isolated service: auth fence, full save/conflict/metadata/read; restart retains old versions',async()=>{
 const dir=mkdtempSync(join(root,'http-'));let proc
 async function start(){proc=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,ECOLLINK_PORT:'21983',ECOLLINK_POOL_DIR:dir,ECOLLINK_TOKEN:'synthetic-http-token',ECOLLINK_DEEPSEEK_API_KEY:'',ECOLLINK_AUTO_CONFIRM:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';proc.stdout.on('data',b=>output+=b);proc.stderr.on('data',b=>output+=b);for(let i=0;i<70;i++){if(output.includes('http://127.0.0.1:21983'))return;if(proc.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,25))}throw Error('service start timeout '+output)}
 const stop=async()=>{if(proc?.exitCode===null){const exited=new Promise(r=>proc.once('exit',r));proc.kill();await exited}}
 const request=(path,args,auth=true)=>fetch('http://127.0.0.1:21983'+path,{method:args?'POST':'GET',headers:{...(auth?{'X-Ecolink-Token':'synthetic-http-token'}:{}),'Content-Type':'application/json'},...(args?{body:JSON.stringify(args)}:{})})
 try{await start();assert.equal((await request('/memory/artifact',{name:'x',content,requestId:'http-request-one'},false)).status,401)
 const first=await (await request('/memory/artifact',{name:'x',content,requestId:'http-request-one'})).json();assert.equal(first.ok,true);assert.equal((await request('/memory/artifact',{name:'x',content:'新版本',requestId:'http-request-two'})).status,409)
 const update=await (await request('/memory/artifact',{name:'x',content:'新版本',requestId:'http-request-two',expectedVersion:first.version})).json();assert.equal(update.revision,2);assert.equal((await (await request('/memory/metadata',{id:first.id,poolId:'shared',version:update.version,injectionPolicy:'universal'})).json()).ok,true)
 await stop();await start();const stored=await (await request('/memory/pool')).json();assert.equal(stored.shared_pool[0].versions[0].content,content);assert.equal(stored.shared_pool[0].injectionPolicy,'universal')
 }finally{await stop()}
})
