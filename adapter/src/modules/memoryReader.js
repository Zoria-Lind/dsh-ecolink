import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { entryIdentity, injectionPolicy } from '../../../extension/core/entry.mjs'
export const digest = value => createHash('sha256').update(String(value)).digest('hex')
export const versionOf = item => digest(entryIdentity(item))
export const expandHome = p => /^~(?:[/\\]|$)/.test(String(p)) ? join(homedir(), String(p).slice(2)) : p
function recordTime(item) {
  const time = Date.parse(item.timestamp)
  return Number.isFinite(time) ? time : -Infinity
}
export function flattenPool(pool) {
  const result = []
  const add = (items, poolId, poolName) => {
    for (const item of items ?? []) {
      if (!item || typeof item.content !== 'string') continue
      const id = item.id ?? `legacy:${digest(entryIdentity(item))}`
      result.push({ ...item, id, poolId, poolName, ref: JSON.stringify([poolId, id]),
        version: versionOf(item), injectionPolicy: injectionPolicy(item) })
    }
  }
  add(pool?.shared_pool, 'shared', '共享池')
  for (const [id, sp] of Object.entries(pool?.session_pools ?? {})) add(sp.memories, id, sp.identity ?? id)
  return result.sort((a,b) => (recordTime(b) - recordTime(a)) || a.ref.localeCompare(b.ref))
}
export function catalogEntry(e) {
  const content = Array.from(e.content)
  return { id:e.id, ref:e.ref, key:e.key ?? null, pool:e.poolName, poolId:e.poolId,
    version:e.version, injectionPolicy:e.injectionPolicy, kind:e.kind ?? 'fact',
    timestamp:e.timestamp ?? null, chars:content.length, preview:content.slice(0,80).join(''), partial:content.length>80 }
}
function integer(value, fallback, max) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('分页参数越界')
  return value
}
export function createMemoryReader(config, deps={}) {
  const readFile=deps.readFile ?? (p=>readFileSync(p,'utf8'))
  function entries() {
    try { return flattenPool(JSON.parse(readFile(expandHome(config.poolPath)))) }
    catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }
  function select(args={}) {
    let all=entries()
    if (args.pool) {
      const ids=[...new Set(all.filter(e=>e.poolId===args.pool || e.poolName===args.pool).map(e=>e.poolId))]
      if (ids.length>1) throw new Error(`池名有歧义，请用 poolId：${JSON.stringify(ids)}`)
      all=all.filter(e=>e.poolId===ids[0])
    }
    if (args.ref) all=all.filter(e=>e.ref===args.ref)
    else if (args.id) all=all.filter(e=>e.id===args.id)
    else if (args.key) all=all.filter(e=>e.key===args.key)
    if (args.query) all=all.filter(e=>[e.key,e.poolName,e.content].some(s=>String(s??'').includes(args.query)))
    if (args.injectionPolicy !== undefined) {
      if (!['manual','universal'].includes(args.injectionPolicy)) throw new Error('记忆类型无效')
      all=all.filter(e=>e.injectionPolicy===args.injectionPolicy)
    }
    return all
  }
  function list(args={}) {
    const all=select(args), revision=digest(all.map(e=>e.ref+e.version).join('\n'))
    if (args.revision && args.revision!==revision) throw new Error('目录已变化，请从第一页重新读取')
    const offset=integer(args.offset,0,all.length), limit=integer(args.limit,10,20)
    if (!limit) throw new Error('limit 必须大于0')
    const items=all.slice(offset,offset+limit).map(catalogEntry), next=offset+items.length
    return { kind:'catalog', revision, total:all.length, offset, items, nextOffset:next<all.length?next:null,
      note:'目录仅含摘要；用 ecolink_memory action=read 和 ref/version 分页读取存储全文。' }
  }
  function read(args={}) {
    if (!args.ref && !args.id && !args.key) throw new Error('请指定 ref、id 或完整 key；池名仅用于分组')
    const all=select(args)
    if (!all.length) return {kind:'missing',error:'没有匹配条目'}
    if (all.length!==1) return {kind:'ambiguous',error:'名称不唯一，请用 ref 或 pool + id',items:all.slice(0,20).map(catalogEntry),total:all.length}
    const e=all[0]
    if (args.version && args.version!==e.version) throw new Error('条目版本已变化，请重新预览')
    const chars=Array.from(e.content), offset=integer(args.offset,0,chars.length), limit=integer(args.limit,2000,4000)
    if (!limit) throw new Error('limit 必须大于0')
    const end=Math.min(chars.length,offset+limit)
    return {kind:'content',...catalogEntry(e),content:chars.slice(offset,end).join(''),offset,totalChars:chars.length,
      nextOffset:end<chars.length?end:null,partial:offset>0||end<chars.length}
  }
  return {entries,select,list,read}
}
export function parseReadArgs(raw, action) {
  const input=String(raw??'').trim()
  if (!input) return {}
  if (input.startsWith('{')) return JSON.parse(input)
  return action==='read'?{key:input}:{query:input}
}
