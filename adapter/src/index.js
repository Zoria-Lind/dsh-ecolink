// dsh-ecolink-adapter(E1/E2):dsh-ecolink 的 DSH 适配层。
// 职责(PLAN §6/§8):直读 memory.json(只读,唯一写者是 ecolink-service),
// pre-step 指令通道(每轮幂等追加 plugin 快照消息,E1)+ 可选内容注入逃生舱 +
// 记忆 skill 运行时注册(E2:内容按需 read),与网页端记忆生态打通。
// 与 token-optimizer / behavior-enhancer 的联动开关(memory_bridge 配置节)已
// 在两者中占位,等适配层稳定后在各自 README 说明如何开启。

import { DEFAULT_CONFIG, resolveConfig } from './config.js'
import { createMemoryInjectModule } from './modules/memoryInject.js'
import { createMemoryWriteModule } from './modules/memoryWrite.js'
import { createServiceGuardModule } from './modules/serviceGuard.js'
import { createMemoryDiffModule } from './modules/memoryDiff.js'

// E2 记忆 skill 正文:指引模型按需 read 记忆池(内容不再自动注入,这里是读取入口)。
// 引用细节前必须 read 原文核对(沿用 token-optimizer 的堵漏原则)。
const SKILL_CONTENT = `# dsh-ecolink 跨端记忆池

本机记忆池文件:\`~/.dsh-memory/memory.json\`(归档:\`~/.dsh-memory/archive.json\`)。
网页端(chat.deepseek.com)与 DSH 共用这一份结构化池;网页端记过的事实在这里能查到。

## 文件结构
- 顶层:{ version, shared_pool: [...], session_pools: { <网页会话id>: { identity, memories: [...] } } }
- 条目字段:id / key / content / timestamp(UTC ISO) / time_precision / source(web|dsm-import|dsh) / importance(always|called) / pinned / last_accessed
- shared_pool 是跨会话共享记忆;session_pools 按网页会话分组,identity 是该会话的人类可读名

## 何时读
- 用户提到"我在网页端记过 / 之前说过 / 我的偏好"等跨端记忆问题时
- 需要回忆历史偏好、项目约定、个人事实,而当前上下文没有答案时

## 使用规则
- 先运行 /ecolink-diff 命令获取记忆池自上次查看以来的新增/变化(本会话或重启后首次调用会返回全量)——多数问题只靠这个结果就能答
- 禁止在未查询记忆池的情况下回答"不知道/不记得/没有记录":记忆池与本对话上下文是两回事,池里有而上下文没有是常态
- 需要核对细节或完整历史时,用 read 工具读取 memory.json 原文;引用任何记忆细节前必须先读到原文,禁止凭印象回答
- timestamp 是 UTC 存储值(例:2026-09-14T10:24Z = 本地 18:24,本机时区 UTC+8)。展示给用户时**必须先转本地时间**,再按龄降精度:2 小时内→分钟,48 小时内→小时,5 天内→日期,更早不显示时间;禁止直接把 UTC 原值当本地时间展示
- 记忆可能过时:时间戳较旧或与当前对话矛盾时,先向用户复述该记忆并确认,不要当作当前事实直接使用
`

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const stats = { bump() {}, addSample() {}, dispose() {}, snapshot() { return {} } }
  const modules = []
  modules.push(createMemoryInjectModule(ctx, resolved.adapter, stats))
  // E4:DSH 记忆写回(/ecolink-push 显式触发;service 是唯一写者)
  modules.push(createMemoryWriteModule(ctx, resolved.adapter, stats))
  // E9:记忆 diff 查看(/ecolink-diff;调用即读取事件,游标随调用推进,skill 优先走这条)
  modules.push(createMemoryDiffModule(ctx, resolved.adapter, stats))
  // v1.1:service 未运行时自动拉起(先探测后 spawn,已在跑就不会重复起)
  modules.push(createServiceGuardModule(ctx, resolved.adapter, stats))

  // E2:记忆 skill 运行时注册(register 返回 Cordis disposer,非 Promise;
  // 同名重复注册是 first-wins + no-op disposer,重复挂载不会叠加)。
  // inject 依赖缺失时本回调永不执行(插件其余部分不受影响)。
  const skillDisposers = []
  ctx.inject?.(['skills'], (skillCtx) => {
    try {
      skillDisposers.push(skillCtx.skills.register({
        name: resolved.adapter.skillName,
        description: '按需读取 dsh-ecolink 跨端记忆池(~/.dsh-memory/memory.json)',
        whenToUse: '需要回忆网页端记过的偏好/事实/决策,或用户提到之前记过的内容时',
        content: SKILL_CONTENT,
        source: 'runtime',
      }))
    } catch (err) {
      console.warn(`[dsh-ecolink-adapter] skill 注册失败(${err?.message ?? err})`)
    }
  })

  return () => {
    for (const cleanup of modules) cleanup()
    for (const dispose of skillDisposers) {
      try { dispose?.() } catch { /* noop */ }
    }
    stats.dispose()
  }
}

export { DEFAULT_CONFIG, resolveConfig }
