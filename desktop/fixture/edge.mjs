import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createPool } from '../../service/pool.mjs'
import { createMemoryBridge, isDeepSeekDocument } from '../memory-bridge.mjs'
import { buildGuestPreload } from '../build-guest.mjs'

const root = process.env.DSH_ECO_STATE
const edge = process.env.ECO04B_EDGE
assert.ok(root && edge, 'Isolated test paths are required')
const dir = mkdtempSync(join(root, 'edge-'))
const pool = createPool({ dir: mkdtempSync(join(root, 'edge-pool-')) })
const calls = []
let failNext = true
const bridge = createMemoryBridge({ port: 21286, token: 'fixture-only', fetcher: async (url, options) => {
  assert.equal(options.headers['X-Ecolink-Token'], 'fixture-only')
  assert.ok(url.startsWith('http://127.0.0.1:21286/memory/'))
  const body = JSON.parse(options.body)
  if (url.endsWith('/artifact') && failNext) {
    failNext = false
    throw Error('synthetic failure')
  }
  const result = url.endsWith('/artifact') ? await pool.saveArtifact(body) : await pool.sync(body)
  return Response.json(result, { status: result.ok ? 200 : result.conflict ? 409 : 400 })
} })
assert.ok(isDeepSeekDocument('https://chat.deepseek.com/a/chat/s/test'))
for (const url of ['http://chat.deepseek.com/', 'https://chat.deepseek.com.example.invalid/', 'https://u:p@chat.deepseek.com/', 'about:blank']) {
  assert.equal(isDeepSeekDocument(url), false)
}

const child = spawn(edge, ['--headless=new', '--disable-gpu', '--disable-background-networking',
  '--remote-debugging-port=0', '--user-data-dir=' + dir, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
let socket
const pending = new Map()
const handlers = new Map()
let id = 0
function send(method, params = {}) {
  const call = ++id
  socket.send(JSON.stringify({ id: call, method, params }))
  return new Promise((resolve, reject) => pending.set(call, { resolve, reject }))
}
async function until(action) {
  for (let i = 0; i < 80; i++) {
    const value = await action()
    if (value) return value
    await delay(50)
  }
  throw Error('Timed out awaiting browser fixture condition')
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
const watchdog = setTimeout(() => { console.error('Browser fixture exceeded 25 seconds'); socket?.close(); child.kill(); process.exit(1) }, 25000)

try {
  const port = await until(() => {
    try { return readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch {}
  })
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const call = pending.get(message.id)
    if (call) {
      pending.delete(message.id)
      if (message.error) call.reject(Error(message.error.message))
      else call.resolve(message.result)
    }
    handlers.get(message.method)?.(message.params).catch(error => {
      console.error(error)
      socket.close()
    })
  })
  handlers.set('Fetch.requestPaused', ({ requestId, request }) => send('Fetch.fulfillRequest', {
    requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html' }],
    body: Buffer.from(request.url.endsWith('/fixture') ?
      '<!doctype html><style>body{font:16px Arial}.ds-markdown{width:max-content}</style>' +
      '<div data-message-role="user">User paragraph</div>' +
      '<div class="ds-message" data-message-role="assistant"><div class="ds-markdown"><p>First paragraph</p><p>Second paragraph</p></div></div>' +
      '<input value="Ignore this field">' : '').toString('base64'),
  }))
  handlers.set('Runtime.bindingCalled', async ({ payload }) => {
    const { index, message } = JSON.parse(payload)
    calls.push(message)
    const result = await bridge(message)
    await evaluate('window.__fixtureReplies.get(' + index + ')(' + JSON.stringify(result) + ')')
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Runtime.addBinding', { name: '__fixtureSend' })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  const preload = await buildGuestPreload(new URL('../../', import.meta.url))
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__fixtureReplies = new Map();
    (() => {
      let index = 0;
      const process = {isMainFrame: window === window.top};
      const require = () => ({
        contextBridge: {executeInMainWorld: ({func}) => func()},
        ipcRenderer: {invoke: (_channel,message) => new Promise(resolve => {
          window.__fixtureReplies.set(++index,resolve);
          window.__fixtureSend(JSON.stringify({index,message}));
        })},
      });
      ${preload}
    })();
  ` })
  await send('Page.navigate', { url: 'https://chat.deepseek.com/fixture' })
  await until(() => calls.some(m => m.kind === 'get-settings'))

  async function select(selector) {
    return evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      const rect = range.getBoundingClientRect();
      return { content:window.getSelection().toString(), x:Math.ceil(rect.right)+15, y:Math.ceil(rect.top)+10 };
    })()`)
  }
  async function click({ x, y }) {
    await send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', buttons:1, clickCount:1, x, y })
    await send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', buttons:0, clickCount:1, x, y })
  }
  const shown = ({ x, y }) => evaluate(`!!document.elementFromPoint(${x},${y})?.style?.left`)
  const answer = await select('.ds-markdown')
  assert.equal(answer.content, 'First paragraph\n\nSecond paragraph')
  await until(() => shown(answer))
  await click(answer)
  await until(() => calls.some(m => m.kind === 'selection-save'))
  await delay(140)
  assert.equal(pool.pool().shared_pool.length, 0)
  await click(answer)
  await until(() => pool.pool().shared_pool.length)
  const selections = calls.filter(m => m.kind === 'selection-save')
  assert.equal(selections.length, 2)
  assert.equal(selections[0].requestId, selections[1].requestId)
  assert.equal(pool.pool().shared_pool[0].content, answer.content)
  assert.equal(pool.pool().shared_pool[0].injectionPolicy, 'manual')
  console.log('PASS trusted selection click, write failure retry, paragraph fidelity and manual policy')

  const user = await select('[data-message-role="user"]')
  await until(() => shown(user))
  await click(user)
  await until(() => pool.pool().shared_pool.length === 2)
  assert.ok(createPool({ dir: pool.dir }).pool().shared_pool.some(m => m.content === 'User paragraph'))
  console.log('PASS user message can be selected and persisted')

  await evaluate(`window.dispatchEvent(new CustomEvent('ecolink:page', {detail: JSON.stringify({
    type:'harvest', session_id:'fixture-session', memories:[{key:'fixture-short',content:'Synthetic short memory'}]
  })}))`)
  await until(() => calls.some(m => m.kind === 'harvest'))
  await until(() => pool.pool().session_pools['fixture-session']?.memories.some(m => m.key === 'fixture-short') ||
    pool.pool().shared_pool.some(m => m.key === 'fixture-short'))
  console.log('PASS short-memory handoff coexists with excerpt saving')

  async function findNode(match) {
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true })
    function find(node) {
      if (match(node)) return node
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const result = find(child)
        if (result) return result
      }
    }
    return find(root)
  }
  async function clickText(label) {
    const node = await until(() => findNode(node => node.nodeName === 'BUTTON' && node.children?.[0]?.nodeValue === label))
    await send('DOM.scrollIntoViewIfNeeded', { nodeId: node.nodeId })
    const { model: { content } } = await send('DOM.getBoxModel', { nodeId: node.nodeId })
    await click({ x: (content[0]+content[4])/2, y: (content[1]+content[5])/2 })
  }
  await clickText('保存完整成果')
  const nameField = await until(() => findNode(node => node.nodeName === 'INPUT' && node.attributes?.some(v => v.includes('成果名称'))))
  const { object } = await send('DOM.resolveNode', { nodeId: nameField.nodeId })
  await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function () {
    this.value = 'Fixture full artifact'; this.dispatchEvent(new Event('input', {bubbles:true}));
  }` })
  await clickText('确认保存全文')
  await until(() => calls.some(m => m.kind === 'artifact-save')).catch(async error => {
    const status = await findNode(node => node.nodeName === '#text' && /已从所选|保存失败|页面正文尚不可/.test(node.nodeValue))
    throw Error(status?.nodeValue || error.message)
  })
  await until(() => pool.pool().shared_pool.some(m => m.key === 'Fixture full artifact' && m.content.includes('Second paragraph')));
  console.log('PASS full-artifact button saved the visible answer through the desktop bridge')
} finally {
  clearTimeout(watchdog)
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: ++id, method:'Browser.close' }))
    socket.close()
  }
  child.kill()
}
