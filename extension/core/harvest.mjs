// 标签收割:从模型回复流中提取 <DSM:memory_write> 标签(PLAN §3.1 主路径)。
// 纯函数、无浏览器依赖——SSE 累积文本在流结束时一次提取,标签从文本中剥离
// (ReadableStream 重写层保证标签永不进 DOM)。
// 黑名单校验参照 DSM 的 isValidMemoryWrite 模式:模型不服从/吐垃圾时宁弃勿存。

const DEFAULT_TAG = 'DSM:memory_write'

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 标签内容允许的简短修饰前缀(如 "importance:key|内容"),其余视为纯文本
const PREFIX_RE = /^(?:importance\s*:\s*(key|called|temp|context)\s*\|)/i
// DSM 属性形式:<DSM:memory_write key="snake_key" importance="always|called">value</DSM:memory_write>
// 模型对 DSM 格式有惯性,兼容吸收,服从率最高
const ATTR_RE = /^<DSM:memory_write\s+key="[^"]*"\s+importance="(always|called)">([\s\S]*?)<\/DSM:memory_write>$/i

// 模型常见不服从输出:占位/元话/自我描述/格式示例回显,一律不收(黑名单)。
// DSM 同款防御(其 zm 校验函数实测对抗有效):
//   ① 杀手规则——值含方括号/花括号/尖括号一律拒([fact from user's message]、
//      <tag> 回显等整类垃圾一条规则通杀;真实记忆极少含这三种括号,代价可接受)
//   ② 黑名单子串匹配(非锚定,更宽)
//   ③ user_name 长度 sanity
const BRACKET_RE = /\[.*?\]|\{.*?\}|<.*?>/
const STANDALONE_RE = /^(待补充|待填写|待确认|TODO|TBD|\.\.\.|暂无|无|空|memory[_ ]?write)$/i
// DSM(MIT,Md. Wahid)完整黑名单 + 本项目的增量条目(指令回显等)
const SUBSTRING_BLACKLIST = [
  ...['example_name', 'extracted_name', 'extracted_country', 'extracted_language', 'placeholder', 'example', '[fact from user', '[extracted_', '[user_name]', '[user_country]', '[user_language]', 'your_name_here', 'your_country_here', 'sample_name'],
  ...['brief fact', 'snake_case_key', 'fact from user', '记忆内容', '输出记忆标签', 'key: fact', '开头,紧接着写事实,以', '开头,紧接着写该条内容,以', '三部分连在一起', '事实内容', 'snake_case_key'],
]
const KEY_BLACKLIST = new Set(['snake_case_key', 'example', 'example_name', 'example_key', 'placeholder', 'sample', 'key'])

export function extractTags(text, tagName = DEFAULT_TAG) {
  const safe = escapeRe(tagName)
  const plainRe = new RegExp(`<${safe}>([\\s\\S]*?)</${safe}>`, 'gi')
  const attrRe = new RegExp(`<${safe}\\s+key="[^"]*"\\s+importance="[^"]*">[\\s\\S]*?</${safe}>`, 'gi')
  const memories = []
  // 前端可能把标签转义渲染(&lt;DSM:memory_write&gt;),先还原再解析(DSM Gr 同款)
  const cleaned = String(text ?? '').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    // 属性形式保留完整标签(parseTagContent 要读属性),纯文本形式只取内容
    .replace(attrRe, (all) => { memories.push(all); return '' })
    .replace(plainRe, (_all, inner) => { memories.push(inner); return '' })
  return { cleaned, memories }
}

export function parseTagContent(raw) {
  let s = String(raw ?? '').trim()
  const m = PREFIX_RE.exec(s)
  if (m) return { importance: m[1].toLowerCase(), content: s.slice(m[0].length).trim(), key: null }
  // DSM 属性形式(整段 raw 含属性标签时):提取 key/value/importance
  // (key = 压缩/更新闭环的锚点:同 key 覆盖旧值,PLAN §4.4 replace 指令的天然载体)
  const a = ATTR_RE.exec(s)
  if (a) {
    const key = /key="([^"]*)"/i.exec(s)?.[1]?.trim() || null
    return { importance: a[1] === 'always' ? 'key' : 'called', content: a[2].trim(), key }
  }
  return { importance: 'called', content: s, key: null }
}

// 收割侧校验:括号规则 + 黑名单 + 长度上限 + 示例 key 拒绝,返回 null 表示丢弃
export function isValidMemoryWrite(content, key = null) {
  const s = String(content ?? '').trim()
  if (s.length === 0 || s.length > 2000) return false
  if (BRACKET_RE.test(s)) return false
  if (key != null && KEY_BLACKLIST.has(String(key).trim().toLowerCase())) return false
  if (STANDALONE_RE.test(s)) return false
  const lower = s.toLowerCase()
  for (const bad of SUBSTRING_BLACKLIST) {
    if (lower.includes(bad)) return false
  }
  if (String(key ?? '').toLowerCase() === 'user_name' && s.length < 2) return false
  return true
}

// 对整段流文本做收割:提取 → 校验 → 返回 { cleaned, memories }
export function harvestFromText(text, tagName = DEFAULT_TAG) {
  const { cleaned, memories } = extractTags(text, tagName)
  const out = []
  for (const raw of memories) {
    const parsed = parseTagContent(raw)
    if (isValidMemoryWrite(parsed.content, parsed.key)) {
      out.push({ content: parsed.content, importance: parsed.importance, source: 'web', key: parsed.key ?? null })
    }
  }
  return { cleaned, memories: out }
}
