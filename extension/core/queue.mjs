// 离线队列(PLAN §3.3):bridge 未启动时记忆缓存在 chrome.storage.local,
// 重连后补发。依赖注入化(storage/fetch),node:test 可用内存实现测退避逻辑。
// 序列化:入队与 flush 的「读-裁-写」都串到同一条 promise 链上(队列变更单一执行者),
// 网络调用保持在链外(退避等待不能卡链)。并发 push 不丢条目,失败保序不越队。

export function createOfflineQueue({ storage, fetchImpl, bridgeUrl, token = '', maxRetries = 6, baseDelayMs = 1000 }) {
  const KEY = 'ecolink_outbox'
  let flushing = false
  let chain = Promise.resolve()
  const serialize = (fn) => (chain = chain.then(fn, fn))

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

  // 入队(链内读-改-写,原子;并发 push 依次落盘,不再互相覆盖)+ 触发 flush(不阻塞调用方)
  function enqueue(entry) {
    return serialize(async () => {
      const items = await readQueue()
      items.push(entry)
      await writeQueue(items)
    })
  }
  function push(entry) {
    const p = enqueue(entry)
    p.catch(() => {}).then(() => flush())
    return p
  }

  // 串行 flush:每次都在链内重读队首(不沿用旧快照——快照裁剪会把并发写入覆盖掉),
  // 逐条按序发,失败指数退避重试 maxRetries 次;失败路径只读不写(保序、不越队),
  // 下次 push/定时器再试
  async function flush() {
    if (flushing) return
    flushing = true
    try {
      for (;;) {
        const entry = await serialize(async () => (await readQueue())[0])
        if (entry === undefined) break
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
        await serialize(async () => {
          const items = await readQueue()
          items.shift()
          await writeQueue(items)
        })
      }
    } finally {
      flushing = false
    }
  }

  return { push, flush, pendingCount: () => readQueue().then((q) => q.length) }
}
