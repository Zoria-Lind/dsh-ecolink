function installEcolinkSelection(isAnswer, send) {
  const host = document.createElement('div')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = [
    ':host{position:fixed;z-index:2147483646;pointer-events:none}',
    'button{pointer-events:auto;white-space:nowrap;cursor:pointer;padding:4px 9px;border-radius:7px;',
    'border:1px solid rgba(42,57,80,.18);background:rgba(250,252,255,.75);color:#253451;',
    'font:12px/18px system-ui;backdrop-filter:blur(12px);box-shadow:0 2px 8px rgba(27,41,62,.10)}',
    'button:hover,button:focus-visible{background:rgba(250,252,255,.96)}',
    'button:focus-visible{outline:2px solid #547be3;outline-offset:2px}',
    'button:disabled{cursor:default}',
    '@media(prefers-color-scheme:dark){button{color:#edf2ff;background:rgba(30,38,52,.78);',
    'border-color:rgba(218,230,255,.18)}button:hover,button:focus-visible{background:rgba(30,38,52,.96)}}',
  ].join('')
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-live', 'polite')
  shadow.append(style, button)
  let active, dismissed, frame, timer
  let dragging = false

  function hide() {
    clearTimeout(timer)
    host.remove()
    active = undefined
  }

  function update() {
    if (dragging) return
    const selection = window.getSelection()
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      dismissed = undefined
      hide()
      return
    }
    const range = selection.getRangeAt(0)
    const answer = isAnswer(range.startContainer, range.endContainer)
    const content = selection.toString()
    if (!answer || !content.trim()) return hide()
    if (dismissed?.content === content && dismissed.answer === answer) return
    const rect = range.getBoundingClientRect()
    if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return hide()
    if (active?.content !== content || active.answer !== answer) {
      clearTimeout(timer)
      active = { answer, content, requestId: crypto.randomUUID(), busy: false }
      button.disabled = false
      button.textContent = '入记忆池'
      button.removeAttribute('title')
    }
    if (!host.isConnected) document.body.append(host)
    host.style.left = Math.max(8, Math.min(rect.right + 8, innerWidth - button.offsetWidth - 8)) + 'px'
    host.style.top = Math.max(8, Math.min(rect.top, innerHeight - button.offsetHeight - 8)) + 'px'
  }

  function schedule() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(update)
  }
  button.addEventListener('pointerdown', event => event.preventDefault())
  button.addEventListener('click', async event => {
    const item = active
    if (!event.isTrusted || !item || item.busy) return
    item.busy = true
    button.disabled = true
    button.textContent = '保存中…'
    try {
      const result = await send({ kind: 'selection-save', content: item.content, requestId: item.requestId })
      if (!result?.ok) throw new Error(result?.error || '保存失败')
      if (item !== active) return
      button.textContent = '已入池'
      dismissed = item
      timer = setTimeout(hide, 1500)
    } catch (error) {
      if (item !== active) return
      item.busy = false
      button.disabled = false
      button.textContent = '保存失败 · 重试'
      button.title = error.message
    }
  })
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target === host) return
    dragging = true
    dismissed = undefined
    hide()
  }, true)
  const stopDragging = () => {
    dragging = false
    schedule()
  }
  window.addEventListener('pointerup', stopDragging, true)
  window.addEventListener('pointercancel', stopDragging, true)
  document.addEventListener('selectionchange', schedule)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      dismissed = active
      hide()
    }
  }, true)
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
}
