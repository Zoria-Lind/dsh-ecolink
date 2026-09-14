// dsh-ecolink-web 只读记忆面板(E6,内容脚本隔离世界)。
// 设计约束(10-ecolink E6 / 0D):
//   - 必须挂 closed shadow root:inject.js(MAIN world)用 TreeWalker 扫全页文本并
//     就地剥离,light DOM 里的面板会被反复扫描甚至剥空;shadow 内容对 TreeWalker 不可见
//   - 只读 + 手动插入:插入经 CustomEvent('ecolink:panel') 交给 MAIN world 的
//     inject.js 完成(React 受控输入要用原生 setter/insertText,同世界最可靠)
//   - 数据来源:content.js 周期/收割后经 CustomEvent('ecolink:cu') 推送的 pool
//     (detail 是 JSON 字符串——跨世界传 detail 的既有契约,存在才合并不受影响)
//   - 铁律:任何异常 → 静默退出,绝不影响页面
;(function () {
  'use strict'
  try {
    if (document.getElementById('ecolink-panel-host')) return
    if (window[Symbol.for('__ecolink-panel')]) return
    Object.defineProperty(window, Symbol.for('__ecolink-panel'), { value: true })

    let pool = null
    let settings = null
    let open = false

    const host = document.createElement('div')
    host.id = 'ecolink-panel-host'
    host.style.cssText = 'position:fixed;right:16px;bottom:56px;z-index:2147483646;width:0;height:0;'
    const root = host.attachShadow({ mode: 'closed' }) // closed:页面 JS 摸不到内部
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(host))
    if (document.body) document.body.appendChild(host)

    const style = document.createElement('style')
    style.textContent = `
      .btn { all: initial; cursor: pointer; display: block; width: 40px; height: 40px; border-radius: 50%;
             background: #0ea5a4; color: #fff; font: 600 16px/40px system-ui,"Microsoft YaHei",sans-serif;
             text-align: center; user-select: none; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
      .panel { position: absolute; right: 0; bottom: 48px; width: 320px; max-height: 440px;
               display: none; flex-direction: column; background: var(--p-bg,#fff); color: var(--p-fg,#111);
               border: 1px solid rgba(128,128,128,.4); border-radius: 10px; overflow: hidden;
               box-shadow: 0 8px 28px rgba(0,0,0,.25); font: 13px/1.5 system-ui,"Microsoft YaHei",sans-serif; }
      .panel.open { display: flex; }
      .head { padding: 8px 10px; border-bottom: 1px solid rgba(128,128,128,.25); display: flex; gap: 6px; align-items: center; }
      .head input { flex: 1; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(128,128,128,.5);
                    background: transparent; color: inherit; font: inherit; }
      .list { overflow: auto; padding: 6px 10px 10px; }
      .group { margin: 8px 0 4px; font-weight: 600; color: #0ea5a4; font-size: 12px; }
      .item { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
      .item .txt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .item button { all: initial; cursor: pointer; padding: 2px 8px; border: 1px solid rgba(128,128,128,.5);
                     border-radius: 5px; font: 12px system-ui,sans-serif; color: inherit; }
      .empty { color: rgba(128,128,128,.9); font-size: 12px; margin: 8px 0; }
    `
    root.appendChild(style)

    const toggle = document.createElement('div')
    toggle.className = 'btn'
    toggle.textContent = '忆'
    toggle.title = 'dsh-ecolink 记忆面板(只读)'
    root.appendChild(toggle)

    const panel = document.createElement('div')
    panel.className = 'panel'
    panel.innerHTML = '<div class="head"><input type="search" placeholder="搜索记忆…"></div><div class="list"></div>'
    root.appendChild(panel)

    const search = panel.querySelector('input')
    const listEl = panel.querySelector('.list')
    search.addEventListener('input', () => render())

    toggle.addEventListener('click', () => {
      open = !open
      panel.classList.toggle('open', open)
      if (open) {
        try { chrome.runtime?.sendMessage?.({ kind: 'mark-read' })?.catch?.(() => {}) } catch { /* fail-open */ }
        render()
      }
    })

    window.addEventListener('ecolink:cu', (e) => {
      try {
        const d = JSON.parse(e.detail)
        if (d.pool && typeof d.pool === 'object') pool = d.pool
        if (d.settings && typeof d.settings === 'object') {
          settings = d.settings
          applyVisibility()
        }
        if (open) render()
      } catch { /* fail-open */ }
    })

    function applyVisibility() {
      // E7 muted / E6 panelEnabled 任一关闭 → 整个面板退场(不再占位)
      const off = settings && (settings.muted === true || settings.panelEnabled === false)
      host.style.display = off ? 'none' : ''
    }

    function allItems() {
      const out = []
      for (const it of pool?.shared_pool ?? []) out.push({ content: it?.content, ts: it?.timestamp, group: '共享记忆' })
      for (const [sid, sp] of Object.entries(pool?.session_pools ?? {})) {
        const name = sp?.identity || `${String(sid).slice(0, 8)}…`
        for (const it of sp?.memories ?? []) out.push({ content: it?.content, ts: it?.timestamp, group: `会话:${name}` })
      }
      return out
    }

    function render() {
      try {
        listEl.textContent = ''
        if (!pool) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = '暂无池数据(等服务推送或点扩展刷新)'; listEl.appendChild(d); return }
        const q = String(search.value ?? '').trim().toLowerCase()
        const items = allItems()
          .filter((it) => it.content && (!q || it.content.toLowerCase().includes(q)))
          .sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')))
          .slice(0, 200)
        if (items.length === 0) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = q ? '无匹配记忆' : '记忆池为空'; listEl.appendChild(d); return }
        let lastGroup = ''
        for (const it of items) {
          if (it.group !== lastGroup) {
            lastGroup = it.group
            const g = document.createElement('div')
            g.className = 'group'
            g.textContent = it.group
            listEl.appendChild(g)
          }
          const row = document.createElement('div')
          row.className = 'item'
          const txt = document.createElement('span')
          txt.className = 'txt'
          txt.textContent = it.content
          txt.title = it.content
          const ins = document.createElement('button')
          ins.textContent = '插入'
          ins.title = '把这条记忆插入输入框'
          ins.addEventListener('click', () => {
            try { window.dispatchEvent(new CustomEvent('ecolink:panel', { detail: JSON.stringify({ type: 'insert', text: it.content }) })) } catch { /* fail-open */ }
          })
          row.append(txt, ins)
          listEl.appendChild(row)
        }
      } catch { /* fail-open */ }
    }
  } catch { /* 面板失败不干扰页面 */ }
})()
