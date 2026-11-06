import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session } from 'electron'

const root = process.env.ECO04B_FIXTURE
if (!root) throw new Error('Isolated fixture directory is required')
const restartPhase = process.env.ECO04B_RESTART_PHASE
if (restartPhase && !['write', 'read'].includes(restartPhase)) throw new Error('Invalid restart test phase')
const accountMode = process.env.ECO04B_ACCOUNT_MODE
if (accountMode && (restartPhase || !['smoke', 'interactive'].includes(accountMode))) throw new Error('Invalid account test mode')
const profile = accountMode ? 'fixture-account-' + accountMode : restartPhase ? 'fixture-restart-profile' : 'fixture-profile'
app.setPath('userData', join(root, profile))
if (accountMode && !app.requestSingleInstanceLock()) app.exit(1)
const bundle = join(root, 'app.asar', 'lib')
const candidate = join(root, 'candidate')
const { createMemoryBridge, isDeepSeekDocument, ECOLINK_CHANNEL } = await import(pathToFileURL(join(bundle, 'ecolink-memory.mjs')))
const { createPool } = await import(pathToFileURL(join(candidate, 'service', 'pool.mjs')))
const main = readFileSync(join(bundle, 'main.js'), 'utf8')
const guestFile = join(bundle, 'ecolink-guest.cjs')
const leaseClass = main.slice(main.indexOf('var DesktopBrowserGuests = class'), main.indexOf('//#endregion\n//#region ../../packages/client/shortcuts/lib/protocol.js'))
assert.ok(leaseClass.includes('configureSession(browserSession)'))
const createGuestManager = new Function('session', 'app', 'randomUUID', 'isDeepSeekDocument', 'guestFile', 'DESKTOP_IPC',
  leaseClass.replace('fileURLToPath(new URL("./ecolink-guest.cjs", import.meta.url))', 'guestFile') +
  '\nreturn new DesktopBrowserGuests(() => undefined)')
const guests = createGuestManager(session, app, randomUUID, isDeepSeekDocument, guestFile, {})
const pool = accountMode ? undefined : createPool({ dir: join(root, 'fixture-memory') })
const lines = []
let failNext = false
const bridge = createMemoryBridge({ port: 21286, token: 'fixture-only', fetcher: async (url, options) => {
  assert.equal(options.headers['X-Ecolink-Token'], 'fixture-only')
  const body = JSON.parse(options.body)
  if (failNext) {
    failNext = false
    throw new Error('fixture write failure')
  }
  const result = url.endsWith('/artifact') ? await pool.saveArtifact(body) : await pool.sync(body)
  return Response.json(result, { status: result.ok ? 200 : 400 })
} })
const calls = []
ipcMain.handle(ECOLINK_CHANNEL, async (event, message) => {
  assert.ok(guests.isEcolinkGuest(event.sender))
  assert.equal(event.senderFrame, event.sender.mainFrame)
  assert.ok(isDeepSeekDocument(event.senderFrame.url))
  if (accountMode) {
    if (message?.kind === 'get-settings') return {
      ok: true, settings: { contentInjectionEnabled: false, panelEnabled: false, harvestEnabled: false },
    }
    return { ok: false, error: 'Memory writes are disabled in the account test' }
  }
  calls.push(message)
  return bridge(message)
})

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    const value = await fn()
    if (value) return value
    await wait(60)
  }
  throw new Error('Fixture condition timed out')
}
async function run() {
  await app.whenReady()
  const window = new BrowserWindow({
    show: accountMode === 'interactive', title: 'Ecolink | DeepSeek sign-in restart test', width: 1100, height: 760,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true } })
  guests.bind(window, () => () => {})
  const hostDocument = accountMode
    ? '<!doctype html><title>Ecolink | DeepSeek sign-in restart test</title><style>html,body{height:100%;margin:0}</style>'
    : '<main id="harness">Harness conversation</main>'
  await window.loadURL('data:text/html,' + encodeURIComponent(hostDocument))
  const { lease, partition } = guests.acquire(window.webContents, 'ecolink:deepseek', true)
  assert.equal(partition, 'persist:dsh-ecolink-chat')
  const guestSession = session.fromPartition(partition)
  const answer = '<!doctype html><style>body{font:16px Arial}.ds-markdown{width:max-content}</style>' +
    '<div data-message-role="user">User paragraph</div>' +
    '<div class="ds-message" data-message-role="assistant"><div class="ds-markdown"><p>First paragraph</p><p>Second paragraph</p></div></div>'
  if (!accountMode) guestSession.protocol.handle('https', request => {
    if (request.url === 'https://chat.deepseek.com/') {
      return new Response(answer, { headers: { 'content-type': 'text/html' } })
    }
    return new Response('', { status: 404 })
  })
  let attached
  window.webContents.once('did-attach-webview', (_event, guest) => { attached = guest })
  await window.webContents.executeJavaScript(`
    const guest = document.createElement('webview');
    guest.name = ${JSON.stringify(lease)};
    guest.partition = ${JSON.stringify(partition)};
    guest.src = ${JSON.stringify('about:blank#' + lease)};
    guest.style = 'display:flex;width:800px;height:470px';
    if (${Boolean(accountMode)}) guest.style = 'display:flex;width:100vw;height:100vh';
    guest.addEventListener('dom-ready', () => guest.loadURL('https://chat.deepseek.com/').catch(() => {}), {once:true});
    document.body.append(guest);
  `)
  const guest = await until(() => attached)
  if (accountMode === 'interactive') {
    await new Promise(resolve => window.once('closed', resolve))
    return
  }
  if (accountMode === 'smoke') {
    const loaded = await until(async () => {
      if (!isDeepSeekDocument(guest.getURL())) return false
      return guest.executeJavaScript(`document.querySelector('input[type="password"],input[type="email"],input[type="tel"]') !== null`)
    }, 200)
    assert.equal(loaded, true)
    lines.push('The official DeepSeek login form rendered in the isolated native guest')
    await guests.release(window.webContents, lease)
    window.destroy()
    return
  }
  guest.on('preload-error', (_event, _file, error) => lines.push(error.stack))
  await until(async () => guest.getURL() === 'https://chat.deepseek.com/' && await guest.executeJavaScript('!!document.querySelector(".ds-markdown")'))
  assert.ok(guests.isEcolinkGuest(guest))
  assert.equal(await guest.executeJavaScript('typeof require'), 'undefined')
  await until(() => calls.find(m => m.kind === 'get-settings'))
  lines.push('Electron attached the owned sandboxed guest and executed the packaged preload')

  if (restartPhase) {
    const url = 'https://chat.deepseek.com/'
    const name = 'ecolink_fixture_login'
    const localKey = 'ecolink-fixture-login'
    const value = 'synthetic-session'
    const cookie = { url, name, value, httpOnly: true, secure: true, sameSite: 'lax' }
    if (restartPhase === 'write') {
      assert.deepEqual(await guestSession.cookies.get({ url, name }), [])
      await guestSession.cookies.set({ ...cookie, expirationDate: Date.now() / 1000 + 90 * 24 * 60 * 60 })
      await guestSession.cookies.set({ ...cookie, name: name + '_session' })
      await guest.executeJavaScript(`localStorage.setItem(${JSON.stringify(localKey)}, ${JSON.stringify(value)})`)
      lines.push('Stored synthetic persistent and temporary cookies and origin storage')
    } else {
      const cookies = await guestSession.cookies.get({ url, name })
      assert.equal(cookies.length, 1)
      assert.equal(cookies[0].value, value)
      assert.equal(cookies[0].httpOnly, true)
      assert.equal(cookies[0].secure, true)
      assert.ok(cookies[0].expirationDate > Date.now() / 1000 + 89 * 24 * 60 * 60)
      assert.deepEqual(await guestSession.cookies.get({ url, name: name + '_session' }), [])
      assert.equal(await guest.executeJavaScript(`localStorage.getItem(${JSON.stringify(localKey)})`), value)
      assert.deepEqual(await session.defaultSession.cookies.get({ url, name }), [])
      lines.push('Fresh process recovered persistent cookie and origin storage in the same partition')
      lines.push('Temporary cookie expired and cookie did not leak into the default session')
    }
    await guests.release(window.webContents, lease)
    window.destroy()
    return
  }

  const geometry = await guest.executeJavaScript(`(() => {
    const node = document.querySelector('.ds-markdown');
    const range = document.createRange();
    range.selectNodeContents(node);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const rect = range.getBoundingClientRect();
    return { content:window.getSelection().toString(), x:Math.ceil(rect.right)+15, y:Math.ceil(rect.top)+10 }
  })()`)
  assert.equal(geometry.content, 'First paragraph\n\nSecond paragraph')
  await until(() => guest.executeJavaScript(`!!document.elementFromPoint(${geometry.x},${geometry.y})?.style?.left`))
  guest.debugger.attach('1.3')
  const click = async () => {
    await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1,
      clickCount: 1, x: geometry.x, y: geometry.y })
    await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0,
      clickCount: 1, x: geometry.x, y: geometry.y })
  }
  failNext = true
  await click()
  await until(() => calls.find(m => m.kind === 'selection-save'))
  await wait(150)
  assert.equal(pool.pool().shared_pool.length, 0)
  await click()
  await until(() => pool.pool().shared_pool.length)
  const selections = calls.filter(m => m.kind === 'selection-save')
  assert.equal(selections.length, 2)
  assert.equal(selections[0].requestId, selections[1].requestId)
  assert.equal(pool.pool().shared_pool[0].content, geometry.content)
  assert.equal(pool.pool().shared_pool[0].injectionPolicy, 'manual')
  assert.equal(createPool({ dir: pool.dir }).pool().shared_pool[0].content, geometry.content)
  lines.push('Trusted click: paragraphs preserved, failure retry reused request ID, one manual entry persisted')

  await guest.executeJavaScript(`window.dispatchEvent(new CustomEvent('ecolink:page', {detail: JSON.stringify({
    type:'harvest', session_id:'fixture-session', memories:[{key:'fixture-short',content:'Synthetic short memory'}]
  })}))`)
  await until(() => calls.find(m => m.kind === 'harvest'))
  await until(() => pool.pool().session_pools['fixture-session']?.memories.find(m => m.key === 'fixture-short'))
  lines.push('Short tag handoff and selected excerpt use separate storage routes')

  const id = guest.id
  await window.webContents.executeJavaScript('document.querySelector("webview").hidden = true; true')
  await window.webContents.executeJavaScript('document.querySelector("webview").hidden = false; true')
  assert.equal(guest.id, id)
  assert.equal(guest.getURL(), 'https://chat.deepseek.com/')
  assert.ok(guests.isEcolinkGuest(guest))
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#harness").textContent'), 'Harness conversation')
  lines.push('Switching visibility preserves the same guest and host conversation')
  await guests.release(window.webContents, lease)
  window.destroy()
}
const logFile = join(root, accountMode ? 'electron-account-' + accountMode + '.log'
  : restartPhase ? 'electron-restart-' + restartPhase + '.log' : 'electron-fixture.log')
run().then(() => {
  writeFileSync(logFile, lines.join('\n') + '\nECO04B_ELECTRON_PASS\n')
  app.exit(0)
}).catch(error => {
  writeFileSync(logFile, lines.join('\n') + '\n' + error.stack + '\n')
  app.exit(1)
})
