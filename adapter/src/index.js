// dsh-ecolink-adapter(阶段 4 v0):dsh-ecolink 的 DSH 适配层。
// 职责(PLAN §6/§8):直读 memory.json(只读,唯一写者是 ecolink-service),
// pre-step 注入记忆块(打分+预算+会话去重+#记忆名 过滤),与网页端记忆生态打通。
// 与 token-optimizer / behavior-enhancer 的联动开关(memory_bridge 配置节)已
// 在两者中占位,等适配层稳定后在各自 README 说明如何开启。

import { DEFAULT_CONFIG, resolveConfig } from './config.js'
import { createMemoryInjectModule } from './modules/memoryInject.js'

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const stats = { bump() {}, addSample() {}, dispose() {}, snapshot() { return {} } }
  const modules = []
  modules.push(createMemoryInjectModule(ctx, resolved.adapter, stats))
  return () => {
    for (const cleanup of modules) cleanup()
    stats.dispose()
  }
}

export { DEFAULT_CONFIG, resolveConfig }
