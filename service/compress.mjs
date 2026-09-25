// 备用 API 压缩模式(PLAN §4.4 v3 补):网页端压缩是默认主路径,模型不服从时
// 用一次 Flash API 调用完成压缩(符合成本原则:万不得已的 API 只用 Flash)。
// 复用 extension/core/harvest.mjs 的标签解析(同源逻辑,不重复实现)。

import { harvestFromText } from '../extension/core/harvest.mjs'

// 与 inject.js 的 COMPRESS_INSTRUCTION 保持同步(以 inject.js 为网页端主路径基准;
// 2026-09-25 起网页版多一段"验收规则"明示——API 路径的验收由代码强制,无需在提示词里重复)。
// 2026-09-25 第三版:模型自报重复数——清单里的完全重复/高度重叠条目由模型在压缩时统计,
// 说明里写"压缩完成(重复 N 条)",service 按 (总数-N)*2/3 动态算下限(仅内容级去重永远
// 低估语义重复,模型才是重复的最终裁判)。
export const COMPRESS_INSTRUCTION = '记忆压缩任务。下面是记忆池里的旧记忆清单,每行格式:方括号内是该条的 key(英文标识),冒号后是内容。请逐条阅读后压缩合并:只合并内容明显重复或高度重叠的条目,不同主题必须各自保留、分别输出标签,任何旧记忆的信息都不得丢弃;宁可多输出几条也禁止过度合并——标签总数应接近清单总数减去你报告的重复数 N,明显偏少说明你过度合并了。压缩完成后,在回复开头先写一行说明,格式:压缩完成(重复 N 条)——N 是你统计出的清单里内容完全重复或高度重叠、应直接合并或去掉的条数。然后在说明之后逐条输出压缩结果,即使标签很多也必须全部输出,禁止省略、禁止写"其余略"。每条标签必须写成完整属性形式:<DSM:memory_write key="snake_case_key" importance="always">事实内容</DSM:memory_write>。key 规则:内容未变的条目必须沿用清单里方括号中的原 key;只有合并或改写时才生成新 key(小写单词用下划线连接)。importance 按重要性写 always 或 called。输出前逐条核对原文,确保没有遗漏和编造。只输出说明和标签,不要输出其他文字。'

// 从模型输出里提取自报重复数(说明行"压缩完成(重复 N 条)");无报告返回 0
export function extractDupReport(text) {
  const m = /压缩完成\s*[(（]\s*重复\s*(\d+)\s*条\s*[)）]/.exec(String(text ?? ''))
  return m ? Number(m[1]) : 0
}

// 数量下限(旧版):少于该值视为过度合并,调用方应拒绝删除旧条目
export function minExpectedTags(oldCount) {
  return oldCount <= 2 ? 1 : Math.ceil(oldCount * 2 / 3)
}

// 动态下限(2026-09-25):dup = max(模型自报, 内容级精确去重),夹在 [0, total-1];
// 下限 = max((total-dup)*2/3, total/10)——兜底只做极端失真防护(1/10),重复很多的池子
// (如 278/327 自报重复)不再被高兜底误杀;防模型夸大自报靠 pendingConfirm 人工闸门(见 server)。
export function effectiveMinTags(total, dupReport = 0, exactDup = 0) {
  const dup = Math.min(Math.max(Number(dupReport) || 0, Number(exactDup) || 0), Math.max(1, total - 1))
  return Math.max(Math.ceil((total - dup) * 2 / 3), Math.ceil(total / 10))
}

// 每块条目上限:chat 无推理开销,60 条/块在 16384 max_tokens 内余量充足
const BATCH_SIZE = 60

// 2026-09-25:清单预去重——池层事故后存在大量内容完全重复的条目(新 key 重吐旧内容),
// 喂给模型只会浪费输入并触发"下限 vs 正确合并"的矛盾。按内容去重,优先保留带 key 的
// 代表条目(模型可复用其 key);删除时由调用方对**原始全量**执行,重复条目一并清掉。
export function dedupeByContent(items) {
  const seen = new Set()
  const out = []
  for (const it of items ?? []) {
    const c = String(it.content ?? '').trim()
    if (!c || seen.has(c)) continue
    seen.add(c)
    out.push(it)
  }
  return out
}

export async function compressWithApi({ apiKey, baseUrl = 'https://api.deepseek.com/v1', oldItems, model = 'deepseek-chat' }) {
  const lines = [COMPRESS_INSTRUCTION, '', '旧记忆清单:']
  for (const it of oldItems ?? []) lines.push(`- [${it.key ?? '-'}] ${it.content ?? ''}`)
  const prompt = lines.join('\n')
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, // 2026-09-25:flash 系推理烧预算,chat 零推理(实测)
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16384,
    }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!resp.ok) throw new Error(`DeepSeek API ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  const data = await resp.json()
  const msg = data?.choices?.[0]?.message
  // 推理模型(content 空)兜底 reasoning_content;正常 chat content 优先
  const text = String(msg?.content || msg?.reasoning_content || '').trim()
  if (!text) throw new Error('API 返回空内容')
  const { memories } = harvestFromText(text)
  if (memories.length === 0) throw new Error('API 输出中没有有效标签')
  return { memories, reportedDup: extractDupReport(text) }
}

// 分块压缩:大池一次调用会超 output 预算,按块调用后合并;任一块不达标即抛错(不删任何旧条目)
// 输入先按内容预去重(重复条目不进 prompt);下限按"模型自报重复数"动态计算。
// 返回 { memories, reportedDup }:reportedDup 为各块自报之和(调用方用于人工确认闸门)。
export async function compressChunked({ apiKey, oldItems, batchSize = BATCH_SIZE }) {
  const items = dedupeByContent(oldItems)
  const out = []
  let totalDup = 0
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize)
    const { memories, reportedDup } = await compressWithApi({ apiKey, oldItems: chunk })
    // 块级动态下限:模型自报的重复数放宽下限,兜底 1/10 防极端失真
    const floor = effectiveMinTags(chunk.length, reportedDup)
    if (memories.length < floor) {
      throw new Error(`第 ${Math.floor(i / batchSize) + 1} 块输出标签过少(${memories.length}/${chunk.length},自报重复 ${reportedDup},下限 ${floor}),疑似过度合并,已拒绝`)
    }
    out.push(...memories)
    totalDup += reportedDup
  }
  // 总下限:合并后仍须覆盖(总量-自报重复)的三分之二,兜底 1/10
  const totalFloor = effectiveMinTags(items.length, totalDup)
  if (out.length < totalFloor) {
    throw new Error(`总输出标签过少(${out.length}/${items.length},自报重复 ${totalDup},下限 ${totalFloor}),疑似过度合并,已拒绝`)
  }
  return { memories: out, reportedDup: totalDup }
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
