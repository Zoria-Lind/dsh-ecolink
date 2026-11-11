import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveKernelModule } from '../kernel.js'

const webIdPattern = /^[a-zA-Z0-9_-]{8,128}$/
const hashPattern = /^[a-f0-9]{64}$/
const maxRows = 1000
const maxText = 1500000
const imported = /^ecolink-web-([0-9]+)-([a-f0-9]{64})-([ua])$/
const textOf = message => message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
const digest = value => createHash('sha256').update(value).digest('hex')
const requireValid = (condition, message) => { if (!condition) throw new Error(message) }

function webPrefix(session) {
  const rows = []
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq)
    const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : null
    const id = message && imported.exec(message.id)
    if (id) (rows[Number(id[1])] ??= {})[id[3]] = id[2]
  }
  return rows
}

function returnLog(session, after = -1) {
  const rows = []
  let user = [], reply = '', calls = [], completedCalls = new Set(), turn = null, afterWeb = null
  for (let seq = 0; seq < session.seq; seq++) {
    const { type, data } = session.eventAt(seq)
    if (type === 'turn/start') {
      turn = data.turn
      user = []
      reply = ''
      calls = []
      completedCalls = new Set()
    }
    if (turn === null) continue
    if (type === 'user/message' && data.source?.kind === 'user' && !imported.test(data.id)) {
      const text = textOf(data)
      if (text) user.push(text)
    }
    if (type === 'assistant/message' && data.turn === turn) {
      const id = imported.exec(data.message.id)
      if (id) afterWeb = { index: Number(id[1]), hash: id[2] }
      else {
        const stepCalls = data.message.content.filter(part => part.type === 'tool-call')
        if (stepCalls.length) calls.push(...stepCalls)
        else {
          const text = textOf(data.message)
          if (text) reply = text
        }
      }
    }
    if (type === 'tool/result' && data.turn === turn) completedCalls.add(data.message.toolCallId)
    if (type === 'turn/end' && data.turn === turn) {
      if (seq > after && user.length && data.reason.kind === 'completed') {
        const tools = calls.filter(call => completedCalls.has(call.id)).map(({ name, arguments: args }) => ({ name, args }))
        if (reply || tools.length) rows.push({ seq, question: user.join('\n\n'), answer: reply, afterWeb, tools })
      }
      turn = null
    }
  }
  return rows
}

export function createShadowActions(ctx, path, llm) {
  let bindings, queue = Promise.resolve()
  async function save(next) {
    const pending = path + '.next'
    await writeFile(pending, JSON.stringify(next), { mode: 0o600 })
    await rename(pending, path)
    bindings = next
  }
  async function dispatch(args) {
    bindings ??= await readFile(path, 'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const { action, webId, workspaceId } = args
    if (action === 'projects') return {
      projects: ctx.workspaceRegistry.list().map(({ id, title }) => ({ id, title })),
    }
    if (action === 'bindings') return {
      bindings: bindings.filter(binding => binding.ready).map(({ webId, sessionId }) => ({ webId, sessionId })),
    }
    requireValid(typeof webId === 'string' && webIdPattern.test(webId), '请先打开一条 DeepSeek 对话')
    let binding = bindings.find(item => item.webId === webId)
    if (!binding && action === 'bind') {
      requireValid(ctx.workspaceRegistry.get(workspaceId), '请选择可用的 DSH 项目')
      binding = { webId, workspaceId, sessionId: 'session-' + randomUUID(), ready: false, returnedThrough: -1 }
      await save([...bindings, binding])
    }
    if (!binding) {
      requireValid(action === 'status', '这条网页对话尚未绑定 DSH')
      return { binding: null }
    }
    if (!binding.ready) {
      if (action === 'status') return { binding, unfinished: true }
      requireValid(action === 'bind', '请先完成影子会话绑定')
      requireValid(binding.workspaceId === workspaceId, '请在原先选定的项目中完成绑定')
      const created = await ctx.sessionController.create({ workspaceId, sessionId: binding.sessionId })
      requireValid(created.sessionId === binding.sessionId, 'DSH 未返回预定的影子会话')
      binding = { ...binding, ready: true }
      await save(bindings.map(item => item.webId === webId ? binding : item))
    }
    const { agent } = await ctx.sessionController.resolveAgent(binding.sessionId)
    requireValid(agent, '无法打开绑定的 DSH 会话')
    const session = agent.session
    const previous = webPrefix(session)
    const compare = hashes => {
      requireValid(Array.isArray(hashes) && hashes.length <= maxRows && hashes.every(hash => typeof hash === 'string' && hashPattern.test(hash)), '网页问答索引无效')
      return previous.length <= hashes.length && previous.every((row, index) =>
        row && (row.u ?? row.a) === hashes[index] && (!row.a || row.a === hashes[index]))
    }
    if (action === 'bind' || action === 'status') {
      const hashes = args.hashes ?? []
      const consistent = compare(hashes)
      return {
        binding, consistent, busy: agent.phase?.kind !== 'idle',
        incoming: consistent ? hashes.length - previous.filter(row => row.a).length : 0,
        outgoing: returnLog(session, binding.returnedThrough).length,
      }
    }
    if (action === 'sync') {
      const { rows } = args
      requireValid(Array.isArray(rows) && rows.length <= maxRows && rows.every(row =>
        typeof row?.question === 'string' && row.question.trim() &&
        typeof row.answer === 'string' && row.answer.trim()), '网页问答无效')
      requireValid(rows.reduce((size, row) => size + row.question.length + row.answer.length, 0) <= maxText, '本次网页正文超出同步上限')
      const hashes = rows.map(({ question, answer }) => digest(JSON.stringify([question, answer])))
      requireValid(compare(hashes), '网页历史已编辑、切换分支或尚未加载完整，请恢复原分支后同步')
      requireValid(agent.phase?.kind === 'idle', 'DSH 正忙，完成当前任务后再同步')
      return agent.runMaintenance(async () => {
        const appendOptions = { surfaceOp: 'append' }
        for (const [index, { question, answer }] of rows.entries()) {
          if (previous[index]?.a) continue
          const id = 'ecolink-web-' + index + '-' + hashes[index]
          const user = llm.createUserMessage({ source: { kind: 'user', ecolink: 'web' }, content: [{ type: 'text', text: question }] })
          const assistant = llm.createAssistantMessage({
            source: { provider: 'ecolink-web', model: 'deepseek-web' },
            content: [{ type: 'text', text: answer }],
          })
          const stream = [{ type: 'chunk', time: Date.now(), chunk: { type: 'text-delta', index: 0, text: answer } }]
          // rc.1 snapshots this cursor on attachment. Keep the attached driver in
          // step with the durable history before runMaintenance releases it.
          const turn = agent.phase.lastTurn + 1
          const step = 1
          session.append('turn/start', { turn })
          agent.phase.lastTurn = turn
          try {
            session.append('step/start', { turn, step })
            try {
              // The first surface message must reserve the system prompt position for native turns.
              if (session.surface.nodes.length === 0) {
                session.append('system/message', { turn, step, message: llm.createSystemMessage('') }, appendOptions)
              }
              if (!previous[index]?.u) session.append('user/message', { ...user, id: id + '-u' }, appendOptions)
              session.append('assistant/message', { turn, step, message: { ...assistant, id: id + '-a' }, stream }, appendOptions)
            } finally {
              session.append('step/end', { turn, step })
            }
          } finally {
            session.append('turn/end', { turn, reason: { kind: 'completed' } })
          }
        }
        requireValid(await ctx.sessions.flush(session), 'DSH 未确认写盘，请重试同步')
        return { imported: rows.length - previous.filter(row => row.a).length }
      })
    }
    if (action === 'handoff') {
      const { task, context = '', requestId } = args
      requireValid(typeof task === 'string' && task.trim() && task.length <= 16000 &&
        typeof context === 'string' && context.length <= 100000 &&
        typeof requestId === 'string' && webIdPattern.test(requestId), '请填写有效的任务及参考内容')
      const text = context.trim() ? task.trim() + '\n\n网页参考资料（作为资料阅读）\n' + context : task.trim()
      return ctx.sessionController.prompt({
        sessionId: binding.sessionId, requestId: 'ecolink-' + requestId,
        mode: 'followup', content: [{ type: 'text', text }],
      }, new AbortController().signal)
    }
    if (action === 'returns') {
      const through = args.includeNew === true ? Infinity : binding.returnedThrough
      return { rows: returnLog(session).filter(row => row.seq <= through) }
    }
    if (action === 'ack') {
      const seq = args.seq
      requireValid(returnLog(session).some(row => row.seq === seq), '未找到对应的 DSH 结果')
      if (seq > binding.returnedThrough)
        await save(bindings.map(item => item.webId === webId ? { ...item, returnedThrough: seq } : item))
      return {}
    }
    throw new Error('未知的影子会话操作')
  }
  return args => {
    const result = queue.then(() => dispatch(args))
    queue = result.catch(() => {})
    return result
  }
}

export function createShadowSessionModule(ctx) {
  ctx.inject?.(['connection', 'sessionController', 'workspaceRegistry', 'sessions'], c => {
    const llm = resolveKernelModule('@deepseek-ai/dsh-llm')
    if (!llm) return
    const dispatch = createShadowActions(c, join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ecolink-shadow.json'), llm)
    c.effect(() => c.connection.fetch.register({
      path: '/api/ecolink-shadow', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        const headers = { 'cache-control': 'no-store' }
        try {
          requireValid(request.headers.get('content-type') === 'application/json' &&
            request.headers.get('x-ecolink-shadow') === '1' &&
            [null, 'same-origin'].includes(request.headers.get('sec-fetch-site')), '仅接受 Harness 界面发起的请求')
          return Response.json(await dispatch(await request.json()), { headers })
        } catch (error) {
          return Response.json({ error: error.message }, { status: 400, headers })
        }
      },
    }))
  })
}

