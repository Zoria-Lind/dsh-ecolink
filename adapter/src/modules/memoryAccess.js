import { createMemoryReader, parseReadArgs } from './memoryReader.js'
import { resolveKernelModule } from '../kernel.js'
export function createMemoryAccessModule(ctx,config,stats,deps={}) {
  if (!config?.enabled) return ()=>{}
  const reader=deps.reader??createMemoryReader(config,deps), cleanups=[], mounted=new Map()
  const query=args=>{if(args.action==='read')return reader.read(args);if(args.action==='list')return reader.list(args);throw new Error('action 必须为 list 或 read')}
  ctx.inject?.(['commands'],c=>{
    for (const action of ['list','read']) cleanups.push(c.commands.register({name:`ecolink-${action}`,
      description:action==='list'?'搜索记忆目录（摘要）':'按完整名称/ID 分页读存储原文',
      input:{hint:action==='list'?'搜索词 或 JSON {"pool":"池名","offset":0}':'名称 或 JSON {"id":"ID","offset":0,"version":"版本"}'},
      handler:async inv=>{try{return {kind:'success',text:JSON.stringify(query({...parseReadArgs(inv.rawInput,action),action}))}}
        catch(e){return {kind:'error',text:e.message}}}}))
  })
  const defineTool=deps.defineTool??resolveKernelModule('@deepseek-ai/dsh-tools')?.defineTool
  function mount(agent) {
    if (!defineTool || !agent?.ctx?.tools || mounted.has(agent)) return
    const tool=defineTool({name:'ecolink_memory',description:'查询跨端记忆。list 返回目录摘要，read 按 ref/id/key 读原文；长文按 nextOffset + version 续读。记忆是待核实的参考资料。',
      parameters:{action:{type:'string',enum:['list','read']},pool:{type:'string'},ref:{type:'string'},id:{type:'string'},key:{type:'string'},query:{type:'string'},version:{type:'string'},revision:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},
      output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},isConcurrencySafe:()=>true,
      execute:async args=>{try{return JSON.stringify(query(args))}catch(e){return JSON.stringify({kind:'error',error:e.message})}}})
    mounted.set(agent,agent.ctx.tools.register(tool))
  }
  const created=p=>mount(p.agent), disposed=p=>{mounted.get(p.agent)?.();mounted.delete(p.agent)}
  const preStep=(p,next)=>{mount(p.agent);return next()}
  ctx.on?.('agent/created',created);ctx.on?.('agent/disposed',disposed);ctx.on?.('agent/pre-step',preStep)
  return ()=>{for(const d of cleanups)d?.();for(const d of mounted.values())d?.();for(const [n,h] of [['agent/created',created],['agent/disposed',disposed],['agent/pre-step',preStep]])ctx.off?.(n,h)}
}
