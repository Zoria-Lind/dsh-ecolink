// 备用 API 压缩模式(PLAN §4.4 v3 补):网页端压缩是默认主路径,模型不服从时
// 用一次 Flash API 调用完成压缩(符合成本原则:万不得已的 API 只用 Flash)。
// 复用 extension/core/harvest.mjs 的标签解析(同源逻辑,不重复实现)。

import { harvestFromText } from '../extension/core/harvest.mjs'

// 与 inject.js 的 COMPRESS_INSTRUCTION 保持同步(以 inject.js 为网页端主路径基准)
export const COMPRESS_INSTRUCTION = '记忆压缩任务。下面是记忆池里的旧记忆,请逐条阅读后压缩合并:去掉重复条目,内容相近的合并成一条,保留日期、数字和专有名词。压缩完成后,在回复末尾逐条输出压缩结果。每条标签的写法(必须完全一致):以 <DSM:memory_write> 开头,紧接着写该条内容,以 </DSM:memory_write> 结尾,三部分连在一起,中间不要空格或换行。输出前逐条核对原文,确保没有遗漏和编造。只输出标签,不要输出解释或其他文字。'

export async function compressWithApi({ apiKey, baseUrl = 'https://api.deepseek.com/v1', oldItems }) {
  const lines = [COMPRESS_INSTRUCTION, '', '旧记忆清单:']
  for (const it of oldItems ?? []) lines.push('- ' + (it.content ?? ''))
  const prompt = lines.join('\n')
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash-vision-exp', // v4Flash 别名已路由到 4.1 Flash
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!resp.ok) throw new Error(`DeepSeek API ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  const data = await resp.json()
  const text = data?.choices?.[0]?.message?.content ?? ''
  if (!text || text.trim().length === 0) throw new Error('API 返回空内容')
  const { memories } = harvestFromText(text)
  if (memories.length === 0) throw new Error('API 输出中没有有效标签')
  return memories
}

// 应用压缩结果:新记忆写入(key upsert 由 pool.sync 处理),内容未变的旧条目删除
// (与网页端流程的"完成压缩"同语义;简化为新记忆统一进共享池)
// ⚠ 顺序:先删后写——模型输出常含"保持原样"的条目,与旧条目同内容;
// 若先写,pool 的内容去重会跳过新条目,随后删除旧条目 → 该记忆彻底消失(实测事故)
export async function applyCompression(pool, oldItems, memories) {
  const all = [
    ...(pool.pool().shared_pool ?? []),
    ...Object.values(pool.pool().session_pools ?? {}).flatMap((sp) => sp.memories ?? []),
  ]
  const byId = new Map(all.map((it) => [it.id, it]))
  const toDelete = []
  for (const old of oldItems ?? []) {
    const cur = byId.get(old.id)
    if (cur && cur.content === old.content) toDelete.push(old.id)
  }
  const deleted = toDelete.length > 0 ? (await pool.deleteMemories({ ids: toDelete })).deleted : 0
  const syncResult = await pool.sync({ memories })
  return { added: syncResult.added, deleted }
}
