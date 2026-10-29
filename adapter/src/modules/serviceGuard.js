// dsh-ecolink-adapter v1.1(2026-09-14):ecolink-service 自动拉起模块。
// 痛点:service 是网页扩展与 DSH 共享记忆池的唯一写者,但它是独立 node 进程,
// 用户必须手动 `node service/server.mjs`。本模块让 DSH 启动时自动探测并拉起:
// - apply 时 + 每次 agent/pre-step(60s 节流)探测 `${serviceUrl}/memory/status`;
// - 200 为可达；其他 HTTP 仅视为端口占用；只在明确 ECONNREFUSED 时尝试拉起，超时不拉起。
// - 仅对 127.0.0.1 / localhost / ::1 生效(远程 URL 绝不 spawn);
// - serviceAutoStart:false 或 server.mjs 不存在(独立发布包无 service 目录)时静默跳过;
// - 与登录自启任务(scripts/install-autostart.ps1)兼容:端口已监听 → 探测即活,不会双起。
// 稳定性铁律:全部 try/catch,任何异常最多一条 warn,绝不打断 DSH 生命周期。
// 测试:deps 注入 fetchImpl/spawnImpl/serverPath/now,见 test/smoke.mjs「服务自动拉起」节。

import { spawn } from 'node:child_process'
import { resolveServiceToken } from './memoryWrite.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// 同仓 service 目录(与 memoryWrite 的 SERVICE_CONFIG 同源;独立发布包无此目录 → 跳过拉起)。
// 三种布局都找:①npm 安装的 @zoria-lind/dsh-ecolink-service 包(尽力而为解析,不写死依赖)
// ②开发挂载(adapter 上一级的 service/)③独立发布包(adapter 内 service/,通常不存在)
const HERE = dirname(fileURLToPath(import.meta.url))
const NPM_SERVICE_PATH = (() => {
  try {
    const req = createRequire(import.meta.url)
    return join(dirname(req.resolve('@zoria-lind/dsh-ecolink-service')), 'server.mjs')
  } catch { return null }
})()
export const SERVICE_SERVER_CANDIDATES = [
  ...(NPM_SERVICE_PATH ? [NPM_SERVICE_PATH] : []),
  join(HERE, '../../../service/server.mjs'),
  join(HERE, '../../service/server.mjs'),
]

export function isLocalServiceUrl(url) {
  try {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(String(url)).hostname)
  } catch { return false }
}

export function shouldAutoStart(config) {
  return Boolean(config?.enabled && config.serviceAutoStart && isLocalServiceUrl(config.serviceUrl))
}

export function createServiceGuardModule(ctx, config, stats, deps = {}) {
  if (!shouldAutoStart(config)) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : ((...a) => fetch(...a))
  const spawnImpl = typeof deps.spawnImpl === 'function' ? deps.spawnImpl : ((...a) => spawn(...a))
  const serverPath = typeof deps.serverPath === 'string' ? deps.serverPath : (SERVICE_SERVER_CANDIDATES.find((p) => existsSync(p)) ?? SERVICE_SERVER_CANDIDATES[0])
  const nowFn = typeof deps.now === 'function' ? deps.now : (() => Date.now())
  const base = String(config.serviceUrl ?? 'http://127.0.0.1:17520').replace(/\/$/, '')

  const THROTTLE_MS = 60_000
  const READY_POLL_MS = 3_000
  let inFlight = null
  let lastCheck = 0
  let warnedMissing = false
  let disposed = false
  let spawnError = null

  async function isAlive() {
    try {
      const resp = await fetchImpl(`${base}/memory/status`, { signal: AbortSignal.timeout(500), headers: { 'X-Ecolink-Token': resolveServiceToken(config) } })
      return resp.status === 200 ? 'alive' : 'occupied'
    } catch (e) { return (e?.code === 'ECONNREFUSED' || e?.cause?.code === 'ECONNREFUSED' || e?.message === 'ECONNREFUSED') ? 'absent' : 'uncertain' }
  }

  async function ensureService(reason) {
    if (disposed) return 'disposed'
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const probe = await isAlive()
        if (probe === 'alive') return 'already-running'
        if (probe !== 'absent') return probe
        if (!existsSync(serverPath)) {
          if (!warnedMissing) {
            warnedMissing = true
            console.warn(`[dsh-ecolink-adapter] 自动拉起跳过:${serverPath} 不存在(独立发布包无 service 目录,请手动启动服务)`)
          }
          return 'skipped'
        }
        spawnError = null
        const child = spawnImpl(process.execPath, [serverPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        child?.once?.('error', err => { spawnError = err })
        child?.unref?.()
        stats?.bump?.('serviceGuard.started')
        // 有界就绪等待(不阻塞 DSH;未就绪也不重试,由网页端离线队列兜底)
        const deadline = Date.now() + READY_POLL_MS
        while (!disposed && Date.now() < deadline) {
          if (spawnError) throw spawnError
          if (await isAlive() === 'alive') {
            console.log(`[dsh-ecolink-adapter] ecolink-service 未运行,已自动启动 (pid ${child?.pid ?? '?'}) [${reason}]`)
            return 'started'
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        console.warn(`[dsh-ecolink-adapter] ecolink-service 已启动但 ${READY_POLL_MS / 1000}s 内未就绪 (pid ${child?.pid ?? '?'})`)
        return 'started-slow'
      } catch (err) {
        console.warn(`[dsh-ecolink-adapter] 自动拉起失败:${err?.message ?? err}`)
        return 'failed'
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  // apply 时探测一次(异步 fire-and-forget,不阻塞插件装配)
  ensureService('apply').catch(() => {})

  // pre-step 节流探测:服务中途被手动停止 → 下一轮请求前自动补起。
  // ⚠ agent/pre-step 是 cordis waterfall:不调 next() 会截断整条链,决策变 undefined,
  // 内核读 decision.kind 直接 TypeError(2026-09-14 全天 DSH 崩溃根因)。
  // 本监听器必须原样转发 next() 结果,探测本身 fire-and-forget。
  const handler = (_payload, next) => {
    const now = nowFn()
    if (now - lastCheck < THROTTLE_MS) return next()
    lastCheck = now
    ensureService('pre-step').catch(() => {})
    return next()
  }
  ctx.on('agent/pre-step', handler)

  // 返回 disposer 供 apply 统一清理;测试经 disposer.ensureService 显式等待
  const dispose = () => { disposed = true; ctx.off?.('agent/pre-step', handler) }
  dispose.ensureService = ensureService
  return dispose
}
