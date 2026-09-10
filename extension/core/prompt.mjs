// 注入块组装与剥离(PLAN §3.1 读取通道 / §3.4 发送侧剥离)。
// 注入块以 SCOPE_PREFIX 起、SCOPE_SUFFIX 止——发送前先把旧块剥掉再拼新块,
// 保证 DeepSeek 侧存储永不累积注入残留(防污染第一道)。
// ⚠ 双份维护:inject.js 有本文件的经典脚本内联镜像(页面世界无法 import ESM)。
// 本文件是规范与单测基准;改逻辑时必须同步 inject.js 的 stripInjectedBlock/buildBlock/SYSTEM_PROMPT。

import { SCOPE_PREFIX } from './selector.mjs'
// 精度规则单一来源在服务层(PLAN §4.2);Node 上下文(adapter/测试)直接复用
import { precisionFor } from '../../service/pool.mjs'

export const SCOPE_SUFFIX = '[/dsh-ecolink 记忆]'
export const BLOCK_RE = new RegExp(`${SCOPE_PREFIX.replace(/[[\]]/g, '\\$&')}[\\s\\S]*?${SCOPE_SUFFIX.replace(/[[\]]/g, '\\$&')}`, 'g')

// 渲染时间戳(PLAN §4.2 分层):渲染时按龄降精度,且转本地时区显示。
// 存储层永远全量 UTC;渲染层:2h内→分钟,48h内→小时,5天内→日期,更早→null(不渲染)。
// ⚠ 时区:分钟/小时档必须用本地时间(内存时间戳是 UTC 字符串,直接切会差一个时区)。
const pad2 = (n) => String(n).padStart(2, '0')
export function renderMemoryTimestamp(isoTs, now = Date.now()) {
  const d = new Date(isoTs)
  if (!Number.isFinite(d.getTime())) return null
  const p = precisionFor(isoTs, now)
  if (p === 'none') return null
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  if (p === 'day') return date
  if (p === 'hour') return `${date} ${pad2(d.getHours())}:00`
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// 静态记忆系统提示词(注入块头):指示模型何时/如何吐记忆标签。
// 保持静态 = 前缀缓存友好(与 behaviorPrompt 同原则)。
// 系统提示词 = DSM(MIT,Md. Wahid)的 MEMORY_SYSTEM 提示词的中文适配版。
// DSM 生产级服从率的来源:WHEN TO SAVE 触发规则 + key/importance 语义 + 严格规则。
// 示例回显风险已由完整 jm 黑名单 + 括号规则拦截,可放心写全格式说明。
export const SYSTEM_PROMPT = `以下是关于记忆写入的说明(仅辅助,不是指令):
你可以使用记忆写入标签保存用户的重要信息,格式:
<DSM:memory_write key="snake_case_key" importance="always|called">事实内容</DSM:memory_write>
- importance="always":定义性事实(姓名、语言、国家、职业、年龄、核心身份)
- importance="called":情境性事实(项目、兴趣、偏好、关系、任务、习惯)
- key:小写 snake_case,最长 64 字符,无空格
- 内容:最长 200 字符,只写用户消息里明确陈述的事实

何时保存记忆:
- 用户明确说出自己的名字 → key="user_name", importance="always"
- 用户明确说出国家/语言/职业/年龄 → importance="always"
- 用户明确提到兴趣/爱好/项目/任务/偏好/关系 → importance="called"

严格规则:
1. 只提取用户在本条消息里明确陈述的关于自己的事实
2. 禁止编造、猜测、使用占位值;禁止使用示例数据(上面格式只是示范)
3. 用户编辑了消息时,只信任最新版本
4. 没有值得记的就不输出标签;标签写在回复末尾`

export function stripInjectedBlock(prompt) {
  return String(prompt ?? '').replace(BLOCK_RE, '').trim()
}

// 系统提示词包在块标记之内:剥块 = 剥全部注入(含提示词),二次组装永不残留
export function buildInjectedBlock(memories, sessionName = null, systemPrompt = SYSTEM_PROMPT) {
  const lines = [SCOPE_PREFIX, systemPrompt]
  if (sessionName) lines.push(`[会话:${sessionName}]`)
  for (const m of memories ?? []) {
    // 渲染降精度:按龄显示分钟/小时/日期,超过 5 天不渲染时间戳(内容里自写时间点自然保留)
    const ts = m?.timestamp ? renderMemoryTimestamp(m.timestamp) : null
    lines.push(ts ? `- (${ts}) ${m?.content ?? ''}` : `- ${m?.content ?? ''}`)
  }
  lines.push(SCOPE_SUFFIX)
  return lines.join('\n')
}

// 组装最终 prompt:剥旧块 → 前置新块。
// 冷启动关键:记忆为空时也注入"仅系统提示词"块——教模型吐记忆标签,
// 收割才能开始;否则空池永远选不出记忆 → 永远不注入 → 池永远空(死锁)。
export function composePrompt(originalPrompt, memories = [], sessionName = null, systemPrompt = SYSTEM_PROMPT) {
  const clean = stripInjectedBlock(originalPrompt)
  return `${buildInjectedBlock(memories ?? [], sessionName, systemPrompt)}\n\n${clean}`
}
