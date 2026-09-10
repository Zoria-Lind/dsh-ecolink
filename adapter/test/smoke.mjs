// dsh-ecolink-adapter 冒烟测试:node test/smoke.mjs(零 API)
// 用临时池文件 + fake ctx 验证:注入/会话去重/#记忆名 过滤/运行时上下文放行/幂等剥离

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { createMemoryInjectModule } from '../src/modules/memoryInject.js'

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ok  ${name}`)
  else { failures += 1; console.error(`FAIL  ${name}`) }
}

function makeFakeCtx() {
  const handlers = new Map()
  return {
    on(event, handler) { handlers.set(event, handler) },
    off(event, handler) { if (handlers.get(event) === handler) handlers.delete(event) },
    async emit(event, ...args) {
      const h = handlers.get(event)
      if (!h) throw new Error(`no handler for ${event}`)
      return h(...args)
    },
  }
}
function txt(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  return ''
}

const pool = {
  version: 1,
  shared_pool: [
    { id: 's1', content: '用户偏好短标题', timestamp: new Date().toISOString(), importance: 'called', pinned: false, last_accessed: null },
  ],
  session_pools: {
    'chat-abc': {
      identity: '微积分补考',
      first_seen: new Date().toISOString(),
      last_active: new Date().toISOString(),
      memories: [
        { id: 'c1', content: '微积分补考范围是前三章', timestamp: new Date().toISOString(), importance: 'called', pinned: false, last_accessed: null },
      ],
    },
  },
}

console.log('== config ==')
{
  const cfg = resolveConfig({})
  check('默认 poolPath', cfg.adapter.poolPath === '~/.dsh-memory/memory.json')
  check('默认注入预算 3000', cfg.adapter.maxInjectionChars === 3000)
  let threw = false
  try { resolveConfig({ adapter: { bogus: 1 } }) } catch { threw = true }
  check('未知键报错', threw)
}

console.log('== 注入 ==')
{
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-adapter-'))
  const poolPath = join(dir, 'memory.json')
  writeFileSync(poolPath, JSON.stringify(pool), 'utf8')
  const ctx = makeFakeCtx()
  const stats = { bump() {}, addSample() {}, dispose() {}, snapshot() { return {} } }
  createMemoryInjectModule(ctx, { ...resolveConfig({}).adapter, poolPath }, stats)
  await ctx.emit('agent/status', { agent: { id: 'a1', session: { id: 'ds-sess-1' } }, status: 'running' })

  // 1) 普通用户消息 → 注入记忆块
  const d1 = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: '帮我复习微积分补考' }] }))
  const t1 = txt(d1.messages[0].content)
  check('注入记忆块', /\[dsh-ecolink 记忆\]/.test(t1) && /短标题|微积分/.test(t1))
  check('原文保留在块后', t1.endsWith('帮我复习微积分补考'))

  // 2) singleInjection:同会话第二条不再注入
  const d2 = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: '继续复习' }] }))
  check('同会话不重复注入', txt(d2.messages[0].content) === '继续复习')

  // 3) #记忆名 显式调用 → 只注入该会话记忆
  await ctx.emit('agent/status', { agent: { id: 'a2', session: { id: 'ds-sess-2' } }, status: 'running' })
  const d3 = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: '#微积分补考 范围是什么' }] }))
  const t3 = txt(d3.messages[0].content)
  check('#记忆名 注入指定会话记忆', /微积分补考范围是前三章/.test(t3))
  check('#记忆名 不混入共享池', !/短标题/.test(t3))

  // 4) 运行时上下文快照(source.kind='plugin')放行不注入
  await ctx.emit('agent/status', { agent: { id: 'a3', session: { id: 'ds-sess-3' } }, status: 'running' })
  const runtime = { role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: 'Current runtime context.'.repeat(50) }
  const d4 = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [runtime] }))
  check('运行时上下文快照原样放行', d4.messages[0].content === runtime.content)

  // 5) 幂等:已注入的消息再注入不嵌套(块剥离)
  await ctx.emit('agent/status', { agent: { id: 'a4', session: { id: 'ds-sess-4' } }, status: 'running' })
  const injected = txt(d1.messages[0].content)
  const d5 = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: injected }] }))
  const count = (txt(d5.messages[0].content).match(/\[dsh-ecolink 记忆\]/g) ?? []).length
  check('重复注入不嵌套(单块标记)', count === 1)

  // 6) 池文件不存在 → 不注入不崩
  const ctx2 = makeFakeCtx()
  createMemoryInjectModule(ctx2, { ...resolveConfig({}).adapter, poolPath: join(dir, 'missing.json') }, stats)
  await ctx2.emit('agent/status', { agent: { id: 'b1', session: { id: 's-x' } }, status: 'running' })
  const d6 = await ctx2.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: '随便问问' }] }))
  check('池不存在不注入不崩', txt(d6.messages[0].content) === '随便问问')
}

console.log('')
if (failures === 0) { console.log('ALL CHECKS PASSED'); process.exit(0) }
else { console.error(`${failures} CHECK(S) FAILED`); process.exit(1) }
