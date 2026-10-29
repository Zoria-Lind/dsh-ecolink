import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createOfflineQueue} from '../core/queue.mjs'
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r))}
const sse=frames=>frames.map(v=>'data: '+JSON.stringify(v)).join('\n\n')
function page(fetch,{throwArtifact=false,abortSignal=AbortSignal}={}){
 const listeners=new Map(),sent=[],requests=[]
 const window={location:{pathname:'/a/chat/s/test',href:'https://chat.deepseek.com/a/chat/s/test',origin:'https://chat.deepseek.com'},localStorage:{getItem:()=>null},
 addEventListener:(n,h)=>listeners.set(n,h),dispatchEvent:e=>{if(throwArtifact&&e.type==='ecolink:artifact-stream')throw Error('synthetic event failure');sent.push(e)},
 fetch:async(...args)=>{requests.push(args);return fetch(...args)}}
 const document={body:null,addEventListener:()=>{},querySelectorAll:()=>[]}
 vm.runInNewContext(readFileSync(new URL('../inject.js',import.meta.url),'utf8'),{window,document,URL,Request,Response,Headers,AbortSignal:abortSignal,TextDecoder,
 CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail}},performance:{now:()=>0},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,requestAnimationFrame:()=>{},MutationObserver:class{observe(){}}})
 return{window,listeners,sent,requests,settings:value=>listeners.get('ecolink:cu')({detail:JSON.stringify({settings:value})}),
 harvest:()=>sent.filter(e=>e.type==='ecolink:page').map(e=>JSON.parse(e.detail)).filter(e=>e.type==='harvest')}
}
const tag='<DSM:memory_write key="user_hobby" importance="called">用户喜欢蓝色星空</DSM:memory_write>'
const raw=sse([{v:{response:{message_id:17,status:'WIP',fragments:[{type:'THINK',content:'不入正文'}]}}},
 {p:'response/fragments',o:'APPEND',v:[{type:'RESPONSE',content:'答复正文\n'+tag.slice(0,22)}]},
 {p:'response/fragments/-1/content',o:'APPEND',v:tag.slice(22,55)},{v:tag.slice(55)},{p:'response/status',o:'SET',v:'FINISHED'}])
test('native MAIN world interceptor starts before the page; isolated UI does not rely on script tag injection',()=>{
 const m=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url)))
 assert.ok(m.content_scripts.some(s=>s.world==='MAIN'&&s.run_at==='document_start'&&s.js.includes('inject.js')))
 const isolated=m.content_scripts.find(s=>s.js.includes('artifact.js'));assert.notEqual(isolated.world,'MAIN')
 assert.equal(/s\.src\s*=\s*chrome.runtime.getURL\('inject.js'\)/.test(readFileSync(new URL('../content.js',import.meta.url),'utf8')),false)
})
test('split and JSON-escaped short tag is still automatically harvested while full original stream stays unchanged',async()=>{
 const p=page(async()=>new Response(raw));const r=await p.window.fetch('/api/v0/chat/completion',{method:'POST',body:JSON.stringify({chat_session_id:'test',prompt:'普通用户消息'})})
 assert.equal(await r.text(),raw);await settle();assert.equal(p.harvest().length,1);assert.equal(p.harvest()[0].memories[0].content,'用户喜欢蓝色星空')
 assert.equal(p.harvest()[0].session_id,'test');assert.ok(p.requests[0][1].body.includes('DSM:memory_write'))
 assert.equal(JSON.parse(p.sent.find(e=>e.type==='ecolink:artifact-stream').detail).raw,raw)
})
test('explicit artifact capture failure cannot disable original automatic short tag harvesting',async()=>{
 const plain=sse([{choices:[{delta:{content:tag},finish_reason:'stop'}]}]);const p=page(async()=>new Response(plain),{throwArtifact:true})
 await(await p.window.fetch('/api/v0/chat/completion',{method:'POST',body:'{"chat_session_id":"test","prompt":"消息"}'})).text();await settle()
 assert.equal(p.harvest().length,1);assert.equal(p.harvest()[0].memories[0].key,'user_hobby')
})
test('harvest switch, automatic injection switch and mute remain respected',async()=>{
 for(const settings of [{harvestEnabled:false},{injectEnabled:false},{muted:true}]){
  const p=page(async()=>new Response(raw));p.settings(settings)
  assert.equal(await(await p.window.fetch('/api/v0/chat/completion',{method:'POST',body:'{"chat_session_id":"test","prompt":"消息"}'})).text(),raw);await settle()
  assert.equal(p.harvest().length,0)
 }
})
test('existing history snapshot is captured without short-memory markers; no response rewrite when nothing needs cleaning',async()=>{
 const payload={data:{biz_code:0,biz_data:{chat_session:{id:'test'},chat_messages:[{message_id:17,message_role:'assistant',content:'# 已有回答\n\n原始正文'}]}}}
 const body=JSON.stringify(payload);const p=page(async()=>new Response(body,{headers:{'content-type':'application/json'}}));p.settings({harvestEnabled:false})
 assert.equal(await(await p.window.fetch('/api/v0/chat/history_messages?chat_session_id=test')).text(),body);await settle()
 const event=p.sent.find(e=>e.type==='ecolink:artifact-history');assert.ok(event);assert.deepEqual(JSON.parse(event.detail).payload,payload)
 assert.equal(p.harvest().length,0)
})
test('history capture and short-tag harvest coexist; escaped JSON is parsed before tags and API response is cleaned',async()=>{
 const payload={data:{biz_data:{chat_session:{id:'test'},chat_messages:[{message_id:17,message_role:'assistant',content:'正文\n'+tag}]}}}
 const p=page(async()=>Response.json(payload));const response=await p.window.fetch('/api/v0/chat/history_messages?chat_session_id=test')
 assert.equal((await response.json()).data.biz_data.chat_messages[0].content.includes('DSM:memory_write'),false)
 assert.equal(p.harvest()[0].memories[0].content,'用户喜欢蓝色星空');assert.equal(p.harvest()[0].session_id,'test')
 assert.equal(JSON.parse(p.sent.find(e=>e.type==='ecolink:artifact-history').detail).payload.data.biz_data.chat_messages[0].content,'正文\n'+tag)
})
test('clicking existing-answer save can read current conversation history with remembered headers; never sends a completion',async()=>{
 const payload={data:{biz_data:{chat_session:{id:'test'},chat_messages:[{message_id:17,message_role:'assistant',content:'历史正文'}]}}}
 const p=page(async()=>Response.json(payload))
 await p.window.fetch('/api/v0/chat_session/fetch_page',{headers:{Authorization:'Bearer synthetic-page-token','x-client-version':'fixture'}})
 const listener=p.listeners.get('ecolink:artifact-history-request');assert.ok(listener)
 await listener({detail:JSON.stringify({requestId:'request-17',pagePath:'/a/chat/s/test'})});await settle()
 const request=p.requests.at(-1);assert.match(String(request[0]),/\/api\/v0\/chat\/history_messages\?chat_session_id=test$/)
 assert.equal(new Headers(request[1].headers).get('authorization'),'Bearer synthetic-page-token')
 assert.equal(p.requests.some(([url])=>String(url).includes('/completion')),false)
 const result=p.sent.find(e=>e.type==='ecolink:artifact-history'&&JSON.parse(e.detail).requestId==='request-17');assert.ok(result)
})
test('short-memory queue refreshes expired service authorization once and retains failed writes for retry',async()=>{
 let value=[],token='expired',refreshes=0;const requests=[]
 const storage={get:async()=>({ecolink_outbox:structuredClone(value)}),set:async o=>{value=structuredClone(o.ecolink_outbox)}}
 const q=createOfflineQueue({storage,bridgeUrl:'http://synthetic',token:()=>token,refreshToken:async()=>{refreshes++;token='fresh';return token},maxRetries:1,
 fetchImpl:async(url,init)=>{requests.push(init);return{ok:init.headers['X-Ecolink-Token']==='fresh',status:401,json:async()=>({ok:true})}}})
 await q.push({kind:'sync',payload:{memories:[{content:'虚构事实'}]}});await settle()
 assert.equal(refreshes,1);assert.equal(value.length,0);assert.equal(requests.length,2);assert.equal(requests[0].body,requests[1].body)
})

function slowHistory(){
 let now=0,release
 const deadlines=[],payload={data:{biz_data:{chat_session:{id:'test'},chat_messages:[{message_id:17,message_role:'assistant',content:'完整历史正文'}]}}}
 const abortSignal={timeout(ms){const controller=new AbortController();deadlines.push({at:now+ms,controller});return controller.signal}}
 const p=page((_url,init)=>new Promise((resolve,reject)=>{
  init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})
  release=()=>resolve(Response.json(payload))
 }),{abortSignal})
 return{...p,read:id=>p.listeners.get('ecolink:artifact-history-request')({detail:JSON.stringify({requestId:id,pagePath:'/a/chat/s/test'})}),
 advance:ms=>{now+=ms;for(const d of deadlines)if(d.at<=now&&!d.controller.signal.aborted)d.controller.abort(new DOMException('signal timed out','TimeoutError'))},
 release:()=>release(),result:id=>p.sent.filter(e=>e.type==='ecolink:artifact-history').map(e=>JSON.parse(e.detail)).find(e=>e.requestId===id)}
}
test('history fetch tolerates a response arriving after fifteen seconds without a second request',async()=>{
 const p=slowHistory(),read=p.read('slow-history')
 p.advance(15000);p.release();await read
 assert.equal(p.result('slow-history').error,undefined)
 assert.equal(p.result('slow-history').payload.data.biz_data.chat_messages[0].content,'完整历史正文')
 assert.equal(p.requests.length,1)
})
test('history timeout is actionable and an explicit retry can recover without sending a completion',async()=>{
 const p=slowHistory(),read=p.read('timed-out')
 p.advance(31000);await read
 assert.match(p.result('timed-out').error,/超时|超过.*秒/)
 assert.doesNotMatch(p.result('timed-out').error,/signal timed out/)
 const retry=p.read('explicit-retry');p.release();await retry
 assert.equal(p.result('explicit-retry').payload.data.biz_data.chat_messages[0].content,'完整历史正文')
 assert.equal(p.requests.length,2)
 assert.ok(p.requests.every(([url])=>String(url).includes('/history_messages')))
})
