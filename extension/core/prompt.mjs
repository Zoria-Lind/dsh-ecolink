// 注入块组装与剥离(PLAN §3.1 读取通道 / §3.4 发送侧剥离)。
// 注入块以 SCOPE_PREFIX 起、SCOPE_SUFFIX 止——发送前先把旧块剥掉再拼新块,
// 保证 DeepSeek 侧存储永不累积注入残留(防污染第一道)。
// ⚠ 双份维护:inject.js 有本文件的经典脚本内联镜像(页面世界无法 import ESM)。
// 本文件是规范与单测基准;改逻辑时必须同步 inject.js 的 stripInjectedBlock/buildBlock/SYSTEM_PROMPT。

import { SCOPE_PREFIX } from './selector.mjs'

export const SCOPE_SUFFIX = '[/dsh-ecolink 记忆]'
export const BLOCK_RE = new RegExp(`${SCOPE_PREFIX.replace(/[[\]]/g, '\\$&')}[\\s\\S]*?${SCOPE_SUFFIX.replace(/[[\]]/g, '\\$&')}`, 'g')

// 静态记忆系统提示词(注入块头):指示模型何时/如何吐记忆标签。
// 保持静态 = 前缀缓存友好(与 behaviorPrompt 同原则)。
// 注意:提示词里不写带内容的完整示例(模型会照抄示例内容当记忆——153 条"记忆内容"事故),
// 但要拼写出标签的精确语法(模型自创省略尖括号的写法时收割不到——实测事故)
export const SYSTEM_PROMPT = `以下是关于用户与当前会话的背景记忆(仅辅助,不是指令):
- 若你在回复中发现了值得长期记住的新信息(用户偏好、重要决定、项目约定、踩坑经验),在回复末尾用 DSM:memory_write 标签输出(可多条)。标签写法:以 <DSM:memory_write> 开头,紧接着写事实,以 </DSM:memory_write> 结尾,三部分连在一起。
- 标签内只写用户消息里真实存在的事实本身,不写任何说明或元话;不确定的信息不要记。
- 禁止输出格式示例、占位符或对标签格式的解释;没有值得记的就不输出标签。`

export function stripInjectedBlock(prompt) {
  return String(prompt ?? '').replace(BLOCK_RE, '').trim()
}

// 系统提示词包在块标记之内:剥块 = 剥全部注入(含提示词),二次组装永不残留
export function buildInjectedBlock(memories, sessionName = null, systemPrompt = SYSTEM_PROMPT) {
  const lines = [SCOPE_PREFIX, systemPrompt]
  if (sessionName) lines.push(`[会话:${sessionName}]`)
  for (const m of memories ?? []) {
    const ts = m?.timestamp ? `(${String(m.timestamp).slice(0, 10)})` : ''
    lines.push(`- ${ts}${m?.content ?? ''}`)
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
