import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export function loadMemoryBridge(sidecar = new URL('../../ecolink-desktop.json', import.meta.url), env = process.env) {
  try {
    if (env.DSH_ECOLINK_BRIDGE_PORT) {
      return createMemoryBridge({ port: env.DSH_ECOLINK_BRIDGE_PORT, token: env.DSH_ECOLINK_BRIDGE_TOKEN })
    }
    const { serviceConfig } = JSON.parse(readFileSync(sidecar, 'utf8'))
    if (typeof serviceConfig !== 'string' || !isAbsolute(serviceConfig)) return null
    const { port = 17520, token } = JSON.parse(readFileSync(serviceConfig, 'utf8'))
    return createMemoryBridge({ port, token })
  } catch {
    return null
  }
}

export const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com'
export const ECOLINK_CHANNEL = 'dsh-desktop:ecolink-memory'

export function isDeepSeekDocument(value) {
  try {
    const url = new URL(value)
    return url.origin === DEEPSEEK_ORIGIN && !url.username && !url.password
  } catch {
    return false
  }
}

export function createMemoryBridge({ port, token, fetcher = fetch }) {
  if (!/^[0-9]+$/.test(String(port)) || Number(port) < 1024 || Number(port) > 65535 || !token) {
    throw new Error('Configure a dedicated loopback ecolink service before enabling the desktop prototype.')
  }

  async function request(path, body) {
    const response = await fetcher('http://127.0.0.1:' + Number(port) + '/memory/' + path, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-Ecolink-Token': token },
      body: JSON.stringify(body),
      redirect: 'error',
    })
    const result = await response.json()
    if (!response.ok && !result.conflict) throw new Error(result.error || '记忆池请求失败')
    return result
  }

  return async function handle(message) {
    try {
      switch (message?.kind) {
        case 'get-settings':
          return {
            ok: true,
            settings: { contentInjectionEnabled: false, panelEnabled: false, harvestEnabled: true },
          }
        case 'harvest': {
          const memories = (Array.isArray(message.memories) ? message.memories.slice(0, 64) : [])
            .filter(item => typeof item?.content === 'string' && item.content.trim().length > 0 && item.content.length <= 1000)
            .map(({ content, key, importance }) => ({
              content,
              key: typeof key === 'string' ? key.slice(0, 64) : null,
              importance: importance === 'always' ? 'always' : 'called',
              source: 'web',
            }))
          if (!memories.length) return { ok: true, skipped: true }
          const sid = message.session_id
          return await request('sync', {
            session_id: typeof sid === 'string' && /^[a-z0-9_-]{1,120}$/i.test(sid) ? sid : null,
            memories,
          })
        }
        case 'selection-save': {
          const { content, requestId } = message
          if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 1500000 ||
              typeof requestId !== 'string' || !/^[\da-f-]{36}$/i.test(requestId)) {
            return { ok: false, error: '选区为空或超过 1.5 MB' }
          }
          const title = Array.from(content.trim().split(/\r?\n/, 1)[0]).slice(0, 38).join('')
          return await request('artifact', { name: title + ' · ' + requestId.slice(0, 8), content, requestId })
        }
        case 'artifact-save': {
          const { name, content, requestId, expectedVersion } = message
          if (typeof name !== 'string' || name.length > 200 || typeof content !== 'string' ||
              Buffer.byteLength(content) > 1500000 || typeof requestId !== 'string' || requestId.length > 100 ||
              (expectedVersion !== undefined && (typeof expectedVersion !== 'string' || expectedVersion.length > 128))) {
            return { ok: false, error: '成果名称或正文超出限制' }
          }
          return await request('artifact', { name, content, requestId, expectedVersion })
        }
        case 'diag':
        case 'touch':
          return { ok: true }
        default:
          return { ok: false, error: '不支持的记忆操作' }
      }
    } catch {
      return { ok: false, error: '记忆池暂不可用，请重试' }
    }
  }
}
