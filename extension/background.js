// dsh-ecolink-web service worker v2(MV3 module)。
// v2 架构(DSM 对齐):注入选择在页内同步完成(content 推送池缓存),本层只负责:
// 配置存储 / 池缓存拉取(get-settings)/ 收割与 touch 转发(离线队列)/ 右键手动保存 / badge。
// 稳定性铁律:任何异常 → 静默降级,绝不干扰页面与请求。

import { createOfflineQueue } from './core/queue.mjs'

const DEFAULT_CONFIG = {
  bridgeUrl: 'http://127.0.0.1:17520',
  token: '',
  injectEnabled: true,
  harvestEnabled: true,
  singleInjection: true,
  maxInjectionChars: 3000,
  compressMinAgeDays: 5,
  tagName: 'DSM:memory_write',
}
const CFG_KEY = 'ecolink_config'
const COMPRESS_KEY = 'ecolink_compress'
const POOL_TTL_MS = 30_000

// 压缩指令的同步副本(inject.js 内联版为准;用于背景层拒绝"指令回显"垃圾)
const COMPRESS_INSTRUCTION_BG = '记忆压缩任务。下面是记忆池里的旧记忆,请逐条阅读后压缩合并:去掉重复条目,内容相近的合并成一条,保留日期、数字和专有名词。压缩完成后:先写一句简短说明(如"压缩完成"),然后紧接着在说明文字之后、同一行内,用空格分隔地输出全部标签。每条标签的写法(必须完全一致):以 <DSM:memory_write> 开头,紧接着写该条内容,以 </DSM:memory_write> 结尾。重要:标签必须跟在说明后面同行,禁止独占一行,禁止用代码块——独占一行的标签会被页面过滤掉,导致记忆无法保存。输出前逐条核对原文,确保没有遗漏和编造。'

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

const storageApi = {
  get: async (key) => chrome.storage.local.get(key),
  set: async (obj) => chrome.storage.local.set(obj),
}
let queue = null
async function getQueue() {
  const cfg = await getConfig()
  if (!queue) queue = createOfflineQueue({ storage: storageApi, fetchImpl: fetch, bridgeUrl: cfg.bridgeUrl, token: cfg.token })
  return queue
}

// 记忆池缓存(桥 /memory/pool,TTL 30s;失败返回 null → 不注入)
let poolCache = { at: 0, data: null }
async function getPool(force = false) {
  const cfg = await getConfig()
  if (!force && poolCache.data && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.data
  try {
    const headers = cfg.token ? { 'X-Ecolink-Token': cfg.token } : {}
    const resp = await fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/pool`, { headers })
    if (!resp.ok) return poolCache.data
    poolCache = { at: Date.now(), data: await resp.json() }
    return poolCache.data
  } catch {
    return poolCache.data // 桥不可达:用旧缓存或 null
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log('[ecolink:bg] 收到消息 kind=' + msg?.kind)
  ;(async () => {
    try {
      switch (msg?.kind) {
        case 'get-settings': {
          const cfg = await getConfig()
          const pool = await getPool()
          const compress = await getCompressState()
          console.log('[ecolink:bg] get-settings 返回, pool=' + (pool ? '有(' + (pool.shared_pool ?? []).length + ' 共享)' : 'null(桥不通)'))
          sendResponse({ ok: true, settings: cfg, pool, compress })
          return
        }
        case 'compress-start': {
          const cfg = await getConfig()
          const headers = cfg.token ? { 'X-Ecolink-Token': cfg.token } : {}
          const resp = await fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/stale?days=${cfg.compressMinAgeDays ?? 5}`, { headers })
          if (!resp.ok) { sendResponse({ ok: false, error: 'stale 请求失败 HTTP ' + resp.status }); return }
          const data = await resp.json()
          if (!data.count) { sendResponse({ ok: true, oldCount: 0 }); return }
          const st = await setCompressState({
            active: true,
            oldCount: data.count,
            oldItems: data.stale.map((s) => ({ id: s.id, key: s.key ?? null, content: s.content, session_id: s.session_id ?? null })),
            newCount: 0,
          })
          console.log('[ecolink:bg] 压缩开始: ' + data.count + ' 条旧记忆')
          sendResponse({ ok: true, oldCount: st.oldCount })
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
          // 保险:压缩期间一个标签都没收到 = 模型没执行压缩 →
          // 拒绝删除,防"压缩流程变成清空池子"事故(实测发生过)
          if ((st.newCount ?? 0) === 0) {
            await setCompressState({ active: false, lastResult: '上次压缩:未收到任何新标签,已跳过删除(防清空)' })
            sendResponse({ ok: true, deleted: 0, kept: st.oldItems?.length ?? 0, skipped: true, reason: 'no-new-tags' })
            return
          }
          const cfg = await getConfig()
          const headers = cfg.token ? { 'X-Ecolink-Token': cfg.token } : {}
          const poolResp = await fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/pool`, { headers })
          const pool = await poolResp.json()
          const all = [...(pool.shared_pool ?? []), ...Object.values(pool.session_pools ?? {}).flatMap((sp) => sp.memories ?? [])]
          const byId = new Map(all.map((it) => [it.id, it]))
          // 只删"内容未变"的旧条目(未被压缩结果覆盖/合并掉的);
          // 被同 key 覆盖过的条目内容已变 → 保留(新内容)
          const toDelete = []
          for (const old of st.oldItems ?? []) {
            const cur = byId.get(old.id)
            if (cur && cur.content === old.content) toDelete.push(old.id)
          }
          let deleted = 0
          if (toDelete.length > 0) {
            const delResp = await fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}/memory/delete`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({ ids: toDelete }),
            })
            deleted = (await delResp.json())?.deleted ?? 0
          }
          await setCompressState({ active: false, lastResult: `上次压缩:删除 ${deleted} 条,保留 ${(st.oldItems?.length ?? 0) - deleted} 条` })
          console.log(`[ecolink:bg] 压缩完成:删 ${deleted} / 留 ${(st.oldItems?.length ?? 0) - deleted}`)
          sendResponse({ ok: true, deleted, kept: (st.oldItems?.length ?? 0) - deleted })
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
            console.log('[ecolink:bg] harvest 跳过(开关/空)')
            sendResponse({ ok: true, skipped: true })
            return
          }
          console.log('[ecolink:bg] harvest ' + msg.memories.length + ' 条 → 入队: ' + msg.memories.map((m) => m.content.slice(0, 30)).join(' | '))
          const q = await getQueue()
          await q.push({
            kind: 'sync',
            payload: { session_id: typeof msg.session_id === 'string' ? msg.session_id : null, memories: msg.memories },
          })
          // 压缩模式:过滤"指令回显"垃圾后记录新标签数(结束保险用)
          const cs = await getCompressState()
          if (cs.active) {
            const real = (msg.memories ?? []).filter((m) => !COMPRESS_INSTRUCTION_BG.includes(m.content ?? ''))
            if (real.length < (msg.memories?.length ?? 0)) {
              console.log('[ecolink:bg] 压缩模式:丢弃 ' + ((msg.memories?.length ?? 0) - real.length) + ' 条指令回显垃圾')
            }
            await setCompressState({ ...cs, newCount: (cs.newCount ?? 0) + real.length })
          }
          // 收割成功后刷新池缓存并随响应带回——content 推回页面,
          // 保证同一 SPA 页面里新开对话立刻用到最新记忆(否则等 45s 周期推送)
          const fresh = await getPool(true).catch(() => null)
          sendResponse({ ok: true, pool: fresh })
          return
        }
        case 'manual-save': {
          const q = await getQueue()
          await q.push({ kind: 'sync', payload: { memories: [{ content: msg.content, importance: 'called', source: 'web-manual' }] } })
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
    await q.push({ kind: 'sync', payload: { memories: [{ content: text, importance: 'called', source: 'web-manual' }] } })
  } catch { /* fail-open */ }
})

// badge:离线队列积压提示
setInterval(async () => {
  try {
    const q = await getQueue()
    const n = await q.pendingCount()
    if (n > 0) {
      await chrome.action.setBadgeText({ text: String(Math.min(n, 99)) })
      await chrome.action.setBadgeBackgroundColor({ color: '#d97706' })
    } else {
      await chrome.action.setBadgeText({ text: '' })
    }
  } catch { /* ignore */ }
}, 30_000)
