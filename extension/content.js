// dsh-ecolink-web content script v2(document_start,隔离世界)。
// 职责:①注入 MAIN world 脚本;②把配置+记忆池推入页面(CustomEvent,页内同步缓存);
// ③转发页面的收割/touch 事件到 background。一切失败静默。

;(() => {
  'use strict'
  if (document.getElementById('__ecolink_hook')) return
  const s = document.createElement('script')
  s.id = '__ecolink_hook'
  s.src = chrome.runtime.getURL('inject.js')
  s.async = false
  s.onload = () => s.remove()
  ;(document.head || document.documentElement).appendChild(s)

  let DEBUG = false
  try { DEBUG = window.localStorage.getItem('ecolink_debug') === '1' } catch { /* ignore */ }
  const dbg = (...a) => { if (DEBUG) { try { console.log('%c[ecolink:content]', 'color:#2563eb', ...a) } catch { /* ignore */ } } }

  // 从 background 拉配置+池,推给页面(DSM dsm:cu 模式)
  async function pushFresh() {
    try {
      const resp = await chrome.runtime.sendMessage({ kind: 'get-settings' })
      if (resp?.ok) {
        window.dispatchEvent(new CustomEvent('ecolink:cu', {
          detail: JSON.stringify({
            settings: resp.settings ?? {},
            pool: resp.pool ?? { shared_pool: [], session_pools: {} },
            compress: resp.compress ?? { active: false },
          }),
        }))
        dbg('已推送配置/池: ' + (resp.pool ? (resp.pool.shared_pool ?? []).length : 0) + ' 条共享' + (resp.compress?.active ? '(压缩模式)' : ''))
      }
    } catch (err) { dbg('拉取配置失败: ' + (err?.message ?? err)) }
  }
  pushFresh()
  setInterval(pushFresh, 45000)

  // 压缩状态 / 配置变化(popup 点开始、完成、改静音、改面板开关)立刻推送到页面——
  // 否则已打开的页面要等 45s 周期。E7 的"一键静音"尤其需要即时生效,
  // 所以这里同时监听 ecolink_config(此前只监听 ecolink_compress,静音最长要等 45s 才生效)。
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      if (changes.ecolink_compress) {
        dbg('压缩状态变化,立即推送')
        pushFresh()
        return
      }
      if (changes.ecolink_config) {
        dbg('配置变化,立即推送(静音/面板开关即时生效)')
        pushFresh()
      }
    })
  } catch { /* fail-open */ }

  // 页面 → background 转发(页面侧 CustomEvent)
  window.addEventListener('ecolink:page', (ev) => {
    let d
    try { d = JSON.parse(ev.detail ?? '{}') } catch { return }
    try {
      if (d.type === 'rq') {
        pushFresh()
      } else if (d.type === 'harvest') {
        dbg('收到 harvest ' + (d.memories?.length ?? 0) + ' 条 → 转发 background')
        chrome.runtime.sendMessage({ kind: 'harvest', memories: d.memories, session_id: d.session_id, dup_report: d.dup_report })
          .then((resp) => {
            // 把收割后的最新池立即推回页面(新对话立刻可见)
            if (resp?.pool && typeof resp.pool === 'object') {
              window.dispatchEvent(new CustomEvent('ecolink:cu', { detail: JSON.stringify({ settings: null, pool: resp.pool }) }))
            }
          })
          .catch(() => {})
      } else if (d.type === 'compress-seen') {
        // 2026-09-25 修复:此前漏转发 → 后台"仅计压缩会话"过滤永远判空 → popup 恒显 0 标签
        chrome.runtime.sendMessage({ kind: 'compress-seen', session_id: d.session_id }).catch(() => {})
      } else if (d.type === 'dup-report') {
        // 2026-09-25:模型自报重复数独立上报(说明行可能不含标签,不随 harvest 走)
        chrome.runtime.sendMessage({ kind: 'dup-report', dup: d.dup, session_id: d.session_id }).catch(() => {})
      } else if (d.type === 'touch') {
        chrome.runtime.sendMessage({ kind: 'touch', ids: d.ids }).catch(() => {})
      } else if (d.type === 'diag') {
        chrome.runtime.sendMessage({ kind: 'diag', msg: d.msg }).catch(() => {})
      }
    } catch { /* fail-open */ }
  })

  dbg('content.js v2 已就绪')
})()
