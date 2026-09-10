// dsh-ecolink-service:本地记忆池唯一写者(PLAN.md §3.3 / §7)。
// 浏览器扩展与 popup 经 localhost POST 推送/查询;DSH 适配层只读文件不连服务。
// 设计:零依赖(node:http)、只绑 127.0.0.1、可选共享 token、CORS 放行
// (content script 的 fetch 是跨源请求)、请求体上限 2MB、所有写操作经 pool 串行化。

import { createServer } from 'node:http'
import { readFileSync, existsSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPool } from './pool.mjs'
import { compressWithApi, applyCompression } from './compress.mjs'

// 请求日志:落盘到 <poolDir>/service.log,大小超 1MB 自动轮转——
// 排障时 Claude 侧可直接读文件定位断点,无需用户翻浏览器控制台
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
  const defaults = { port: 17520, token: '', poolDir: '~/.dsh-memory', retentionDays: 30, deepseekApiKey: '' }
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
  return defaults
}

const config = loadConfig()
const pool = createPool({ dir: config.poolDir, retentionDays: config.retentionDays })
logPath = join(pool.dir, 'service.log')

const JSON_OK = { 'Content-Type': 'application/json; charset=utf-8' }
const CORS = {
  'Access-Control-Allow-Origin': '*',
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
  if (!config.token) return true
  return req.headers['x-ecolink-token'] === config.token
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'
  reqLog(method, path)

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
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
      return send(res, 200, await pool.sync(body))
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
    // 诊断通道:页面/扩展的关键事件落盘到 service.log(Claude 侧直接读,免用户翻控制台)
    if (path === '/memory/diag' && method === 'POST') {
      const msg = String((await readBody(req)).msg ?? '').slice(0, 500)
      reqLog('DIAG', '', msg)
      return send(res, 200, { ok: true })
    }
    // 备用 API 压缩(网页端为主,模型不服从时用;一次 Flash 调用,符合成本原则)
    if (path === '/memory/compress' && method === 'POST') {
      // 每次请求热读配置:用户填/改 deepseekApiKey 后无需重启服务
      const liveCfg = loadConfig()
      if (!liveCfg.deepseekApiKey) return send(res, 400, { ok: false, error: 'deepseekApiKey 未配置(service/config.json)' })
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
