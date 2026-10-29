// dsh-ecolink-adapter 配置。与 token-optimizer / behavior-enhancer 同款 resolveSection 模式。

export const DEFAULT_CONFIG = {
  adapter: {
    enabled: true,
    poolPath: '~/.dsh-memory/memory.json', // 只读;唯一写者是 ecolink-service
    poolTtlMs: 5000,          // 兼容旧配置；指定读取现为每次读取最新池文件
    injectEnabled: true,      // 关闭自动开局及指令注入；侧栏显式注入仍需用户点击
    singleInjection: true,    // 兼容旧配置；正文按版本/范围持久去重
    maxInjectionChars: 3000,  // 每步正文注入字符预算；长文需显式选择分页
    // E1 通道分离:指令每轮幂等注入(维持 DSM:memory_write 捕获);内容默认不再注入
    instructionEnabled: true,       // 指令通道(pre-step 追加 plugin 快照消息)
    contentInjectionEnabled: false, // 兼容旧配置；不再绕过通用/非通用策略
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
