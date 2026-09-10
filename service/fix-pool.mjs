// 一次性修复脚本:清掉池子里的乱码条目,用 Node 直连服务恢复正确中文
// (绕开 shell 命令行编码——curl -d 传中文曾把 GBK 字节写进池子)
const BASE = 'http://127.0.0.1:17520'
const post = async (path, body) => {
  const resp = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return resp.json()
}

// 1) 找出并删除乱码条目(含 U+FFFD 替换符)
const pool = await (await fetch(BASE + '/memory/pool')).json()
const pollutedIds = []
for (const it of pool.shared_pool ?? []) if ((it.content ?? '').includes('�')) pollutedIds.push(it.id)
for (const sp of Object.values(pool.session_pools ?? {})) {
  for (const it of sp.memories ?? []) if ((it.content ?? '').includes('�')) pollutedIds.push(it.id)
}
console.log('乱码条目:', pollutedIds.length)
if (pollutedIds.length > 0) console.log('删除:', JSON.stringify(await post('/memory/delete', { ids: pollutedIds })))

// 2) 恢复正确内容(UTF-8 安全)
const shared = await post('/memory/sync', { memories: [
  { content: '2026-09-10下午开始参加数模国赛广东赛区', importance: 'called' },
  { content: '2026-09-13有企业战略管理闭卷考试', importance: 'called' },
  { key: 'lunch_2026_09_10', content: '2026-09-10中午吃黑松露炒饭+五指毛桃鸡汤', importance: 'called' },
  { key: 'user_name', content: 'Zoria Lind', importance: 'key' },
]})
console.log('共享池恢复:', JSON.stringify(shared))
console.log('会话bd9b恢复:', JSON.stringify(await post('/memory/sync', { session_id: 'bd9b1745-66cc-49d5-b563-24cc9b1a2d1c', memories: [{ content: '2026-09-10下午开始参加数模国赛广东赛区', importance: 'called' }] })))
console.log('会话37d5恢复:', JSON.stringify(await post('/memory/sync', { session_id: '37d5615f-52ec-411a-8a38-a05cd293dba7', memories: [{ key: 'discrete_math_midterm_2026', content: '2026-09-24(中秋节前一天)离散数学期中考试', importance: 'key' }] })))

// 3) 验证
const after = await (await fetch(BASE + '/memory/pool')).json()
console.log('验证:共享池', (after.shared_pool ?? []).map((it) => it.content))
for (const [sid, sp] of Object.entries(after.session_pools ?? {})) {
  console.log('验证:会话', sid.slice(0, 8), (sp.memories ?? []).map((it) => it.content))
}
