// dsh-ecolink-adapter v0:记忆注入模块。
// 与网页端扩展同源的核心逻辑(复用 ../extension/core 的选择器/提示词纯函数):
//   - 直读 memory.json(只读,mtime 缓存——唯一写者是 ecolink-service)
//   - agent/pre-step 注入:与 token-optimizer 同款钩子,只处理 source.kind='user'
//     的真实用户消息(DSH 每轮注入的 runtime-context 快照直接放行)
//   - 打分 + 预算 + #记忆名 显式调用(parseMemoryCommand 按会话 identity 过滤)
//   - singleInjection:每 DSH 会话只注入一次(后续轮次由对话历史携带)
//   - 块标记 [dsh-ecolink 记忆]…[/dsh-ecolink 记忆]:幂等剥离(DSH 每 step 重发
//     inbox 同一消息,与网页端同款防残留逻辑)
// 稳定性铁律:任何异常 → 静默放行,不注入。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { selectMemories, effectiveBudget, parseMemoryCommand } from '../../../extension/core/selector.mjs'
import { buildInjectedBlock, stripInjectedBlock } from '../../../extension/core/prompt.mjs'

function expandHome(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return dir
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) return join(homedir(), dir.slice(2))
  return dir
}

export function createMemoryInjectModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const poolPath = expandHome(deps.poolPath ?? config.poolPath)

  // 池读取:mtime 缓存(TTL 兜底 + 文件变化立即重读);失败返回 null → 不注入
  let poolCache = { mtimeMs: 0, at: 0, data: null }
  function readPool() {
    try {
      if (!existsSync(poolPath)) return null
      const st = statSync(poolPath)
      const now = Date.now()
      if (poolCache.data && st.mtimeMs === poolCache.mtimeMs && now - poolCache.at < config.poolTtlMs) {
        return poolCache.data
      }
      const data = JSON.parse(readFileSync(poolPath, 'utf8'))
      poolCache = { mtimeMs: st.mtimeMs, at: now, data }
      return data
    } catch {
      return poolCache.data // 读失败:用旧缓存或 null
    }
  }

  // 当前 agent 跟踪(与 token-optimizer 同款:pre-step 载荷无 agent)
  let currentAgent
  const onStatus = (payload) => {
    if (payload?.status === 'running' && payload?.agent) currentAgent = payload.agent
  }
  ctx.on?.('agent/status', onStatus)

  const injectedSessions = new Set()
  function sessionKey() {
    const agent = currentAgent
    return String(agent?.session?.id ?? agent?.id ?? 'default')
  }

  const handler = async (payload, next) => {
    const decision = await next()
    try {
      if (!decision || decision.kind !== 'enter') return decision
      if (!config.injectEnabled) return decision
      const messages = decision.messages
      if (!Array.isArray(messages) || messages.length === 0) return decision
      const sk = sessionKey()
      if (config.singleInjection && injectedSessions.has(sk)) return decision

      const pool = readPool()
      if (!pool) return decision
      const shared = pool.shared_pool ?? []
      const sessionPools = pool.session_pools ?? {}

      const out = []
      let changed = false
      for (const message of messages) {
        const srcKind = message?.source?.kind
        if (srcKind !== undefined && srcKind !== 'user') { out.push(message); continue }
        const content = message?.content
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
          : ''
        if (!text || text.trim().length === 0) { out.push(message); continue }

        // #记忆名 显式调用 → 只注入该会话记忆;否则共享池 + 全部会话池
        const cmd = parseMemoryCommand(text, sessionPools)
        let items
        let sessionName = null
        if (cmd) {
          const sp = sessionPools[cmd]
          items = (sp?.memories ?? []).map((m) => ({ ...m, identity: sp?.identity }))
          sessionName = sp?.identity
        } else {
          items = [
            ...shared,
            ...Object.entries(sessionPools).flatMap(([, sp]) => (sp?.memories ?? []).map((m) => ({ ...m, identity: sp?.identity }))),
          ]
        }
        const budget = effectiveBudget(text, config.maxInjectionChars)
        const { memories } = selectMemories(items, text, budget)
        if (memories.length === 0) { out.push(message); continue }

        const clean = stripInjectedBlock(text)
        const composed = buildInjectedBlock(memories, sessionName) + '\n\n' + clean
        if (composed === text) { out.push(message); continue }
        out.push({ ...message, content: typeof content === 'string' ? composed : [{ type: 'text', text: composed }] })
        changed = true
        stats?.bump('ecolinkAdapter.injected', 1)
      }
      if (changed) injectedSessions.add(sk)
      return changed ? { ...decision, messages: out } : decision
    } catch (err) {
      console.warn(`[dsh-ecolink-adapter] 注入失败,静默放行(${err?.message ?? err})`)
      return decision
    }
  }

  ctx.on('agent/pre-step', handler)
  return () => {
    ctx.off('agent/pre-step', handler)
    ctx.off?.('agent/status', onStatus)
  }
}
