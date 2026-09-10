// dsh-ecolink-service 单测:node --test service/test.mjs(零 API、零依赖)
// 覆盖:pool 逻辑(精度/归档/替换/DSM 导入)+ HTTP 全端点(CORS/鉴权/持久化重启)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPool, precisionFor, renderTimestamp } from './pool.mjs'
import { applyCompression } from './compress.mjs'

// ---- pool 层 ----
test('precisionFor 分档:分钟/小时/日期/不渲染', () => {
  const now = Date.now()
  assert.equal(precisionFor(new Date(now - 60e3).toISOString(), now), 'minute')
  assert.equal(precisionFor(new Date(now - 3 * 3600e3).toISOString(), now), 'hour')
  assert.equal(precisionFor(new Date(now - 3 * 86400e3).toISOString(), now), 'day')
  assert.equal(precisionFor(new Date(now - 10 * 86400e3).toISOString(), now), 'none')
  assert.equal(renderTimestamp('2026-09-10T08:15:30.000Z', 'minute'), '2026-09-10T08:15')
  assert.equal(renderTimestamp('2026-09-10T08:15:30.000Z', 'hour'), '2026-09-10T08')
  assert.equal(renderTimestamp('2026-09-10T08:15:30.000Z', 'day'), '2026-09-10')
  assert.equal(renderTimestamp('2026-09-10T08:15:30.000Z', 'none'), null)
})

test('pool:sync 共享池/会话池/replace/touch/会话命名/DSM 导入去重', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-pool-'))
  const pool = createPool({ dir })

  // 共享池写入
  const r1 = await pool.sync({ memories: [{ content: '共享记忆一', importance: 'called' }] })
  assert.equal(r1.ok, true)
  assert.equal(r1.added, 1)
  assert.equal(pool.pool().shared_pool.length, 1)

  // 会话池写入 + last_active
  await pool.sync({ session_id: 'sess-abc', memories: [{ content: '会话记忆一' }] })
  const sp = pool.sessionPool('sess-abc')
  assert.equal(sp.memories.length, 1)
  assert.ok(sp.last_active)

  // replace 目标池优先
  const targetId = sp.memories[0].id
  const rr = await pool.sync({ session_id: 'sess-abc', memories: [{ id: targetId, content: '会话记忆一(改写)', action: 'replace' }] })
  assert.equal(rr.replaced, 1)
  assert.equal(pool.sessionPool('sess-abc').memories[0].content, '会话记忆一(改写)')
  assert.equal(pool.sessionPool('sess-abc').memories.length, 1) // 不新增

  // 会话命名
  await pool.session({ session_id: 'sess-abc', name: '微积分补考' })
  assert.equal(pool.sessionPool('sess-abc').identity, '微积分补考')

  // touch
  const t = await pool.touch([targetId])
  assert.equal(t.touched, 1)
  assert.ok(pool.sessionPool('sess-abc').memories[0].last_accessed)

  // key 化 upsert:同 key 覆盖旧值(压缩/更新闭环)
  await pool.sync({ memories: [{ key: 'pref_title', content: '喜欢短标题 v1', importance: 'called' }] })
  assert.equal(pool.pool().shared_pool.find((it) => it.key === 'pref_title').content, '喜欢短标题 v1')
  const up = await pool.sync({ memories: [{ key: 'pref_title', content: '喜欢短标题 v2(合并压缩后)', importance: 'key' }] })
  assert.equal(up.replaced, 1)
  assert.equal(up.added, 0)
  assert.equal(pool.pool().shared_pool.filter((it) => it.key === 'pref_title').length, 1)
  assert.equal(pool.pool().shared_pool.find((it) => it.key === 'pref_title').content, '喜欢短标题 v2(合并压缩后)')
  // 同 key 同值 → 跳过写入(DSM 同款,防时间戳翻新)
  const tsBefore = pool.pool().shared_pool.find((it) => it.key === 'pref_title').timestamp
  const same = await pool.sync({ memories: [{ key: 'pref_title', content: '喜欢短标题 v2(合并压缩后)' }] })
  assert.equal(same.replaced, 0)
  assert.equal(same.added, 0)
  assert.equal(pool.pool().shared_pool.find((it) => it.key === 'pref_title').timestamp, tsBefore)
  // 无 key 同内容 → 跳过写入(模型回显示例的池层最后一道闸)
  const dup = await pool.sync({ memories: [{ content: '喜欢短标题 v2(合并压缩后)' }] })
  assert.equal(dup.added, 0)

  // delete:按 key 与按 id 删除
  const del = await pool.deleteMemories({ keys: ['pref_title'] })
  assert.equal(del.deleted, 1)
  assert.equal(pool.pool().shared_pool.some((it) => it.key === 'pref_title'), false)
  const someId = pool.pool().shared_pool[0].id
  const del2 = await pool.deleteMemories({ ids: [someId] })
  assert.equal(del2.deleted, 1)
  assert.equal(pool.pool().shared_pool.some((it) => it.id === someId), false)

  // DSM 导入 + 内容去重
  const d1 = await pool.importDsm([{ key: 'k1', value: 'v1', importance: 'key' }])
  assert.equal(d1.added, 1)
  const d2 = await pool.importDsm([{ key: 'k1', value: 'v1' }, { key: 'k2', value: 'v2' }])
  assert.equal(d2.added, 1)
  assert.equal(d2.skipped, 1)

  // recent 排序与截断
  const rec = pool.recent(2)
  assert.equal(rec.length, 2)
  assert.ok(rec[0].timestamp >= rec[1].timestamp)

  // status
  const st = pool.status()
  assert.equal(st.shared, 2) // 删除测试后剩:k1:v1 + k2:v2
  assert.equal(st.sessions['sess-abc'], 1)
  rmSync(dir, { recursive: true, force: true })
})

test('compress:applyCompression(新记忆写入 + 未变旧条目删除)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-cmp-'))
  const pool = createPool({ dir })
  await pool.sync({ memories: [{ content: '旧记忆A', key: 'old_a' }, { content: '旧记忆B' }] })
  const oldItems = pool.pool().shared_pool.map((it) => ({ id: it.id, key: it.key ?? null, content: it.content }))
  // 压缩结果:old_a 被覆盖(同 key 新内容),B 合并进新条目(旧 B 未变 → 应删除)
  const result = await applyCompression(pool, oldItems, [
    { key: 'old_a', content: '旧记忆A(压缩后合并了B)', importance: 'called' },
    { content: '新条目C', importance: 'called' },
  ])
  assert.equal(result.added, 2) // 先删后写:旧 old_a 与 B 都未变被删,新 old_a' 与 C 新增
  assert.equal(result.deleted, 2) // 两条旧条目内容未变 → 全删
  const shared = pool.pool().shared_pool
  assert.equal(shared.filter((it) => it.key === 'old_a').length, 1)
  assert.equal(shared.find((it) => it.key === 'old_a').content, '旧记忆A(压缩后合并了B)')
  assert.equal(shared.some((it) => it.content === '旧记忆B'), false)
  assert.equal(shared.some((it) => it.content === '新条目C'), true)
  rmSync(dir, { recursive: true, force: true })
})

test('pool:stale 过时记忆清单(压缩流程用)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-stale-'))
  const pool = createPool({ dir })
  await pool.sync({ memories: [{ content: '新记忆', key: 'new_one' }] })
  await pool.sync({ session_id: 'sess-x', memories: [{ content: '会话新记忆' }] })
  // 手工把一部分时间戳拨回 10 天前
  const backdate = (arr, content) => { const it = arr.find((x) => x.content === content); it.timestamp = new Date(Date.now() - 10 * 86400e3).toISOString() }
  backdate(pool.pool().shared_pool, '新记忆')
  backdate(pool.pool().session_pools['sess-x'].memories, '会话新记忆')
  const stale = pool.stale(5)
  assert.equal(stale.length, 2)
  assert.ok(stale.some((s) => s.content === '新记忆' && s.session_id === null))
  assert.ok(stale.some((s) => s.content === '会话新记忆' && s.session_id === 'sess-x'))
  // days=7:两条 10 天前的仍过期;days=30:都不够老
  const stale1 = pool.stale(7)
  assert.equal(stale1.length, 2)
  assert.equal(pool.stale(30).length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('pool:归档(超过保留期且未访问的非 pinned)→ archive.json;persist 重启恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-arch-'))
  const pool = createPool({ dir, retentionDays: 0 }) // 0 天:立即过期
  await pool.sync({ memories: [{ content: '会过期' }, { content: '置顶不过期', pinned: true }] })
  // 刚写入即归档:pinned 保留,普通条目进 archive
  assert.equal(pool.pool().shared_pool.length, 1)
  assert.equal(pool.pool().shared_pool[0].content, '置顶不过期')
  assert.ok(existsSync(pool.archiveFile))
  const archive = JSON.parse(readFileSync(pool.archiveFile, 'utf8'))
  assert.equal(archive.archived.length, 1)
  assert.equal(archive.archived[0].content, '会过期')

  // 持久化:同目录新建 pool 实例(模拟重启)读回
  const pool2 = createPool({ dir, retentionDays: 30 })
  assert.equal(pool2.pool().shared_pool.length, 1)
  assert.equal(pool2.status().archived, 1)
  rmSync(dir, { recursive: true, force: true })
})

// ---- HTTP 层(子进程起真实服务,env 注入临时端口与目录) ----
let child
let base
let port
let poolDir
before(async () => {
  poolDir = mkdtempSync(join(tmpdir(), 'ecolink-http-'))
  port = 20000 + Math.floor(Math.random() * 20000)
  child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
    env: { ...process.env, ECOLLINK_PORT: String(port), ECOLLINK_POOL_DIR: poolDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  base = `http://127.0.0.1:${port}`
  // 等就绪:轮询 status 最多 5 秒
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`${base}/memory/status`)
      if (resp.ok) return
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('service did not become ready')
})
after(() => {
  child?.kill()
  rmSync(poolDir, { recursive: true, force: true })
})

test('HTTP:sync/pool/recent/session/status/touch 全端点 + CORS', async () => {
  // sync 到共享池
  const s1 = await fetch(`${base}/memory/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memories: [{ content: 'http 共享记忆' }] }),
  })
  assert.equal(s1.status, 200)
  assert.equal((await s1.json()).added, 1)

  // CORS 头存在(content script 跨源)
  assert.equal(s1.headers.get('access-control-allow-origin'), '*')

  // OPTIONS 预检
  const opt = await fetch(`${base}/memory/sync`, { method: 'OPTIONS' })
  assert.equal(opt.status, 204)

  // sync 到会话池 + 命名
  await fetch(`${base}/memory/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'http-sess', memories: [{ content: 'http 会话记忆' }] }),
  })
  await fetch(`${base}/memory/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'http-sess', name: '测试会话' }),
  })

  // pool 全量
  const poolResp = await fetch(`${base}/memory/pool`)
  const pool = await poolResp.json()
  assert.equal(pool.shared_pool.length, 1)
  assert.equal(pool.session_pools['http-sess'].identity, '测试会话')

  // session/{id}
  const spResp = await fetch(`${base}/memory/session/http-sess`)
  assert.equal((await spResp.json()).memories.length, 1)
  const nf = await fetch(`${base}/memory/session/nope`)
  assert.equal(nf.status, 404)

  // recent
  const rec = await fetch(`${base}/memory/recent?n=1`)
  assert.equal((await rec.json()).memories.length, 1)

  // status
  const st = await fetch(`${base}/memory/status`)
  assert.equal((await st.json()).shared, 1)

  // touch
  const t = await fetch(`${base}/memory/touch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [pool.shared_pool[0].id] }),
  })
  assert.equal((await t.json()).touched, 1)

  // 未知路径 404
  const nf2 = await fetch(`${base}/memory/nope`)
  assert.equal(nf2.status, 404)
})

test('HTTP:token 鉴权(env 注入 token 时无头拒绝)', async () => {
  const authDir = mkdtempSync(join(tmpdir(), 'ecolink-auth-'))
  const authPort = 20000 + Math.floor(Math.random() * 20000)
  const authChild = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
    env: { ...process.env, ECOLLINK_PORT: String(authPort), ECOLLINK_POOL_DIR: authDir, ECOLLINK_TOKEN: 'sekrit' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const authBase = `http://127.0.0.1:${authPort}`
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`${authBase}/memory/status`, { headers: { 'X-Ecolink-Token': 'sekrit' } })
      if (resp.ok) break
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  const denied = await fetch(`${authBase}/memory/status`)
  assert.equal(denied.status, 401)
  const allowed = await fetch(`${authBase}/memory/status`, { headers: { 'X-Ecolink-Token': 'sekrit' } })
  assert.equal(allowed.status, 200)
  authChild.kill()
  rmSync(authDir, { recursive: true, force: true })
})
