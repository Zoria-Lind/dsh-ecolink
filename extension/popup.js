// dsh-ecolink-web popup:状态 / 压缩流程按钮 / 配置 / 会话管理 / DSM 导入。
// popup 可直接 fetch 127.0.0.1(host_permissions 已含);压缩状态机经 background 消息。

const $ = (id) => document.getElementById(id)

async function bridgeFetch(path, init = {}) {
  const cfg = await loadConfig()
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  if (cfg.token) headers['X-Ecolink-Token'] = cfg.token
  return fetch(`${cfg.bridgeUrl.replace(/\/$/, '')}${path}`, { ...init, headers })
}

async function loadConfig() {
  const got = await chrome.storage.local.get('ecolink_config')
  return {
    bridgeUrl: 'http://127.0.0.1:17520',
    token: '',
    injectEnabled: true,
    harvestEnabled: true,
    singleInjection: true,
    maxInjectionChars: 3000,
    compressMinAgeDays: 5,
    ...(got.ecolink_config ?? {}),
  }
}

async function refreshStatus() {
  try {
    const resp = await bridgeFetch('/memory/status')
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

async function fillConfigForm() {
  const cfg = await loadConfig()
  $('cfg_bridgeUrl').value = cfg.bridgeUrl
  $('cfg_token').value = cfg.token
  $('cfg_maxInjectionChars').value = cfg.maxInjectionChars
  $('cfg_compressMinAgeDays').value = cfg.compressMinAgeDays ?? 5
  $('cfg_injectEnabled').checked = cfg.injectEnabled
  $('cfg_harvestEnabled').checked = cfg.harvestEnabled
  $('cfg_singleInjection').checked = cfg.singleInjection
}

$('cfgSave').onclick = async () => {
  const daysVal = Number($('cfg_compressMinAgeDays').value)
  const maxVal = Number($('cfg_maxInjectionChars').value)
  const next = {
    bridgeUrl: $('cfg_bridgeUrl').value.trim() || 'http://127.0.0.1:17520',
    token: $('cfg_token').value.trim(),
    maxInjectionChars: Number.isFinite(maxVal) ? Math.max(200, maxVal) : 3000,
    // 注意:0 是合法值(测试用),不能用 || 兜底(0 被当假值吞掉)
    compressMinAgeDays: Number.isFinite(daysVal) ? Math.max(0, daysVal) : 5,
    injectEnabled: $('cfg_injectEnabled').checked,
    harvestEnabled: $('cfg_harvestEnabled').checked,
    singleInjection: $('cfg_singleInjection').checked,
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
  $('compressStatus').textContent = `压缩进行中:旧记忆 ${st.oldCount} 条,已收到新标签 ${st.newCount ?? 0} 个 → 去开一个新对话发消息,模型会收到压缩指令`
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
  $('compressStatus').textContent = `压缩完成:删除未合并旧条目 ${r.deleted ?? 0} 条,保留 ${r.kept ?? 0} 条(已被新内容覆盖)`
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
      $('compressStatus').textContent = 'API 压缩失败: ' + (r.error ?? 'HTTP ' + resp.status)
    } else if (!r.oldCount) {
      $('compressStatus').textContent = '没有旧记忆可压缩'
    } else {
      $('compressStatus').textContent = `API 压缩完成:处理 ${r.oldCount} 条旧记忆,新增 ${r.added} 条,删除 ${r.deleted} 条`
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
fillConfigForm()
refreshCompress()
