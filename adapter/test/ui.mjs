import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync,mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createOfflineQueue} from '../../extension/core/queue.mjs'
import {DEFAULT_CONFIG} from '../../extension/core/config.mjs'
import {createPool} from '../../service/pool.mjs'
import {artifactPayload,decodeArtifactStream,decodeArtifactHistory,matchArtifactSource,pageArtifactMarkdown} from '../../extension/core/artifact.mjs'
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r))}
function desktop({inputActions,desktopBridge}={}){const registrations=new Map(),opened=[];let definition,Panel,plugin,cursor=0,pending=[],store=[],effects=[],tree,props={sessionId:'A'};const requests=[]
 const React={createElement:(tag,attrs,...children)=>({tag,attrs:attrs??{},children:children.flat(Infinity).filter(v=>v!==null&&v!==false&&v!==undefined)}),
 useState(init){const i=cursor++;store[i]??={value:init};return[store[i].value,v=>{store[i].value=typeof v==='function'?v(store[i].value):v}]},
 useRef(init){const i=cursor++;return store[i]??(store[i]={current:init})},
 useEffect(fn,deps){const i=cursor++;if(!effects[i]||deps.some((v,n)=>v!==effects[i].deps[n])){pending.push(()=>{effects[i]?.dispose?.();effects[i]={deps,dispose:fn()}})}}}
 const fetch=(url,options={})=>new Promise(resolve=>{requests.push({args:options.method==='POST'?JSON.parse(options.body):Object.fromEntries(new URL('http://synthetic/'+url).searchParams),options,resolve:v=>resolve({ok:true,json:async()=>v})})})
 const styles=[]
 const document={createElement:()=>({remove(){styles.splice(styles.indexOf(this),1)}}),head:{appendChild:style=>styles.push(style)}}
 const disposers=[]
 const ctx={effect:fn=>disposers.push(fn()),sidebarRight:{openTab:kind=>opened.push(kind)},sidebarRightTabs:{register:d=>{definition=d;return()=>{}}},slots:{inject:(_n,fn)=>fn(),register:(d,component)=>{registrations.set(d.name,{definition:d,component});if(d.name==='sidebar.right.pane.tab')Panel=component;return()=>{}}}}
 vm.runInNewContext(readFileSync(new URL('../src/client.js',import.meta.url),'utf8'),{window:{dshDesktop:desktopBridge,__ModuleLoader__:{load:d=>{assert.equal(d.id,'@zoria-lind/dsh-ecolink-adapter');plugin=d.factory(n=>{assert.equal(n,'react');return React})}}},document,fetch,URLSearchParams,AbortController,setInterval:()=>1,clearInterval:()=>{}})
 plugin.apply(ctx)
 const render=(sessionId=props.sessionId)=>{props={sessionId,inputActions};cursor=0;tree=Panel(props);const work=pending;pending=[];work.forEach(fn=>fn());return tree}
 const nodes=(value=tree)=>typeof value==='object'&&value?[value,...(value.children??[]).flatMap(v=>nodes(v))]:[]
 const click=text=>{const node=nodes().find(n=>n.tag==='button'&&n.children[0]===text);assert.ok(node,text);return node.attrs.onClick()}
 return{render,requests,click,nodes,registrations,opened,styles,openHeader(){const entry=registrations.get('conversation.session.header.utilities');assert.ok(entry,'native session header entry');const button=entry.component(entry.definition.inject());button.attrs.onClick();return button},get definition(){return definition},dispose:()=>{effects.forEach(e=>e?.dispose?.());disposers.reverse().forEach(dispose=>dispose?.())}}
}
test('actual desktop component keeps captured target/version, ignores stale previews/status after switching, and registers native sidebar type',async()=>{
 const ui=desktop();assert.equal(ui.definition.kind,'ecolink-memory');ui.openHeader();assert.deepEqual(ui.opened,['ecolink-memory']);ui.render('A')
 const item={id:'1',key:'条目',ref:'["shared","1"]',version:'v1',pool:'共享池',chars:4,preview:'正文',injectionPolicy:'manual'}
 ui.requests.find(r=>r.args.action==='list').resolve({total:1,offset:0,nextOffset:null,items:[item]});await settle();ui.render();ui.click('条目 · 非通用')
 const oldPreview=ui.requests.find(r=>r.args.action==='read');ui.render('B');oldPreview.resolve({content:'A的正文',offset:0,totalChars:4,nextOffset:null,partial:false});ui.requests.find(r=>r.args.action==='status'&&r.args.sessionId==='A').resolve({items:[{ref:'A的状态',token:'A',status:'pending'}],omitted:0});await settle();ui.render();assert.equal(JSON.stringify(ui.nodes()).includes('A的正文'),false);assert.equal(JSON.stringify(ui.nodes()).includes('A的状态'),false)
 const bList=ui.requests.filter(r=>r.args.action==='list').at(-1);bList.resolve({total:1,offset:0,nextOffset:null,items:[item]});await settle();ui.render();ui.click('条目 · 非通用');ui.requests.filter(r=>r.args.action==='read').at(-1).resolve({content:'正文',offset:0,totalChars:2,nextOffset:null,partial:false});await settle();ui.render();const mutation=ui.click('注入全文');const inject=ui.requests.find(r=>r.args.action==='inject');assert.equal(inject.args.sessionId,'B');assert.equal(inject.args.version,'v1');ui.render('C');inject.resolve({items:[{ref:'B的结果',token:'B',status:'pending'}],omitted:0});await mutation;ui.render();assert.equal(JSON.stringify(ui.nodes()).includes('B的结果'),false);ui.dispose()
})
test('draft handoff inserts full text only in the current chat and never submits',async()=>{
 const inserted=[],span={start:4,end:4,draftRev:3},inputActions={captureInsertion:()=>span,
  insertText:(...args)=>{inserted.push(args);return true},submit:()=>assert.fail('draft handoff must not submit')}
 const ui=desktop({inputActions,desktopBridge:{browser:{acquireEcolink:()=>{}}}})
 assert.ok(ui.registrations.has('shell.overlay'));ui.render('A')
 const item={id:'1',key:'草稿正文',ref:'draft-ref',version:'v1',pool:'共享池',chars:6,injectionPolicy:'manual'}
 ui.requests.find(r=>r.args.action==='list').resolve({total:1,offset:0,nextOffset:null,items:[item]})
 await settle();ui.render();ui.click('草稿正文 · 非通用')
 const full='正文\n\n结尾'
 ui.requests.find(r=>r.args.action==='read').resolve({content:full,offset:0,totalChars:6,nextOffset:null,version:'v1'})
 await settle();ui.render()
 const prior=ui.nodes().find(n=>n.tag==='button'&&n.children[0]==='带入草稿')
 assert.ok(prior);prior.attrs.onClick()
 assert.deepEqual(inserted,[[full,span]])
 ui.render('B');prior.attrs.onClick()
 assert.equal(inserted.length,1);assert.equal(ui.requests.some(r=>r.options.method==='POST'),false);ui.dispose()
})

test('header button uses scoped transparent styling and releases its stylesheet',()=>{
 const ui=desktop();const button=ui.openHeader()
 assert.equal(button.tag,'button');assert.equal(button.attrs.type,'button');assert.equal(button.attrs['aria-label'],'打开记忆池')
 assert.equal(button.attrs.className,'ecolink-header-button');assert.equal(button.attrs.style,undefined)
 assert.equal(ui.styles.length,1)
 assert.match(ui.styles[0].textContent,/\.ecolink-header-button\s*\{[^}]+background: transparent;/)
 assert.match(ui.styles[0].textContent,/\.ecolink-header-button:focus-visible\s*\{[^}]+outline: 2px/)
 ui.dispose();assert.equal(ui.styles.length,0)
})

test('native header entry is available for an existing chat and full text loads across Unicode pages without injecting',async()=>{
 const ui=desktop();ui.render('existing-chat');ui.openHeader();assert.deepEqual(ui.opened,['ecolink-memory'])
 const chars=Array.from('开头'+('😀中文'.repeat(3000))+'结尾'),full=chars.join('')
 const item={id:'long',key:'完整策划',ref:'["shared","long"]',version:'v-long',pool:'共享池',chars:chars.length,preview:'开头摘要',injectionPolicy:'manual'}
 ui.requests.find(r=>r.args.action==='list').resolve({total:1,offset:0,nextOffset:null,items:[item]});await settle();ui.render();ui.click('完整策划 · 非通用')
 for(let start=0;start<chars.length;start+=4000){
  const req=ui.requests.filter(r=>r.args.action==='read').at(-1);assert.equal(Number(req.args.offset),start);assert.equal(req.args.version,'v-long')
  assert.equal(ui.nodes().some(n=>n.tag==='button'&&n.children[0]==='注入全文'),false)
  req.resolve({content:chars.slice(start,start+4000).join(''),offset:start,totalChars:chars.length,nextOffset:start+4000<chars.length?start+4000:null,version:'v-long'});await settle();ui.render()
 }
 assert.equal(ui.nodes().filter(n=>n.tag==='pre')[0].children[0],full)
 assert.equal(ui.requests.some(r=>r.args.action==='inject'),false)
 ui.click('下一段');ui.render();const task=ui.click('仅注入当前段'),req=ui.requests.find(r=>r.args.action==='inject')
 assert.equal(req.args.sessionId,'existing-chat');assert.equal(req.args.version,'v-long');assert.equal(req.args.partial,true);assert.equal(req.args.offset,1500);assert.equal(req.args.limit,1500)
 req.resolve({items:[],omitted:0});await task;ui.dispose()
})
test('incomplete full-text loading cannot be saved as full injection and a replaced preview ignores its remaining pages',async()=>{
 const ui=desktop();ui.render('old');const item={id:'x',key:'长文',ref:'x',version:'v',chars:5000,injectionPolicy:'manual'}
 ui.requests.find(r=>r.args.action==='list').resolve({total:1,offset:0,nextOffset:null,items:[item]});await settle();ui.render();ui.click('长文 · 非通用')
 ui.requests.filter(r=>r.args.action==='read').at(-1).resolve({content:'甲'.repeat(4000),offset:0,totalChars:5000,nextOffset:4000,version:'v'});await settle();ui.render()
 const trailing=ui.requests.filter(r=>r.args.action==='read').at(-1);ui.render('new');trailing.resolve({content:'旧正文末尾',offset:4000,totalChars:5000,nextOffset:null,version:'v'});await settle();ui.render();assert.equal(JSON.stringify(ui.nodes()).includes('旧正文末尾'),false);assert.equal(trailing.options.signal.aborted,true);ui.dispose()
 const broken=desktop();broken.render('old');broken.requests.find(r=>r.args.action==='list').resolve({total:1,offset:0,nextOffset:null,items:[item]});await settle();broken.render();broken.click('长文 · 非通用')
 broken.requests.filter(r=>r.args.action==='read').at(-1).resolve({content:'少了正文',offset:0,totalChars:5000,nextOffset:null,version:'v'});await settle();broken.render()
 assert.match(JSON.stringify(broken.nodes()),/正文分页不完整/);assert.equal(broken.nodes().some(n=>n.tag==='button'&&n.children[0]==='注入全文'),false);broken.dispose()
})
function browser(pool,{id=17,text,withThinking=false,pageText,timers={setTimeout,clearTimeout}}={}){const buttons=[],modals=[],events=new Map();let confirm=false,offline=true,notify=()=>{};const sent=[]
 class E{get childNodes(){return this.children}constructor(tag){this.nodeType=1;this.tagName=tag.toUpperCase();this.tag=tag;this.style={};this.children=[];this.value='';this.attributes={}}append(...xs){this.children.push(...xs)}attachShadow(){return this.shadow=new E('shadow')}setAttribute(k,v){this.attributes[k]=v}getAttribute(k){return this.attributes[k]??null}remove(){this.removed=true}insertAdjacentElement(_p,node){buttons.push(node)}closest(selector){if(selector.includes('data-message-id'))return this.container;return null}replaceChildren(){this.children=[]}}
 const answer=new E('article');answer.container=new E('div');if(id!=null)answer.container.attributes['data-message-id']=String(id);answer.innerText=text;answer.textContent=text;if(pageText!=null)answer.children=[{nodeType:3,nodeValue:pageText}];const body=new E('body');body.append=(e)=>modals.push(e)
 const thinking=new E('article'),wrapper=new E('div'),heading=new E('div')
 thinking.className=withThinking==='class'?'reasoning_content':withThinking==='inner'?'reasoning':''
 thinking.innerText='Internal analysis text';thinking.textContent=thinking.innerText
 heading.textContent=withThinking==='late'||withThinking==='inner'||withThinking==='class'?'':withThinking==='english'?'thinking (7 s)':'已思考（用时7秒）'
 wrapper.append(heading,thinking);wrapper.querySelectorAll=()=>[thinking];thinking.parentElement=wrapper
 if(withThinking==='inner')thinking.closest=selector=>selector.includes('._74c0879')?wrapper:null
 const document={body,createElement:t=>new E(t),querySelectorAll:()=>withThinking?[thinking,answer]:[answer]};const chrome={runtime:{getURL:()=>'',sendMessage:async msg=>{sent.push(structuredClone(msg));if(offline)throw Error('synthetic offline');return pool.saveArtifact(msg)}}}
 const source=readFileSync(new URL('../../extension/artifact.js',import.meta.url),'utf8').replace("await import(chrome.runtime.getURL('core/artifact.mjs'))",'artifactModule')
 const ready=vm.runInNewContext(source,{artifactModule:{artifactPayload,decodeArtifactStream,decodeArtifactHistory,matchArtifactSource,pageArtifactMarkdown},chrome,crypto:{randomUUID},document,window:{location:{pathname:'/chat/test'},addEventListener:(n,h)=>events.set(n,h),dispatchEvent:e=>sent.push({event:e.type,detail:JSON.parse(e.detail)}),confirm:()=>confirm},CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail}},MutationObserver:class{constructor(fn){notify=fn}observe(){}},setTimeout:timers.setTimeout,clearTimeout:timers.clearTimeout})
 const nodes=(v)=>v?[v,...(v.children??[]).flatMap(nodes),...(v.shadow?nodes(v.shadow):[])]:[]
 return{ready,sent,events,buttons,thinking,heading,async rescan(){notify();await new Promise(resolve=>setTimeout(resolve,280))},activeButtons:()=>buttons.filter(n=>!n.removed),open:()=>buttons[0].shadow.children[0].onclick(),fields:()=>nodes(modals.at(-1)),setOffline:v=>offline=v,setConfirm:v=>confirm=v}
}
test('actual web editor: matching full raw source, offline retry stable ID, same-name cancel and confirmed retained version',async()=>{
 const root=process.env.DSH_ECO_STATE;assert.ok(root);const pool=createPool({dir:mkdtempSync(join(root,'editor-'))}),b=browser(pool);await b.ready
 const full='  # 全文\n[链接] {对象}\n```js\nconst x = "<DSM:memory_write>原文标签</DSM:memory_write>"\n```\n'+('细节😀\n'.repeat(900))+'末尾  '
 b.events.get('ecolink:artifact-source')({detail:JSON.stringify({ok:true,id:17,content:full})});b.open();const fields=b.fields(),name=fields.find(n=>n.tag==='input'),body=fields.find(n=>n.tag==='textarea'),save=fields.find(n=>n.textContent==='确认保存全文');name.value='完整策划书';assert.equal(body.value,full)
 const wrap=fields.find(n=>n.attributes?.['aria-label']==='自动换行');assert.ok(wrap);assert.equal(wrap.checked,true);assert.equal(body.getAttribute('wrap'),'soft');assert.equal(body.style.whiteSpace,'pre-wrap');assert.equal(body.style.overflowWrap,'anywhere')
 wrap.checked=false;wrap.onchange();assert.equal(body.getAttribute('wrap'),'off');assert.equal(body.style.whiteSpace,'pre');assert.equal(body.value,full)
 wrap.checked=true;wrap.onchange();assert.equal(body.getAttribute('wrap'),'soft');assert.equal(body.style.whiteSpace,'pre-wrap');assert.equal(body.value,full)
 await save.onclick();assert.equal(pool.pool().shared_pool.length,0);assert.equal(body.value,full);b.setOffline(false);await save.onclick();assert.equal(b.sent.filter(x=>x.kind==='artifact-save')[0].requestId,b.sent.filter(x=>x.kind==='artifact-save')[1].requestId);assert.equal(pool.pool().shared_pool[0].content,full)
 body.value=full+'\n新版本';await save.onclick();assert.equal(pool.pool().shared_pool[0].content,full);assert.equal(body.value,full+'\n新版本');b.setConfirm(true);await save.onclick();const item=pool.pool().shared_pool[0];assert.equal(item.content,body.value);assert.equal(item.versions[0].content,full);assert.equal(item.revision,2)
})

test('actual fetch interception captures complete original even with automatic injection off, without harvesting',async()=>{
 const raw='data: '+JSON.stringify({id:17,choices:[{delta:{content:'# 原始全文\n<DSM:memory_write>标签字面量</DSM:memory_write>'}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'
 const events=new Map(),sent=[];let calls=0
 const window={location:{pathname:'/chat/test'},localStorage:{getItem:()=>null},addEventListener:(n,fn)=>events.set(n,fn),dispatchEvent:e=>sent.push(e),fetch:async()=>{calls++;return new Response(raw)}}
 const document={body:null,currentScript:null,addEventListener:()=>{},querySelectorAll:()=>[]}
 const src=readFileSync(new URL('../../extension/inject.js',import.meta.url),'utf8')
 vm.runInNewContext(src,{window,document,URL,Request,Response,Headers,TextDecoder,CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail}},performance:{now:()=>0},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,requestAnimationFrame:()=>{},MutationObserver:class{observe(){}}})
 events.get('ecolink:cu')({detail:JSON.stringify({settings:{injectEnabled:false,harvestEnabled:true}})})
 const result=await window.fetch('https://chat.deepseek.com/api/v0/chat/completion',{method:'POST',body:JSON.stringify({chat_session_id:'test'})});assert.equal(await result.text(),raw);await settle();assert.equal(calls,1)
 assert.equal(JSON.parse(sent.find(e=>e.type==='ecolink:artifact-stream').detail).sessionId,'test')
 assert.equal(decodeArtifactStream(JSON.parse(sent.find(e=>e.type==='ecolink:artifact-stream').detail).raw).content,'# 原始全文\n<DSM:memory_write>标签字面量</DSM:memory_write>')
 assert.equal(sent.filter(e=>e.type==='ecolink:page').map(e=>JSON.parse(e.detail)).some(e=>e.type==='harvest'),false)
})
test('actual background explicit artifact save refreshes expired auth once with identical retry identity',async()=>{
 let listener;const requests=[],cfg={bridgeUrl:'http://127.0.0.1:21983',token:'expired'},storage={ecolink_config:cfg}
 const chrome={storage:{local:{get:async k=>({[k]:storage[k]}),set:async v=>Object.assign(storage,v)}},runtime:{onMessage:{addListener:fn=>listener=fn},onInstalled:{addListener:()=>{}}},contextMenus:{onClicked:{addListener:()=>{}}},alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}}
 const source=readFileSync(new URL('../../extension/background.js',import.meta.url),'utf8').replace(/^import .*$/gm,'')
 const fetch=async(url,opts)=>{requests.push({url,opts});if(url.endsWith('/token'))return Response.json({token:'fresh'});if(url.endsWith('/artifact'))return opts.headers['X-Ecolink-Token']==='expired'?Response.json({ok:false},{status:401}):Response.json({ok:true,revision:1});throw Error('unexpected synthetic URL')}
 vm.runInNewContext(source,{chrome,fetch,DEFAULT_CONFIG:{},createOfflineQueue:()=>({pendingCount:async()=>0}),AbortSignal,Response,console})
 const result=await new Promise(resolve=>listener({kind:'artifact-save',name:'全文',content:'内容',requestId:'synthetic-retry-1'},{},resolve))
 assert.equal(result.ok,true);const posts=requests.filter(r=>r.url.endsWith('/artifact'));assert.equal(posts.length,2);assert.equal(posts[0].opts.body,posts[1].opts.body);assert.equal(posts[1].opts.headers['X-Ecolink-Token'],'fresh')
})

test('web stream event auto-fills the clicked answer without a DOM message id or manual paste',async()=>{
 const state=process.env.DSH_ECO_STATE;assert.ok(state)
 const pool=createPool({dir:mkdtempSync(join(state,'editor-no-id-'))})
 const full='# 星舟计划\n\n**截止时间**：2031-03-18 17:20\n\n校验码：Q7-蓝莓-482'
 const b=browser(pool,{id:null,text:'星舟计划\n截止时间：2031-03-18 17:20\n校验码：Q7-蓝莓-482'});await b.ready
 const frames=[{v:{response:{message_id:17,fragments:[{type:'THINK',content:'思考不保存'}]}}},
 {p:'response/fragments/-1/elapsed_secs',o:'SET',v:1},
 {p:'response/fragments',o:'APPEND',v:[{type:'RESPONSE',content:full}]},{p:'response/status',o:'SET',v:'FINISHED'}]
 b.open();const fields=b.fields(),name=fields.find(n=>n.tag==='input'),body=fields.find(n=>n.tag==='textarea');assert.equal(body.value,'')
 b.events.get('ecolink:artifact-stream')({detail:JSON.stringify({raw:frames.map(f=>'data: '+JSON.stringify(f)).join('\n\n'),pagePath:'/',sessionId:'test'})})
 assert.equal(body.value,full);name.value='星舟自动保存验收';b.setOffline(false)
 await fields.find(n=>n.textContent==='确认保存全文').onclick()
 assert.equal(pool.pool().shared_pool[0].content,full)
})


test('desktop universal filter opens complete memory and can convert it to manual without changing chats',async()=>{
 const ui=desktop();ui.render('existing')
 const item={id:'u',key:'通用资料',ref:'["shared","u"]',version:'u-v1',pool:'共享池',chars:4,preview:'原文',injectionPolicy:'universal'}
 ui.requests.find(r=>r.args.action==='list').resolve({total:30,offset:0,nextOffset:10,items:[]});await settle();ui.render()
 ui.click('通用记忆');const filtered=ui.requests.filter(r=>r.args.action==='list').at(-1);assert.equal(filtered.args.injectionPolicy,'universal');assert.equal(filtered.args.offset,'0')
 filtered.resolve({total:1,offset:0,nextOffset:null,items:[item]});await settle();ui.render();ui.click('通用资料 · 通用')
 ui.requests.filter(r=>r.args.action==='read').at(-1).resolve({content:'完整原文',offset:0,totalChars:4,nextOffset:null,version:'u-v1'});await settle();ui.render()
 assert.equal(ui.nodes().find(n=>n.tag==='pre').children[0],'完整原文')
 const change=ui.click('改为非通用'),request=ui.requests.find(r=>r.args.action==='policy');assert.equal(request.args.injectionPolicy,'manual');assert.equal(request.args.ref,item.ref);assert.equal(request.args.version,'u-v1')
 request.resolve({ok:true});await change;ui.render();assert.equal(ui.requests.filter(r=>r.args.action==='list').at(-1).args.injectionPolicy,'universal');assert.equal(ui.requests.some(r=>r.args.action==='inject'),false);ui.dispose()
})

test('desktop injection shows submitting, pending, and backend errors next to the selected memory',async()=>{
 const ui=desktop();ui.render('existing');const item={id:'m',key:'需要注入',ref:'memory-ref',version:'v',chars:2,injectionPolicy:'manual'}
 ui.requests.find(r=>r.args.action==='list').resolve({total:1,offset:0,nextOffset:null,items:[item]});await settle();ui.render();ui.click('需要注入 · 非通用')
 ui.requests.filter(r=>r.args.action==='read').at(-1).resolve({content:'原文',offset:0,totalChars:2,nextOffset:null,version:'v'});await settle();ui.render()
 const injection=ui.click('注入全文');ui.render();let detail=ui.nodes().find(n=>n.attrs['aria-label']==='记忆完整正文');assert.match(JSON.stringify(detail),/正在保存注入选择/);assert.equal(ui.nodes(detail).find(n=>n.tag==='button'&&n.children[0]==='注入全文').attrs.disabled,true)
 ui.requests.find(r=>r.args.action==='inject').resolve({items:[{ref:item.ref,version:'v',token:'t',status:'pending'}],omitted:0});await injection;ui.render();detail=ui.nodes().find(n=>n.attrs['aria-label']==='记忆完整正文');assert.match(JSON.stringify(detail),/下次发送时注入当前对话/)
 const retry=ui.click('注入全文');ui.requests.filter(r=>r.args.action==='inject').at(-1).resolve({error:'模拟写盘失败，未确认成功'});await retry;ui.render();detail=ui.nodes().find(n=>n.attrs['aria-label']==='记忆完整正文');assert.match(JSON.stringify(detail),/模拟写盘失败，未确认成功/);ui.dispose()
})

test('explicit history read can fill an unavailable page answer; short labels stay intact in saved original',async()=>{
 const state=process.env.DSH_ECO_STATE;assert.ok(state);const pool=createPool({dir:mkdtempSync(join(state,'history-editor-'))})
 const tag='<DSM:memory_write key="user_hobby" importance="called">用户喜欢蓝色星空</DSM:memory_write>'
 const full='# 旧回答\n\n**计划**：先调研，再写作\n\n'+tag
 const b=browser(pool,{id:null,text:'旧回答\n计划：先调研，再写作'});await b.ready;b.open()
 const fields=b.fields(),body=fields.find(n=>n.tag==='textarea'),save=fields.find(n=>n.textContent==='确认保存全文')
 assert.equal(body.value,'');assert.equal(save.disabled,true)
 fields.find(n=>n.textContent==='尝试联网读取原始 Markdown').onclick()
 const request=b.sent.find(e=>e.event==='ecolink:artifact-history-request');assert.ok(request)
 b.events.get('ecolink:artifact-history')({detail:JSON.stringify({...request.detail,sessionId:'test',payload:{data:{biz_data:{chat_session:{id:'test'},chat_messages:[{message_id:17,message_role:'assistant',content:full}]}}}})})
 assert.equal(body.value,full);assert.equal(save.disabled,false)
 fields.find(n=>n.tag==='input').value='旧回答全文';b.setOffline(false);await save.onclick();assert.equal(pool.pool().shared_pool[0].content,full)
})
test('history read preserves a user edited body and ambiguous rendering offers explicit full-source selection',async()=>{
 const state=process.env.DSH_ECO_STATE;const b=browser(createPool({dir:mkdtempSync(join(state,'history-choice-'))}),{id:null,text:'含引用的表格渲染，不能用前缀猜测'})
 await b.ready;b.open();const fields=b.fields(),body=fields.find(n=>n.tag==='textarea')
 fields.find(n=>n.textContent==='尝试联网读取原始 Markdown').onclick()
 const request=b.sent.find(e=>e.event==='ecolink:artifact-history-request')
 b.events.get('ecolink:artifact-history')({detail:JSON.stringify({...request.detail,payload:{messages:[{role:'assistant',id:1,content:'# 第一份完整回答'},{role:'assistant',id:2,content:'|第二份|表格|\n|---|---|\n|精确|正文|'}]}})})
 assert.equal(body.value,'');const select=fields.find(n=>n.tag==='select');assert.equal(select.style.display,'block');select.value='1';select.onchange();assert.match(body.value,/第二份/)
 body.value='用户自己修改后的全文';body.oninput()
 b.events.get('ecolink:artifact-history')({detail:JSON.stringify({...request.detail,payload:{messages:[{role:'assistant',id:3,content:'另一个回答'}]}})})
 assert.equal(body.value,'用户自己修改后的全文')
})

for(const variant of ['chinese','class','english'])test('save button excludes reasoning sibling: '+variant,async()=>{
 const b=browser({}, {withThinking:variant,text:'最终回答'});await b.ready;assert.equal(b.buttons.length,1)
})
test('a late reasoning header removes its early save button and a reused body can gain it again',async()=>{
 const b=browser({}, {withThinking:'late',text:'最终回答'});await b.ready;assert.equal(b.activeButtons().length,2)
 const early=b.buttons[0];b.heading.textContent='已思考（用时7秒）'
 early.shadow.children[0].onclick();assert.equal(b.fields().length,0,'late reasoning cannot open an editor before the next scan')
 await b.rescan();assert.equal(b.activeButtons().length,1,'reasoning button removed after streaming header arrives')
 b.heading.textContent='普通回答';await b.rescan();assert.equal(b.activeButtons().length,2,'reused DOM is scanned again after becoming a response')
})

test('a generic content ancestor does not hide the inner reasoning marker',async()=>{
 const b=browser({}, {withThinking:'inner',text:'最终回答'});await b.ready;assert.equal(b.activeButtons().length,1)
})

test('ordinary final text beginning with a thinking phrase still has a save button',async()=>{
 const b=browser({}, {text:'思考过程：这里是用户要求保存在正文里的教学说明。'});await b.ready;assert.equal(b.activeButtons().length,1)
})

test('original automatic short tag reaches the actual content relay, background queue and isolated pool alongside full artifacts',async()=>{
 const state=process.env.DSH_ECO_STATE;const pool=createPool({dir:mkdtempSync(join(state,'auto-short-'))})
 let listener;const storage={ecolink_config:{...DEFAULT_CONFIG,bridgeUrl:'http://synthetic',token:'expired'}},requests=[]
 const chrome={storage:{local:{get:async k=>({[k]:storage[k]}),set:async v=>Object.assign(storage,v)},onChanged:{addListener:()=>{}}},
 runtime:{onMessage:{addListener:fn=>listener=fn},onInstalled:{addListener:()=>{}},getURL:()=>''},
 contextMenus:{onClicked:{addListener:()=>{}}},alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}}
 const fetch=async(url,opts={})=>{
  requests.push({url,opts})
  if(url.endsWith('/token'))return Response.json({token:'fresh'})
  if(url.endsWith('/pool'))return Response.json(pool.pool())
  if(url.endsWith('/sync')){
   if(opts.headers['X-Ecolink-Token']!=='fresh')return Response.json({ok:false},{status:401})
   return Response.json(await pool.sync(JSON.parse(opts.body)))
  }
  if(url.endsWith('/artifact'))return Response.json(await pool.saveArtifact(JSON.parse(opts.body)))
  throw Error('unexpected synthetic request')
 }
 const background=readFileSync(new URL('../../extension/background.js',import.meta.url),'utf8').replace(/^import .*$/gm,'')
 vm.runInNewContext(background,{chrome,fetch,DEFAULT_CONFIG,createOfflineQueue,AbortSignal,Response,console,setTimeout})
 chrome.runtime.sendMessage=msg=>new Promise(resolve=>listener(msg,{},resolve))
 const events=new Map(),window={localStorage:{getItem:()=>null},addEventListener:(n,h)=>events.set(n,h),dispatchEvent:()=>{}}
 vm.runInNewContext(readFileSync(new URL('../../extension/content.js',import.meta.url),'utf8'),{window,chrome,CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail}},setInterval:()=>1,console})
 await settle()
 events.get('ecolink:page')({detail:JSON.stringify({type:'harvest',session_id:'synthetic-session',memories:[{key:'user_hobby',content:'用户喜欢蓝色星空',importance:'called',source:'web'}]})})
 for(let i=0;i<25&&(!pool.sessionPool('synthetic-session')?.memories?.length);i++)await settle()
 assert.equal(pool.sessionPool('synthetic-session').memories[0].content,'用户喜欢蓝色星空')
 assert.equal(storage.ecolink_outbox.length,0)
 const syncPosts=requests.filter(r=>r.url.endsWith('/sync'));assert.equal(syncPosts.length,2);assert.equal(syncPosts[0].opts.body,syncPosts[1].opts.body)
 const artifact=await chrome.runtime.sendMessage({kind:'artifact-save',name:'完整成果',content:'# 长文\n'+('完整细节😀'.repeat(100)),requestId:'coexist-artifact'})
 assert.equal(artifact.ok,true);assert.equal(pool.sessionPool('synthetic-session').memories.length,1);assert.equal(pool.pool().shared_pool.some(m=>m.kind==='artifact'),true)
})

test('history editor waits through a slow read and allows retry while preserving a typed draft',async()=>{
 let now=0;const tasks=new Set()
 const timers={setTimeout(fn,delay){const task={fn,at:now+delay,unref(){}};tasks.add(task);return task},clearTimeout:task=>tasks.delete(task)}
 const advance=ms=>{now+=ms;for(const task of [...tasks])if(task.at<=now){tasks.delete(task);task.fn()}}
 const b=browser({}, {text:'现有回答',timers});await b.ready;b.open()
 const fields=b.fields(),retry=fields.find(n=>n.textContent==='尝试联网读取原始 Markdown'),body=fields.find(n=>n.tag==='textarea')
 retry.onclick()
 advance(13000);assert.equal(retry.disabled,true,'UI must not expire before the history request deadline')
 advance(23000);assert.equal(retry.disabled,false)
 assert.ok(fields.some(n=>/网络.*重试/.test(n.textContent??'')))
 assert.equal(fields.some(n=>/重新加载扩展/.test(n.textContent??'')),false)
 body.value='保留的草稿';body.oninput();retry.onclick()
 const request=b.sent.filter(n=>n.event==='ecolink:artifact-history-request').at(-1)
 b.events.get('ecolink:artifact-history')({detail:JSON.stringify({...request.detail,error:'读取原文超时，请稍后重试'})})
 assert.equal(body.value,'保留的草稿');assert.equal(retry.disabled,false)
 fields.find(n=>n.textContent==='取消').onclick()
})

test('visible answer opens locally without any history request and saves to the existing artifact path',async()=>{
 const state=process.env.DSH_ECO_STATE, pool=createPool({dir:mkdtempSync(join(state,'local-save-'))})
 const visible='页面已经显示的回答😀\n'+('任务细节\n'.repeat(1000))+'结尾校验'
 const b=browser(pool,{id:null,text:visible,pageText:visible});await b.ready;b.open()
 const fields=b.fields(),body=fields.find(n=>n.tag==='textarea'),save=fields.find(n=>n.textContent==='确认保存全文')
 assert.ok(body.value.includes('结尾校验'));assert.equal(save.disabled,false)
 assert.equal(b.sent.some(e=>e.event==='ecolink:artifact-history-request'),false)
 assert.ok(fields.some(n=>/页面还原/.test(n.textContent??'')))
 fields.find(n=>n.tag==='input').value='离线读取成果';b.setOffline(false);await save.onclick()
 assert.equal(pool.pool().shared_pool[0].content,body.value)
 fields.find(n=>n.textContent==='取消').onclick()
})
test('raw source upgrades an untouched page fallback, while late errors and raw data preserve edited drafts',async()=>{
 const b=browser({}, {text:'可见正文',pageText:'可见正文'});await b.ready;b.open()
 const fields=b.fields(),body=fields.find(n=>n.tag==='textarea'),retry=fields.find(n=>n.textContent==='尝试联网读取原始 Markdown')
 retry.onclick();assert.equal(body.value,'可见正文');assert.equal(fields.find(n=>n.textContent==='确认保存全文').disabled,false);const req=b.sent.filter(e=>e.event==='ecolink:artifact-history-request').at(-1)
 b.events.get('ecolink:artifact-history')({detail:JSON.stringify({...req.detail,error:'模拟网络超时'})})
 assert.equal(body.value,'可见正文');assert.ok(fields.some(n=>/已保留/.test(n.textContent??'')))
 const original='**可见正文**';b.events.get('ecolink:artifact-source')({detail:JSON.stringify({ok:true,id:17,content:original})})
 assert.equal(body.value,original);assert.ok(fields.some(n=>/已取得该回答原文/.test(n.textContent??'')))
 body.value='保留编辑细节';body.oninput()
 b.events.get('ecolink:artifact-source')({detail:JSON.stringify({ok:true,id:17,content:'更新的原文'})})
 assert.equal(body.value,'保留编辑细节')
 b.setConfirm(false);fields.find(n=>n.textContent==='重新读取页面正文（不联网）').onclick();assert.equal(body.value,'保留编辑细节')
 b.setConfirm(true);fields.find(n=>n.textContent==='重新读取页面正文（不联网）').onclick();assert.equal(body.value,'可见正文')
 fields.find(n=>n.textContent==='取消').onclick()
})

test('cached raw answer wins over the rendered fallback at opening without a history request',async()=>{
 const b=browser({}, {text:'页面正文',pageText:'页面正文'});await b.ready
 const send=value=>b.events.get('ecolink:artifact-source')({detail:JSON.stringify(value)})
 send({ok:true,id:17,content:'**原始 Markdown**',pagePath:'/chat/test'});b.open()
 const fields=b.fields(),body=fields.find(n=>n.tag==='textarea')
 assert.equal(body.value,'**原始 Markdown**');assert.equal(b.sent.some(e=>e.event==='ecolink:artifact-history-request'),false)
 fields.find(n=>n.textContent==='取消').onclick()
})
