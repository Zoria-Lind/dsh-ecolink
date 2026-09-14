// dsh-ecolink-service:本地记忆池唯一写者(PLAN.md §3.3 / §7)。
// 浏览器扩展与 popup 经 localhost POST 推送/查询;DSH 适配层只读文件不连服务。
// 设计:零依赖(node:http)、只绑 127.0.0.1、强制共享 token(E8:为空时启动自动生成,
// 空 token 一律 401)、CORS 仅放行 https://chat.deepseek.com(content script 以页面
// origin 发 fetch;扩展页面走 host_permissions 不受 CORS 约束)、请求体上限 2MB、
// 所有写操作经 pool 串行化。

import { createServer } from 'node:http'
import { readFileSync, existsSync, appendFileSync, statSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createPool } from './pool.mjs'
import { compressWithApi, applyCompression } from './compress.mjs'

// 请求日志:落盘到 <poolDir>/service.log,大小超 1MB 自动轮转——
// 排障时可直接读文件定位断点,无需用户翻浏览器控制台
let logPath = ''
function reqLog(method, path, detail = '') {
  if (!logPath) return
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] ${method} ${path} ${detail}\n`, 'utf8')
    if (statSync(logPath).size > 1024 * 1024) {
      renameSync(logPath, `${logPath}.old`)
    }
  } catch { /* 日志失败不阻断服务 */ }
}

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = join(SERVICE_DIR, 'config.json')

function loadConfig() {
  const defaults = { port: 17520, token: '', poolDir: '~/.dsh-memory', retentionDays: 30, deepseekApiKey: '', autoConfirm: false, blacklist: [] }
  if (existsSync(CONFIG_FILE)) {
    try {
      Object.assign(defaults, JSON.parse(readFileSync(CONFIG_FILE, 'utf8')))
    } catch (err) {
      console.warn(`[ecolink-service] config.json 解析失败(${err?.message}),用默认配置`)
    }
  }
  // 环境变量覆盖(config 文件优先于默认,env 优先于 config)——测试与部署用
  if (process.env.ECOLLINK_PORT) defaults.port = Number(process.env.ECOLLINK_PORT) || defaults.port
  if (process.env.ECOLLINK_POOL_DIR) defaults.poolDir = process.env.ECOLLINK_POOL_DIR
  if (process.env.ECOLLINK_TOKEN !== undefined) defaults.token = process.env.ECOLLINK_TOKEN
  if (process.env.ECOLLINK_RETENTION_DAYS) defaults.retentionDays = Number(process.env.ECOLLINK_RETENTION_DAYS) || defaults.retentionDays
  if (process.env.ECOLLINK_DEEPSEEK_API_KEY) defaults.deepseekApiKey = process.env.ECOLLINK_DEEPSEEK_API_KEY
  if (process.env.ECOLLINK_AUTO_CONFIRM !== undefined) {
    defaults.autoConfirm = ['1', 'true', 'yes', 'on'].includes(String(process.env.ECOLLINK_AUTO_CONFIRM).trim().toLowerCase())
  }
  // E7 黑名单:config.json 数组优先;env 用逗号分隔("机密,密码")
  if (process.env.ECOLLINK_BLACKLIST !== undefined) {
    defaults.blacklist = String(process.env.ECOLLINK_BLACKLIST).split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (!Array.isArray(defaults.blacklist)) defaults.blacklist = []
  return defaults
}

const config = loadConfig()

// E8 默认安全:token 为空时自动生成随机 token 并写回 config.json(供用户填进扩展 popup),
// 同时打印。仅当「未设 ECOLLINK_TOKEN 且 config token 为空」才走这条路径——
// 测试子进程始终显式注入 env token,不会写生产配置;显式设 ECOLLINK_TOKEN="" 表示刻意锁死。
if (!config.token && process.env.ECOLLINK_TOKEN === undefined) {
  config.token = randomBytes(24).toString('base64url')
  try {
    let raw = {}
    if (existsSync(CONFIG_FILE)) {
      try { raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) ?? {} } catch { /* 写回时重建 */ }
    }
    raw.token = config.token
    const tmp = `${CONFIG_FILE}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8')
      renameSync(tmp, CONFIG_FILE)
    } finally {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 清理失败不掩盖原错误 */ }
    }
  } catch (err) {
    console.warn(`[ecolink-service] 生成的 token 写回 config.json 失败(${err?.message ?? err});本次运行仍有效,重启会重新生成`)
  }
  console.log(`[ecolink-service] token 为空,已自动生成并写回 config.json: ${config.token}`)
  console.log('[ecolink-service] 请把该 token 填入扩展 popup 的 token 配置项,否则扩展请求会 401')
}

const pool = createPool({ dir: config.poolDir, retentionDays: config.retentionDays, blacklist: config.blacklist })
logPath = join(pool.dir, 'service.log')

const JSON_OK = { 'Content-Type': 'application/json; charset=utf-8' }
const CORS = {
  // E8 收窄:不再通配;content script 以页面 origin(https://chat.deepseek.com)发 fetch,
  // 扩展页面(popup/background)凭 host_permissions 不受 CORS 约束
  'Access-Control-Allow-Origin': 'https://chat.deepseek.com',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ecolink-Token',
  'Access-Control-Max-Age': '86400',
}

function send(res, status, body) {
  res.writeHead(status, { ...JSON_OK, ...CORS })
  res.end(JSON.stringify(body))
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function authorized(req) {
  // E8:空 token = 未配置鉴权 → 默认拒绝(不再放行)。启动路径会自动生成 token,
  // 正常运行不会出现空 token;显式 ECOLLINK_TOKEN="" 即锁死服务
  if (!config.token) return false
  return req.headers['x-ecolink-token'] === config.token
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'
  reqLog(method, path)

  // E8-fix:OPTIONS 预检。content script 以页面 origin 发带 Origin 头的请求会先预检;
  // 预检【不带】Origin(浏览器不给),所以必须在这里按"是否声明 token 发现端点"放行,
  // 否则预检失败 → 连取 token 的请求都发不出去(本轮实测踩到)。
  if (method === 'OPTIONS') {
    const wantsToken = path === '/memory/token'
    const disabled = process.env.ECOLLINK_DISABLE_TOKEN_DISCOVERY === '1'
    if (wantsToken && !disabled) {
      res.writeHead(204, {
        ...CORS,
        // 允许这个端点要用的头(浏览器会按 Access-Control-Request-Headers 逐个匹配)
        'Access-Control-Allow-Headers': 'Content-Type, X-Ecolink-Token, Origin',
      })
      return res.end()
    }
    res.writeHead(204, CORS)
    return res.end()
  }
  // E8-fix:token 发现端点。扩展侧(background/popup/content script)拿不到本地文件,
  // 而 E8 起服务端强制 token → 此前只能靠用户手工把 token 从服务日志贴进扩展。
  // 这里放开读 token,但用 Origin 白名单把"从别的网站发起"的读取挡死(403):
  //   - 浏览器简单跨源请求(如 <img>/<script>/顶层导航)【不会】带 Origin,
  //     因此拿不到 token → 这正是关键防线
  //   - https://chat.deepseek.com 页面可读,但那本来就是用户自己在看的站点,
  //     且 token 只对 127.0.0.1 的本地服务有效
  //   - 扩展页(popup/background)凭 host_permissions 不受 CORS 约束,正常读到
  // 不想要这个端点:设 ECOLLINK_DISABLE_TOKEN_DISCOVERY=1。
  if (path === '/memory/token' && method === 'GET') {
    if (process.env.ECOLLINK_DISABLE_TOKEN_DISCOVERY === '1') {
      return send(res, 403, { ok: false, error: 'token discovery disabled' })
    }
    const origin = req.headers['origin']
    if (origin !== 'https://chat.deepseek.com') {
      return send(res, 403, { ok: false, error: 'token discovery requires the chat.deepseek.com page origin' })
    }
    return send(res, 200, { ok: true, token: config.token })
  }

  if (!authorized(req)) {
    return send(res, 401, { ok: false, error: 'unauthorized: X-Ecolink-Token missing or wrong' })
  }

  try {
    // ---- POST ----
    if (path === '/memory/sync' && method === 'POST') {
      const body = await readBody(req)
      const memories = Array.isArray(body.memories) ? body.memories : []
      reqLog('POST', path, `sync ${memories.length} 条: ${memories.map((m) => `[${m.key ?? '-'}]${String(m.content ?? '').slice(0, 40)}`).join(' | ')}`)
      // E5:autoConfirm=false(默认)→ 进建议确认队列;响应形状保留 F1 硬依赖的
      // added/replaced/archived(排队时为 0),新增 queued 字段。
      // 请求体 confirm:true = 逐请求直入(压缩闭环/手动保存等用户显式动作用:
      // 否则 compress-finish 会把"池中内容未变"的旧条目全删,而压缩新结果还在队列里)
      const direct = config.autoConfirm === true || body?.confirm === true
      if (!direct) {
        const r = await pool.suggest(body)
        return send(res, 200, { ok: true, added: 0, replaced: 0, archived: 0, queued: r.queued })
      }
      const r = await pool.sync(body)
      return send(res, 200, { ...r, queued: 0 })
    }
    // ---- E5 建议确认队列 ----
    if (path === '/memory/suggest' && method === 'POST') {
      return send(res, 200, await pool.suggest(await readBody(req)))
    }
    if (path === '/memory/suggest/confirm' && method === 'POST') {
      return send(res, 200, await pool.confirmSuggestion(await readBody(req)))
    }
    if (path === '/memory/suggest/reject' && method === 'POST') {
      return send(res, 200, await pool.rejectSuggestion(await readBody(req)))
    }
    if (path === '/memory/suggestions' && method === 'GET') {
      return send(res, 200, pool.listSuggestions())
    }
    if (path === '/memory/touch' && method === 'POST') {
      return send(res, 200, await pool.touch((await readBody(req)).ids))
    }
    if (path === '/memory/delete' && method === 'POST') {
      return send(res, 200, await pool.deleteMemories(await readBody(req)))
    }
    if (path === '/memory/session' && method === 'POST') {
      return send(res, 200, await pool.session(await readBody(req)))
    }
    if (path === '/memory/import-dsm' && method === 'POST') {
      return send(res, 200, await pool.importDsm((await readBody(req)).entries))
    }
    // 诊断通道:页面/扩展的关键事件落盘到 service.log(可直接读,免用户翻控制台)
    if (path === '/memory/diag' && method === 'POST') {
      const msg = String((await readBody(req)).msg ?? '').slice(0, 500)
      reqLog('DIAG', '', msg)
      return send(res, 200, { ok: true })
    }
    // 备用 API 压缩(网页端为主,模型不服从时用;一次 Flash 调用,符合成本原则)
    if (path === '/memory/compress' && method === 'POST') {
      // 每次请求热读配置:key 以环境变量 ECOLLINK_DEEPSEEK_API_KEY 为默认来源(E8:出于
      // 安全不再落盘 config.json;兼容读取旧字段,但两份 config 模板已不含该键)
      const liveCfg = loadConfig()
      if (!liveCfg.deepseekApiKey) return send(res, 400, { ok: false, error: 'deepseekApiKey 未配置:请设环境变量 ECOLLINK_DEEPSEEK_API_KEY(不再落盘 config.json)' })
      const body = await readBody(req)
      // 0 是合法值(全部视为过时,测试用)——不能用 || 兜底(0 被当假值吞成 5,已是第三次犯)
      const daysParsed = Number(body.days)
      const days = Math.min(3650, Math.max(0, Number.isFinite(daysParsed) ? daysParsed : 5))
      const oldItems = pool.stale(days)
      if (oldItems.length === 0) return send(res, 200, { ok: true, oldCount: 0, added: 0, deleted: 0 })
      reqLog('POST', path, `API 压缩开始: ${oldItems.length} 条旧记忆`)
      try {
        const memories = await compressWithApi({ apiKey: liveCfg.deepseekApiKey, oldItems })
        const result = await applyCompression(pool, oldItems, memories)
        reqLog('POST', path, `API 压缩完成: 新增 ${result.added}, 删除 ${result.deleted}`)
        return send(res, 200, { ok: true, oldCount: oldItems.length, ...result })
      } catch (err) {
        reqLog('POST', path, `API 压缩失败: ${err?.message ?? err}`)
        return send(res, 502, { ok: false, error: String(err?.message ?? err) })
      }
    }
    // ---- GET ----
    if (path === '/memory/pool' && method === 'GET') {
      return send(res, 200, pool.pool())
    }
    if (path === '/memory/recent' && method === 'GET') {
      const n = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('n') ?? '10', 10) || 10))
      return send(res, 200, { ok: true, memories: pool.recent(n, url.searchParams.get('session_id')) })
    }
    if (path.startsWith('/memory/session/') && method === 'GET') {
      const sp = pool.sessionPool(decodeURIComponent(path.slice('/memory/session/'.length)))
      return sp ? send(res, 200, sp) : send(res, 404, { ok: false, error: 'session not found' })
    }
    if (path === '/memory/status' && method === 'GET') {
      return send(res, 200, pool.status())
    }
    if (path === '/memory/stale' && method === 'GET') {
      // 0 是合法值(全部视为过时,测试用)——不能用 || 兜底(0 被当假值吞成 5)
      const daysParsed = Number.parseInt(url.searchParams.get('days') ?? '5', 10)
      const days = Math.min(3650, Math.max(0, Number.isFinite(daysParsed) ? daysParsed : 5))
      const stale = pool.stale(days)
      return send(res, 200, { ok: true, days, count: stale.length, stale })
    }
    // ---- E3:快照 / diff / 快照清单 ----
    if (path === '/memory/snapshot' && method === 'POST') {
      return send(res, 200, { ok: true, hash: await pool.snapshotNow() })
    }
    if (path === '/memory/snapshots' && method === 'GET') {
      return send(res, 200, pool.listSnapshots())
    }
    if (path === '/memory/diff' && method === 'GET') {
      const since = url.searchParams.get('since') ?? ''
      const diff = pool.diffSince(since)
      return diff ? send(res, 200, diff) : send(res, 404, { ok: false, error: 'unknown snapshot' })
    }
    return send(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    return send(res, 400, { ok: false, error: `bad request: ${err?.message ?? err}` })
  }
})

server.listen(config.port, '127.0.0.1', () => {
  const s = pool.status()
  console.log(`[ecolink-service] listening on http://127.0.0.1:${config.port}`)
  console.log(`[ecolink-service] pool: ${s.poolFile} (shared=${s.shared}, sessions=${Object.keys(s.sessions).length}, archived=${s.archived})`)
  console.log(`[ecolink-service] token: ${config.token ? 'enabled' : 'disabled'}`)
})

server.on('error', (err) => {
  console.error(`[ecolink-service] failed to start: ${err?.message ?? err}`)
  process.exit(1)
})

export { server, config, pool }
