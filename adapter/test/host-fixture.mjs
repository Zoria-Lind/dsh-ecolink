import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import vm from 'node:vm'
const root=join(dirname(fileURLToPath(import.meta.url)),'../../..')
const rows=[]
for(const name of ['host-fixtures.json','checkpoint-fixtures.json'])rows.push(...JSON.parse(fs.readFileSync(join(root,'_evidence/TO-03',name),'utf8')))
const host={}
for(const row of rows){const bytes=fs.readFileSync(row.copy);assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);host[row.inside.split('/')[3]]=bytes.toString('utf8')}
export function clip(text,start,end){const i=text.indexOf(start),j=text.indexOf(end,i+start.length);assert.ok(i>=0&&j>i,start);return text.slice(i,j)}
const deepFreeze=o=>{if(o&&typeof o==='object'&&!Object.isFrozen(o)){Object.freeze(o);for(const v of Object.values(o))deepFreeze(v)}return o}
const snapshotJsonValue=o=>{try{return JSON.parse(JSON.stringify(o))}catch{return undefined}}
const common={structuredClone,deepFreeze,snapshotJsonValue,brandNumber:x=>x,brandString:x=>x,isAbsolute:p=>/^(?:[A-Z]:[\\/]|\/)/i.test(p),assertNever:x=>{throw Error('unexpected '+x)},Service:class {},scopeOf:Symbol('scope'),scopeTarget:Symbol('scopeTarget'),callConfigEquals:(a,b)=>JSON.stringify(a)===JSON.stringify(b)}
export const sessionApi=vm.runInNewContext(host['dsh-session'].replace(/^import .*\n/gm,'').replace(/^export \{[^]*$/m,'')+'\n({Session,appendPluginRecord,pluginRecordOf,SessionStore})',common)
export const llm=vm.runInNewContext(clip(host['dsh-llm'],'const CONTEXT_SUMMARY_MAX_CHARS','//#endregion')+'\n({createUserMessage})',{...common,randomUUID})
export const defineTool=vm.runInNewContext(clip(host['dsh-tools'],'//#region lib/types/json-schema.js','//#region lib/types/ptc-calls.js')+'\ndefineTool',{HarnessError:Error,assertNever:common.assertNever,isJsonValue:x=>JSON.stringify(x)!==undefined})
export const hostPreStep=vm.runInNewContext('({'+clip(host['dsh-agent-loop'],'\tasync preStep(target, position) {','\t/** Whether the assembled tool schemas differ')+'})',{assembleContextFor:()=>({}),renderContextSections:()=>[],joinContextSections:()=>''}).preStep
export const hostFlush=vm.runInNewContext('({'+clip(host['dsh-session'],'\tasync flush(session) {','\t/** Return the exact live entry')+'})',{collectSessionCallbacks:(ctx,args)=>ctx.handlers.get(args[1])??[]}).flush
export function context(sessions=[]){const handlers=new Map(),commands=new Map(),routes=[],definitions=new Map();const ctx={handlers,commands,routes,definitions,
 on(n,h,opts){const a=handlers.get(n)??[];opts?.prepend?a.unshift(h):a.push(h);handlers.set(n,a);return()=>this.off(n,h)},off(n,h){const a=handlers.get(n)??[];if(a.includes(h))a.splice(a.indexOf(h),1)},
 inject(names,fn){return fn({...ctx,commands:{register(d){commands.set(d.name,d);return()=>commands.delete(d.name)}},connection:{fetch:{register(d){routes.push(d);return()=>routes.splice(routes.indexOf(d),1)}}}})},
 async emit(n,p){for(const h of [...handlers.get(n)??[]])await h(p)},
 waterfall(agent,n,p,end){const a=[...handlers.get(n)??[]];const run=i=>i===a.length?end():a[i]({...p,agent},()=>run(i+1));return run(0)},
 sessions:{ctx:null,get:id=>sessions.find(s=>s.id===id),liveEntryFor:()=>({carrier:{}}),flush:hostFlush}}
 ctx.sessions.ctx=ctx;ctx.on('session/flush',async()=>{});return ctx}
export function agent(ctx,session){const owned=new Map(),a={id:'agent-'+session.id,session,ctx:{tools:{register(d){owned.set(d.name,d);return()=>owned.delete(d.name)}}},owned,phase:{kind:'running',abort:new AbortController()},inbox:{claim:()=>[]},loopCtx:{systemPrompt:{assemble:async()=>({})}},runtimeContext:{project:()=>undefined},dispatch:{waterfall:(n,p,end)=>ctx.waterfall(a,n,p,end)},preStep:hostPreStep};return a}
export const user=text=>llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})
export async function step(a,messages=[user('虚构用户请求')],admit=true){a.inbox.claim=()=>messages;const d=await a.preStep('next-turn',{turn:1,step:1});if(admit)for(const m of d.messages)a.session.append('user/message',m,{surfaceOp:'append'});return d}
export const plain=o=>JSON.parse(JSON.stringify(o))

// The real host property guard rejects services read outside their injected context.
const guardRow=JSON.parse(fs.readFileSync(join(root,'_evidence/ECO-03-feedback2/host-guard.json'),'utf8'))
const guardBytes=fs.readFileSync(guardRow.copy);assert.equal(createHash('sha256').update(guardBytes).digest('hex'),guardRow.sha256)
const guardText=guardBytes.toString('utf8'),guardStart=guardText.indexOf('\t\tget: (target, prop, ctx) => {',guardText.indexOf('var ReflectService = class')),guardEnd=guardText.indexOf('\n\t\tset:',guardStart)
assert.ok(guardStart>=0&&guardEnd>guardStart)
const guardSymbols={isolate:Symbol('isolate'),shadow:Symbol('shadow'),receiver:Symbol('receiver')}
const hostServiceGet=vm.runInNewContext('({'+guardText.slice(guardStart,guardEnd)+'}).get',{Reflect,Error,symbols:guardSymbols,isSpecialProperty:p=>typeof p==='symbol',getTraceable:(_ctx,value)=>value,enhanceError:e=>e})
export function restrictSessionService(base){
 const parent={[guardSymbols.isolate]:{},fiber:{runtime:null,inject:{}}}
 const target={...base,reflect:{props:{}},events:{waterfall(_n,_ctx,_prop,_err,end){return end()}},fiber:{runtime:{},store:{},inject:{},parent},[guardSymbols.isolate]:parent[guardSymbols.isolate]}
 delete target.sessions
 return new Proxy(target,{get:hostServiceGet})
}
