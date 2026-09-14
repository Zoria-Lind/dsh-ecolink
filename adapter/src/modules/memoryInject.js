// dsh-ecolink-adapter v1(E1 通道分离):记忆注入模块。
// 与网页端扩展同源的核心逻辑(复用 ../extension/core 的选择器/提示词纯函数):
//   - 直读 memory.json(只读,mtime 缓存——唯一写者是 ecolink-service)
//   - 【指令通道,默认开】agent/pre-step 每轮幂等追加一条 source.kind='plugin' 的
//     快照消息承载 [dsh-ecolink 指令] 块(照抄内核 dsh-time-context 的成熟做法:
//     prepend 注册 + await next() + 末尾 append createUserMessage;决策里的 messages
//     只喂本步请求、不写入会话事件)。不改写用户消息 → 不碰前缀缓存。
//   - 【内容通道,默认关(contentInjectionEnabled 逃生舱)】旧行为:改写用户消息注入
//     记忆块(打分 + 预算 + #记忆名 + singleInjection 会话去重)。
//   - 块标记 [dsh-ecolink 记忆] / [dsh-ecolink 指令]:幂等剥离(DSH 每 step 重发
//     inbox 同一消息,与网页端同款防残留逻辑)
// 稳定性铁律:任何异常 → 静默放行,不注入。
// 内核事实(09 §A 已核实):agent/* 事件载荷由 agentEvents() 自动 {...payload, agent} 融合
// → pre-step 载荷直接有 payload.agent(v0 的 agent/status 跟踪 hack 据此移除)。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { selectMemories, effectiveBudget, parseMemoryCommand } from '../../../extension/core/selector.mjs'
import { buildInjectedBlock, buildInstructionBlock, stripAllBlocks } from '../../../extension/core/prompt.mjs'
import { resolveKernelModule } from '../kernel.js'

const INSTRUCTION_SUMMARY = 'ecolink-instruction'

function expandHome(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return dir
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) return join(homedir(), dir.slice(2))
  return dir
}

export function createMemoryInjectModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const poolPath = expandHome(deps.poolPath ?? config.poolPath)

  // createUserMessage:测试经 deps 注入假实现(显式 null = 强制禁用,模拟解析失败);
  // 生产从 @deepseek-ai/dsh-llm 解析(失败 → 指令通道静默禁用,警告一次)
  let createUserMessage = null
  if (deps.createUserMessage === null) {
    // 强制禁用路径(测试用)
  } else if (typeof deps.createUserMessage === 'function') {
    createUserMessage = deps.createUserMessage
  } else {
    const llm = resolveKernelModule('@deepseek-ai/dsh-llm')
    if (llm && typeof llm.createUserMessage === 'function') {
      createUserMessage = llm.createUserMessage
    } else {
      console.warn('[dsh-ecolink-adapter] 未能解析 @deepseek-ai/dsh-llm,指令通道禁用(记忆注入不受影响)')
    }
  }

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

  // 指令消息识别(幂等剥旧用:summary 唯一属于本插件的指令快照)
  const isOwnInstruction = (m) => m?.source?.kind === 'plugin'
    && m?.source?.plugin === 'ecolink-adapter'
    && m?.source?.summary === INSTRUCTION_SUMMARY

  // 指令快照消息(与内核 dsh-time-context 同款形状:form='snapshot' + sections)
  // E9.1:指令块内追加"读路径"指引——旧版只教写不教读,模型不知道池可查,
  // "你还记得吗"类问题零工具调用凭印象回答(2026-09-14 实测)。
  // E9.2:从"建议"升级为"硬规则"——查池是回答记忆类问题的前提,查之前禁止
  // 答"不知道/不记得"(模型常因"当前上下文没有"而诚实地说不知道,但池是另一回事)
  const READ_HINT = '跨端记忆查询(强制规则):当用户询问或提及"之前记过什么/你还记得吗/我的偏好/日程安排/考试安排/习惯/计划"等任何可能与历史记忆有关的问题时,第一步必须先运行 /ecolink-diff 命令查询记忆池(本会话首次调用返回全量),需要细节时再用 read 工具读 ~/.dsh-memory/memory.json 核对。禁止在未查询记忆池的情况下回答"不知道/不记得/没有记录"——记忆池与本对话上下文是两回事,池里有而上下文没有是常态。'
  function buildInstructionMessage() {
    const text = buildInstructionBlock().replace('[/dsh-ecolink 指令]', READ_HINT + '\n[/dsh-ecolink 指令]')
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'ecolink-adapter', form: 'snapshot', summary: INSTRUCTION_SUMMARY, sections: [{ name: 'ecolink-instruction', text }] },
    })
  }

  // 内容通道(E1 逃生舱):旧行为的按消息改写注入
  function injectContentIntoMessages(messages) {
    const sk = String(currentAgent?.session?.id ?? currentAgent?.id ?? 'default')
    if (config.singleInjection && injectedSessions.has(sk)) return { messages, changed: false }

    const pool = readPool()
    if (!pool) return { messages, changed: false }
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

      const clean = stripAllBlocks(text)
      const composed = buildInjectedBlock(memories, sessionName) + '\n\n' + clean
      if (composed === text) { out.push(message); continue }
      out.push({ ...message, content: typeof content === 'string' ? composed : [{ type: 'text', text: composed }] })
      changed = true
      stats?.bump('ecolinkAdapter.injected', 1)
    }
    if (changed) injectedSessions.add(sk)
    return { messages: out, changed }
  }

  // 当前 agent(pre-step 载荷自带 agent,内核 agentEvents() 融合;保底用上次 running 状态)
  let currentAgent
  const onStatus = (payload) => {
    if (payload?.status === 'running' && payload?.agent) currentAgent = payload.agent
  }
  ctx.on?.('agent/status', onStatus)

  const injectedSessions = new Set()

  const handler = async (payload, next) => {
    const decision = await next()
    try {
      if (!decision || decision.kind !== 'enter') return decision
      if (payload?.signal?.aborted) return decision
      if (!config.injectEnabled) return decision
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      if (messages.length === 0) return decision

      currentAgent = payload?.agent ?? currentAgent
      let out = messages
      let changed = false

      // ① 指令通道(默认开):剥旧指令快照 → 末尾追加新指令(每轮幂等,不改写用户消息)
      if (config.instructionEnabled && createUserMessage) {
        const kept = out.filter((m) => !isOwnInstruction(m))
        out = [...kept, buildInstructionMessage()]
        changed = true
        stats?.bump('ecolinkAdapter.instructed', 1)
      }

      // ② 内容通道(默认关):改写用户消息注入记忆块
      if (config.contentInjectionEnabled) {
        const r = injectContentIntoMessages(out)
        out = r.messages
        changed = changed || r.changed
      }

      return changed ? { ...decision, messages: out } : decision
    } catch (err) {
      console.warn(`[dsh-ecolink-adapter] 注入失败,静默放行(${err?.message ?? err})`)
      return decision
    }
  }

  ctx.on('agent/pre-step', handler, { prepend: true })
  return () => {
    ctx.off('agent/pre-step', handler)
    ctx.off?.('agent/status', onStatus)
  }
}
