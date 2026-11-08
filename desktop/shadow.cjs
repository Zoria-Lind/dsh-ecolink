function installEcolinkShadow({ userSelector, markdownSelector, reasoning, pageArtifactMarkdown }) {
  const send = (action, args = {}) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const timeout = setTimeout(() => { requests.delete(id); reject(new Error('Harness 响应超时，可重试')) }, 30000)
    requests.set(id, result => {
      clearTimeout(timeout)
      if (result.error) reject(new Error(result.error))
      else resolve(result)
    })
    ipcRenderer.sendToHost('ecolink-shadow', { action, id, ...args })
  })
  const requests = new Map()
  ipcRenderer.on('ecolink-shadow-result', (_event, { id, result }) => {
    requests.get(id)?.(result)
    requests.delete(id)
  })
  const element = (tag, text) => {
    const node = document.createElement(tag)
    if (text) node.textContent = text
    return node
  }
  const button = (text, click) => {
    const node = element('button', text)
    node.type = 'button'
    node.onclick = event => {
      if (event.isTrusted) click()
    }
    return node
  }
  const host = element('div')
  host.style.cssText = 'position:fixed;top:10px;right:52px;z-index:10000'
  host.dataset.ecolinkShadow = ''
  const root = host.attachShadow({ mode: 'closed' })
  const style = element('style')
  style.textContent = [
    ':host{font:13px/1.5 system-ui;color-scheme:light dark;color:CanvasText}',
    '.bar,footer{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
    'button,select,textarea{font:inherit;color:inherit;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;background:color-mix(in srgb,Canvas 68%,transparent);padding:5px 9px}',
    'button{cursor:pointer;backdrop-filter:blur(10px)}button:hover{background:color-mix(in srgb,Canvas 90%,currentColor)}button:disabled{opacity:.5;cursor:default}',
    '[hidden]{display:none!important}',
    'section{position:absolute;top:100%;right:0;margin:8px 0 0;width:min(480px,calc(100vw - 70px));max-height:72vh;overflow:auto;background:color-mix(in srgb,Canvas 93%,transparent);backdrop-filter:blur(18px);border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px;padding:12px;box-shadow:0 12px 42px #0004}',
    '.handoff{border-top:1px solid color-mix(in srgb,currentColor 18%,transparent);margin-top:10px;padding-top:4px}textarea{display:block;box-sizing:border-box;width:100%;min-height:64px;margin:8px 0}p{margin:6px 0}'
  ].join('')
  const bar = element('div'); bar.className = 'bar'
  const panel = element('section'); panel.hidden = true
  const info = element('p'); info.setAttribute('role', 'status')
  const projects = element('select'); projects.setAttribute('aria-label', 'DSH 项目')
  const task = element('textarea'); task.placeholder = '要交给 DSH 的任务'
  const context = element('textarea'); context.placeholder = '附带网页参考内容（可选）'
  const bind = button('绑定此会话', () => perform(async () => {
    await bindSession(webId, projects.value)
    await refresh()
  }))
  const start = button('新建影子会话', () => perform(async () => {
    if (!projects.value) throw new Error('请先选择 DSH 项目')
    await send('set-pending', { workspaceId: projects.value })
    location.assign('/')
  }))
  const normal = button('新建普通会话', () => perform(async () => {
    await send('set-pending', { workspaceId: null })
    location.assign('/')
  }))
  const attach = button('附上最近一轮网页问答', () => {
    const latest = pageRows().at(-1)
    if (!latest) { info.textContent = '当前网页还没有完整问答'; return }
    context.value = '网页问题\n' + latest.question + '\n\n网页回答\n' + latest.answer
  })
  const handoff = button('确认交办', () => perform(async () => {
    if (!task.value.trim()) throw new Error('请填写要交办的任务')
    const value = JSON.stringify([webId, task.value, context.value])
    if (handoffRequest?.value !== value) handoffRequest = { value, id: crypto.randomUUID() }
    await send('handoff', { webId, task: task.value, context: context.value, requestId: handoffRequest.id })
    handoffRequest = null
    task.value = ''
    context.value = ''
    setHandoffOpen(false)
    await refresh()
    info.textContent = '任务已交给绑定的 DSH 会话。完成后会自动显示在网页对话中。'
  }))
  const push = button('同步到 Harness', () => perform(async () => {
    const id = webId
    await syncToHarness(id)
    await send('open', { webId: id })
  }))
  const toggle = button('影子会话', () => {
    setPanelOpen(panel.hidden)
    if (!panel.hidden) perform(async () => {
      const { projects: items } = await send('projects')
      projects.replaceChildren(...items.map(({ id, title }) => {
        const option = element('option', title || id); option.value = id; return option
      }))
      if (pending) projects.value = pending
      await refresh()
    })
  })
  const projectActions = element('footer'); projectActions.append(projects, start, normal, bind)
  const form = element('div'); form.className = 'handoff'
  const formActions = element('footer'); formActions.append(attach, handoff)
  form.append(task, context, formActions)
  const handoffToggle = button('交办给 DSH', () => {
    setHandoffOpen(form.hidden)
    if (!form.hidden) task.focus()
  })
  function setHandoffOpen(open) {
    form.hidden = !open
    handoffToggle.setAttribute('aria-expanded', String(open))
  }
  function setPanelOpen(open) {
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (!open) setHandoffOpen(false)
  }
  bar.append(toggle)
  const syncActions = element('footer'); syncActions.append(push)
  const handoffActions = element('footer'); handoffActions.append(handoffToggle)
  handoffActions.style.marginTop = '8px'
  panel.append(info, syncActions, projectActions, handoffActions, form)
  root.append(style, bar, panel)
  setPanelOpen(false)
  document.addEventListener('pointerdown', event => {
    if (!panel.hidden && !event.composedPath().includes(host)) setPanelOpen(false)
  }, true)

  let webId, pending, state, handoffRequest, refreshing, operating = false, lastSignature, completedId
  let transcript, displayedThrough
  const pathId = path => /^\/(?:a\/chat\/s|chat)\/([a-zA-Z0-9_-]{8,128})\/?$/.exec(path)?.[1]
  const currentId = () => pathId(location.pathname)
  window.addEventListener('ecolink:artifact-stream', event => {
    if (!pending || state?.binding?.ready) return
    const { sessionId, pagePath } = JSON.parse(event.detail)
    if (pagePath === '/' && typeof sessionId === 'string') completedId = sessionId
  })
  async function bindSession(id, workspaceId) {
    const result = await send('bind', { webId: id, workspaceId })
    if (pending) {
      await send('set-pending', { workspaceId: null })
      pending = null
    }
    return result
  }
  function pageRows(anchors) {
    const rows = []
    let question = '', answers = [], lastAnswer
    function finish() {
      if (!question || !answers.length) return
      rows.push({ question, answer: answers.join('\n\n') })
      if (anchors) {
        anchors.foreground = lastAnswer
        anchors.answers.push(lastAnswer.closest('.ds-message,[data-message-role="assistant"]') ?? lastAnswer)
      }
    }
    for (const node of document.querySelectorAll(userSelector + ',' + markdownSelector)) {
      if (node.matches(userSelector)) {
        if (node.parentElement?.closest(userSelector)) continue
        finish()
        if (anchors) {
          anchors.firstQuestion ??= node.closest('.ds-message') ?? node
          anchors.questionText = node.querySelector('.ds-collapsible-text') ?? node
        }
        question = stripInjectedBlock(node.innerText ?? node.textContent)
        answers = []
      } else if (question && !node.closest(userSelector) && !node.parentElement?.closest(markdownSelector) && !reasoning(node)) {
        const value = pageArtifactMarkdown(node)
        if (value.trim()) {
          answers.push(value)
          lastAnswer = node
        }
      }
    }
    const generating = document.querySelector('[aria-label="停止生成"],[aria-label="Stop generating"],[data-testid="stop-generating"],.ds-markdown--typing,.ds-markdown--streaming')
    if (!generating) finish()
    return rows
  }
  function buildTranscript(rows) {
    for (const group of transcript ?? []) group.host.remove()
    const groups = new Map()
    for (const { question, answer, afterWeb, tools = [] } of rows) {
      const key = JSON.stringify(afterWeb)
      if (!groups.has(key)) groups.set(key, { afterWeb, turns: [] })
      const text = answer.replace(/<DSM:memory_write(?:\s[^>]*)?>[\s\S]*?<\/DSM:memory_write>/gi, '').trim()
      groups.get(key).turns.push({ question, answer: text, tools })
    }
    return [...groups.values()].map(({ afterWeb, turns }) => {
      const host = element('div')
      host.dataset.ecolinkTranscript = ''
      const root = host.attachShadow({ mode: 'closed' })
      const style = element('style')
      style.textContent = ':host{display:block;max-width:800px;margin:16px auto;padding:0 12px;color-scheme:light dark;color:CanvasText}' +
        'article{display:grid;gap:10px;margin:14px 0}header,button,small{font:12px/1.5 system-ui;color:inherit}' +
        'header,small{opacity:.72}' +
        '.question{font:var(--ecolink-question-font,inherit);justify-self:end;max-width:82%;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 14px;border-radius:14px;background:color-mix(in srgb,currentColor 8%,transparent)}' +
        '.answer{font:var(--ecolink-answer-font,inherit);min-width:0;overflow-wrap:anywhere;border-inline-start:2px solid color-mix(in srgb,currentColor 18%,transparent);padding-inline-start:12px}' +
        '.answer>:first-child{margin-block-start:0}.answer>:last-child{margin-block-end:0}.answer a{color:inherit;text-underline-offset:.18em}' +
        '.answer blockquote{margin-inline:0;padding-inline-start:12px;border-inline-start:2px solid color-mix(in srgb,currentColor 22%,transparent)}' +
        'pre,code{font-size:.9em;background:color-mix(in srgb,currentColor 7%,transparent);border-radius:5px}code{padding:.1em .25em}pre{padding:10px;overflow:auto}pre code{font-size:inherit;background:none;padding:0}' +
        'table{display:block;overflow:auto;border-collapse:collapse}th,td{padding:5px 9px;border:1px solid color-mix(in srgb,currentColor 18%,transparent)}th{background:color-mix(in srgb,currentColor 7%,transparent)}' +
        'details{min-width:0;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:8px;font:12px/1.5 system-ui}summary{cursor:pointer;padding:5px 9px;overflow-wrap:anywhere}summary:hover{background:color-mix(in srgb,currentColor 5%,transparent)}details pre{margin:0 8px 8px}' +
        'button{cursor:pointer;background:transparent;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:8px;padding:5px 9px}button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}'
      root.append(style, element('header', '来自 DeepSeek Harness'))
      for (const { question, answer, tools } of turns) {
        const article = element('article')
        const user = element('p', question); user.className = 'question'
        article.append(user)
        for (const { name, args } of tools) {
          const call = element('details')
          call.append(element('summary', '工具调用 · ' + name), element('pre', args || '无参数'))
          article.append(call)
        }
        if (answer) {
          const reply = element('div'); reply.className = 'answer'
          try { reply.innerHTML = shadowMarkdown.parse(answer) } catch { reply.textContent = answer; reply.style.whiteSpace = 'pre-wrap' }
          article.append(reply)
        }
        root.append(article)
      }
      const draftTurns = turns.filter(({ answer }) => answer)
      if (!draftTurns.length) return { host, afterWeb }
      const status = element('small'); status.setAttribute('role', 'status')
      root.append(button('带入网页草稿', () => {
        const composer = document.querySelector('textarea#chat-input,textarea[placeholder*="DeepSeek"],textarea[placeholder*="Message"]')
        if (!composer) { status.textContent = ' 找不到网页输入框'; return }
        const text = draftTurns.map(({ question, answer }) => 'DSH 问题\n' + question + '\n\nDSH 回答\n' + answer).join('\n\n')
        const old = composer.value
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, old ? old + '\n\n' + text : text)
        composer.dispatchEvent(new Event('input', { bubbles: true }))
        composer.focus()
        status.textContent = ' 已加入草稿，发送后网页模型可接着聊'
      }), status)
      return { host, afterWeb }
    })
  }
  function nativeFont(node) {
    if (!node) return ''
    const { fontWeight, fontSize, lineHeight, fontFamily } = getComputedStyle(node)
    return fontWeight + ' ' + fontSize + '/' + lineHeight + ' ' + fontFamily
  }
  function placeTranscript(anchors) {
    const questionFont = nativeFont(anchors.questionText)
    const answerFont = nativeFont(anchors.foreground?.querySelector('p') ?? anchors.foreground)
    const color = anchors.foreground ? getComputedStyle(anchors.foreground).color : ''
    for (const { host, afterWeb } of transcript ?? []) {
      host.style.color = color
      host.style.setProperty('--ecolink-question-font', questionFont)
      host.style.setProperty('--ecolink-answer-font', answerFont)
      if (!afterWeb) {
        if (!anchors.firstQuestion) host.remove()
        else if (anchors.firstQuestion.previousSibling !== host) anchors.firstQuestion.before(host)
        continue
      }
      const anchor = refresh.hashes[afterWeb.index] === afterWeb.hash && anchors.answers[afterWeb.index]
      if (!anchor) host.remove()
      else if (anchor.nextSibling !== host) anchor.after(host)
    }
  }
  async function perform(work) {
    if (operating) return
    operating = true
    try { await work() } catch (error) {
      info.textContent = error.message
    } finally { operating = false }
  }
  function refresh() {
    refreshing ??= inspect().finally(() => { refreshing = undefined })
    return refreshing
  }
  async function inspect() {
    const id = currentId()
    if (id !== webId) {
      webId = id
      state = null
      lastSignature = undefined
      for (const group of transcript ?? []) group.host.remove()
      transcript = displayedThrough = undefined
      task.value = ''
      context.value = ''
      handoffRequest = null
      setHandoffOpen(false)
    }
    const anchors = { answers: [] }
    const rows = id ? pageRows(anchors) : []
    const signature = JSON.stringify(rows)
    if (signature !== lastSignature) {
      lastSignature = signature
      refresh.hashes = await Promise.all(rows.map(async ({ question, answer }) => {
        const bytes = new TextEncoder().encode(JSON.stringify([question, answer]))
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
      }))
    }
    let result = await send('inspect', { webId: id, hashes: refresh.hashes })
    if (id !== currentId()) return
    pending = result.pending
    state = result.state
    if (pending && id && id === completedId && rows.length && !state?.binding?.ready && !operating) {
      await bindSession(id, pending)
      if (id !== currentId()) return
      result = await send('inspect', { webId: id, hashes: refresh.hashes })
      if (id !== currentId()) return
      state = result.state
    }
    markSidebar(new Set(result.webIds))
    const ready = state?.binding?.ready
    if (ready && state.consistent && anchors.firstQuestion) {
      const includeNew = state.outgoing > 0
      let latest
      if (!transcript || includeNew) {
        const { rows: returned } = await send('returns', { webId: id, includeNew })
        if (id !== currentId()) return
        latest = returned.at(-1)?.seq
        if (!transcript || latest !== displayedThrough) {
          transcript = buildTranscript(returned)
          displayedThrough = latest
        }
      }
      placeTranscript(anchors)
      if (includeNew && latest !== undefined && transcript.every(({ host }) => host.isConnected)) {
        await send('ack', { webId: id, seq: latest })
        if (id !== currentId()) return
      }
    } else {
      for (const { host } of transcript ?? []) host.remove()
    }
    handoffToggle.hidden = !ready
    push.hidden = !ready || !state.incoming
    push.disabled = !!state?.busy
    bind.hidden = !id || ready
    if (!ready) setHandoffOpen(false)
    toggle.textContent = ready ? '影子会话 · 已绑定' : pending ? '影子会话 · 待绑定' : '影子会话'
    const next = ready
      ? state.consistent ? state.incoming ? '有 ' + state.incoming + ' 轮网页问答待同步。' : '已绑定。当前没有待同步的完整网页问答。' : '已同步历史与当前页面不一致，请加载原对话及分支。'
      : pending ? '已选定 DSH 项目。首轮完成后自动绑定，也可手动绑定。' : '选一个 DSH 项目，可新建影子会话或绑定当前对话。'
    if (info.dataset.state !== next) info.textContent = info.dataset.state = next
  }
  async function syncToHarness(id) {
    if (id !== currentId()) throw new Error('网页已切换，请重新打开绑定的对话')
    const result = await send('sync', { webId: id, rows: pageRows() })
    await refresh()
    return result
  }
  ipcRenderer.on('ecolink-shadow-sync', async (_event, id) => {
    try {
      const result = await syncToHarness(id)
      ipcRenderer.sendToHost('ecolink-shadow-sync-done', { imported: result.imported })
    } catch (error) { ipcRenderer.sendToHost('ecolink-shadow-sync-done', { error: error.message }) }
  })
  function markSidebar(ids) {
    for (const row of document.querySelectorAll('a[href*="/chat/"]')) {
      row.toggleAttribute('data-ecolink-shadow-session', row.origin === location.origin && ids.has(pathId(row.pathname)))
    }
  }
  const launch = () => {
    document.head.append(element('style', 'a[data-ecolink-shadow-session]::after{content:"⇄" / "影子会话";font-size:.85em;opacity:.75;margin-inline-start:auto;padding-inline-start:.45em;flex:none;pointer-events:none}'))
    document.body.append(host)
    handoffToggle.hidden = push.hidden = true
    const check = () => refresh().catch(error => {
      if (!panel.hidden) info.textContent = error.message
    })
    void check()
    setInterval(check, 2200)
  }
  if (document.body) launch()
  else document.addEventListener('DOMContentLoaded', launch, { once: true })
}

