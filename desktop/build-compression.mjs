import { readFile } from 'node:fs/promises'

function section(source, start, end) {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first + start.length)
  if (first < 0 || last < 0) throw new Error('Ecolink browser source changed: ' + start)
  return source.slice(first, last)
}

// Package the extension's actual handlers. Chrome continues loading its own files.
export async function buildCompressionBackground(root) {
  const read = name => readFile(new URL('extension/' + name, root), 'utf8')
  const [background, config, queue] = await Promise.all([
    read('background.js'), read('core/config.mjs'), read('core/queue.mjs'),
  ])
  return [
    config, queue,
    "export function createCompression({ storage, fetch, getConfig, getQueue, getPool }) {",
    'const chrome = { storage: { local: storage } }; const blog = () => {};',
    section(background, 'const COMPRESS_KEY', 'const POOL_TTL_MS'),
    section(background, 'const COMPRESS_INSTRUCTION_BG', 'async function getConfig()'),
    'return { getCompressState, async handle(msg) { let result; const sendResponse = value => { result = value };',
    'await (async () => { switch (msg.kind) {',
    section(background, "case 'compress-start':", "case 'touch':"),
    section(background, "case 'harvest':", "case 'artifact-save':"),
    '} })(); return result; } }; }',
  ].join('\n')
}

export async function buildCompressionControls(root) {
  const read = name => readFile(new URL('extension/' + name, root), 'utf8')
  const [popup, html, panel] = await Promise.all([read('popup.js'), read('popup.html'), read('panel.js')])
  const sectionStart = '<section>\n    <h2>压缩过时记忆</h2>'
  const markup = section(html.replace(/\r\n/g, '\n'), sectionStart, '</section>') + '</section>'
  const handlers = section(popup, 'async function refreshCompress()', '\nrefreshStatus()')
    .replace('const okConfirm = confirm(', 'const okConfirm = await confirm(')
  return panel
    .replace(/\r\n/g, '\n')
    .replace("document.createElement('div')\n    toggle.className", "document.createElement('button')\n    toggle.className")
    .replace("toggle.textContent = '忆'", "toggle.textContent = '记忆池'\n    toggle.type = 'button'\n    toggle.setAttribute('aria-expanded', 'false')")
    .replace("    root.appendChild(panel)", `
    panel.insertAdjacentHTML('afterbegin', ${JSON.stringify(markup)})
    root.appendChild(panel)
    style.textContent += \`
      :host-context(.dark), :host-context([data-theme="dark"]) { --ecolink-scheme: dark; }
      :host-context(.light), :host-context([data-theme="light"]) { --ecolink-scheme: light; }
      .btn { position: absolute; right: 0; bottom: 0; white-space: nowrap;
             width: auto; height: 32px; padding: 0 12px; border-radius: 8px;
             border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
             color-scheme: var(--ecolink-scheme, light dark); color: CanvasText; font: 500 13px system-ui, sans-serif;
             background: color-mix(in srgb, Canvas 72%, transparent);
             box-shadow: 0 3px 12px #0002; backdrop-filter: blur(10px); }
      .btn:hover { background: color-mix(in srgb, Canvas 85%, transparent); }
      .btn:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
      .panel { color-scheme: var(--ecolink-scheme, light dark); --p-bg: Canvas; --p-fg: CanvasText;
               width: min(380px, calc(100vw - 32px)); max-height: min(510px, calc(100vh - 116px)); }
      .panel section { padding: 10px; border-bottom: 1px solid #8885; }
      .panel h2 { margin: 0 0 6px; font-size: 13px; }
      .panel .row { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0; }
      .panel button, dialog button { color: inherit; font: inherit; padding: 4px 8px;
                        border: 1px solid #8886; border-radius: 6px; background: transparent; cursor: pointer; }
      .panel button:disabled { opacity: .45; cursor: default; }
      .panel .hint { min-height: 1em; opacity: .82; }
      .item .content { white-space: pre-wrap; overflow-wrap: anywhere; }
      dialog { color-scheme: var(--ecolink-scheme, light dark); color: CanvasText; background: Canvas; padding: 16px;
               border: 1px solid #8886; border-radius: 10px; width: min(320px, calc(100vw - 64px)); }
      dialog p { white-space: pre-wrap; margin: 0 0 12px; }
    \`
    const $ = id => root.getElementById(id)
    const loadConfig = () => chrome.runtime.sendMessage({ kind: 'compress-config' })
    const bridgeFetch = async (path, init) => {
      const reply = await chrome.runtime.sendMessage({
        kind: 'compress-api', operation: path.slice('/memory/'.length),
        days: init.body && JSON.parse(init.body).days,
      })
      return { status: reply.status, json: async () => reply.body ?? reply }
    }
    async function refreshStatus() {
      const reply = await chrome.runtime.sendMessage({ kind: 'panel-pool' })
      pool = reply.pool ?? null
      if (open) render()
    }
    function confirm(question) {
      const dialog = document.createElement('dialog')
      dialog.innerHTML = '<p></p><form method="dialog"><button value="yes">确认</button> <button value="no">取消</button></form>'
      dialog.querySelector('p').textContent = question
      root.appendChild(dialog)
      dialog.showModal()
      return new Promise(resolve => {
        dialog.onclose = () => { dialog.remove(); resolve(dialog.returnValue === 'yes') }
      })
    }
    ${handlers}
    for (const id of ['compressStart', 'compressFinish', 'compressApi']) {
      const button = $(id)
      const click = button.onclick
      button.onclick = event => { if (event.isTrusted) return click() }
    }
    chrome.storage.onChanged.addListener(changes => {
      if (!open) return
      refreshStatus()
      if (changes.ecolink_progress) refreshCompress()
    })
    `)
    .replace("      if (open) {\n        try", "      toggle.setAttribute('aria-expanded', String(open))\n      if (open) {\n        refreshStatus()\n        refreshCompress()\n        try")
    .replace("        if (d.pool && typeof d.pool === 'object') pool = d.pool\n", '')
    .replace('暂无池数据(等服务推送或点扩展刷新)', '暂未读取到记忆池，关闭并重新打开可重试')
    .replace('dsh-ecolink 记忆面板(只读)', '查看记忆池')
    .replace("    function applyVisibility() {", "    host.style.display = 'none'\n    function applyVisibility() {")
}
