// dsh-ecolink-adapter 冒烟测试:node test/smoke.mjs(零 API)
// E1 通道分离后覆盖:指令通道(每轮幂等追加 plugin 快照消息,不改写用户消息)/
// 内容逃生舱(旧行为:块注入+会话去重+#记忆名)/skill 运行时注册(E2)/幂等剥离。

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { createMemoryInjectModule } from '../src/modules/memoryInject.js'
import { createMemoryWriteModule } from '../src/modules/memoryWrite.js'
import { createMemoryDiffModule } from '../src/modules/memoryDiff.js'
import { createServiceGuardModule, shouldAutoStart, isLocalServiceUrl } from '../src/modules/serviceGuard.js'
import { apply } from '../src/index.js'

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ok  ${name}`)
  else { failures += 1; console.error(`FAIL  ${name}`) }
}

function txt(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  return ''
}

// 假 createUserMessage:形状贴近真内核(role:user + source + content)
const fakeCreateUserMessage = (input) => ({ role: 'user', source: input.source, content: input.content })

function makeFakeCtx({ withSkills = false, withCommands = false } = {}) {
  const handlers = new Map()
  const registered = []
  const registeredCommands = []
  const ctx = {
    on(event, handler) { handlers.set(event, handler) },
    off(event, handler) { if (handlers.get(event) === handler) handlers.delete(event) },
    async emit(event, ...args) {
      const h = handlers.get(event)
      if (!h) throw new Error(`no handler for ${event}`)
      return h(...args)
    },
  }
  if (withSkills || withCommands) {
    ctx.inject = (deps, cb) => {
      const svc = {}
      if (withSkills && deps.includes('skills')) {
        svc.skills = { register: (skill) => { registered.push(skill); return () => { const i = registered.indexOf(skill); if (i >= 0) registered.splice(i, 1) } } }
      }
      if (withCommands && deps.includes('commands')) {
        svc.commands = { register: (def) => { registeredCommands.push(def); return () => { const i = registeredCommands.indexOf(def); if (i >= 0) registeredCommands.splice(i, 1) } } }
      }
      if (Object.keys(svc).length > 0) cb(svc)
    }
  }
  ctx._registeredSkills = registered
  ctx._handlers = handlers // waterfall 回归测试用:直接取监听器验证 next() 转发
  ctx._registeredCommands = registeredCommands
  return ctx
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

const agentOf = (id, sid) => ({ id, session: { id: sid } })
const userMsg = (text) => ({ role: 'user', source: { kind: 'user' }, content: text })
const makePoolFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-adapter-'))
  const poolPath = join(dir, 'memory.json')
  writeFileSync(poolPath, JSON.stringify(pool), 'utf8')
  return poolPath
}

console.log('== config ==')
{
  const cfg = resolveConfig({})
  check('默认 poolPath', cfg.adapter.poolPath === '~/.dsh-memory/memory.json')
  check('默认注入预算 3000', cfg.adapter.maxInjectionChars === 3000)
  check('E1 默认指令通道开', cfg.adapter.instructionEnabled === true)
  check('E1 默认内容通道关', cfg.adapter.contentInjectionEnabled === false)
  check('E2 默认 skillName', cfg.adapter.skillName === 'ecolink-memory')
  check('E4 默认 serviceUrl', cfg.adapter.serviceUrl === 'http://127.0.0.1:17520')
  check('E4 默认 serviceToken 空(自动读 service/config.json)', cfg.adapter.serviceToken === '')
  check('v1.1 默认 serviceAutoStart 开', cfg.adapter.serviceAutoStart === true)
  check('v1.1 serviceAutoStart 可关', resolveConfig({ adapter: { serviceAutoStart: false } }).adapter.serviceAutoStart === false)
  let threw = false
  try { resolveConfig({ adapter: { bogus: 1 } }) } catch { threw = true }
  check('未知键报错', threw)
  let threw2 = false
  try { resolveConfig({ adapter: { instructionEnabled: 'yes' } }) } catch { threw2 = true }
  check('布尔键类型校验', threw2)
}

console.log('== 指令通道(E1 默认开) ==')
{
  const poolPath = makePoolFile()
  const ctx = makeFakeCtx()
  const stats = { bump() {}, addSample() {}, dispose() {}, snapshot() { return {} } }
  createMemoryInjectModule(ctx, { ...resolveConfig({}).adapter, poolPath }, stats, { createUserMessage: fakeCreateUserMessage })

  // 1) 用户消息不改写,末尾追加指令快照消息
  const d1 = await ctx.emit('agent/pre-step', { agent: agentOf('a1', 'ds-1'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('帮我复习微积分补考')] }))
  check('用户消息不被改写', d1.messages[0].content === '帮我复习微积分补考')
  check('指令快照追加在末尾', d1.messages.length === 2 && /\[dsh-ecolink 指令\]/.test(txt(d1.messages[1].content)))
  check('指令标记成对', txt(d1.messages[1].content).includes('[/dsh-ecolink 指令]'))
  check('指令消息 source 形状', d1.messages[1].source?.kind === 'plugin' && d1.messages[1].source?.plugin === 'ecolink-adapter' && d1.messages[1].source?.summary === 'ecolink-instruction')
  check('不含记忆内容', !/短标题|微积分补考范围是前三章/.test(txt(d1.messages[1].content)))

  // 2) 每轮幂等:下一轮(claimed 里没有旧指令消息)仍恰好 1 条指令消息
  const d2 = await ctx.emit('agent/pre-step', { agent: agentOf('a1', 'ds-1'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('继续复习')] }))
  const inst2 = d2.messages.filter((m) => m?.source?.summary === 'ecolink-instruction')
  check('每轮幂等:仍恰好 1 条指令消息', d2.messages.length === 2 && inst2.length === 1)

  // 3) claimed 里混入旧指令消息(异常场景)也不叠加
  const d3 = await ctx.emit('agent/pre-step', { agent: agentOf('a1', 'ds-1'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('第三轮'), d1.messages[1]] }))
  const inst3 = d3.messages.filter((m) => m?.source?.summary === 'ecolink-instruction')
  check('旧指令消息被剥掉不叠加', inst3.length === 1)

  // 4) reject 决策原样放行
  const d4 = await ctx.emit('agent/pre-step', { agent: agentOf('a1', 'ds-1'), signal: {} }, async () => ({ kind: 'reject' }))
  check('reject 决策原样放行', d4.kind === 'reject' && d4.messages === undefined)

  // 5) 总开关关闭 → 全静默
  const ctx5 = makeFakeCtx()
  createMemoryInjectModule(ctx5, { ...resolveConfig({}).adapter, poolPath, injectEnabled: false }, stats, { createUserMessage: fakeCreateUserMessage })
  const d5 = await ctx5.emit('agent/pre-step', { agent: agentOf('a5', 'ds-5'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('问题')] }))
  check('injectEnabled=false 全静默', d5.messages.length === 1 && d5.messages[0].content === '问题')

  // 6) instructionEnabled=false → 无指令消息
  const ctx6 = makeFakeCtx()
  createMemoryInjectModule(ctx6, { ...resolveConfig({}).adapter, poolPath, instructionEnabled: false }, stats, { createUserMessage: fakeCreateUserMessage })
  const d6 = await ctx6.emit('agent/pre-step', { agent: agentOf('a6', 'ds-6'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('问题')] }))
  check('instructionEnabled=false 无指令消息', d6.messages.length === 1)
}

console.log('== 内容通道逃生舱(E1 默认关) ==')
{
  const poolPath = makePoolFile()
  const ctx = makeFakeCtx()
  const stats = { bump() {}, addSample() {}, dispose() {}, snapshot() { return {} } }
  const cfg = { ...resolveConfig({}).adapter, poolPath, contentInjectionEnabled: true }
  createMemoryInjectModule(ctx, cfg, stats, { createUserMessage: fakeCreateUserMessage })

  // 1) 旧行为:改写用户消息注入记忆块(指令通道同时保持)
  const d1 = await ctx.emit('agent/pre-step', { agent: agentOf('b1', 'ds-b1'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('帮我复习微积分补考')] }))
  check('内容通道:用户消息被改写为记忆块', /\[dsh-ecolink 记忆\]/.test(txt(d1.messages[0].content)) && /微积分补考范围是前三章/.test(txt(d1.messages[0].content)))
  check('内容通道:原文保留在块后', txt(d1.messages[0].content).endsWith('帮我复习微积分补考'))
  check('内容+指令并存', d1.messages.length === 2 && /\[dsh-ecolink 指令\]/.test(txt(d1.messages[1].content)))

  // 2) singleInjection:同会话第二条不再注入内容
  const d2 = await ctx.emit('agent/pre-step', { agent: agentOf('b1', 'ds-b1'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('继续复习')] }))
  check('同会话内容不重复注入', txt(d2.messages[0].content) === '继续复习')

  // 3) #记忆名 显式调用 → 只注入该会话记忆
  const d3 = await ctx.emit('agent/pre-step', { agent: agentOf('b2', 'ds-b2'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('#微积分补考 范围是什么')] }))
  const t3 = txt(d3.messages[0].content)
  check('#记忆名 注入指定会话记忆', /微积分补考范围是前三章/.test(t3))
  check('#记忆名 不混入共享池', !/短标题/.test(t3))

  // 4) 运行时上下文快照(source.kind='plugin')放行不改写
  const runtime = { role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: 'Current runtime context.'.repeat(50) }
  const d4 = await ctx.emit('agent/pre-step', { agent: agentOf('b3', 'ds-b3'), signal: {} }, async () => ({ kind: 'enter', messages: [runtime] }))
  check('运行时上下文快照原样放行', d4.messages[0].content === runtime.content)
}

console.log('== 池缺失与降级 ==')
{
  // 池不存在:指令通道照常(不依赖池);内容通道静默
  const ctx = makeFakeCtx()
  const stats = { bump() {}, addSample() {}, dispose() {}, snapshot() { return {} } }
  createMemoryInjectModule(ctx, { ...resolveConfig({}).adapter, poolPath: join(tmpdir(), 'missing.json'), contentInjectionEnabled: true }, stats, { createUserMessage: fakeCreateUserMessage })
  const d1 = await ctx.emit('agent/pre-step', { agent: agentOf('c1', 'ds-c1'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('随便问问')] }))
  check('池不存在:指令仍注入', d1.messages.length === 2 && /\[dsh-ecolink 指令\]/.test(txt(d1.messages[1].content)))
  check('池不存在:内容不注入不崩', d1.messages[0].content === '随便问问')

  // 无 createUserMessage(deps 显式 null 模拟内核解析失败):指令通道静默禁用,决策原样
  const ctx2 = makeFakeCtx()
  createMemoryInjectModule(ctx2, { ...resolveConfig({}).adapter, poolPath: join(tmpdir(), 'missing.json') }, stats, { createUserMessage: null })
  const d2 = await ctx2.emit('agent/pre-step', { agent: agentOf('c2', 'ds-c2'), signal: {} }, async () => ({ kind: 'enter', messages: [userMsg('问题')] }))
  check('无 createUserMessage 指令通道静默禁用', d2.messages.length === 1 && d2.messages[0].content === '问题')
}

console.log('== E4 写回(/ecolink-push)==')
{
  const ctx = makeFakeCtx({ withCommands: true })
  const stats = { bump() {}, addSample() {}, dispose() {}, snapshot() { return {} } }
  const calls = []
  let mode = 'ok'
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    if (mode === 'fail') return { ok: false, status: 500, text: async () => 'boom' }
    if (mode === 'queued') return { ok: true, status: 200, json: async () => ({ ok: true, queued: 2 }) }
    if (mode === 'dedup') return { ok: true, status: 200, json: async () => ({ ok: true, added: 0, replaced: 0, archived: 0 }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, added: 2, replaced: 1, archived: 0 }) }
  }
  createMemoryWriteModule(ctx, { ...resolveConfig({}).adapter, serviceToken: 'tk-e4' }, stats, { fetchImpl })
  check('命令已注册', ctx._registeredCommands.length === 1)
  const cmd = ctx._registeredCommands[0]
  check('命令名/描述/输入提示', cmd?.name === 'ecolink-push' && typeof cmd?.description === 'string' && cmd.description.length > 0 && typeof cmd?.input?.hint === 'string' && cmd.input.hint.length > 0)

  const noInput = await cmd.handler({ rawInput: '   ' })
  check('空输入 → error 用法提示', noInput.kind === 'error' && noInput.text.includes('用法'))

  mode = 'ok'
  const ok1 = await cmd.handler({ rawInput: '第一条要点\n第二条要点' })
  check('成功推送 → success 文案含新增与覆盖数', ok1.kind === 'success' && ok1.text.includes('2') && ok1.text.includes('1'))
  const last = calls[calls.length - 1]
  check('POST 到 /memory/sync', last.url.endsWith('/memory/sync'))
  check('带 X-Ecolink-Token(显式配置)', last.headers['X-Ecolink-Token'] === 'tk-e4')
  check('逐条 content + source=dsh', last.body.memories.length === 2 && last.body.memories.every((m) => m.source === 'dsh' && typeof m.content === 'string' && m.content.length > 0))

  mode = 'queued'
  const ok2 = await cmd.handler({ rawInput: '建议模式' })
  check('queued 响应 → 提示建议确认队列', ok2.kind === 'success' && ok2.text.includes('建议确认队列'))

  mode = 'fail'
  const err1 = await cmd.handler({ rawInput: '会失败' })
  check('HTTP 失败 → error 含原因', err1.kind === 'error' && err1.text.includes('推送失败') && err1.text.includes('500'))

  mode = 'dedup'
  const dup = await cmd.handler({ rawInput: '重复内容' })
  check('服务端去重(added+replaced=0)→ 如实提示', dup.kind === 'success' && dup.text.includes('无新增'))
}

console.log('== E9 diff 查看(/ecolink-diff)==')
{
  const ctx = makeFakeCtx({ withCommands: true })
  const stats = { bump() {}, addSample() {}, dispose() {}, snapshot() { return {} } }
  const poolData = { version: 1, shared_pool: [{ id: 'a1', key: 'k1', content: '记忆A' }, { id: 'b1', key: 'k2', content: '记忆B' }], session_pools: {} }
  let fileContent = JSON.stringify(poolData)
  const readFile = () => { if (fileContent === null) throw new Error('boom'); return fileContent }
  createMemoryDiffModule(ctx, { ...resolveConfig({}).adapter, poolPath: '/fake/memory.json' }, stats, { readFile })
  check('命令已注册', ctx._registeredCommands.length === 1)
  const cmd = ctx._registeredCommands[0]
  check('命令名/描述', cmd?.name === 'ecolink-diff' && typeof cmd?.description === 'string' && cmd.description.length > 0)

  const first = await cmd.handler({})
  check('首次调用 → 全量 2 条', first.kind === 'success' && first.text.includes('2') && first.text.includes('记忆A') && first.text.includes('记忆B'))

  const second = await cmd.handler({})
  check('无变化 → 无变化文案', second.kind === 'success' && second.text.includes('无变化'))

  poolData.shared_pool.push({ id: 'c1', key: 'k3', content: '记忆C' })
  poolData.shared_pool[0].content = '记忆A改'
  fileContent = JSON.stringify(poolData)
  const third = await cmd.handler({})
  check('新增1+变更1 → diff 2 条', third.kind === 'success' && third.text.includes('2') && third.text.includes('记忆C') && third.text.includes('记忆A改'))

  fileContent = null
  const broken = await cmd.handler({})
  check('池文件损坏 → error 文案', broken.kind === 'error' && broken.text.includes('失败'))
}

console.log('== E2 skill 运行时注册 ==')
{
  const ctx = makeFakeCtx({ withSkills: true })
  const dispose = apply(ctx, { adapter: { skillName: 'my-memory', serviceAutoStart: false } })
  check('skill 已注册', ctx._registeredSkills.length === 1)
  check('skill 名取自 skillName', ctx._registeredSkills[0]?.name === 'my-memory')
  check('skill content 非空且含池路径', typeof ctx._registeredSkills[0]?.content === 'string' && ctx._registeredSkills[0].content.includes('memory.json'))
  check('skill source=runtime', ctx._registeredSkills[0]?.source === 'runtime')
  check('skill description 非空', typeof ctx._registeredSkills[0]?.description === 'string' && ctx._registeredSkills[0].description.length > 0)
  dispose()
  check('cleanup 调用 skill disposer', ctx._registeredSkills.length === 0)

  // 无 skills 服务(离线):apply 不抛
  const ctx2 = makeFakeCtx()
  let threw = false
  try { const d = apply(ctx2, { adapter: { serviceAutoStart: false } }); d() } catch { threw = true }
  check('无 skills 服务不抛', !threw)
}

console.log('== 服务自动拉起(v1.1)==')
{
  check('isLocalServiceUrl 本地判真', isLocalServiceUrl('http://127.0.0.1:17520') && isLocalServiceUrl('http://localhost:9999'))
  check('isLocalServiceUrl 远程判假', !isLocalServiceUrl('http://192.168.1.5:17520') && !isLocalServiceUrl('not-a-url'))
  const baseCfg = { ...resolveConfig({}).adapter }
  check('shouldAutoStart 默认真', shouldAutoStart(baseCfg) === true)
  check('shouldAutoStart 关掉后假', shouldAutoStart({ ...baseCfg, serviceAutoStart: false }) === false)
  check('shouldAutoStart 远程 URL 假', shouldAutoStart({ ...baseCfg, serviceUrl: 'http://10.0.0.9:17520' }) === false)
  check('shouldAutoStart enabled=false 假', shouldAutoStart({ ...baseCfg, enabled: false }) === false)

  // 1) 服务已活(401 也算活)→ 不 spawn
  {
    let alive = true
    const spawns = []
    const guard = createServiceGuardModule(makeFakeCtx(), baseCfg, null, {
      fetchImpl: async () => { if (alive) return { status: 401 }; throw new Error('ECONNREFUSED') },
      spawnImpl: (...a) => { spawns.push(a); return { pid: 4242, unref() {} } },
      serverPath: 'X:/fake/server.mjs',
    })
    const r = await guard.ensureService('test')
    check('已活(401 也算)→ already-running 不 spawn', r === 'already-running' && spawns.length === 0)
  }

  // 2) 未运行 → spawn 拉起,参数形状正确,就绪后不再起
  {
    let alive = false
    const spawns = []
    const tmpDir = mkdtempSync(join(tmpdir(), 'ecolink-guard-'))
    const realServer = join(tmpDir, 'server.mjs')
    writeFileSync(realServer, '', 'utf8')
    const guard = createServiceGuardModule(makeFakeCtx(), baseCfg, null, {
      fetchImpl: async () => { if (alive) return { status: 200 }; throw new Error('ECONNREFUSED') },
      spawnImpl: (...a) => { spawns.push(a); alive = true; return { pid: 777, unref() {} } },
      serverPath: realServer,
    })
    const r = await guard.ensureService('test')
    check('未运行 → spawn 后 started', r === 'started')
    check('恰好 spawn 一次', spawns.length === 1)
    const [cmd, args, opts] = spawns[0]
    check('spawn 用 process.execPath + server.mjs', cmd === process.execPath && args[0].endsWith('server.mjs'))
    check('spawn 参数 detached+windowsHide+ignore', opts.detached === true && opts.windowsHide === true && opts.stdio === 'ignore')
    const r2 = await guard.ensureService('again')
    check('拉起后再探测 → already-running', r2 === 'already-running' && spawns.length === 1)
  }

  // 3) server.mjs 不存在(独立发布包)→ skipped 不 spawn
  {
    const spawns = []
    const guard = createServiceGuardModule(makeFakeCtx(), baseCfg, null, {
      fetchImpl: async () => { throw new Error('ECONNREFUSED') },
      spawnImpl: (...a) => { spawns.push(a); return { pid: 1, unref() {} } },
      serverPath: 'X:/nonexistent/server.mjs',
    })
    const r = await guard.ensureService('test')
    check('server.mjs 缺失 → skipped 不 spawn', r === 'skipped' && spawns.length === 0)
    const r2 = await guard.ensureService('test2')
    check('缺失重复探测也不 spawn', r2 === 'skipped' && spawns.length === 0)
  }

  // 4) 并发去重:apply 触发与显式调用共享同一 in-flight
  {
    let alive = false
    let spawnCount = 0
    const tmpDir = mkdtempSync(join(tmpdir(), 'ecolink-guard-'))
    const realServer = join(tmpDir, 'server.mjs')
    writeFileSync(realServer, '', 'utf8')
    const guard = createServiceGuardModule(makeFakeCtx(), baseCfg, null, {
      fetchImpl: async () => { if (alive) return { status: 200 }; throw new Error('ECONNREFUSED') },
      spawnImpl: () => { spawnCount += 1; alive = true; return { pid: 9, unref() {} } },
      serverPath: realServer,
    })
    // apply 时已触发一次(在 in-flight 中);显式调用应拿到同一个 promise
    const r = await guard.ensureService('test')
    check('并发探测只 spawn 一次', r === 'started' && spawnCount === 1)
  }

  // 5) pre-step 节流(60s)+ 服务中途被停 → 窗口过后补起;
  //    ⚠ waterfall 回归:监听器必须调用 next 并返回其结果(2026-09-14 全天崩溃根因:
  //    不调 next → 链被截断 → 内核读 decision.kind TypeError)
  {
    let alive = true
    let spawnCount = 0
    let now = 61_000 // 越过初始节流(lastCheck=0)
    const tmpDir = mkdtempSync(join(tmpdir(), 'ecolink-guard-'))
    const realServer = join(tmpDir, 'server.mjs')
    writeFileSync(realServer, '', 'utf8')
    const ctx = makeFakeCtx()
    const guard = createServiceGuardModule(ctx, baseCfg, null, {
      fetchImpl: async () => { if (alive) return { status: 200 }; throw new Error('ECONNREFUSED') },
      spawnImpl: () => { spawnCount += 1; alive = true; return { pid: 11, unref() {} } },
      serverPath: realServer,
      now: () => now,
    })
    const preStep = ctx._handlers.get('agent/pre-step')
    check('pre-step 监听器已注册', typeof preStep === 'function')
    let nextCalls = 0
    const fakeNext = async () => { nextCalls += 1; return 'DECISION' }
    const r1 = await preStep({}, fakeNext)
    check('waterfall:调用 next 并返回其结果', r1 === 'DECISION' && nextCalls === 1)
    await guard.ensureService('sync')
    check('pre-step 探测(已活,不 spawn)', spawnCount === 0)
    alive = false // 模拟服务被手动停止
    await preStep({}, fakeNext)
    check('节流窗口内不重复探测,但链不断', spawnCount === 0 && nextCalls === 2)
    now = 122_000
    await preStep({}, fakeNext)
    const r = await guard.ensureService('sync2')
    check('节流窗口过后补起服务', r === 'started' && spawnCount === 1)
    check('每一轮都转发 next(链从未截断)', nextCalls === 3)
  }
}

console.log('')
if (failures === 0) { console.log('ALL CHECKS PASSED'); process.exit(0) }
else { console.error(`${failures} CHECK(S) FAILED`); process.exit(1) }
