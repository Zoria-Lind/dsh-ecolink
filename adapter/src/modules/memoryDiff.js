// Cursors belong to a DSH conversation. Only returned catalog rows are acknowledged.
import { createMemoryReader, catalogEntry } from './memoryReader.js'
export function createMemoryDiffModule(ctx, config, stats, deps={}) {
  if (!config?.enabled || !ctx?.inject) return ()=>{}
  const reader=deps.reader ?? createMemoryReader(config,deps), cursors=new Map(), disposers=[]
  ctx.inject(['commands'],c=>{
    disposers.push(c.commands.register({name:'ecolink-diff',description:'本对话未查看的记忆变化目录（摘要，重复调用续页）',
      input:{hint:'无需输入；条目全文用 /ecolink-read'},handler:async invocation=>{
        try {
          const sid=invocation?.agent?.session?.id
          if (!sid) throw new Error('无法确认当前会话，未推进读取进度')
          const all=reader.entries(), seen=cursors.get(sid)??new Map()
          const pending=all.filter(e=>seen.get(e.ref)!==e.version), items=[]
          const cap=Math.max(600,config.maxInjectionChars??3000)
          for (const e of pending) {
            const row=catalogEntry(e)
            if (JSON.stringify([...items,row]).length>cap-120) {
              if(items.length) break
              throw new Error('单条目录元数据超过预算，请用 /ecolink-list 指定名称查询')
            }
            items.push(row)
          }
          const text=items.length?`变化目录（仅摘要；共 ${all.length} 条，剩余 ${pending.length-items.length} 条可再次调用）：\n${JSON.stringify(items)}`:`自上次查看以来无变化（池共 ${all.length} 条）。`
          if (invocation?.signal?.aborted) throw new Error('查询已取消，未推进进度')
          for (const row of items) seen.set(row.ref,row.version)
          for (const ref of seen.keys()) if (!all.some(e=>e.ref===ref)) seen.delete(ref)
          cursors.set(sid,seen);stats?.bump?.('memoryDiff.called',1)
          return {kind:'success',text}
        } catch(e) { return {kind:'error',text:`读取记忆池失败：${e.message}`} }
      }}))
  })
  const onDisposed=p=>{if(p?.agent?.session?.id) cursors.delete(p.agent.session.id)}
  ctx.on?.('agent/disposed',onDisposed)
  return ()=>{for(const d of disposers)d?.();ctx.off?.('agent/disposed',onDisposed);cursors.clear()}
}
