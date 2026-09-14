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

test('E3:快照/diff(新增/更新/删除,覆盖共享池与会话池)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-snap-'))
  const pool = createPool({ dir })
  await pool.sync({ memories: [{ content: '甲', key: 'k_a' }, { content: '乙' }] })
  await pool.sync({ session_id: 'sess-s', memories: [{ content: '会话甲' }] })
  const hash1 = await pool.snapshotNow()
  assert.equal(typeof hash1, 'string')
  assert.equal(hash1.length, 64)

  // 新增 + 更新(key 覆盖)+ 会话池新增 → added/updated
  await pool.sync({ memories: [{ content: '丙' }, { key: 'k_a', content: '甲(改)' }] })
  await pool.sync({ session_id: 'sess-s', memories: [{ content: '会话乙' }] })
  const d = pool.diffSince(hash1)
  assert.equal(d.ok, true)
  assert.equal(d.current.length, 64)
  assert.equal(d.added.length, 2) // 丙 + sess-s:会话乙
  assert.equal(d.updated.length, 1) // k_a 覆盖(时间戳+内容变)
  assert.equal(d.removed.length, 0)

  // 删除 → removed
  const del = await pool.deleteMemories({ keys: ['k_a'] })
  assert.equal(del.deleted, 1)
  const d2 = pool.diffSince(hash1)
  assert.equal(d2.removed.length, 1)

  // 二次快照后 since=latest 无差异;清单与 latest 指向
  await pool.snapshotNow()
  const d3 = pool.diffSince('latest')
  assert.equal(d3.added.length + d3.removed.length + d3.updated.length, 0)
  const list = pool.listSnapshots()
  assert.equal(list.ok, true)
  assert.equal(list.snapshots.length, 2)
  assert.equal(list.latest, list.snapshots[0].hash) // 按 mtime 倒序,最新在前

  // 未知快照 → null(走 HTTP 404)
  assert.equal(pool.diffSince('f'.repeat(64)), null)
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
// E8 后鉴权默认开启:测试子进程必须显式注入 env token(否则服务会生成随机 token
// 并写回生产 config.json);以下所有请求都带 X-Ecolink-Token
const TEST_TOKEN = 'test-token'
let child
let base
let port
let poolDir
before(async () => {
  poolDir = mkdtempSync(join(tmpdir(), 'ecolink-http-'))
  port = 20000 + Math.floor(Math.random() * 20000)
  child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
    // E5:主子进程显式开 autoConfirm → 保持"直入池"旧语义的既有断言;建议队列分支另起子进程测
    env: { ...process.env, ECOLLINK_PORT: String(port), ECOLLINK_POOL_DIR: poolDir, ECOLLINK_TOKEN: TEST_TOKEN, ECOLLINK_AUTO_CONFIRM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  base = `http://127.0.0.1:${port}`
  // 等就绪:轮询 status 最多 5 秒(带 token;E8 后无 token 一律 401)
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`${base}/memory/status`, { headers: { 'X-Ecolink-Token': TEST_TOKEN } })
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
  const AUTH = { 'X-Ecolink-Token': TEST_TOKEN }
  // E8:无 token 一律 401(默认安全)
  const denied = await fetch(`${base}/memory/status`)
  assert.equal(denied.status, 401)

  // sync 到共享池
  const s1 = await fetch(`${base}/memory/sync`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ memories: [{ content: 'http 共享记忆' }] }),
  })
  assert.equal(s1.status, 200)
  assert.equal((await s1.json()).added, 1)

  // CORS 头存在且收窄到页面 origin(E8:不再通配;content script 以页面 origin 发 fetch)
  assert.equal(s1.headers.get('access-control-allow-origin'), 'https://chat.deepseek.com')

  // OPTIONS 预检(不鉴权)
  const opt = await fetch(`${base}/memory/sync`, { method: 'OPTIONS' })
  assert.equal(opt.status, 204)

  // sync 到会话池 + 命名
  await fetch(`${base}/memory/sync`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'http-sess', memories: [{ content: 'http 会话记忆' }] }),
  })
  await fetch(`${base}/memory/session`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'http-sess', name: '测试会话' }),
  })

  // pool 全量
  const poolResp = await fetch(`${base}/memory/pool`, { headers: AUTH })
  const pool = await poolResp.json()
  assert.equal(pool.shared_pool.length, 1)
  assert.equal(pool.session_pools['http-sess'].identity, '测试会话')

  // session/{id}
  const spResp = await fetch(`${base}/memory/session/http-sess`, { headers: AUTH })
  assert.equal((await spResp.json()).memories.length, 1)
  const nf = await fetch(`${base}/memory/session/nope`, { headers: AUTH })
  assert.equal(nf.status, 404)

  // recent
  const rec = await fetch(`${base}/memory/recent?n=1`, { headers: AUTH })
  assert.equal((await rec.json()).memories.length, 1)

  // status
  const st = await fetch(`${base}/memory/status`, { headers: AUTH })
  assert.equal((await st.json()).shared, 1)

  // touch
  const t = await fetch(`${base}/memory/touch`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [pool.shared_pool[0].id] }),
  })
  assert.equal((await t.json()).touched, 1)

  // 错 token 也 401
  const wrong = await fetch(`${base}/memory/status`, { headers: { 'X-Ecolink-Token': 'wrong' } })
  assert.equal(wrong.status, 401)

  // 未知路径 404
  const nf2 = await fetch(`${base}/memory/nope`, { headers: AUTH })
  assert.equal(nf2.status, 404)
})

test('HTTP:快照/diff/快照清单(E3)', async () => {
  const AUTH = { 'X-Ecolink-Token': TEST_TOKEN }
  const snap = await fetch(`${base}/memory/snapshot`, { method: 'POST', headers: AUTH })
  assert.equal(snap.status, 200)
  const { hash } = await snap.json()
  assert.equal(typeof hash, 'string')
  assert.equal(hash.length, 64)

  // 变更池 → diff 能看到新增
  await fetch(`${base}/memory/sync`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ memories: [{ content: 'diff 探针条目' }] }),
  })
  const diff = await fetch(`${base}/memory/diff?since=${hash}`, { headers: AUTH })
  assert.equal(diff.status, 200)
  const dj = await diff.json()
  assert.ok(dj.ok)
  assert.ok(dj.added.length >= 1)

  // 清单 + latest 指向
  const list = await fetch(`${base}/memory/snapshots`, { headers: AUTH })
  assert.equal(list.status, 200)
  const lj = await list.json()
  assert.ok(lj.ok)
  assert.equal(lj.latest, hash)
  assert.ok(lj.snapshots.some((s) => s.hash === hash))

  // 未知快照 → 404
  const nf = await fetch(`${base}/memory/diff?since=${'f'.repeat(64)}`, { headers: AUTH })
  assert.equal(nf.status, 404)
})

test('E5:建议确认队列(队列分支=显式 ECOLLINK_AUTO_CONFIRM=0;确认后入池;拒绝移除;未确认不进池)', async () => {
  // 独立子进程:显式 ECOLLINK_AUTO_CONFIRM='0' → sync 进建议队列。
  // (2026-09-14 设计纠正:生产默认 autoConfirm=true 直入池,队列代码保留、显式关断才走。
  //  教训:子进程会读到真实 config.json,不固定 env 就会被用户配置污染——曾因此
  //  E5 断言失败 + sugChild 没被杀 → 孤儿进程吊死整个套件,故下面必须 try/finally)
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-sug-'))
  const sugPort = 20000 + Math.floor(Math.random() * 20000)
  const sugChild = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
    env: { ...process.env, ECOLLINK_PORT: String(sugPort), ECOLLINK_POOL_DIR: dir, ECOLLINK_TOKEN: TEST_TOKEN, ECOLLINK_AUTO_CONFIRM: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const sugBase = `http://127.0.0.1:${sugPort}`
    const AUTH = { 'X-Ecolink-Token': TEST_TOKEN }
    for (let i = 0; i < 50; i++) {
      try {
        const resp = await fetch(`${sugBase}/memory/status`, { headers: AUTH })
        if (resp.ok) break
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 100))
    }

    // sync(队列模式)→ queued:1,added:0(F1 形状保留);/memory/pool 看不到
    const s1 = await fetch(`${sugBase}/memory/sync`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memories: [{ content: '建议条目甲' }] }),
    })
    assert.equal(s1.status, 200)
    const r1 = await s1.json()
    assert.equal(r1.ok, true)
    assert.equal(r1.added, 0)
    assert.equal(r1.queued, 1)
    const poolView1 = await (await fetch(`${sugBase}/memory/pool`, { headers: AUTH })).json()
    assert.equal(poolView1.shared_pool.length, 0) // 未确认绝不入池

    // 列表可见;显式 /memory/suggest 同样进队列
    const sug2 = await fetch(`${sugBase}/memory/suggest`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memories: [{ content: '建议条目乙' }] }),
    })
    assert.equal((await sug2.json()).queued, 1)
    const listResp = await fetch(`${sugBase}/memory/suggestions`, { headers: AUTH })
    const list = await listResp.json()
    assert.equal(list.suggestions.length, 2)
    const idA = list.suggestions.find((s) => s.content === '建议条目甲')?.id
    const idB = list.suggestions.find((s) => s.content === '建议条目乙')?.id
    assert.ok(idA && idB)

    // 确认甲 → 入池 + 队列减一
    const conf = await fetch(`${sugBase}/memory/suggest/confirm`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idA }),
    })
    const cr = await conf.json()
    assert.equal(cr.confirmed, 1)
    assert.equal(cr.added, 1)
    const poolView2 = await (await fetch(`${sugBase}/memory/pool`, { headers: AUTH })).json()
    assert.equal(poolView2.shared_pool.length, 1)
    assert.equal(poolView2.shared_pool[0].content, '建议条目甲')

    // 拒绝乙 → 直接丢弃
    const rej = await fetch(`${sugBase}/memory/suggest/reject`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idB }),
    })
    assert.equal((await rej.json()).rejected, 1)
    const list2 = await (await fetch(`${sugBase}/memory/suggestions`, { headers: AUTH })).json()
    assert.equal(list2.suggestions.length, 0)

    // 不存在的 id:confirm/reject 幂等不抛
    const confMiss = await fetch(`${sugBase}/memory/suggest/confirm`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'nope' }),
    })
    assert.equal((await confMiss.json()).confirmed, 0)

    // 请求体 confirm:true = 逐请求直入(压缩闭环/手动保存用,绕过建议队列)
    const cDirect = await fetch(`${sugBase}/memory/sync`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, memories: [{ content: '显式直入条目' }] }),
    })
    const rDirect = await cDirect.json()
    assert.equal(rDirect.added, 1)
    assert.equal(rDirect.queued, 0)
    const poolView3 = await (await fetch(`${sugBase}/memory/pool`, { headers: AUTH })).json()
    assert.equal(poolView3.shared_pool.length, 2) // 确认的甲 + 直入条目

    // 持久化:suggestions.json 落盘、重启(新 pool 实例)后队列还在
    await fetch(`${sugBase}/memory/suggest`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memories: [{ content: '重启前的建议' }] }),
    })
    sugChild.kill()
    const { createPool } = await import('./pool.mjs')
    const pool2 = createPool({ dir })
    assert.equal(pool2.listSuggestions().suggestions.length, 1)
  } finally {
    // 断言失败也必须杀子进程,否则孤儿进程带开 stdio 管道会把整个套件吊死(2026-09-14 事故)
    try { sugChild.kill() } catch { /* noop */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('E7:黑名单拦截(sync/建议/确认/DSM 导入,落盘前拒收)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-bl-'))
  const pool = createPool({ dir, blacklist: ['机密', 'PASSWORD'] })

  // sync:命中的拒收(blocked 计数),干净条目正常入库
  const r1 = await pool.sync({ memories: [{ content: '包含机密文件的内容' }, { content: '正常记忆' }] })
  assert.equal(r1.added, 1)
  assert.equal(r1.blocked, 1)
  assert.equal(pool.pool().shared_pool.length, 1)

  // 大小写不敏感
  const r2 = await pool.sync({ memories: [{ content: 'my password is 123' }] })
  assert.equal(r2.added, 0)
  assert.equal(r2.blocked, 1)

  // 建议队列同样拦截
  const r3 = await pool.suggest({ memories: [{ content: '机密事项' }, { content: '干净事项' }] })
  assert.equal(r3.queued, 1)
  assert.equal(r3.blocked, 1)

  // 确认干净建议正常入池
  const id = pool.listSuggestions().suggestions[0]?.id
  const r4 = await pool.confirmSuggestion({ id })
  assert.equal(r4.added, 1)
  assert.equal(r4.blocked, 0)

  // DSM 导入同样拦截
  const r5 = await pool.importDsm([{ key: 'k', value: '机密值' }, { key: 'k2', value: '干净值' }])
  assert.equal(r5.added, 1)
  assert.equal(r5.blocked, 1)

  rmSync(dir, { recursive: true, force: true })
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

// E8-fix 回归:token 发现端点。扩展侧拿不到本地 config.json,必须能自动取回 token;
// 同时必须挡住"从别的网站发起"的读取。注意:简单跨源请求【不带】Origin → 403,
// 这正是防线所在,所以要分别断言"无 Origin 403"与"带页面 Origin 200"。
test('HTTP:token 发现端点(仅 chat.deepseek.com origin 可读)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecolink-tok-'))
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
    env: { ...process.env, ECOLLINK_PORT: String(port), ECOLLINK_POOL_DIR: dir, ECOLLINK_TOKEN: 'discover-me' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`${base}/memory/status`, { headers: { 'X-Ecolink-Token': 'discover-me' } })
      if (resp.ok) break
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 100))
  }

  // 预检必须放行(否则浏览器连取 token 的请求都发不出去)
  const opt = await fetch(`${base}/memory/token`, { method: 'OPTIONS' })
  assert.equal(opt.status, 204)

  // 无 Origin(= 别的网站的简单跨源请求)→ 拒绝
  const noOrigin = await fetch(`${base}/memory/token`)
  assert.equal(noOrigin.status, 403)

  // 伪造 origin → 拒绝
  const forged = await fetch(`${base}/memory/token`, { headers: { Origin: 'https://evil.example' } })
  assert.equal(forged.status, 403)

  // 正确的页面 origin → 放行并给出 token
  const ok = await fetch(`${base}/memory/token`, { headers: { Origin: 'https://chat.deepseek.com' } })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).token, 'discover-me')

  // 该端点不得顺带泄漏别的数据
  const body = await (await fetch(`${base}/memory/token`, { headers: { Origin: 'https://chat.deepseek.com' } })).text()
  assert.ok(!body.includes('shared_pool') && !body.includes('session_pools'))

  child.kill()
  rmSync(dir, { recursive: true, force: true })
})
