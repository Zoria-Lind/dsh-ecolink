import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export function loadMemoryBridge(sidecar = new URL('../../ecolink-desktop.json', import.meta.url), env = process.env, desktop = {}) {
  try {
    if (env.DSH_ECOLINK_BRIDGE_PORT) {
      return createMemoryBridge({ port: env.DSH_ECOLINK_BRIDGE_PORT, token: env.DSH_ECOLINK_BRIDGE_TOKEN, ...desktop })
    }
    const { serviceConfig } = JSON.parse(readFileSync(sidecar, 'utf8'))
    if (typeof serviceConfig !== 'string' || !isAbsolute(serviceConfig)) return null
    const { port = 17520, token } = JSON.parse(readFileSync(serviceConfig, 'utf8'))
    return createMemoryBridge({ port, token, ...desktop })
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

export function createMemoryBridge({ port, token, fetcher = fetch, stateDir, compression }) {
  if (!/^[0-9]+$/.test(String(port)) || Number(port) < 1024 || Number(port) > 65535 || !token) {
    throw new Error('Configure a dedicated loopback ecolink service before enabling the desktop prototype.')
  }

  const bridgeUrl = 'http://127.0.0.1:' + Number(port)
  const bridgeFetch = (url, options) => fetcher(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Ecolink-Token': token },
    signal: new URL(url).pathname === '/memory/compress' ? undefined : AbortSignal.timeout(10000),
    redirect: 'error',
  })
  const fetchMemory = (path, options) => bridgeFetch(bridgeUrl + '/memory/' + path, options)
  const stateFile = stateDir && join(stateDir, 'ecolink-compression.json')
  let state = {}
  if (stateFile) {
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const storage = {
    async get(key) { return { [key]: state[key] } },
    async set(values) {
      const next = { ...state, ...values }
      if (stateFile) {
        writeFileSync(stateFile + '.tmp', JSON.stringify(next))
        renameSync(stateFile + '.tmp', stateFile)
      }
      state = next
    },
  }
  const queue = compression?.createOfflineQueue({ storage, fetchImpl: bridgeFetch, bridgeUrl, token })
  const getConfig = () => ({ ...compression.DEFAULT_CONFIG, bridgeUrl, token })
  const getPool = async () => {
    const response = await fetchMemory('pool')
    if (!response.ok) throw new Error('无法读取记忆池')
    return response.json()
  }
  const compress = compression?.createCompression({
    storage, fetch: bridgeFetch, getConfig, getPool, getQueue: () => queue,
  })
  const staging = async () => {
    const response = await fetchMemory('compress-status')
    if (!response.ok) throw new Error('无法检查压缩暂存池')
    return (await response.json()).staging
  }

  async function request(path, body) {
    const response = await fetchMemory(path, { method: 'POST', body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok && !result.conflict) throw new Error(result.error || '记忆池请求失败')
    return result
  }

  async function handle(message) {
    try {
      switch (message?.kind) {
        case 'get-settings': {
          const { active, oldItems } = await compress?.getCompressState() ?? {}
          return {
            ok: true,
            settings: { contentInjectionEnabled: false, panelEnabled: Boolean(compress), harvestEnabled: true },
            compress: { active, oldItems },
          }
        }
        case 'panel-pool':
          return { ok: true, pool: await getPool() }
        case 'compress-config':
          return { compressMinAgeDays: getConfig().compressMinAgeDays }
        case 'compress-status':
        case 'compress-seen':
        case 'dup-report':
          return await compress.handle(message)
        case 'compress-start': {
          if ((await staging())?.count) return { ok: false, error: '已有压缩暂存，请先在发起的界面完成该轮压缩' }
          const result = await compress.handle(message)
          if (result.oldCount) await storage.set({ stage: (await staging())?.startedAt })
          return result
        }
        case 'compress-finish': {
          const current = await compress.getCompressState()
          if (current.active && (!state.stage || (await staging())?.startedAt !== state.stage)) {
            await storage.set({ ecolink_compress: { active: false }, stage: null })
            return { ok: false, error: '压缩暂存已变更，请检查发起压缩的界面' }
          }
          return await compress.handle(message)
        }
        case 'compress-api': {
          const { operation } = message
          if (operation === 'compress') {
            if ((await staging())?.count) return { ok: false, error: '已有压缩暂存，请先在发起的界面完成该轮压缩' }
          } else if (!['compress-commit', 'compress-rollback'].includes(operation) ||
                     !state.apiStage || (await staging())?.startedAt !== state.apiStage) {
            return { ok: false, error: 'API 压缩暂存已变更，请检查发起压缩的界面' }
          }
          const response = await fetchMemory(operation, {
            method: 'POST', body: operation === 'compress' ? JSON.stringify({ days: getConfig().compressMinAgeDays }) : undefined,
          })
          const body = await response.json()
          await storage.set({ apiStage: body.pendingConfirm ? (await staging())?.startedAt : null })
          return { ok: response.ok, status: response.status, body }
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
          const session_id = typeof sid === 'string' && /^[a-z0-9_-]{1,120}$/i.test(sid) ? sid : null
          if ((await compress?.getCompressState())?.active) {
            const result = await compress.handle({ ...message, session_id, memories })
            return { ok: result.ok, compressionChanged: result.ok }
          }
          return await request('sync', {
            session_id,
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

  // IPC arrives independently for a streamed reply's session, tags, and duplicate count.
  let pending = Promise.resolve()
  return message => {
    const result = pending.then(() => handle(message))
    pending = result.catch(() => {})
    return result
  }
}
