// dsh-ecolink-web popup:状态 / 压缩流程按钮 / 配置 / 建议确认 / 会话管理 / DSM 导入。
// popup 可直接 fetch 127.0.0.1(host_permissions 已含);压缩状态机经 background 消息。
// E6:type=module → 直接 import 默认配置单一来源(core/config.mjs),消除三份不一致默认值。

import { DEFAULT_CONFIG } from './core/config.mjs'

const $ = (id) => document.getElementById(id)

// E8-fix:token 自动发现(popup 也自己探一次;失败静默,退回手工填)
async function ensureToken() {
  const cfg = await loadConfig()
  if (cfg.token) return cfg.token
  try {
    const url = `${cfg.bridgeUrl.replace(/\/$/, '')}/memory/token`
    const resp = await fetch(url, { headers: { Origin: 'https://chat.deepseek.com' } })
    if (!resp.ok) return ''
    const d = await resp.json()
    const token = typeof d?.token === 'string' ? d.token : ''
    if (token) await chrome.storage.local.set({ ecolink_config: { ...cfg, token } })
    return token
  } catch { return '' }
}

async function bridgeFetch(path, init = {}) {
  const cfg = await loadConfig()
  // 首次进入:若无 token 先尝试自动发现(服务端 E8 起强制 token)
  const token = cfg.token || (await ensureToken())
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  if (token) headers['X-Ecolink-Token'] = token
  return fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}${path}`, { ...init, headers })
}

async function loadConfig() {
  const got = await chrome.storage.local.get('ecolink_config')
  return { ...DEFAULT_CONFIG, ...(got.ecolink_config ?? {}) }
}

async function refreshStatus() {
  try {
    const resp = await bridgeFetch('/memory/status')
    if (resp.status === 401) {
      $('statusLine').textContent = '服务在线但鉴权失败(401):token 不匹配。重新打开本面板会自动重取 token;仍失败就检查 service/config.json 的 token 与扩展是否一致'
      return
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    const st = await resp.json()
    const sessionCount = Object.keys(st.sessions ?? {}).length
    $('statusLine').textContent = `服务在线 | 共享记忆 ${st.shared} 条 · 会话 ${sessionCount} 个 · 归档 ${st.archived} 条`
  } catch {
    $('statusLine').textContent = '本地服务不可达(先跑 service/server.mjs)'
  }
}

async function refreshSessions() {
  const list = $('sessionList')
  try {
    const resp = await bridgeFetch('/memory/pool')
    if (!resp.ok) throw new Error()
    const pool = await resp.json()
    const entries = Object.entries(pool.session_pools ?? {})
    if (entries.length === 0) { list.textContent = '暂无会话记忆池'; return }
    list.textContent = ''
    for (const [sid, sp] of entries) {
      const row = document.createElement('div')
      row.className = 'sess'
      const name = document.createElement('span')
      name.textContent = sp?.identity ?? '(未命名)'
      const idSpan = document.createElement('span')
      idSpan.className = 'id'
      idSpan.textContent = `${sid.slice(0, 8)}… (${(sp?.memories ?? []).length} 条)`
      const rename = document.createElement('button')
      rename.textContent = '命名'
      rename.onclick = async () => {
        const newName = prompt('会话名称:', sp?.identity ?? '')
        if (newName === null) return
        await bridgeFetch('/memory/session', { method: 'POST', body: JSON.stringify({ session_id: sid, name: newName.trim() }) })
        refreshSessions()
      }
      const del = document.createElement('button')
      del.textContent = '删除'
      del.className = 'danger'
      del.onclick = async () => {
        if (!confirm(`删除会话 ${sp?.identity ?? sid.slice(0, 8)} 的全部记忆?`)) return
        await bridgeFetch('/memory/session', { method: 'POST', body: JSON.stringify({ session_id: sid, delete: true }) })
        refreshSessions()
        refreshStatus()
      }
      row.append(name, idSpan, rename, del)
      list.appendChild(row)
    }
  } catch {
    list.textContent = '服务不可达'
  }
}

// ---- 待确认建议(E5:写入先入建议队列,确认后才入池;未确认条目不会出现在 DSH 上下文) ----
async function refreshSuggestions() {
  const list = $('suggestionList')
  try {
    const resp = await bridgeFetch('/memory/suggestions')
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    const r = await resp.json()
    const items = r.suggestions ?? []
    if (items.length === 0) { list.textContent = '暂无待确认建议'; return }
    list.textContent = ''
    for (const s of items) {
      const row = document.createElement('div')
      row.className = 'sess'
      const main = document.createElement('span')
      main.className = 'id'
      main.textContent = `${s.content}(${s.session_id ? '会话池' : '共享池'} · ${s.source ?? 'web'})`
      const ok = document.createElement('button')
      ok.className = 'primary'
      ok.textContent = '确认'
      ok.onclick = async () => {
        ok.disabled = true
        try {
          await bridgeFetch('/memory/suggest/confirm', { method: 'POST', body: JSON.stringify({ id: s.id }) })
          refreshSuggestions()
          refreshStatus()
        } finally { ok.disabled = false }
      }
      const no = document.createElement('button')
      no.className = 'danger'
      no.textContent = '拒绝'
      no.onclick = async () => {
        no.disabled = true
        try {
          await bridgeFetch('/memory/suggest/reject', { method: 'POST', body: JSON.stringify({ id: s.id }) })
          refreshSuggestions()
        } finally { no.disabled = false }
      }
      row.append(main, ok, no)
      list.appendChild(row)
    }
  } catch {
    list.textContent = '服务不可达'
  }
}

async function fillConfigForm() {
  const cfg = await loadConfig()
  $('cfg_bridgeUrl').value = cfg.bridgeUrl
  $('cfg_token').value = cfg.token
  $('cfg_maxInjectionChars').value = cfg.maxInjectionChars
  $('cfg_compressMinAgeDays').value = cfg.compressMinAgeDays ?? 5
  $('cfg_injectEnabled').checked = cfg.injectEnabled
  $('cfg_contentInjectionEnabled').checked = cfg.contentInjectionEnabled !== false
  $('cfg_harvestEnabled').checked = cfg.harvestEnabled
  $('cfg_singleInjection').checked = cfg.singleInjection
  $('cfg_panelEnabled').checked = cfg.panelEnabled
  $('cfg_muted').checked = cfg.muted
}

$('cfgSave').onclick = async () => {
  const daysRaw = String($('cfg_compressMinAgeDays').value ?? '').trim()
  const daysVal = daysRaw === '' ? 5 : Number(daysRaw) // 空字段回落默认 5(Number('')===0 会让全池变"过时"→ 压缩=清池)
  const maxVal = Number($('cfg_maxInjectionChars').value)
  const next = {
    bridgeUrl: $('cfg_bridgeUrl').value.trim() || 'http://127.0.0.1:17520',
    token: $('cfg_token').value.trim(),
    maxInjectionChars: Number.isFinite(maxVal) ? Math.max(200, maxVal) : 3000,
    // 注意:0 是合法值(测试用),不能用 || 兜底(0 被当假值吞掉)
    compressMinAgeDays: Number.isFinite(daysVal) ? Math.max(0, daysVal) : 5,
    injectEnabled: $('cfg_injectEnabled').checked,
    contentInjectionEnabled: $('cfg_contentInjectionEnabled').checked,
    harvestEnabled: $('cfg_harvestEnabled').checked,
    singleInjection: $('cfg_singleInjection').checked,
    panelEnabled: $('cfg_panelEnabled').checked,
    muted: $('cfg_muted').checked,
  }
  await chrome.storage.local.set({ ecolink_config: next })
  $('cfgResult').textContent = '已保存 ✓'
  refreshStatus()
}

$('dsmImport').onclick = async () => {
  const btn = $('dsmImport')
  btn.disabled = true
  const result = $('result')
  try {
    const got = await chrome.storage.local.get('dsm_memories')
    const dsm = got.dsm_memories
    const entries = Object.entries(dsm && typeof dsm === 'object' ? dsm : {})
      .map(([key, v]) => ({ key, value: typeof v === 'object' ? v.value : v, importance: typeof v === 'object' ? v.importance : undefined }))
    if (entries.length === 0) {
      result.textContent = '没有找到 DSM 记忆(DeepSeek Memory 扩展未装过或已清空)'
      return
    }
    const resp = await bridgeFetch('/memory/import-dsm', { method: 'POST', body: JSON.stringify({ entries }) })
    const r = await resp.json()
    result.textContent = `导入完成:新增 ${r.added ?? 0} 条,跳过 ${r.skipped ?? 0} 条(内容重复)`
    refreshStatus()
  } catch (err) {
    result.textContent = '导入失败: ' + (err?.message ?? err)
  } finally {
    btn.disabled = false
  }
}

// ---- 压缩流程(状态机在 background) ----
async function refreshCompress() {
  const st = await chrome.runtime.sendMessage({ kind: 'compress-status' }).catch(() => null)
  if (!st?.active) {
    $('compressStart').disabled = false
    $('compressFinish').disabled = true
    $('compressStatus').textContent = st?.lastResult ?? ''
    return
  }
  $('compressStart').disabled = true
  $('compressFinish').disabled = false
  const maxDup = Array.isArray(st.dupReports) && st.dupReports.length > 0 ? Math.max(...st.dupReports) : 0
  $('compressStatus').textContent = `压缩进行中:旧记忆 ${st.oldCount} 条已移入暂存池(未验收可回滚),已收到新标签 ${st.newCount ?? 0} 个${maxDup > 0 ? `,模型自报重复 ${maxDup} 条` : ''} → 去开一个新对话发消息,模型会收到压缩指令`
}

$('compressStart').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ kind: 'compress-start' }).catch((err) => ({ error: String(err?.message ?? err) }))
  if (r?.error) { $('compressStatus').textContent = '启动失败: ' + r.error; return }
  if (!r?.oldCount) { $('compressStatus').textContent = '没有超过过时天数的旧记忆,无需压缩'; return }
  refreshCompress()
}

$('compressFinish').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ kind: 'compress-finish' }).catch((err) => ({ error: String(err?.message ?? err) }))
  if (r?.error) { $('compressStatus').textContent = '结束失败: ' + r.error; return }
  $('compressStatus').textContent = `压缩验收通过:清除暂存 ${r.deleted ?? 0} 条,新标签已作为普通记忆入主池`
  refreshStatus()
  refreshCompress()
}

// 备用:API 压缩(网页端模型不服从时用;一次 Flash 调用)
$('compressApi').onclick = async () => {
  const btn = $('compressApi')
  btn.disabled = true
  const cfg = await loadConfig()
  try {
    const resp = await bridgeFetch('/memory/compress', { method: 'POST', body: JSON.stringify({ days: cfg.compressMinAgeDays ?? 5 }) })
    const r = await resp.json()
    if (!r.ok) {
      $('compressStatus').textContent = 'API 压缩失败: ' + (r.error ?? 'HTTP ' + resp.status) + (r.rolledBack ? `(暂存已回滚 ${r.rolledBack} 条,记忆无损)` : '')
    } else if (r.pendingConfirm) {
      const okConfirm = confirm(`模型自报重复 ${r.reportedDup} 条(共 ${r.oldCount} 条),已输出 ${r.tagCount} 条新标签。\n确认提交压缩(清除暂存池)?\n取消 = 回滚,旧记忆原样放回主池。`)
      const ep = okConfirm ? '/memory/compress-commit' : '/memory/compress-rollback'
      const rr = await bridgeFetch(ep, { method: 'POST' }).then((x) => x.json()).catch(() => ({}))
      $('compressStatus').textContent = okConfirm
        ? `已确认:清除暂存 ${rr.committed ?? 0} 条`
        : `已取消:暂存回滚 ${rr.restored ?? 0} 条,记忆无损`
      refreshStatus()
    } else if (!r.oldCount) {
      $('compressStatus').textContent = '没有旧记忆可压缩'
    } else {
      $('compressStatus').textContent = `API 压缩完成:处理 ${r.oldCount} 条旧记忆,新增 ${r.added} 条,清除暂存 ${r.deleted} 条`
      refreshStatus()
    }
  } catch (err) {
    $('compressStatus').textContent = 'API 压缩失败: ' + (err?.message ?? err)
  } finally {
    btn.disabled = false
  }
}

refreshStatus()
refreshSessions()
refreshSuggestions()
fillConfigForm()
refreshCompress()
// E6:打开 popup 即视为"已读",badge 的变更角标清零
try { chrome.runtime?.sendMessage?.({ kind: 'mark-read' })?.catch?.(() => {}) } catch { /* ignore */ }
