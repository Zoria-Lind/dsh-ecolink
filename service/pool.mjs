// dsh-ecolink-service 记忆池层:memory.json 的唯一写者。
// 设计要点(PLAN.md §4):
//   - 零依赖、零 LLM 调用;所有"大脑"动作(压缩/合并/重写)在免费网页对话中完成
//   - 存储层时间戳永远全量 UTC;time_precision 落盘时算初始值,渲染降精度
//     由消费者(popup/适配层)按 precisionFor 重新评估
//   - 过期归档:超过保留期且未被访问过的非 pinned 条目 → archive.json(不硬删,可恢复)
//   - 原子写入:tmp + rename,串行化所有变更操作(扩展与 popup 可能并发请求)

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

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

// ---- 快照与 diff(E3:变更角标/同步的基础;此前服务侧完全没有 hash/快照能力) ----
// 规范化 JSON 的 sha256;state 是池全量(shared_pool + session_pools)
export function hashState(state) {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex')
}

// 按 id/key 对比两份池状态,added/updated/removed 同时覆盖 shared_pool 与 session_pools。
// keyOf:key 优先(压缩/覆盖闭环的锚点),无 key 回退 id。updated 用 JSON 全等比较——
// 注意 touch 会改 last_accessed → 任何 touch 都算 updated(08 §B16,文档已写明)。
export function diffStates(prev, next) {
  const keyOf = (m) => `${m?.key ?? ''}::${m?.id ?? ''}`
  const buckets = (s) => ({ shared: s?.shared_pool ?? [], sessions: s?.session_pools ?? {} })
  const A = buckets(prev)
  const B = buckets(next)
  const added = []
  const removed = []
  const updated = []
  const a = new Map(A.shared.map((m) => [keyOf(m), m]))
  const b = new Map(B.shared.map((m) => [keyOf(m), m]))
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(k)
    else if (JSON.stringify(a.get(k)) !== JSON.stringify(v)) updated.push(k)
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k)
  for (const sid of new Set([...Object.keys(A.sessions), ...Object.keys(B.sessions)])) {
    const sa = new Map((A.sessions[sid]?.memories ?? []).map((m) => [keyOf(m), m]))
    const sb = new Map((B.sessions[sid]?.memories ?? []).map((m) => [keyOf(m), m]))
    for (const [k, v] of sb) {
      if (!sa.has(k)) added.push(`${sid}:${k}`)
      else if (JSON.stringify(sa.get(k)) !== JSON.stringify(v)) updated.push(`${sid}:${k}`)
    }
    for (const k of sa.keys()) if (!sb.has(k)) removed.push(`${sid}:${k}`)
  }
  return { added, removed, updated }
}

function expandHome(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return dir
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) return join(homedir(), dir.slice(2))
  return dir
}

export function createPool(options = {}) {
  const dir = expandHome(options.dir ?? join(homedir(), '.dsh-memory'))
  const retentionDays = options.retentionDays ?? 30
  // E7 敏感词黑名单(落盘前拦截;命中 → 拒收该条并计入 blocked;大小写不敏感的子串匹配)
  const blacklist = (Array.isArray(options.blacklist) ? options.blacklist : [])
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter(Boolean)
  const isBlocked = (content) => {
    if (blacklist.length === 0) return false
    const c = String(content ?? '').toLowerCase()
    return blacklist.some((w) => c.includes(w))
  }
  const poolFile = join(dir, 'memory.json')
  const archiveFile = join(dir, 'archive.json')
  const snapDir = join(dir, 'snapshots') // E3 快照目录:<hash>.json + latest.json
  const sugFile = join(dir, 'suggestions.json') // E5 建议确认队列(独立文件,不进 memory.json → 适配层读不到未确认条目)
  const stagingFile = join(dir, 'staging.json') // 2026-09-25:压缩暂存池(事务:stage→commit/rollback)
  let state = null
  let sugState = null
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

  // 原子写(E8 加固):tmp + rename;中途失败也要清掉 tmp 残留(P8:残留 tmp 曾伴生整体丢写入)
  function atomicWrite(file, text) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, file)
    } finally {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 清理失败不掩盖原错误 */ }
    }
  }

  function save() {
    atomicWrite(poolFile, JSON.stringify(state, null, 2))
  }

  // ---- E5 建议确认队列(独立存储;确认后才由 applySync 写入 memory.json) ----
  function sugLoad() {
    if (sugState) return
    if (existsSync(sugFile)) {
      try {
        const data = JSON.parse(readFileSync(sugFile, 'utf8'))
        sugState = { version: data?.version ?? 1, suggestions: Array.isArray(data?.suggestions) ? data.suggestions : [] }
        return
      } catch (err) {
        try { renameSync(sugFile, `${sugFile}.broken-${Date.now()}`) } catch { /* 忽略 */ }
        console.warn(`[ecolink-service] suggestions.json 损坏(${err?.message}),已备份并从空队列开始`)
      }
    }
    sugState = { version: 1, suggestions: [] }
  }
  function sugSave() {
    atomicWrite(sugFile, JSON.stringify(sugState, null, 2))
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
      atomicWrite(archiveFile, JSON.stringify(archive, null, 2))
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

  // 把暂存条目原样放回所属池(回滚用;保留原始 id/key/content/timestamp;会话池已消失则入共享池)
  function restoreEntry(it) {
    const sid = typeof it.session_id === 'string' && it.session_id.length > 0 ? it.session_id : null
    const { session_id, identity, ...rest } = it
    if (sid && state.session_pools[sid]) state.session_pools[sid].memories.push(rest)
    else state.shared_pool.push(rest)
  }

  // 条目入库的核心循环(sync 与建议确认共用):key 化 upsert + 无 key 内容去重 + replace
  function addMemoriesToState(payload) {
    const memories = Array.isArray(payload?.memories) ? payload.memories : []
    const sessionId = typeof payload?.session_id === 'string' && payload.session_id.length > 0 ? payload.session_id : null
    let added = 0
    let replaced = 0
    let blocked = 0
    let deduped = 0
    for (const m of memories) {
      if (typeof m?.content !== 'string' || m.content.trim().length === 0) continue
      // E7 黑名单:落盘前拦截(覆盖 sync / 建议确认 / compress 经 sync 的写入)
      if (isBlocked(m.content)) { blocked += 1; continue }
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
      // 2026-09-25:全池内容去重——模型在压缩/内容注入场景会用新 key 重吐旧内容,
      // 旧逻辑只在同 key/无 key 路径去重,导致重复条目暴涨(实测 242→388)。
      // 不同 key 但内容与池中任意条目完全一致 → 跳过(内容即事实,重复即垃圾)。
      // 压缩完成流程是"先删后写",被跳过的标签在删除后会由调用方重新写入,不丢内容。
      {
        const trimmed = m.content.trim()
        const allPools = [...state.shared_pool, ...Object.values(state.session_pools ?? {}).flatMap((sp) => sp.memories ?? [])]
        if (allPools.some((it) => it.content === trimmed)) { deduped += 1; continue }
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
    return { added, replaced, blocked, deduped }
  }

  return {
    poolFile,
    archiveFile,
    dir,

    // POST /memory/sync:session_id 缺省/null → 共享池
    sync(payload) {
      return mutate(() => {
        load()
        const r = addMemoriesToState(payload)
        const archived = runArchive()
        return { ok: true, added: r.added, replaced: r.replaced, archived, blocked: r.blocked }
      })
    },

    // ---- E5 建议确认队列 ----
    // POST /memory/suggest(/memory/sync 在 autoConfirm=false 时也走这里):
    // 只进建议队列,绝不直接落 memory.json → DSH 适配层读不到未确认条目
    suggest(payload) {
      return mutate(() => {
        load()
        sugLoad()
        const memories = Array.isArray(payload?.memories) ? payload.memories : []
        const sessionId = typeof payload?.session_id === 'string' && payload.session_id.length > 0 ? payload.session_id : null
        let queued = 0
        let blocked = 0
        for (const m of memories) {
          if (typeof m?.content !== 'string' || m.content.trim().length === 0) continue
          if (isBlocked(m.content)) { blocked += 1; continue } // E7:黑名单命中不入队
          sugState.suggestions.push({
            id: randomUUID(),
            key: typeof m.key === 'string' && m.key.trim().length > 0 ? m.key.trim() : null,
            content: m.content.trim(),
            importance: m.importance ?? 'called',
            source: m.source ?? 'web',
            timestamp: new Date().toISOString(),
            session_id: sessionId,
            pinned: !!m.pinned,
          })
          queued += 1
        }
        if (queued > 0) sugSave()
        return { ok: true, queued, blocked }
      })
    },
    // GET /memory/suggestions
    listSuggestions() {
      load()
      sugLoad()
      return { ok: true, suggestions: sugState.suggestions }
    },
    // POST /memory/suggest/confirm:从队列移除并按 sync 语义入库(返回真实 added/replaced)
    confirmSuggestion({ id } = {}) {
      return mutate(() => {
        load()
        sugLoad()
        const idx = sugState.suggestions.findIndex((s) => s.id === id)
        if (idx < 0) return { ok: true, confirmed: 0, added: 0, replaced: 0, archived: 0 }
        const sug = sugState.suggestions.splice(idx, 1)[0]
        sugSave()
        const r = addMemoriesToState({
          session_id: sug.session_id,
          memories: [{ content: sug.content, key: sug.key, importance: sug.importance, source: sug.source, pinned: sug.pinned }],
        })
        const archived = runArchive()
        return { ok: true, confirmed: 1, added: r.added, replaced: r.replaced, archived, blocked: r.blocked }
      })
    },
    // POST /memory/suggest/reject:直接丢弃
    rejectSuggestion({ id } = {}) {
      return mutate(() => {
        load()
        sugLoad()
        const idx = sugState.suggestions.findIndex((s) => s.id === id)
        if (idx < 0) return { ok: true, rejected: 0 }
        sugState.suggestions.splice(idx, 1)
        sugSave()
        return { ok: true, rejected: 1 }
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
        let blocked = 0
        const existing = new Set(state.shared_pool.map((it) => it.content))
        for (const e of entries ?? []) {
          const content = [e?.key, e?.value].filter((s) => typeof s === 'string' && s.trim().length > 0).join(': ')
          if (!content) continue
          if (isBlocked(content)) { blocked += 1; continue } // E7:黑名单同样覆盖 DSM 导入
          if (existing.has(content)) { skipped += 1; continue }
          const item = makeItem({ content, importance: e?.importance || 'key', source: 'dsm-import' })
          state.shared_pool.push(item)
          existing.add(content)
          added += 1
        }
        runArchive()
        return { ok: true, added, skipped, blocked }
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
    // ---- 压缩事务(2026-09-25):stage → commit/rollback ----
    // 旧记忆先整体移入 staging.json(主池里清空),压缩标签以普通同步正常入主池;
    // 验收合格 → commit(删 staging);不合格/失败 → rollback(原样放回主池)。
    // 任何时刻旧记忆都有一份完整落盘副本,压缩事故(9-14 清池/9-22 丢 56 条)类彻底消灭。
    stagingStatus() {
      if (!existsSync(stagingFile)) return null
      try {
        const d = JSON.parse(readFileSync(stagingFile, 'utf8'))
        return { startedAt: d?.startedAt ?? null, count: Array.isArray(d?.staged) ? d.staged.length : 0 }
      } catch { return { startedAt: null, count: 0 } }
    },
    // 把过时条目移入暂存池(已有暂存时先自动回滚,防悬空丢失)。返回暂存条目(供压缩清单用)。
    stageStale(days = 5) {
      return mutate(() => {
        load()
        const oldStaging = existsSync(stagingFile) ? (() => { try { return JSON.parse(readFileSync(stagingFile, 'utf8')) } catch { return null } })() : null
        if (oldStaging && Array.isArray(oldStaging.staged) && oldStaging.staged.length > 0) {
          // 上一轮压缩没走完(崩溃/忘记点完成):先把旧暂存放回主池再开新一轮
          for (const it of oldStaging.staged) restoreEntry(it)
          console.warn(`[ecolink-service] 检测到遗留暂存池(${oldStaging.staged.length} 条),已自动回滚后重新暂存`)
        }
        const cutoff = Date.now() - days * 86400e3
        const staged = []
        const pull = (arr, sessionId = null) => {
          for (let i = arr.length - 1; i >= 0; i--) {
            const ts = new Date(arr[i].timestamp).getTime()
            if (Number.isFinite(ts) && ts <= cutoff) staged.push({ ...arr[i], session_id: sessionId })
          }
        }
        const keep = (arr, sessionId = null) => arr.filter((it) => {
          const ts = new Date(it.timestamp).getTime()
          return !(Number.isFinite(ts) && ts <= cutoff)
        })
        pull(state.shared_pool)
        state.shared_pool = keep(state.shared_pool)
        for (const sid of Object.keys(state.session_pools)) {
          pull(state.session_pools[sid].memories ?? [], sid)
          state.session_pools[sid].memories = keep(state.session_pools[sid].memories ?? [], sid)
        }
        staged.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
        const payload = { startedAt: new Date().toISOString(), staged }
        atomicWrite(stagingFile, JSON.stringify(payload, null, 2))
        save()
        return payload
      })
    },
    // 验收合格:清掉暂存池(暂存条目不再需要——新标签已作为普通记忆入主池)
    commitStaging() {
      return mutate(() => {
        load()
        if (!existsSync(stagingFile)) return { committed: 0 }
        const d = (() => { try { return JSON.parse(readFileSync(stagingFile, 'utf8')) } catch { return null } })()
        const n = Array.isArray(d?.staged) ? d.staged.length : 0
        unlinkSync(stagingFile)
        return { committed: n }
      })
    },
    // 验收不合格:暂存条目原样放回主池(恢复后做一次全池内容去重,吸收期间重复入池的同内容标签)
    rollbackStaging() {
      return mutate(() => {
        load()
        if (!existsSync(stagingFile)) return { restored: 0 }
        const d = (() => { try { return JSON.parse(readFileSync(stagingFile, 'utf8')) } catch { return null } })()
        const staged = Array.isArray(d?.staged) ? d.staged : []
        for (const it of staged) restoreEntry(it)
        // 全池内容去重:同内容保留首条(暂存条目先放回,新标签若内容一致则被吸收)
        const seen = new Set()
        const dedupe = (arr) => arr.filter((it) => {
          const c = String(it.content ?? '').trim()
          if (!c || seen.has(c)) return false
          seen.add(c)
          return true
        })
        state.shared_pool = dedupe(state.shared_pool)
        for (const sid of Object.keys(state.session_pools)) {
          state.session_pools[sid].memories = dedupe(state.session_pools[sid].memories ?? [])
        }
        unlinkSync(stagingFile)
        save()
        return { restored: staged.length }
      })
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

    // ---- E3:快照 / diff / 快照清单 ----
    // 生成快照:规范化 JSON 的 sha256 落 snapshots/<hash>.json,latest.json 指向当前 hash。
    // 走 mutate() 保持单一写者语义(mutate 末尾的 save() 对未变更的池是幂等重写,无害)。
    snapshotNow() {
      return mutate(() => {
        const hash = hashState(state)
        mkdirSync(snapDir, { recursive: true })
        atomicWrite(join(snapDir, `${hash}.json`), JSON.stringify(state))
        atomicWrite(join(snapDir, 'latest.json'), JSON.stringify({ hash }))
        return hash
      })
    },
    // 与指定快照对比;since='latest' 时解析 latest.json。返回 null = 快照不存在。
    diffSince(since) {
      load()
      let hash = since
      if (since === 'latest') {
        const latestFile = join(snapDir, 'latest.json')
        if (!existsSync(latestFile)) return null
        try { hash = JSON.parse(readFileSync(latestFile, 'utf8'))?.hash } catch { return null }
        if (typeof hash !== 'string') return null
      }
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null
      const file = join(snapDir, `${hash}.json`)
      if (!existsSync(file)) return null
      let prev
      try { prev = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
      return { ok: true, since: hash, current: hashState(state), ...diffStates(prev, state) }
    },
    // 快照清单(按 mtime 倒序)+ latest 指向
    listSnapshots() {
      load()
      let latest = null
      const latestFile = join(snapDir, 'latest.json')
      if (existsSync(latestFile)) {
        try { latest = JSON.parse(readFileSync(latestFile, 'utf8'))?.hash ?? null } catch { latest = null }
      }
      const snapshots = []
      if (existsSync(snapDir)) {
        for (const name of readdirSync(snapDir)) {
          const m = /^([0-9a-f]{64})\.json$/.exec(name)
          if (!m) continue
          let mtimeMs = 0
          try { mtimeMs = statSync(join(snapDir, name)).mtimeMs } catch { /* 忽略 */ }
          snapshots.push({ hash: m[1], mtimeMs })
        }
      }
      snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return { ok: true, latest, snapshots }
    },
  }
}
