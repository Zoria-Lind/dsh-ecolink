import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import {join} from 'node:path'
import {createMemoryReader,versionOf,flattenPool} from '../src/modules/memoryReader.js'
import {createMemoryDiffModule} from '../src/modules/memoryDiff.js'
import {createMemoryAccessModule} from '../src/modules/memoryAccess.js'
import {createMemoryPanelModule} from '../src/modules/memoryPanel.js'
import {createServiceGuardModule,isLocalServiceUrl} from '../src/modules/serviceGuard.js'
import {sessionApi,llm,defineTool,context,agent,step,user,plain,restrictSessionService} from './host-fixture.mjs'
const root=process.env.DSH_ECO_STATE;assert.ok(root,'isolated runner required')
const memory=(id,key,content,policy='manual')=>({id,key,content,injectionPolicy:policy,timestamp:'2026-10-26T00:00:00Z'})
function harness(entries=[],options={}){let data={shared_pool:entries,session_pools:{}};const config={enabled:true,injectEnabled:true,maxInjectionChars:3000,poolPath:'synthetic',serviceUrl:'http://127.0.0.1:17520',...options};const reader=createMemoryReader(config,{readFile:()=>JSON.stringify(data)});const sessions=[],ctx=context(sessions),panel=createMemoryPanelModule(ctx,config,null,{reader,llm,sessionApi,...options.deps});return{config,reader,ctx,panel,sessions,data,make(id,seed){const s=new sessionApi.Session(id,seed);sessions.push(s);return agent(ctx,s)},entry:id=>reader.entries().find(e=>e.id===id)}}
const refs=d=>d.messages.filter(m=>m.source?.summary?.startsWith('ecolink-memory:'))

test('reader: exact Unicode names, duplicate key/pool disambiguation and paginated original reassembly',()=>{
 const h=harness([memory('1','名称 带 空格','  第一行\n'+('😀é中<>[]{}\n'.repeat(500))+'\n尾部  ')])
 h.data.session_pools={x:{identity:'同名池',memories:[memory('2','名称 带 空格','x')]},y:{identity:'同名池',memories:[memory('3','名称 带 空格','y')]}}
 assert.equal(h.reader.read({key:'名称 带 空格'}).kind,'ambiguous');assert.throws(()=>h.reader.list({pool:'同名池'}),/歧义/)
 assert.equal(h.reader.read({pool:'x',key:'名称 带 空格'}).content,'x');assert.equal(h.reader.read({key:'不存在'}).kind,'missing');assert.throws(()=>h.reader.read({pool:'x'}),/指定/)
 const e=h.entry('1');let all='',offset=0;do{const p=h.reader.read({ref:e.ref,version:e.version,offset,limit:701});all+=p.content;offset=p.nextOffset}while(offset!==null)
 assert.equal(all,e.content);assert.throws(()=>h.reader.read({ref:e.ref,offset:-1}),/越界/)
 const list=h.reader.list({limit:1});h.data.shared_pool[0].content+='!';assert.throws(()=>h.reader.list({revision:list.revision}),/变化/);assert.throws(()=>h.reader.read({ref:e.ref,version:e.version}),/变化/);h.panel()
})
test('diff: budgeted pages acknowledge only returned rows and isolate sessions/cancellation/errors',async()=>{
 const h=harness(Array.from({length:8},(_,i)=>memory(String(i),'标题'+i,'正文'+i)),{maxInjectionChars:600});const dispose=createMemoryDiffModule(h.ctx,h.config,null,{reader:h.reader});const command=h.ctx.commands.get('ecolink-diff');const a=h.make('A'),b=h.make('B')
 const run=(agent,signal)=>command.handler({agent,signal});const first=await run(a);assert.equal(first.kind,'success');assert.ok(first.text.length<=600)
 const bfirst=await run(b);assert.equal(bfirst.text,first.text)
 const rows=[];for(let n=0;n<10;n++){const p=n===0?first:await run(a);if(p.text.includes('无变化'))break;rows.push(...JSON.parse(p.text.slice(p.text.indexOf('\n')+1)))}assert.equal(new Set(rows.map(e=>e.ref)).size,8)
 h.data.shared_pool[0].content='仅中间有变化';const ac=new AbortController();ac.abort();assert.equal((await run(a,ac.signal)).kind,'error');assert.match((await run(a)).text,/仅中间/)
 assert.equal((await command.handler({})).kind,'error');dispose();h.panel()
})
test('native defineTool: conversation-owned registry mounts once, executes exact read, and unmounts',async()=>{
 const h=harness([memory('1','全文','正文😀')]);const a=h.make('tools');const dispose=createMemoryAccessModule(h.ctx,h.config,null,{reader:h.reader,defineTool});await h.ctx.emit('agent/created',{agent:a});await step(a);assert.equal(a.owned.size,1)
 const tool=a.owned.get('ecolink_memory');assert.ok(tool);const output=await tool.execute({action:'read',key:'全文'},{});assert.equal(JSON.parse(output).content,'正文😀');await assert.rejects(tool.execute({action:'bad'},{}),/invalid arguments/)
 assert.equal((await h.ctx.commands.get('ecolink-read').handler({rawInput:'全文'})).kind,'success');await h.ctx.emit('agent/disposed',{agent:a});assert.equal(a.owned.size,0);dispose();h.panel()
})
test('universal only at new conversation opening; manual transitions never backfill current or restored chats',async()=>{
 const h=harness([memory('u','姓名','虚构姓名','universal'),memory('m','方案','方案正文')]);const a=h.make('new-A');const first=await step(a);assert.equal(refs(first).length,1);assert.match(refs(first)[0].content[0].text,/虚构姓名/);assert.ok(Object.isFrozen(refs(first)[0]));assert.equal(h.panel.status(a.session).items[0].status,'admitted')
 h.data.shared_pool[1].injectionPolicy='universal';assert.equal(refs(await step(a)).length,0)
 const b=h.make('new-B');assert.equal(refs(await step(b)).length,2)
 const restored=h.make('restored',plain(a.session.log));assert.equal(refs(await step(restored)).length,0)
 const legacy=new sessionApi.Session('legacy');legacy.append('user/message',user('既有对话'),{surfaceOp:'append'});h.sessions.push(legacy);assert.equal(refs(await step(agent(h.ctx,legacy))).length,0);assert.match(h.panel.status(legacy).notice,/已有/)
 h.data.shared_pool[0].injectionPolicy='manual';assert.equal(refs(await step(a)).length,0);assert.ok(a.session.log.some(e=>e.type==='user/message'&&e.data.source?.summary?.startsWith('ecolink-memory:')));h.panel()
})
test('empty opening checkpoint prevents subsequent universal backfill; new chat uses new policy',async()=>{
 const h=harness([memory('m','初始非通用','不会追补')]);const a=h.make('empty');await step(a);assert.equal(h.panel.status(a.session).initialized,true);h.data.shared_pool[0].injectionPolicy='universal';assert.equal(refs(await step(a)).length,0);assert.equal(refs(await step(h.make('after-change'))).length,1);h.panel()
})
test('manual queue targets captured session, persists before acknowledgment, enters empty tool step, deduplicates replay',async()=>{
 const h=harness([memory('m','手动','长计划与细节')]);const a=h.make('target-A'),b=h.make('target-B'),e=h.entry('m');let release;const gate=new Promise(r=>release=r);let held=true;h.ctx.on('session/flush',async()=>{if(held)await gate})
 let done=false;const task=h.panel.queue(a.session,{ref:e.ref,version:e.version}).then(v=>{done=true;return v});await new Promise(r=>setImmediate(r));assert.equal(done,false);assert.equal(h.panel.status(b.session).items.length,0);held=false;release();await task
 assert.equal(h.panel.status(a.session).items[0].status,'pending');const first=await step(a,[],false);assert.equal(refs(first).length,1);assert.equal(h.panel.status(a.session).items[0].status,'pending')
 const retry=await step(a,[],true);assert.equal(refs(retry).length,1);assert.equal(refs(await step(a,[])).length,0);assert.equal((await h.panel.queue(a.session,{ref:e.ref,version:e.version})).duplicate,true)
 const fork=h.make('fork',plain(a.session.log));assert.equal(refs(await step(fork)).length,0);assert.equal(h.panel.status(fork.session).items[0].status,'admitted');h.panel()
})
test('checkpoint failure retry is never false success; no native durability listener cannot acknowledge',async()=>{
 const h=harness([memory('m','写盘','待写入')]),a=h.make('disk-fail'),e=h.entry('m');let fail=true;h.ctx.on('session/flush',async()=>{if(fail)throw Error('synthetic ENOSPC')})
 await assert.rejects(h.panel.queue(a.session,{ref:e.ref,version:e.version}),/ENOSPC/);await assert.rejects(h.panel.queue(a.session,{ref:e.ref,version:e.version}),/ENOSPC/);fail=false;assert.equal((await h.panel.queue(a.session,{ref:e.ref,version:e.version})).duplicate,true);assert.equal(a.session.log.filter(e=>e.data.kind==='queue').length,1)
 h.ctx.handlers.set('session/flush',[]);await assert.rejects(step(a,[]),/持久化/);assert.equal(h.panel.status(a.session).items[0].status,'pending');h.panel()
})
test('cancel before native admission remains pending; long content requires explicitly labelled page and enforces version',async()=>{
 const h=harness([memory('long','长文','中文😀'.repeat(3000))]),a=h.make('partial'),e=h.entry('long');await assert.rejects(h.panel.queue(a.session,{ref:e.ref,version:e.version}),/全文超过/)
 await assert.rejects(h.panel.queue(a.session,{ref:e.ref,version:'old'}),/版本/);await h.panel.queue(a.session,{ref:e.ref,version:e.version,partial:true,offset:2,limit:400});const d=await step(a,[],false);assert.match(refs(d)[0].content[0].text,/"partial":true/)
 a.phase.abort.abort();await assert.rejects(step(a,[]));assert.equal(h.panel.status(a.session).items[0].status,'pending');assert.equal(a.session.log.some(e=>e.type==='user/message'),false);h.panel()
})
test('native host route has no arbitrary file path/token and validates captured session/version for every mutation',async()=>{
 const h=harness([memory('1','目录','正文')]),a=h.make('route'),e=h.entry('1');assert.equal(h.ctx.routes[0].path,'/api/ecolink');const call=(args,method='GET')=>h.panel.handle(new Request('http://synthetic/api/ecolink'+(method==='GET'?'?'+new URLSearchParams(args):''),{method,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify(args)}:{})}))
 assert.equal((await (await call({action:'list'})).json()).items.length,1);assert.equal((await call({action:'inject',sessionId:'closed',ref:e.ref,version:e.version},'POST')).status,400);assert.equal((await call({action:'inject',sessionId:a.session.id,ref:e.ref,version:e.version})).status,400)
 await call({action:'inject',sessionId:a.session.id,ref:e.ref,version:e.version},'POST');assert.equal(h.panel.status(a.session).items.length,1);assert.equal(a.session.log.some(e=>e.type==='user/message'),false);h.panel()
})
test('service guard: timeout/foreign listener never spawns; IPv6 local accepted; handler removed on disposal',async()=>{
 assert.equal(isLocalServiceUrl('http://[::1]:17520'),true)
 for(const mode of ['timeout','occupied']){let spawns=0;const ctx=context(),guard=createServiceGuardModule(ctx,{enabled:true,serviceAutoStart:true,serviceUrl:'http://localhost:17520'},null,{fetchImpl:async()=>{if(mode==='timeout')throw Error('timeout');return{status:401}},spawnImpl:()=>{spawns++;throw Error('must not spawn')}});assert.equal(await guard.ensureService('test'),mode==='timeout'?'uncertain':'occupied');assert.equal(spawns,0);guard();assert.equal(ctx.handlers.get('agent/pre-step').length,0)}
})

test('TO-01 integration: owned ecolink reader stays callable while MCP schemas are lazy-loaded',async()=>{
 const {fixture}=await import('../../../dsh-token-optimizer/test/availability.mjs')
 const f=fixture(['read','mcp__example__one','mcp__example__two']),a=f.agent('ecolink-with-optimizer')
 const reader=createMemoryReader({poolPath:'synthetic'},{readFile:()=>JSON.stringify({shared_pool:[memory('1','交接全文','细节完整')],session_pools:{}})})
 const dispose=createMemoryAccessModule(f.ctx,{enabled:true},null,{reader,defineTool})
 await f.create(a);assert.ok(f.view(a).visible.has('ecolink_memory'));assert.equal(f.view(a).visible.has('mcp__example__one'),false)
 const read=()=>f.view(a).visible.get('ecolink_memory').execute({action:'read',key:'交接全文'},{})
 assert.equal(JSON.parse(await read()).content,'细节完整');await f.call(a,{names:['mcp__example__one']});assert.equal(JSON.parse(await read()).content,'细节完整')
 dispose();f.stop()
})

test('service guard probes with configured token before considering readiness',async()=>{
 let headers;const ctx=context(),g=createServiceGuardModule(ctx,{enabled:true,serviceAutoStart:true,serviceUrl:'http://localhost:17520',serviceToken:'synthetic-only'},null,{fetchImpl:async(_url,opts)=>{headers=opts.headers;return{status:200}}})
 assert.equal(await g.ensureService('auth'),'already-running');assert.equal(headers['X-Ecolink-Token'],'synthetic-only');g()
})

test('existing conversation route queues manual full memory and admits it on the next step without universal backfill',async()=>{
 const h=harness([memory('u','通用资料','不追补的资料','universal'),memory('m','手动资料','当前对话需要的完整细节')])
 const a=h.make('existing-conversation');a.session.append('user/message',user('之前已经聊过的任务'),{surfaceOp:'append'})
 const e=h.entry('m'),request=new Request('http://synthetic/api/ecolink',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'inject',sessionId:a.session.id,ref:e.ref,version:e.version})})
 const response=await h.panel.handle(request);assert.equal(response.status,200);assert.equal((await response.json()).items[0].status,'pending');assert.equal(a.session.log.filter(ev=>ev.type==='user/message').length,1)
 const messages=refs(await step(a));assert.equal(messages.length,1);assert.match(messages[0].content[0].text,/当前对话需要的完整细节/);assert.doesNotMatch(messages[0].content[0].text,/不追补的资料/);assert.equal(h.panel.status(a.session).items[0].status,'admitted');h.panel()
})


test('type filter finds universal memories beyond the first page across shared and session pools',()=>{
 const h=harness(Array.from({length:25},(_,i)=>memory(String(i),'条目'+i,'完整正文'+i,i===24?'universal':'manual')))
 h.data.session_pools={other:{identity:'会话池',memories:[memory('session-u','会话通用','会话通用全文','universal')]}}
 h.data.shared_pool[24].timestamp='2025-01-01T00:00:00Z';h.data.session_pools.other.memories[0].timestamp='2024-01-01T00:00:00Z'
 assert.equal(h.reader.list().items.some(e=>e.injectionPolicy==='universal'),false)
 const universal=h.reader.list({injectionPolicy:'universal'});assert.equal(universal.total,2);assert.ok(universal.items.every(e=>e.injectionPolicy==='universal'))
 assert.equal(h.reader.read({ref:universal.items[0].ref,version:universal.items[0].version}).content,universal.items[0].id==='24'?'完整正文24':'会话通用全文')
 assert.equal(h.reader.list({injectionPolicy:'manual'}).total,24);assert.throws(()=>h.reader.list({injectionPolicy:'bad'}),/类型无效/)
 h.data.shared_pool[24].injectionPolicy='manual';assert.equal(h.reader.list({injectionPolicy:'universal'}).total,1);h.panel()
})

test('actual host service guard: status, durable manual injection, and pre-step use the injected session service',async()=>{
 const h=harness([memory('m','可注入资料','现有对话所需完整正文')]),a=h.make('guarded-existing');h.panel()
 a.session.append('user/message',user('已有任务'),{surfaceOp:'append'})
 const guarded=restrictSessionService(h.ctx);assert.throws(()=>guarded.sessions,/cannot get property "sessions" without inject/)
 const panel=createMemoryPanelModule(guarded,h.config,null,{reader:h.reader,llm,sessionApi}),e=h.entry('m')
 const status=await panel.handle(new Request('http://synthetic/api/ecolink?action=status&sessionId=guarded-existing'));assert.equal(status.status,200)
 const response=await panel.handle(new Request('http://synthetic/api/ecolink',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'inject',sessionId:a.session.id,ref:e.ref,version:e.version})}));assert.equal(response.status,200);assert.equal((await response.json()).items[0].status,'pending')
 assert.ok(a.session.log.some(ev=>ev.type==='plugin:ecolink/state'&&ev.data.kind==='queue'))
 const admitted=refs(await step(a));assert.equal(admitted.length,1);assert.match(admitted[0].content[0].text,/现有对话所需完整正文/);assert.equal(panel.status(a.session).items[0].status,'admitted');panel()
})
