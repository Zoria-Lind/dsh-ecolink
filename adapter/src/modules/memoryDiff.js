// dsh-ecolink-adapter(E9):记忆 diff 查看模块(/ecolink-diff)。
// 动机:skill 读取路径的 token 成本——池变大后每次 read 全量都烧上下文。
// 语义:"自上次 /ecolink-diff 调用以来"的新增/变化条目——命令调用本身就是读取事件,
// 游标随调用推进,无需读检测;首次调用(或 DSH 重启后)返回全量。纯模块内状态,不落盘。
// 稳定性铁律:任何异常 → kind:'error' 文案,绝不抛出打断命令管线。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const COMMAND_NAME = 'ecolink-diff'

function expandHome(dir) {
  const d = String(dir ?? '')
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) return join(homedir(), d.slice(2))
  return d
}

function contentFp(text) { const s = String(text ?? ''); return s.length + ':' + s.slice(0, 40) + ':' + s.slice(-40) }
function entryKey(e) { return e?.id ?? 'c:' + contentFp(e?.content) }

export function createMemoryDiffModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.inject !== 'function') return () => {}

  const readFile = typeof deps.readFile === 'function' ? deps.readFile : ((p) => readFileSync(p, 'utf8'))
  // 响应体按内容通道预算裁剪,避免超大 diff 直接灌满上下文
  const cap = Number.isFinite(config.maxInjectionChars) ? Math.max(200, config.maxInjectionChars) : 3000

  let lastSnapshot = null // Map(entryKey → content);null = 尚未建立基线(首次调用)

  function flatten(pool) {
    const out = []
    for (const m of pool?.shared_pool ?? []) out.push(m)
    for (const [sid, sp] of Object.entries(pool?.session_pools ?? {})) {
      for (const m of sp?.memories ?? []) out.push({ ...m, _identity: sp?.identity })
    }
    // 最新在前:模型读列表时注意力集中在头部,新记忆垫底会被漏掉(2026-09-14 实测:
    // "今晚要干嘛"的答案就在列表最后一条,模型复述时把它丢了)
    out.sort((a, b) => String(b?.timestamp ?? '').localeCompare(String(a?.timestamp ?? '')))
    return out
  }

  // 渲染降精度(与网页端 renderMemoryTimestamp 同规则):2h→分钟,48h→小时,5天→日期,更早不渲染
  function renderTs(isoTs) {
    const d = new Date(isoTs)
    if (!Number.isFinite(d.getTime())) return null
    const age = Math.max(0, Date.now() - d.getTime())
    if (age > 5 * 86400e3) return null
    const pad = (n) => String(n).padStart(2, '0')
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    if (age > 48 * 3600e3) return date
    if (age > 2 * 3600e3) return `${date} ${pad(d.getHours())}:00`
    return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  function computeDiff(entries) {
    if (!lastSnapshot) {
      lastSnapshot = new Map(entries.map((e) => [entryKey(e), e.content]))
      return { first: true, items: entries }
    }
    const items = entries.filter((e) => !lastSnapshot.has(entryKey(e)) || lastSnapshot.get(entryKey(e)) !== e.content)
    lastSnapshot = new Map(entries.map((e) => [entryKey(e), e.content]))
    return { first: false, items }
  }

  function formatItems(items) {
    const lines = []
    let used = 0
    for (const it of items) {
      const content = String(it?.content ?? '')
      const ts = it?.timestamp ? renderTs(it.timestamp) : null
      const line = (ts ? `(${ts}) ` : '') + (it?._identity ? `[${it._identity}] ` : '') + (it?.key ? `(${it.key}) ` : '') + (content.length > 300 ? content.slice(0, 300) + '…' : content)
      if (used + line.length + 2 > cap && lines.length > 0) {
        lines.push(`…(共 ${items.length} 条,超出预算已截断;其余请 read 原文)`)
        break
      }
      lines.push('- ' + line)
      used += line.length + 2
    }
    return lines.join('\n')
  }

  const disposers = []
  ctx.inject(['commands'], (cmdCtx) => {
    try {
      disposers.push(cmdCtx.commands.register({
        name: COMMAND_NAME,
        description: '查看 dsh-ecolink 记忆池自上次查看以来的新增/变化条目(首次调用返回全量)',
        input: { hint: '无需输入,直接回车查看' },
        handler: async (invocation) => {
          try {
            const pool = JSON.parse(readFile(expandHome(config.poolPath)))
            const entries = flatten(pool)
            const { first, items } = computeDiff(entries)
            stats?.bump?.('memoryDiff.called', 1)
            if (first) {
              const body = formatItems(items)
              return { kind: 'success', text: `记忆池共 ${entries.length} 条(首次调用,返回全量):\n${body || '(空池)'}` }
            }
            if (items.length === 0) {
              return { kind: 'success', text: `自上次查看以来无变化(池共 ${entries.length} 条)。需要完整上下文请用 read 工具读 memory.json。` }
            }
            return { kind: 'success', text: `自上次查看以来新增/变化 ${items.length} 条:\n${formatItems(items)}` }
          } catch (err) {
            return { kind: 'error', text: `读取记忆池失败:${err?.message ?? err}(检查 poolPath 下是否存在 memory.json)` }
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
