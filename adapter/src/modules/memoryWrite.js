// dsh-ecolink-adapter v1(E4):DSH 记忆写回模块。
// 原则:DSH 侧只发 HTTP 请求,写盘由 ecolink-service 完成(P7 唯一写者)。
// 端点复用既有 POST /memory/sync(07 F3 推荐①),条目带 source:'dsh',不新增端点。
// 触发方式:斜杠命令 /ecolink-push(P6 形状)——默认不自动推送,必须显式调用。
// token 来源:config.serviceToken 显式配置优先;为空时读取同仓 service/config.json
// (E8 默认安全:服务启动自动生成 token 并写回该文件;浏览器读不到本地文件,不破坏鉴权边界)。
// 稳定性铁律:任何异常 → 返回 kind:'error' 文案,绝不抛出打断命令管线。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const COMMAND_NAME = 'ecolink-push'
// 同仓服务配置(仅当 serviceToken 未显式配置时读 token 字段;每次推送热读,容忍失败)
const SERVICE_CONFIG = join(dirname(fileURLToPath(import.meta.url)), '../../../service/config.json')

// 2026-09-25:npm 安装时包内不含 config.json(发布包排除敏感文件)→
// 追加 node_modules 里独立 service 包的配置候选(与 serviceGuard 双候选同款解析)。
// 该包的 config.json 由服务首次启动自动生成 token,正是 npm 用户的真实 token 所在。
function npmServiceConfig() {
  try {
    const req = createRequire(import.meta.url)
    return join(dirname(req.resolve('@zoria-lind/dsh-ecolink-service/package.json')), 'service/config.json')
  } catch { return null }
}

function resolveServiceToken(config) {
  if (config.serviceToken) return config.serviceToken
  for (const cand of [SERVICE_CONFIG, npmServiceConfig()]) {
    if (!cand) continue
    try {
      if (existsSync(cand)) {
        const token = String(JSON.parse(readFileSync(cand, 'utf8'))?.token ?? '')
        if (token) return token
      }
    } catch { /* 读不到就试下一个,最终不带头由服务端 401 提示 */ }
  }
  return ''
}

export function createMemoryWriteModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.inject !== 'function') return () => {}

  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : ((...a) => fetch(...a))

  // POST /memory/sync:响应形状 { ok, added, replaced, archived } 是现存硬依赖(07 F1)
  async function pushMemories(contents) {
    const base = String(config.serviceUrl ?? 'http://127.0.0.1:17520').replace(/\/$/, '')
    const headers = { 'Content-Type': 'application/json' }
    const token = resolveServiceToken(config)
    if (token) headers['X-Ecolink-Token'] = token
    const resp = await fetchImpl(`${base}/memory/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ memories: contents.map((content) => ({ content, importance: 'called', source: 'dsh' })) }),
    })
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new Error(`ecolink-service HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    return resp.json()
  }

  const disposers = []
  ctx.inject(['commands'], (cmdCtx) => {
    try {
      disposers.push(cmdCtx.commands.register({
        name: COMMAND_NAME,
        description: '把指定要点推送到 dsh-ecolink 记忆池(网页端与 DSH 共用)',
        input: { hint: '要记住的要点(一行一条,可多条)' },
        handler: async (invocation) => {
          try {
            const raw = String(invocation?.rawInput ?? '').trim()
            if (!raw) {
              return { kind: 'error', text: '用法:/ecolink-push <要点>。要推送的内容不能为空,一行一条可写多条。' }
            }
            const contents = raw.split('\n').map((s) => s.trim()).filter(Boolean)
            const result = await pushMemories(contents)
            stats?.bump?.('memoryWrite.pushed', contents.length)
            if (result?.queued) {
              return { kind: 'success', text: `已提交 ${result.queued} 条到建议确认队列,请在网页端 popup 确认后入池。` }
            }
            const added = result?.added ?? 0
            const replaced = result?.replaced ?? 0
            if (added + replaced === 0) {
              return { kind: 'success', text: '服务端判定无新增(与现有记忆重复),未写入。' }
            }
            return { kind: 'success', text: `已写入记忆池:新增 ${added} 条,覆盖 ${replaced} 条(来源标记 dsh)。` }
          } catch (err) {
            return { kind: 'error', text: `推送失败:${err?.message ?? err}(service 未运行会由 adapter 下一轮自动拉起;仍失败请检查 token 是否一致)` }
          }
        },
      }))
    } catch (err) {
      console.warn(`[dsh-ecolink-adapter] /${COMMAND_NAME} 注册失败(${err?.message ?? err})`)
    }
  })

  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* noop */ }
    }
  }
}
