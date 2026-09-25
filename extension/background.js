// dsh-ecolink-web service worker v2(MV3 module)。
// v2 架构(DSM 对齐):注入选择在页内同步完成(content 推送池缓存),本层只负责:
// 配置存储 / 池缓存拉取(get-settings)/ 收割与 touch 转发(离线队列)/ 右键手动保存 / badge。
// 稳定性铁律:任何异常 → 静默降级,绝不干扰页面与请求。

import { createOfflineQueue } from './core/queue.mjs'
import { DEFAULT_CONFIG } from './core/config.mjs' // E6:默认配置单一来源(此前与本文件内联副本不一致)

const CFG_KEY = 'ecolink_config'
const COMPRESS_KEY = 'ecolink_compress'
const POOL_TTL_MS = 30_000
const UNREAD_KEY = 'ecolink_unread_cursor' // E6:池变更未读游标(持久化;SW 被回收也不丢)

// 隐私卫生(审查反馈):普通日志受配置 debug 门控——收割内容片段进 console 属隐私泄露面
let bgDebug = false
getConfig().then((c) => { bgDebug = !!c.debug }).catch(() => {})
const blog = (...a) => { if (bgDebug) console.log(...a) }

// 压缩指令的同步副本(inject.js 内联版为准;用于背景层拒绝"指令回显"垃圾)
const COMPRESS_INSTRUCTION_BG = '记忆压缩任务。下面是记忆池里的旧记忆清单,每行格式:方括号内是该条的 key(英文标识),冒号后是内容。请逐条阅读后压缩合并:只合并内容明显重复或高度重叠的条目,不同主题必须各自保留、分别输出标签,任何旧记忆的信息都不得丢弃;宁可多输出几条也禁止过度合并。压缩完成后:先写一句说明,格式为 压缩完成(重复 N 条)——N 是你统计出的清单里内容完全重复或高度重叠、应直接合并或去掉的条数。验收规则(服务会严格按此验收,不满足则整批作废、旧记忆原样恢复):标签数量必须不少于"(清单总数 − N) × 三分之二"与"清单总数 × 十分之一"两者中的较大值;输出完标签后自己数一遍数量,不够就继续补齐。然后紧接着在说明文字之后、同一行内,用空格分隔地输出全部标签。每条标签必须写成完整属性形式:<DSM:memory_write key="snake_case_key" importance="always">事实内容</DSM:memory_write>。key 规则:内容未变的条目必须沿用清单里方括号中的原 key;只有合并或改写时才生成新 key(小写单词用下划线连接)。importance 按重要性写 always 或 called。重要:标签必须跟在说明后面同行,禁止独占一行,禁止用代码块——独占一行的标签会被页面过滤掉,导致记忆无法保存;即使标签很多也必须全部输出,禁止省略。输出前逐条核对原文,确保没有遗漏和编造。'

// ---- 压缩状态机(PLAN §4.4 v3:开始→旧清单快照→注入指令→收割新key→结束比对删除) ----
async function getCompressState() {
  const got = await chrome.storage.local.get(COMPRESS_KEY)
  return got[COMPRESS_KEY] && typeof got[COMPRESS_KEY] === 'object' ? got[COMPRESS_KEY] : { active: false }
}
async function setCompressState(st) {
  await chrome.storage.local.set({ [COMPRESS_KEY]: st })
  return st
}

async function getConfig() {
  const got = await chrome.storage.local.get(CFG_KEY)
  return { ...DEFAULT_CONFIG, ...(got[CFG_KEY] ?? {}) }
}

// E8-fix:token 自动发现。E8 起服务端强制 token,而扩展读不到本地 config.json。
// 服务端提供 /memory/token(仅 chat.deepseek.com origin 可读)→ 这里取回并缓存进
// chrome.storage。用户不再需要手工从服务日志复制 token。
// 失败一律静默(桥没起/用户禁用了发现端点)→ 行为与之前一致,不引入新故障面。
let tokenProbe = null
async function ensureToken(force = false) {
  const cfg = await getConfig()
  if (cfg.token && !force) return cfg.token
  if (tokenProbe && !force) return tokenProbe
  tokenProbe = (async () => {
    try {
      const resp = await fetch(`${String(cfg.bridgeUrl).replace(/\/$/, '')}/memory/token`, { headers: { Origin: 'https://chat.deepseek.com' } })
      if (!resp.ok) return null
      const d = await resp.json()
      const token = typeof d?.token === 'string' ? d.token : ''
      if (!token) return null
      const cur = await chrome.storage.local.get(CFG_KEY)
      await chrome.storage.local.set({ [CFG_KEY]: { ...DEFAULT_CONFIG, ...(cur[CFG_KEY] ?? {}), token } })
      blog('[ecolink:bg] 已自动发现并缓存 service token')
      return token
    } catch { return null }
  })()
  const got = await tokenProbe
  tokenProbe = null
  return got
}
// 启动即探一次:让 queue 与后续请求一开始就带上 token
ensureToken().catch(() => {})

const storageApi = {
  get: async (key) => chrome.storage.local.get(key),
  set: async (obj) => chrome.storage.local.set(obj),
}
let queue = null
async function getQueue() {
  const cfg = await getConfig()
  if (!queue) {
    const token = cfg.token || (await ensureToken()) || ''
    queue = createOfflineQueue({ storage: storageApi, fetchImpl: fetch, bridgeUrl: cfg.bridgeUrl, token })
  }
  return queue
}

// 记忆池缓存(桥 /memory/pool,TTL 30s;失败返回 null → 不注入)
let poolCache = { at: 0, data: null }
async function getPool(force = false) {
  const cfg = await getConfig()
  if (!force && poolCache.data && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.data
  const fetchPool = async (token) => {
    const headers = token ? { 'X-Ecolink-Token': token } : {}
    return fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/pool`, { headers })
  }
  try {
    let resp = await fetchPool(cfg.token)
    // E8-fix:401 说明本地 token 过期/还没发现 → 重新发现一次再试(只重试一次)
    if (resp.status === 401) {
      const fresh = await ensureToken(true)
      if (fresh) resp = await fetchPool(fresh)
    }
    if (!resp.ok) return poolCache.data
    poolCache = { at: Date.now(), data: await resp.json() }
    return poolCache.data
  } catch {
    return poolCache.data // 桥不可达:用旧缓存或 null
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  blog('[ecolink:bg] 收到消息 kind=' + msg?.kind)
  ;(async () => {
    try {
      switch (msg?.kind) {
        case 'get-settings': {
          const cfg = await getConfig()
          const pool = await getPool()
          const compress = await getCompressState()
          blog('[ecolink:bg] get-settings 返回, pool=' + (pool ? '有(' + (pool.shared_pool ?? []).length + ' 共享)' : 'null(桥不通)'))
          sendResponse({ ok: true, settings: cfg, pool, compress })
          return
        }
        case 'compress-start': {
          const cfg = await getConfig()
          const headers = cfg.token ? { 'X-Ecolink-Token': cfg.token } : {}
          // 2026-09-25 事务:开始=旧记忆移入暂存池(主池清空该批,可随时回滚)
          const resp = await fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/compress-stage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ days: cfg.compressMinAgeDays ?? 5 }),
          })
          if (!resp.ok) { sendResponse({ ok: false, error: '暂存失败 HTTP ' + resp.status }); return }
          const data = await resp.json()
          if (!data.oldCount) { sendResponse({ ok: true, oldCount: 0 }); return }
          const st = await setCompressState({
            active: true,
            oldCount: data.oldCount,
            oldItems: (data.staged ?? []).map((s) => ({ id: s.id, key: s.key ?? null, content: s.content, session_id: s.session_id ?? null })),
            newCount: 0,
            sessions: [], // 仅"收到压缩指令块"的会话,其收割才计入 newCount(防其他对话收割误计数→误删)
            newContents: [], // 压缩会话新标签的内容清单(结束保险:必须确实入池才允许删除)
            newMemories: [], // 2026-09-25:完整标签(delete-then-write 的"写"侧数据)
            dupReports: [], // 2026-09-25:模型自报的重复条数(动态下限用,取各轮最大值)
          })
          blog('[ecolink:bg] 压缩开始: ' + data.count + ' 条旧记忆')
          sendResponse({ ok: true, oldCount: st.oldCount })
          return
        }
        case 'compress-seen': {
          // inject.js 在"哪个会话收到压缩指令块"时上报;背景层据此过滤 newCount 来源
          const cs2 = await getCompressState()
          if (cs2.active === true && typeof msg.session_id === 'string' && msg.session_id) {
            const sids = Array.isArray(cs2.sessions) ? cs2.sessions : []
            if (!sids.includes(msg.session_id)) await setCompressState({ ...cs2, sessions: [...sids, msg.session_id] })
          }
          sendResponse({ ok: true })
          return
        }
        case 'dup-report': {
          // 2026-09-25:模型自报重复数独立上报(说明行可能不含标签,不随 harvest 走)
          const cs2 = await getCompressState()
          if (cs2.active === true && Number.isFinite(Number(msg.dup)) && Number(msg.dup) > 0) {
            const sid = typeof msg.session_id === 'string' ? msg.session_id : ''
            const sids = Array.isArray(cs2.sessions) ? cs2.sessions : []
            if (sid && sids.includes(sid)) {
              const dups = Array.isArray(cs2.dupReports) ? cs2.dupReports : []
              await setCompressState({ ...cs2, dupReports: [...dups, Number(msg.dup)] })
              blog('[ecolink:bg] 压缩会话自报重复 ' + msg.dup + ' 条')
            }
          }
          sendResponse({ ok: true })
          return
        }
        case 'compress-status': {
          const st = await getCompressState()
          sendResponse({ ok: true, ...st })
          return
        }
        case 'compress-finish': {
          const st = await getCompressState()
          if (!st.active) { sendResponse({ ok: true, deleted: 0, kept: 0 }); return }
          const cfg = await getConfig()
          const headers = cfg.token ? { 'X-Ecolink-Token': cfg.token } : {}
          // 2026-09-25 事务:验收不过 = 回滚(暂存记忆原样放回主池,零丢失)
          const rollback = async (why) => {
            await fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/compress-rollback`, { method: 'POST', headers: { ...headers } }).catch(() => {})
            await setCompressState({ active: false, lastResult: `上次压缩:${why},暂存记忆已回滚到主池` })
            sendResponse({ ok: true, deleted: 0, kept: st.oldItems?.length ?? 0, skipped: true, reason: why })
          }
          // 保险:压缩期间一个标签都没收到 = 模型没执行压缩 → 回滚
          if ((st.newCount ?? 0) === 0) { await rollback('未收到任何新标签'); return }
          // 保险3(2026-09-25 动态下限):模型自报重复数放宽下限——正确压缩会因重复合并
          // 输出少于 2/3,固定下限会误杀;自报取各轮最大值,兜底 1/10(与服务端同公式)
          const dupReport = Array.isArray(st.dupReports) && st.dupReports.length > 0 ? Math.max(...st.dupReports) : 0
          const effDup = Math.min(dupReport, Math.max(1, (st.oldCount ?? 0) - 1))
          const minTags = Math.max(Math.ceil(((st.oldCount ?? 0) - effDup) * 2 / 3), Math.ceil((st.oldCount ?? 0) / 10))
          if ((st.newCount ?? 0) < minTags) { await rollback(`新标签过少(${st.newCount ?? 0}/${st.oldCount ?? 0},自报重复 ${dupReport}),疑似过度合并`); return }
          // 保险2:新标签必须确实已入主池(暂存期间主池无旧条目,落地即同步成功)
          const poolResp = await fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/pool`, { headers })
          const pool = await poolResp.json()
          const all = [...(pool.shared_pool ?? []), ...Object.values(pool.session_pools ?? {}).flatMap((sp) => sp.memories ?? [])]
          const poolContents = new Set(all.map((it) => it.content))
          const landed = Array.isArray(st.newContents) && st.newContents.length > 0 && st.newContents.some((c) => poolContents.has(c))
          if (!landed) { await rollback('新标签未在池中落地'); return }
          // 验收通过 → commit:清除暂存池
          const commitResp = await fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/compress-commit`, { method: 'POST', headers: { ...headers } })
          const cr = await commitResp.json().catch(() => ({ committed: 0 }))
          await setCompressState({ active: false, lastResult: `上次压缩:验收通过,清除暂存 ${cr.committed ?? 0} 条` })
          blog(`[ecolink:bg] 压缩验收通过:清暂存 ${cr.committed ?? 0} 条`)
          sendResponse({ ok: true, deleted: cr.committed ?? 0, kept: 0 })
          return
        }
        case 'touch': {
          const q = await getQueue()
          await q.push({ kind: 'touch', payload: { ids: Array.isArray(msg.ids) ? msg.ids : [] } })
          sendResponse({ ok: true })
          return
        }
        case 'diag': {
          const cfg = await getConfig()
          const headers = cfg.token ? { 'X-Ecolink-Token': cfg.token } : {}
          fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/diag`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ msg: String(msg.msg ?? '').slice(0, 500) }),
          }).catch(() => {})
          sendResponse({ ok: true })
          return
        }
        case 'harvest': {
          const cfg = await getConfig()
          if (!cfg.harvestEnabled || !Array.isArray(msg.memories) || msg.memories.length === 0) {
            blog('[ecolink:bg] harvest 跳过(开关/空)')
            sendResponse({ ok: true, skipped: true })
            return
          }
          // 压缩状态先读:E5 起普通收割进建议确认队列,但压缩闭环的新标签必须直入
          // (confirm:true)——否则 compress-finish 会把"池中内容未变"的旧条目全删,
          // 而压缩结果还躺在队列里没入池 → 用户不确认就是数据丢失
          const cs = await getCompressState()
          const compressActive = cs.active === true
          blog('[ecolink:bg] harvest ' + msg.memories.length + ' 条 → 入队: ' + msg.memories.map((m) => m.content.slice(0, 30)).join(' | '))
          const q = await getQueue()
          await q.push({
            kind: 'sync',
            payload: {
              session_id: typeof msg.session_id === 'string' ? msg.session_id : null,
              memories: msg.memories,
              ...(compressActive ? { confirm: true } : {}),
            },
          })
          // 压缩模式:过滤"指令回显"垃圾后记录新标签数(结束保险用)。
          // 只计"收到压缩指令块"的会话——其他会话的正常收割绝不能计入,
          // 否则会被误当成"压缩已产出新内容"→ 触发全量删除(2026-09-14 清池事故根因)
          if (compressActive) {
            const real = (msg.memories ?? []).filter((m) => !COMPRESS_INSTRUCTION_BG.includes(m.content ?? ''))
            if (real.length < (msg.memories?.length ?? 0)) {
              blog('[ecolink:bg] 压缩模式:丢弃 ' + ((msg.memories?.length ?? 0) - real.length) + ' 条指令回显垃圾')
            }
            const sid = typeof msg.session_id === 'string' ? msg.session_id : ''
            const sids = Array.isArray(cs.sessions) ? cs.sessions : []
            if (sid && sids.includes(sid) && real.length > 0) {
              const contents = Array.isArray(cs.newContents) ? cs.newContents : []
              const mems = Array.isArray(cs.newMemories) ? cs.newMemories : []
              const dups = Array.isArray(cs.dupReports) ? cs.dupReports : []
              await setCompressState({
                ...cs,
                newCount: (cs.newCount ?? 0) + real.length,
                newContents: [...contents, ...real.map((m) => m.content ?? '')],
                newMemories: [...mems, ...real.map((m) => ({ content: m.content ?? '', key: m.key ?? null, importance: m.importance ?? 'called' }))],
                dupReports: [...dups, Number(msg.dup_report) || 0],
              })
            } else if (real.length > 0) {
              blog('[ecolink:bg] 压缩模式:忽略非压缩会话收割 ' + real.length + ' 条(sid=' + (sid || '无') + ')')
            }
          }
          // 收割成功后刷新池缓存并随响应带回——content 推回页面,
          // 保证同一 SPA 页面里新开对话立刻用到最新记忆(否则等 45s 周期推送)
          const fresh = await getPool(true).catch(() => null)
          sendResponse({ ok: true, pool: fresh })
          return
        }
        case 'manual-save': {
          // 用户手动保存 = 显式动作,直入池(confirm:true),不进建议队列
          const q = await getQueue()
          await q.push({ kind: 'sync', payload: { confirm: true, memories: [{ content: msg.content, importance: 'called', source: 'web-manual' }] } })
          sendResponse({ ok: true })
          return
        }
        case 'mark-read': {
          // E6:用户看面板/popup 即把未读游标推进到当前最新快照(badge 变更角标清零)
          const cfg2 = await getConfig()
          const headers2 = cfg2.token ? { 'X-Ecolink-Token': cfg2.token } : {}
          try {
            const resp = await fetch(`${cfg2.bridgeUrl.replace(/\/$/, '')}/memory/snapshots`, { headers: headers2 })
            if (resp.ok) {
              const latest = (await resp.json())?.latest
              if (typeof latest === 'string') await chrome.storage.local.set({ [UNREAD_KEY]: latest })
            }
          } catch { /* fail-open */ }
          sendResponse({ ok: true })
          return
        }
        default:
          sendResponse({ ok: false, error: 'unknown message kind' })
      }
    } catch (err) {
      // fail-open:任何异常都答复失败/跳过,绝不抛给页面
      console.error('[ecolink:bg] 处理失败: ' + (err?.stack ?? err?.message ?? err))
      sendResponse({ ok: false, error: String(err?.message ?? err) })
    }
  })()
  return true // 异步 sendResponse
})

// 右键菜单:选中文本 → 手动保存(收割兜底,PLAN §3.1)
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ecolink-save-selection',
      title: '保存选中文本为记忆(dsh-ecolink)',
      contexts: ['selection'],
    })
  })
})
chrome.contextMenus.onClicked.addListener(async (info, _tab) => {
  if (info.menuItemId !== 'ecolink-save-selection') return
  const text = (info.selectionText ?? '').trim()
  if (!text) return
  try {
    const q = await getQueue()
    await q.push({ kind: 'sync', payload: { confirm: true, memories: [{ content: text, importance: 'called', source: 'web-manual' }] } })
  } catch { /* fail-open */ }
})

// badge(E6/F14:修 bug + 扩语义)。原 setInterval(30s) 在 MV3 SW 里不保证触发
// (SW 空闲 ~30s 即被回收,定时器随 SW 死亡)→ 改 chrome.alarms(manifest 已补 alarms 权限)。
// 语义:优先「离线队列积压 n」(amber #d97706);其次「池变更未读 +n」(teal #0ea5a4,
// 游标 = 用户上次查看面板/popup 时的快照 hash,持久化到 chrome.storage)。
async function refreshBadge() {
  try {
    const q = await getQueue()
    const offline = await q.pendingCount()
    if (offline > 0) {
      await chrome.action.setBadgeText({ text: String(Math.min(offline, 99)) })
      await chrome.action.setBadgeBackgroundColor({ color: '#d97706' })
      return
    }
    const cfg = await getConfig()
    const headers = cfg.token ? { 'X-Ecolink-Token': cfg.token } : {}
    const got = await chrome.storage.local.get(UNREAD_KEY)
    const since = typeof got[UNREAD_KEY] === 'string' ? got[UNREAD_KEY] : ''
    if (since) {
      const resp = await fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/diff?since=${since}`, { headers })
      if (resp.ok) {
        const d = await resp.json()
        const unread = (d.added?.length ?? 0) + (d.updated?.length ?? 0)
        if (unread > 0) {
          await chrome.action.setBadgeText({ text: '+' + String(Math.min(unread, 99)) })
          await chrome.action.setBadgeBackgroundColor({ color: '#0ea5a4' })
          return
        }
      }
    }
    await chrome.action.setBadgeText({ text: '' })
  } catch { /* ignore:badge 属于可观测性,不影响功能 */ }
}
chrome.alarms.create('ecolink-badge', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === 'ecolink-badge') refreshBadge()
})
refreshBadge()
