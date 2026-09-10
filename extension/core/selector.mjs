// 注入选择器(PLAN §3.5):打分排序 + token 预算 + #记忆名 显式调用。
// 打分:关键词重叠(内容 2-gram 命中 ×5)+ 会话名匹配 ×15 + 时间衰减 + 访问计数 + pinned。
// 预算:maxInjectionChars(默认 3000 字符),长提示词自动缩减。
// ⚠ 双份维护:inject.js 有本文件的经典脚本内联镜像(页面世界无法 import ESM)。
// 本文件是规范与单测基准;改逻辑时必须同步 inject.js 的 selectMemories/effectiveBudget/parseMemoryCommand。

export const SCOPE_PREFIX = '[dsh-ecolink 记忆]'

// 中文友好的大块匹配:内容 2-gram 与提示词 2-gram 的重叠命中数
export function bigrams(s) {
  const t = String(s ?? '')
  if (t.length < 2) return new Set()
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}

export function keywordHits(content, promptBigrams, promptLower) {
  const c = String(content ?? '')
  const cb = bigrams(c)
  let hits = 0
  for (const g of cb) if (promptBigrams.has(g)) hits += 1
  // 整词附加分(英文/数字词)
  const words = promptLower.split(/[^\w一-龥]+/).filter((w) => w.length >= 2)
  const cl = c.toLowerCase()
  for (const w of words) if (cl.includes(w)) hits += 2
  return hits
}

export function scoreItem(item, prompt, now = Date.now()) {
  const promptLower = String(prompt ?? '').toLowerCase()
  const pb = bigrams(promptLower)
  const content = item?.content ?? ''
  let score = Math.min(20, keywordHits(content, pb, promptLower) * 5)
  // 会话名匹配(identity 即"名字",权重 ×15)
  const identity = item?.identity
  if (identity && promptLower.includes(String(identity).toLowerCase())) score += 15
  // 时间衰减:越新越相关(半衰 ~7 天)
  const ts = new Date(item?.timestamp).getTime()
  if (Number.isFinite(ts)) {
    const ageDays = Math.max(0, (now - ts) / 86400e3)
    score += 10 / (1 + ageDays / 7)
  }
  // 访问过的记忆加权(选择器自举:用过的更可能再用)
  if (item?.last_accessed) score += 5
  if (item?.pinned) score += 10
  return score
}

// 在预算内精选:按分数排序取前 N,单条截断到 500 字符
export function selectMemories(items, prompt, budgetChars = 3000, now = Date.now()) {
  const scored = items
    .map((item) => ({ item, score: scoreItem(item, prompt, now) }))
    .sort((a, b) => b.score - a.score || (b.item?.timestamp ?? '').localeCompare(a.item?.timestamp ?? ''))
  const chosen = []
  let used = 0
  for (const { item } of scored) {
    const content = String(item?.content ?? '').trim()
    if (!content) continue
    const capped = content.length > 500 ? content.slice(0, 500) + '…' : content
    const cost = capped.length + 24 // 条目头部格式开销
    if (used + cost > budgetChars) break
    chosen.push({ ...item, content: capped })
    used += cost
  }
  return { memories: chosen, chars: used }
}

// 长提示词自动缩减预算:提示词本身越长,留给记忆的空间越小
export function effectiveBudget(prompt, maxInjectionChars = 3000) {
  const len = String(prompt ?? '').length
  if (len <= 5000) return maxInjectionChars
  if (len <= 12000) return Math.floor(maxInjectionChars * 0.5)
  return Math.floor(maxInjectionChars * 0.25)
}

// #记忆名 显式调用(PLAN §3.5,WebTool parseMemoryCommand 模式):
// 提示词里的 "#<会话名>" 命中会话池 identity → 只注入该会话的记忆,返回会话 id
export function parseMemoryCommand(prompt, sessionPools) {
  const m = /#([^\s#,，。.!?？、#]{1,40})/.exec(String(prompt ?? ''))
  if (!m) return null
  const name = m[1].trim()
  if (!name) return null
  for (const [sid, pool] of Object.entries(sessionPools ?? {})) {
    if (pool?.identity && String(pool.identity).toLowerCase() === name.toLowerCase()) return sid
  }
  return null
}
