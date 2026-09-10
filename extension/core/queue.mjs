// 离线队列(PLAN §3.3):bridge 未启动时记忆缓存在 chrome.storage.local,
// 重连后补发。依赖注入化(storage/fetch),node:test 可用内存实现测退避逻辑。
// 序列化:同一时间只跑一个 flush,新 push 排队尾随。

export function createOfflineQueue({ storage, fetchImpl, bridgeUrl, token = '', maxRetries = 6, baseDelayMs = 1000 }) {
  const KEY = 'ecolink_outbox'
  let flushing = false

  async function readQueue() {
    const raw = await storage.get(KEY)
    return Array.isArray(raw?.[KEY]) ? raw[KEY] : []
  }
  async function writeQueue(items) {
    await storage.set({ [KEY]: items })
  }

  async function postToBridge(entry) {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['X-Ecolink-Token'] = token
    const resp = await fetchImpl(`${bridgeUrl.replace(/\/$/, '')}/memory/${entry.kind === 'session' ? 'session' : entry.kind === 'touch' ? 'touch' : 'sync'}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(entry.payload),
    })
    if (!resp.ok) throw new Error(`bridge ${resp.status}`)
    return resp.json()
  }

  // 入队 + 触发 flush(不阻塞调用方)
  function push(entry) {
    const p = readQueue().then(async (items) => {
      items.push(entry)
      await writeQueue(items)
    })
    p.catch(() => {}).then(() => flush())
    return p
  }

  // 串行 flush:逐条按序发,失败指数退避重试 maxRetries 次;
  // 任一条失败则停止(保留顺序语义),下次 push/定时器再试
  async function flush() {
    if (flushing) return
    flushing = true
    try {
      let items = await readQueue()
      while (items.length > 0) {
        const entry = items[0]
        let ok = false
        let delay = baseDelayMs
        for (let attempt = 0; attempt < maxRetries && !ok; attempt++) {
          try {
            await postToBridge(entry)
            ok = true
          } catch (err) {
            if (attempt < maxRetries - 1) {
              await new Promise((r) => setTimeout(r, delay))
              delay = Math.min(delay * 2, 60000)
            }
          }
        }
        if (!ok) break // bridge 仍不可达:停,保序等下次
        items = items.slice(1)
        await writeQueue(items)
      }
    } finally {
      flushing = false
    }
  }

  return { push, flush, pendingCount: () => readQueue().then((q) => q.length) }
}
