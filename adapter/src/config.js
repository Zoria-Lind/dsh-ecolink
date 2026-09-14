// dsh-ecolink-adapter 配置。与 token-optimizer / behavior-enhancer 同款 resolveSection 模式。

export const DEFAULT_CONFIG = {
  adapter: {
    enabled: true,
    poolPath: '~/.dsh-memory/memory.json', // 只读;唯一写者是 ecolink-service
    poolTtlMs: 5000,          // 池文件缓存(mtime 变化立即重读,否则 TTL 兜底)
    injectEnabled: true,      // 总开关(false = 两个通道全关)
    singleInjection: true,    // 内容通道专用:每 DSH 会话只注入一次(指令通道天然每轮幂等,不适用)
    maxInjectionChars: 3000,  // 内容通道注入预算(长提示词自动缩减,与网页端同规则)
    // E1 通道分离:指令每轮幂等注入(维持 DSM:memory_write 捕获);内容默认不再注入
    instructionEnabled: true,       // 指令通道(pre-step 追加 plugin 快照消息)
    contentInjectionEnabled: false, // 内容通道逃生舱(旧行为:改写用户消息注入记忆块)
    skillName: 'ecolink-memory',    // E2 记忆 skill 的注册名(kebab-case)
    // E4 写回:POST /memory/sync 到本机 service(service 是唯一写者,DSH 只发请求)
    serviceUrl: 'http://127.0.0.1:17520',
    serviceToken: '',               // 留空则自动读同仓 service/config.json 的 token(E8 自动生成)
    serviceAutoStart: true,         // v1.1:探测到 service 未运行就自动拉起(仅本地 URL;见 serviceGuard.js)
  },
}

const NUMERIC_KEYS = new Set(['poolTtlMs', 'maxInjectionChars'])

function resolveSection(section, defaults) {
  const out = { ...defaults }
  if (section && typeof section === 'object') {
    for (const [key, value] of Object.entries(section)) {
      if (!(key in defaults)) {
        throw new Error(`dsh-ecolink-adapter config: unknown key "${key}" (allowed: ${Object.keys(defaults).join(', ')})`)
      }
      if (NUMERIC_KEYS.has(key)) {
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`dsh-ecolink-adapter config: ${key} (${value}) must be a positive number`)
        }
      } else if (typeof value !== typeof defaults[key]) {
        throw new Error(`dsh-ecolink-adapter config: "${key}" must be ${typeof defaults[key]}`)
      }
      out[key] = value
    }
  }
  return Object.freeze(out)
}

export function resolveConfig(config = {}) {
  if (typeof config !== 'object' || config === null) config = {}
  return Object.freeze({
    adapter: resolveSection(config.adapter, DEFAULT_CONFIG.adapter),
  })
}
