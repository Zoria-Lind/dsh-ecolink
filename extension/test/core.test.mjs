// dsh-ecolink-web 核心模块单测:node --test extension/test/core.test.mjs(零浏览器)
// 收割/选择器/提示词/离线队列全部纯函数化,chrome API 以注入的假实现替代。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractTags, parseTagContent, isValidMemoryWrite, harvestFromText } from '../core/harvest.mjs'
import { scoreItem, selectMemories, effectiveBudget, parseMemoryCommand, bigrams, keywordHits } from '../core/selector.mjs'
import { stripInjectedBlock, buildInjectedBlock, composePrompt, SYSTEM_PROMPT, BLOCK_RE, SCOPE_SUFFIX } from '../core/prompt.mjs'
import { createOfflineQueue } from '../core/queue.mjs'

// ---- harvest ----
test('harvest:提取/清洗/多条/前缀解析', () => {
  const text = '前面正文\n<DSM:memory_write>用户偏好短标题</DSM:memory_write>\n后面正文\n<DSM:memory_write>importance:key|项目约定:先读后写</DSM:memory_write>'
  const { cleaned, memories } = harvestFromText(text)
  assert.equal(memories.length, 2)
  assert.equal(memories[0].content, '用户偏好短标题')
  assert.equal(memories[0].importance, 'called')
  assert.equal(memories[1].content, '项目约定:先读后写')
  assert.equal(memories[1].importance, 'key')
  assert.ok(!cleaned.includes('DSM:memory_write'))
  assert.ok(cleaned.includes('前面正文'))
  assert.ok(cleaned.includes('后面正文'))
})

test('harvest:HTML 转义标签(&lt;/&gt;)也能收割', () => {
  // 前端把标签转义渲染时,文本节点里是 &lt;DSM:memory_write&gt; 形式(实测事故)
  const text = '&lt;DSM:memory_write&gt;Zoria Lind&lt;/DSM:memory_write&gt;\n&lt;DSM:memory_write&gt;喜欢短标题&lt;/DSM:memory_write&gt;'
  const { cleaned, memories } = harvestFromText(text)
  assert.equal(memories.length, 2)
  assert.equal(memories[0].content, 'Zoria Lind')
  assert.equal(memories[1].content, '喜欢短标题')
  assert.ok(!cleaned.includes('memory_write'))
})

test('harvest:DSM 属性格式兼容(key/importance)', () => {
  // 模型对 DSM 格式有惯性,兼容吸收
  const text = '<DSM:memory_write key="user_name" importance="always">Zoria</DSM:memory_write>'
  const { cleaned, memories } = harvestFromText(text)
  assert.equal(memories.length, 1)
  assert.equal(memories[0].content, 'Zoria')
  assert.equal(memories[0].importance, 'key')
  assert.equal(memories[0].key, 'user_name')
  assert.ok(!cleaned.includes('DSM:memory_write'))
  // 混合:属性形式 + 纯文本形式
  const mixed = harvestFromText(text + '\n<DSM:memory_write>喜欢短标题</DSM:memory_write>')
  assert.equal(mixed.memories.length, 2)
  assert.equal(mixed.memories[1].importance, 'called')
})

test('harvest:黑名单与长度校验(模型不服从时宁弃勿存)', () => {
  const cases = [
    '<DSM:memory_write></DSM:memory_write>',          // 空
    '<DSM:memory_write>待补充</DSM:memory_write>',      // 占位
    '<DSM:memory_write>memory_write</DSM:memory_write>', // 标签名回显
    `<DSM:memory_write>${'长'.repeat(2001)}</DSM:memory_write>`, // 超长
    // DSM 示例垃圾(括号规则通杀)
    '<DSM:memory_write>[fact from user\'s message]</DSM:memory_write>',
    '<DSM:memory_write><DSM:memory_write key="snake_case_key" importance="always|called">Brief fact</DSM:memory_write></DSM:memory_write>',
    '<DSM:memory_write key="snake_case_key" importance="always">Brief fact</DSM:memory_write>',
    '<DSM:memory_write key="user_name" importance="always">x</DSM:memory_write>',
  ]
  for (const c of cases) {
    assert.equal(harvestFromText(c).memories.length, 0, `应丢弃: ${c.slice(0, 30)}`)
  }
  // 正常内容通过
  assert.equal(harvestFromText('<DSM:memory_write>用户在做微积分补考准备</DSM:memory_write>').memories.length, 1)
  // 无标签 → 原样返回
  const plain = harvestFromText('没有标签的普通回复')
  assert.equal(plain.cleaned, '没有标签的普通回复')
  assert.equal(plain.memories.length, 0)
})

// ---- selector ----
test('selector:打分(会话名命中 > 关键词 > 旧记忆)与预算截断', () => {
  const now = Date.now()
  const items = [
    { content: '微积分补考范围是前三章', identity: '微积分补考', timestamp: new Date(now - 86400e3).toISOString() },
    { content: '用户喜欢短标题', timestamp: new Date(now - 86400e3).toISOString() },
    { content: '与微积分无关的老旧内容', timestamp: new Date(now - 90 * 86400e3).toISOString() },
  ]
  const prompt = '帮我复习微积分补考的内容'
  const { memories, chars } = selectMemories(items, prompt, 1000, now)
  assert.equal(memories[0].identity, '微积分补考') // 名+关键词双命中排第一
  assert.ok(chars <= 1000)
  assert.equal(memories.length, 3)
  // 预算收紧 → 只有第一名
  const tight = selectMemories(items, prompt, 60, now)
  assert.equal(tight.memories.length, 1)
  // 超长内容截断到 500 字符
  const long = [{ content: '长'.repeat(800), timestamp: new Date(now).toISOString() }]
  const sel = selectMemories(long, '长', 3000, now)
  assert.equal(sel.memories[0].content.length, 501) // 500 + …
})

test('selector:effectiveBudget 长提示词缩减 / #记忆名 显式调用', () => {
  assert.equal(effectiveBudget('短'.repeat(100), 3000), 3000)
  assert.equal(effectiveBudget('长'.repeat(6000), 3000), 1500)
  assert.equal(effectiveBudget('长'.repeat(15000), 3000), 750)
  const pools = { 's1': { identity: '微积分补考', memories: [] } }
  assert.equal(parseMemoryCommand('帮我复习 #微积分补考 内容', pools), 's1')
  assert.equal(parseMemoryCommand('普通消息没有指令', pools), null)
  assert.equal(parseMemoryCommand('#不存在的会话', pools), null)
})

test('selector:bigrams 与 keywordHits 中文匹配', () => {
  const pb = bigrams('微积分补考范围')
  assert.ok(keywordHits('微积分补考范围是前三章', pb, '微积分补考范围') >= 4)
  assert.equal(keywordHits('完全无关的英文内容', pb, '微积分补考范围'), 0)
})

// ---- prompt ----
test('prompt:注入块剥离幂等 + 组装', () => {
  const base = '用户的问题正文'
  const block = buildInjectedBlock([{ content: '偏好短标题', timestamp: '2026-09-10T00:00:00.000Z' }], '测试会话')
  assert.ok(block.startsWith('[dsh-ecolink 记忆]'))
  assert.ok(block.includes('会话:测试会话'))
  assert.ok(block.endsWith(SCOPE_SUFFIX))

  const composed = composePrompt(base, [{ content: '偏好短标题', timestamp: '2026-09-10T00:00:00.000Z' }], '测试会话')
  assert.ok(composed.includes(SYSTEM_PROMPT.slice(0, 20)))
  assert.ok(composed.includes('偏好短标题'))
  assert.ok(composed.includes('用户的问题正文'))

  // 二次组装不产生嵌套残留(发送侧剥离)
  const twice = composePrompt(composed, [{ content: '偏好短标题', timestamp: '2026-09-10T00:00:00.000Z' }], '测试会话')
  assert.equal((twice.match(/\[dsh-ecolink 记忆\]/g) ?? []).length, 1)

  // 剥离语义:stripInjectedBlock 负责除残留;compose 永远注入(空记忆=仅提示词块)
  const stripped = stripInjectedBlock(composed)
  assert.equal(stripped, '用户的问题正文')

  // 冷启动:空记忆也注入"仅系统提示词"块(教模型吐标签,防空池死锁)
  const cold = composePrompt('第一条消息', [], null)
  assert.ok(cold.includes(SYSTEM_PROMPT.slice(0, 20)))
  assert.ok((cold.match(/\[dsh-ecolink 记忆\]/g) ?? []).length === 1)
  assert.ok(!cold.includes('- (')) // 无记忆行
})

// ---- queue ----
function fakeStorage(initial = {}) {
  const store = { ...initial }
  return {
    get: async (key) => ({ [key]: store[key] }),
    set: async (obj) => { Object.assign(store, obj) },
    _store: store,
  }
}

test('queue:成功 flush 清空队列 + 保序', async () => {
  const storage = fakeStorage()
  const sent = []
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const q = createOfflineQueue({ storage, fetchImpl, bridgeUrl: 'http://127.0.0.1:17520', token: 't', baseDelayMs: 1 })
  await q.push({ kind: 'sync', payload: { memories: [{ content: 'a' }] } })
  await q.push({ kind: 'sync', payload: { memories: [{ content: 'b' }] } })
  await q.flush()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(sent.length, 2)
  assert.equal(sent[0].url, 'http://127.0.0.1:17520/memory/sync')
  assert.equal(sent[0].body.memories[0].content, 'a')
  assert.equal(sent[1].body.memories[0].content, 'b')
  assert.equal(await q.pendingCount(), 0)
})

test('queue:bridge 不可达 → 重试后保留队列(保序不跳过)', async () => {
  const storage = fakeStorage()
  const sent = []
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body))
    throw new Error('ECONNREFUSED')
  }
  const q = createOfflineQueue({ storage, fetchImpl, bridgeUrl: 'http://127.0.0.1:17520', maxRetries: 3, baseDelayMs: 1 })
  await q.push({ kind: 'sync', payload: { memories: [{ content: 'a' }] } })
  await q.push({ kind: 'sync', payload: { memories: [{ content: 'b' }] } })
  await q.flush()
  await new Promise((r) => setTimeout(r, 50))
  // 第一条重试 3 次全失败 → 停止,第二条从未尝试(保序)
  assert.equal(sent.length, 3)
  assert.equal(sent.every((s) => s.memories[0].content === 'a'), true)
  assert.equal(await q.pendingCount(), 2)
})

test('queue:恢复后补发 + token 头', async () => {
  const storage = fakeStorage()
  let down = true
  const headers = []
  const fetchImpl = async (_url, init) => {
    headers.push(init.headers)
    if (down) throw new Error('down')
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const q = createOfflineQueue({ storage, fetchImpl, bridgeUrl: 'http://127.0.0.1:17520', token: 'sekrit', maxRetries: 2, baseDelayMs: 1 })
  await q.push({ kind: 'sync', payload: { memories: [{ content: '恢复后补发' }] } })
  await q.flush()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(await q.pendingCount(), 1)
  down = false
  await q.flush()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(await q.pendingCount(), 0)
  assert.ok(headers.some((h) => h['X-Ecolink-Token'] === 'sekrit'))
})
