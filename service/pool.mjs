// dsh-ecolink-service 记忆池层:memory.json 的唯一写者。
// 设计要点(PLAN.md §4):
//   - 零依赖、零 LLM 调用;所有"大脑"动作(压缩/合并/重写)在免费网页对话中完成
//   - 存储层时间戳永远全量 UTC;time_precision 落盘时算初始值,渲染降精度
//     由消费者(popup/适配层)按 precisionFor 重新评估
//   - 过期归档:超过保留期且未被访问过的非 pinned 条目 → archive.json(不硬删,可恢复)
//   - 原子写入:tmp + rename,串行化所有变更操作(扩展与 popup 可能并发请求)

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// ---- 时间戳精度(渲染降精度规则,PLAN.md §4.2) ----
// 2 小时内→分钟;48 小时内→小时;5 天内→日期;更早→不渲染时间戳(内容里用户自写时间点自然保留)
export const PRECISION_RULES = [
  { maxAgeMs: 2 * 3600e3, precision: 'minute' },
  { maxAgeMs: 48 * 3600e3, precision: 'hour' },
  { maxAgeMs: 5 * 86400e3, precision: 'day' },
  { maxAgeMs: Infinity, precision: 'none' },
]
export function precisionFor(isoTs, now = Date.now()) {
  const t = new Date(isoTs).getTime()
  if (!Number.isFinite(t)) return 'none'
  const age = Math.max(0, now - t)
  for (const r of PRECISION_RULES) {
    if (age <= r.maxAgeMs) return r.precision
  }
  return 'none'
}
// 按精度截断 ISO 字符串(minute 截到分钟,hour 到小时,day 到日期,none 返回 null)
export function renderTimestamp(isoTs, precision = null) {
  const p = precision ?? precisionFor(isoTs)
  if (p === 'none') return null
  const d = new Date(isoTs)
  if (!Number.isFinite(d.getTime())) return null
  if (p === 'day') return isoTs.slice(0, 10)
  if (p === 'hour') return isoTs.slice(0, 13)
  return isoTs.slice(0, 16) // minute
}

const EMPTY_POOL = { version: 1, shared_pool: [], session_pools: {} }

function expandHome(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return dir
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) return join(homedir(), dir.slice(2))
  return dir
}

export function createPool(options = {}) {
  const dir = expandHome(options.dir ?? join(homedir(), '.dsh-memory'))
  const retentionDays = options.retentionDays ?? 30
  const poolFile = join(dir, 'memory.json')
  const archiveFile = join(dir, 'archive.json')
  let state = null
  let queue = Promise.resolve() // 变更串行化

  function load() {
    if (state) return
    mkdirSync(dir, { recursive: true })
    if (existsSync(poolFile)) {
      try {
        const data = JSON.parse(readFileSync(poolFile, 'utf8'))
        if (data && typeof data === 'object') {
          state = {
            version: data.version ?? 1,
            shared_pool: Array.isArray(data.shared_pool) ? data.shared_pool : [],
            session_pools: (data.session_pools && typeof data.session_pools === 'object') ? data.session_pools : {},
          }
          return
        }
      } catch (err) {
        // 损坏:备份坏文件后从空池开始(不阻断服务,坏数据可人工恢复)
        try { renameSync(poolFile, `${poolFile}.broken-${Date.now()}`) } catch { /* 忽略 */ }
        console.warn(`[ecolink-service] memory.json 损坏(${err?.message}),已备份并从空池开始`)
      }
    }
    state = structuredClone(EMPTY_POOL)
  }

  function save() {
    mkdirSync(dirname(poolFile), { recursive: true })
    const tmp = `${poolFile}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, poolFile)
  }

  // 串行执行变更(所有写操作经此排队,防并发交错)
  function mutate(fn) {
    const run = queue.then(() => { load(); const r = fn(); save(); return r })
    queue = run.catch(() => {})
    return run
  }

  // ---- 归档:超过保留期且未被访问的非 pinned 条目 → archive.json(PLAN §4.3) ----
  function runArchive() {
    const now = Date.now()
    const cutoff = now - retentionDays * 86400e3
    const archived = []
    const keep = (item) => {
      if (item.pinned) return true
      const ts = new Date(item.timestamp).getTime()
      const acc = item.last_accessed ? new Date(item.last_accessed).getTime() : 0
      // <= 而非 <:条目时间戳可能与 cutoff 同毫秒(实测抖动),同刻即视为到期
      if (Number.isFinite(ts) && ts <= cutoff && acc <= cutoff) {
        archived.push({ ...item, archived_at: new Date(now).toISOString() })
        return false
      }
      return true
    }
    state.shared_pool = state.shared_pool.filter(keep)
    for (const sid of Object.keys(state.session_pools)) {
      const sp = state.session_pools[sid]
      sp.memories = (sp.memories ?? []).filter(keep)
    }
    if (archived.length > 0) {
      let archive = { version: 1, archived: [] }
      if (existsSync(archiveFile)) {
        try { archive = JSON.parse(readFileSync(archiveFile, 'utf8')) ?? archive } catch { /* 损坏则新建 */ }
      }
      archive.archived = [...(archive.archived ?? []), ...archived]
      mkdirSync(dirname(archiveFile), { recursive: true })
      const tmp = `${archiveFile}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, JSON.stringify(archive, null, 2), 'utf8')
      renameSync(tmp, archiveFile)
    }
    return archived.length
  }

  function makeItem({ content, importance = 'called', source = 'web', pinned = false, key = null }) {
    const now = new Date().toISOString()
    return {
      id: randomUUID(),
      key: typeof key === 'string' && key.trim().length > 0 ? key.trim() : null,
      content: String(content ?? '').trim(),
      timestamp: now,
      time_precision: precisionFor(now, Date.now()), // 落盘时初始值;渲染层再按龄重算
      source,
      importance,
      pinned: !!pinned,
      last_accessed: null,
    }
  }

  function findItem(id) {
    for (const it of state.shared_pool) if (it.id === id) return it
    for (const sid of Object.keys(state.session_pools)) {
      for (const it of state.session_pools[sid].memories ?? []) if (it.id === id) return it
    }
    return null
  }

  return {
    poolFile,
    archiveFile,
    dir,

    // POST /memory/sync:session_id 缺省/null → 共享池;replace 需带 id(目标池优先,再找共享池)
    sync(payload) {
      return mutate(() => {
        load()
        const memories = Array.isArray(payload?.memories) ? payload.memories : []
        const sessionId = typeof payload?.session_id === 'string' && payload.session_id.length > 0 ? payload.session_id : null
        let added = 0
        let replaced = 0
        for (const m of memories) {
          if (typeof m?.content !== 'string' || m.content.trim().length === 0) continue
          if (m.action === 'replace' && typeof m.id === 'string') {
            const target = findItem(m.id)
            if (target) {
              target.content = m.content.trim()
              target.timestamp = new Date().toISOString()
              target.source = m.source ?? target.source
              replaced += 1
              continue
            }
          }
          // key 化 upsert(DSM 同款语义):同 key 覆盖旧值——压缩/更新闭环的锚点
          // (模型重写旧记忆时吐同 key 新值,收割落盘自动覆盖,无需扩展侧传 uuid)
          const key = typeof m.key === 'string' && m.key.trim().length > 0 ? m.key.trim() : null
          if (key) {
            const poolArr = sessionId ? (state.session_pools[sessionId]?.memories ?? []) : state.shared_pool
            const existing = poolArr.find((it) => it.key === key)
            if (existing) {
              // DSM 同款:同 key 同值跳过写入(防时间戳无意义翻新与重复计数)
              if (existing.content === m.content.trim()) continue
              existing.content = m.content.trim()
              existing.timestamp = new Date().toISOString()
              existing.importance = m.importance ?? existing.importance
              existing.source = m.source ?? existing.source
              replaced += 1
              if (sessionId && state.session_pools[sessionId]) state.session_pools[sessionId].last_active = new Date().toISOString()
              continue
            }
          }
          // 无 key 条目按内容去重:相同内容已存在则跳过
          // (模型回显示例会同一内容反复吐,池层是最后一道闸)
          if (!key) {
            const poolArr = sessionId ? (state.session_pools[sessionId]?.memories ?? []) : state.shared_pool
            if (poolArr.some((it) => it.content === m.content.trim())) continue
          }
          const item = makeItem({ content: m.content, importance: m.importance, source: m.source, pinned: m.pinned, key })
          if (sessionId) {
            if (!state.session_pools[sessionId]) {
              state.session_pools[sessionId] = {
                identity: null,
                first_seen: new Date().toISOString(),
                last_active: new Date().toISOString(),
                memories: [],
              }
            } else {
              state.session_pools[sessionId].last_active = new Date().toISOString()
            }
            state.session_pools[sessionId].memories.push(item)
          } else {
            state.shared_pool.push(item)
          }
          added += 1
        }
        const archived = runArchive()
        return { ok: true, added, replaced, archived }
      })
    },

    // POST /memory/delete:按 id 或 key 删除(压缩闭环:新 key 集合外的旧条目显式删除)
    deleteMemories({ ids = [], keys = [] }) {
      return mutate(() => {
        load()
        const idSet = new Set((ids ?? []).filter((x) => typeof x === 'string'))
        const keySet = new Set((keys ?? []).filter((x) => typeof x === 'string'))
        let deleted = 0
        const match = (it) => (idSet.has(it.id) || (it.key != null && keySet.has(it.key)))
        state.shared_pool = state.shared_pool.filter((it) => {
          if (match(it)) { deleted += 1; return false }
          return true
        })
        for (const sid of Object.keys(state.session_pools)) {
          const sp = state.session_pools[sid]
          sp.memories = (sp.memories ?? []).filter((it) => {
            if (match(it)) { deleted += 1; return false }
            return true
          })
        }
        return { ok: true, deleted }
      })
    },

    // POST /memory/touch:注入/选用过的记忆记访问时间(选择器打分 + 归档豁免)
    touch(ids) {
      return mutate(() => {
        load()
        let touched = 0
        for (const id of ids ?? []) {
          const it = findItem(id)
          if (it) { it.last_accessed = new Date().toISOString(); touched += 1 }
        }
        return { ok: true, touched }
      })
    },

    // POST /memory/session:重命名 / 删除会话池(PLAN §3.2 用户命名映射)
    session(payload) {
      return mutate(() => {
        load()
        const sid = payload?.session_id
        if (typeof sid !== 'string' || sid.length === 0) return { ok: false, error: 'session_id required' }
        if (payload?.delete) {
          if (state.session_pools[sid]) { delete state.session_pools[sid]; return { ok: true, deleted: true } }
          return { ok: true, deleted: false }
        }
        const name = typeof payload?.name === 'string' && payload.name.length > 0 ? payload.name : null
        if (!state.session_pools[sid]) {
          state.session_pools[sid] = {
            identity: name,
            first_seen: new Date().toISOString(),
            last_active: new Date().toISOString(),
            memories: [],
          }
        } else {
          state.session_pools[sid].identity = name
        }
        return { ok: true, identity: name }
      })
    },

    // POST /memory/import-dsm:deepseek-memory 扩展的 dsm_memories 一键导入(PLAN §4.5)
    importDsm(entries) {
      return mutate(() => {
        load()
        let added = 0
        let skipped = 0
        const existing = new Set(state.shared_pool.map((it) => it.content))
        for (const e of entries ?? []) {
          const content = [e?.key, e?.value].filter((s) => typeof s === 'string' && s.trim().length > 0).join(': ')
          if (!content) continue
          if (existing.has(content)) { skipped += 1; continue }
          const item = makeItem({ content, importance: e?.importance || 'key', source: 'dsm-import' })
          state.shared_pool.push(item)
          existing.add(content)
          added += 1
        }
        runArchive()
        return { ok: true, added, skipped }
      })
    },

    // 只读查询
    pool() { load(); return state },
    // 过时记忆清单(压缩流程用,PLAN §4.4 v3):超过 days 天未更新的条目,含会话归属
    stale(days = 5) {
      load()
      const cutoff = Date.now() - days * 86400e3
      const out = []
      const push = (it, sessionId = null, identity = null) => {
        const ts = new Date(it.timestamp).getTime()
        // <= 与归档同语义:同毫秒即视为到期(days=0 时全部命中,测试用)
        if (Number.isFinite(ts) && ts <= cutoff) out.push({ ...it, session_id: sessionId, identity })
      }
      for (const it of state.shared_pool) push(it)
      for (const [sid, sp] of Object.entries(state.session_pools)) {
        for (const it of sp.memories ?? []) push(it, sid, sp.identity)
      }
      out.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      return out
    },
    recent(n = 10, sessionId = null) {
      load()
      const src = sessionId && state.session_pools[sessionId]
        ? state.session_pools[sessionId].memories ?? []
        : [...state.shared_pool, ...Object.values(state.session_pools).flatMap((s) => s.memories ?? [])]
      return [...src].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, n)
    },
    sessionPool(id) {
      load()
      return state.session_pools[id] ?? null
    },
    status() {
      load()
      let archivedCount = 0
      if (existsSync(archiveFile)) {
        try { archivedCount = (JSON.parse(readFileSync(archiveFile, 'utf8'))?.archived ?? []).length } catch { /* 忽略 */ }
      }
      return {
        ok: true,
        version: state.version,
        shared: state.shared_pool.length,
        sessions: Object.fromEntries(Object.entries(state.session_pools).map(([id, s]) => [id, (s.memories ?? []).length])),
        archived: archivedCount,
        poolFile,
        retentionDays,
      }
    },
  }
}
