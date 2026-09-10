// dsh-ecolink-adapter 配置。与 token-optimizer / behavior-enhancer 同款 resolveSection 模式。

export const DEFAULT_CONFIG = {
  adapter: {
    enabled: true,
    poolPath: '~/.dsh-memory/memory.json', // 只读;唯一写者是 ecolink-service
    poolTtlMs: 5000,          // 池文件缓存(mtime 变化立即重读,否则 TTL 兜底)
    injectEnabled: true,
    singleInjection: true,    // 每 DSH 会话只注入一次(后续轮次由对话历史携带)
    maxInjectionChars: 3000,  // 注入预算(长提示词自动缩减,与网页端同规则)
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
