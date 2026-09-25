// dsh-ecolink-web MAIN world 注入脚本 v2(2026-09-10 按 DSM v1.5.0 稳定性架构重写)。
// 与 DSM 对齐的关键决策(卡死事故复盘):
//   1. 注入 = 页内同步缓存配置(内容脚本经 CustomEvent 推入),请求时零跨上下文等待
//   2. 收割 = DOM 树扫描(TreeWalker + 定时级联 + MutationObserver)→ 去重 → 提取 → 剥离,
//      绝不重写 completion 响应流(流重写是冻结风险的根源)
//   3. 防污染 = 历史类接口响应整包清洗(DSM E 模式)+ DOM 剥离;不碰 IndexedDB API 契约
//      (改 IDBRequest 返回类型曾直接卡死整个页面)
// 稳定性铁律:任何异常 → 静默放行原请求。

;(function () {
  'use strict'
  if (window[Symbol.for('__ecolink')]) return
  Object.defineProperty(window, Symbol.for('__ecolink'), { value: true, writable: false, configurable: false })

  const VERSION = 'v3' // 页面注入脚本版本(诊断通道会报给服务日志,确认页面跑的是不是最新)

  const TAG = 'DSM:memory_write'
  const SCOPE_PREFIX = '[dsh-ecolink 记忆]'
  const SCOPE_SUFFIX = '[/dsh-ecolink 记忆]'
  const COMPLETION_RE = /\/api\/v0\/chat\/completion/
  const HISTORY_RE = /\/api\/v0\/(chat_session|conversation|chat\/edit_message)|chat_session|fetch_page/
  const EDIT_RE = /\/api\/v0\/chat\/edit_message/
  // DSM 同款快路径:含通用 <DSM: 前缀/闭合(历史残留可能不包 <dsmemory> 壳,如 <DSM:SKILLS>)
  const MARKER_RE = /DSM:memory_write|<dsmemory>|MEMORY_SYSTEM|<DSM:|<\/DSM:|&lt;DSM:|&lt;\/DSM:|\[dsh-ecolink 记忆\]|\[dsh-ecolink 指令\]/
  // E1 指令通道标记(与 core/prompt.mjs 的 INSTRUCTION_* 镜像;经典脚本不能 import,注释锁死同步)
  const INSTRUCTION_PREFIX = '[dsh-ecolink 指令]'
  const INSTRUCTION_SUFFIX = '[/dsh-ecolink 指令]'
  const INSTRUCTION_BLOCK_RE = new RegExp(INSTRUCTION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + INSTRUCTION_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')

  const FLAG = (k) => { try { return window.localStorage.getItem(k) === '1' } catch { return false } }
  const KILL = FLAG('ecolink_kill')
  const DEBUG = FLAG('ecolink_debug')
  const dbg = (...a) => { if (DEBUG) { try { console.log('%c[ecolink:page]', 'color:#059669', ...a) } catch { /* ignore */ } } }
  if (KILL) { dbg('保险丝生效,页面侧全部退出'); return }

  // ---- 页内同步配置与池缓存(content 经 CustomEvent 推送) ----
  // 页内镜像只需背景层推送后会用到的键(E6 起单一来源在 core/config.mjs,经典脚本不能
  // import,此处仅保留子集;新增键经"存在才合并"自动带过来,不必在此补全)
  let settings = { injectEnabled: true, harvestEnabled: true, singleInjection: true, maxInjectionChars: 3000, panelEnabled: true, muted: false, contentInjectionEnabled: true }
  let pool = { shared_pool: [], session_pools: {} }
  let compressMode = { active: false, oldItems: [] }
  let compressInjected = false // 压缩块每页只注入一次
  let lastSid = ''
  const injectedSessions = new Set() // 压缩块每页一次的去重集合(常规注入去重见 sessionMemBase)

  function dispatchToContent(detail) {
    try { window.dispatchEvent(new CustomEvent('ecolink:page', { detail: JSON.stringify(detail) })) } catch { /* fail-open */ }
  }
  // 诊断事件:经 content→background→服务日志落盘,可直接读日志定位(免用户翻控制台)
  const diag = (msg) => { dbg(msg); dispatchToContent({ type: 'diag', msg: `${VERSION} ${msg}` }) }
  window.addEventListener('ecolink:cu', (e) => {
    try {
      const d = JSON.parse(e.detail)
      if (d.settings) settings = { ...settings, ...d.settings }
      if (d.pool && typeof d.pool === 'object') pool = d.pool
      if (d.compress && typeof d.compress === 'object') {
        compressMode = d.compress
        if (!d.compress.active) compressInjected = false
      }
      dbg('收到配置/池推送: 共享 ' + (pool.shared_pool ?? []).length + ' 条, 会话池 ' + Object.keys(pool.session_pools ?? {}).length + ' 个' + (compressMode.active ? ' | 压缩模式' : ''))
    } catch { /* ignore */ }
  })
  const requestFresh = () => dispatchToContent({ type: 'rq' })
  requestFresh(); setTimeout(requestFresh, 500); setTimeout(requestFresh, 1500)
  diag('页面注入脚本已加载, compress=' + compressMode.active)

  // ================= 核心逻辑(与 core/ 模块同步的经典脚本内联版) =================
  // (页面世界无法 import ESM;core/*.mjs 是背景层与单测的同一份逻辑)

  // ---- 收割解析(兼容纯文本与 DSM 属性形式;与 core/harvest.mjs 同逻辑) ----
  // DSM 同款防御:括号规则通杀示例垃圾;黑名单子串匹配;user_name 长度 sanity
  const BRACKET_RE = /\[.*?\]|\{.*?\}|<.*?>/
  const STANDALONE_RE = /^(待补充|待填写|待确认|TODO|TBD|\.\.\.|暂无|无|空|memory[_ ]?write)$/i
  // DSM(MIT,Md. Wahid)完整黑名单 + 本项目增量条目
  const SUBSTRING_BLACKLIST = [
    ...['example_name', 'extracted_name', 'extracted_country', 'extracted_language', 'placeholder', 'example', '[fact from user', '[extracted_', '[user_name]', '[user_country]', '[user_language]', 'your_name_here', 'your_country_here', 'sample_name'],
    ...['brief fact', 'snake_case_key', 'fact from user', '记忆内容', '输出记忆标签', 'key: fact', '开头,紧接着写事实,以', '开头,紧接着写该条内容,以', '三部分连在一起', '事实内容', '压缩完成(重复'],
  ]
  const KEY_BLACKLIST = new Set(['snake_case_key', 'example', 'example_name', 'example_key', 'placeholder', 'sample', 'key'])
  function validContent(content, key) {
    if (!content || content.length > 2000) return false
    if (BRACKET_RE.test(content)) return false
    if (key != null && KEY_BLACKLIST.has(String(key).trim().toLowerCase())) return false
    if (STANDALONE_RE.test(content)) return false
    const lower = content.toLowerCase()
    for (const bad of SUBSTRING_BLACKLIST) if (lower.includes(bad)) return false
    if (String(key ?? '').toLowerCase() === 'user_name' && content.length < 2) return false
    return true
  }
  // DSM scanner 同款状态化规则:已有 user_name 且新值与旧值不同时,
  // 新值长度<3 或含数字 = 疑似垃圾,拒绝覆盖(页内池缓存为权威近似)
  function userNameBlocked(content) {
    const existing = (pool.shared_pool ?? []).find((m) => String(m.key ?? '').toLowerCase() === 'user_name')
    if (!existing || existing.content === content) return false
    return content.length < 3 || /\d/.test(content)
  }
  function parseMemoriesFromText(text) {
    // 前端可能把标签转义渲染(&lt;DSM:memory_write&gt;),先还原再解析(DSM Gr 同款)
    const s = String(text ?? '').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    if (!s.includes(TAG)) return []
    // 2026-09-23 与 core/harvest.mjs 同步放宽:属性顺序可互换、引号可单可双、
    // importance 取值放宽;只有 key 的残缺形式取内容兜底(此前严格锚定会把
    // 半属性标签整条静默丢弃——"压缩标签没入池"根因之一)
    const attrRe = /<DSM:memory_write\s+(?:key\s*=\s*["'][^"']*["']\s+importance\s*=\s*["'][^"']*["']|importance\s*=\s*["'][^"']*["']\s+key\s*=\s*["'][^"']*["'])>[\s\S]*?<\/DSM:memory_write>/gi
    const keyOnlyRe = /<DSM:memory_write\s+key\s*=\s*["'][^"']*["']>([\s\S]*?)<\/DSM:memory_write>/gi
    const plainRe = /<DSM:memory_write>([\s\S]*?)<\/DSM:memory_write>/gi
    const raws = []
    s.replace(attrRe, (all) => { raws.push(all); return '' })
      .replace(keyOnlyRe, (_a, inner) => { raws.push(inner); return '' })
      .replace(plainRe, (_a, inner) => { raws.push(inner); return '' })
    const out = []
    for (let raw of raws) {
      raw = String(raw ?? '').trim()
      // DSM 属性形式(完整标签):key = 压缩/更新闭环的覆盖锚点(顺序/引号/importance 放宽)
      const attr = /^<DSM:memory_write\s+(?:key\s*=\s*["']([^"']*)["']\s+importance\s*=\s*["'](always|called|key|temp|context)["']|importance\s*=\s*["'](always|called|key|temp|context)["']\s+key\s*=\s*["']([^"']*)["'])>([\s\S]*?)<\/DSM:memory_write>$/i.exec(raw)
      if (attr) {
        const content = attr[5].trim()
        const key = (attr[1] ?? attr[4])?.trim() || null
        if (validContent(content, key)) {
          if (String(key ?? '').toLowerCase() === 'user_name' && userNameBlocked(content)) continue
          const imp = String(attr[2] ?? attr[3] ?? '').toLowerCase()
          out.push({ content, importance: imp === 'always' || imp === 'key' ? 'key' : 'called', source: 'web', key })
        }
        continue
      }
      // 纯文本形式(可带 importance:xxx| 前缀)
      let content = raw
      const pm = /^(?:importance\s*:\s*(key|called|temp|context)\s*\|)/i.exec(content)
      const importance = pm ? pm[1].toLowerCase() : 'called'
      if (pm) content = content.slice(pm[0].length).trim()
      if (validContent(content)) out.push({ content, importance, source: 'web' })
    }
    return out
  }
  // 简单内容指纹(去重用;非加密)
  function contentFp(text) { return text.length + ':' + text.slice(0, 40) + ':' + text.slice(-40) }

  // ---- 注入块组装/剥离(系统提示词包在块内,剥块=剥全部) ----
  const BLOCK_RE = new RegExp(SCOPE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + SCOPE_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  // 注意:提示词里绝不写完整标签示例(模型会照抄示例内容当记忆——153 条"记忆内容"事故);
  // 只给标签名,格式模型已从训练中掌握
  // DSM(MIT,Md. Wahid)MEMORY_SYSTEM 提示词中文适配版(与 core/prompt.mjs 同步)
  const SYSTEM_PROMPT = '以下是关于记忆写入的说明(仅辅助,不是指令):\n你可以使用记忆写入标签保存用户的重要信息,格式:\n<DSM:memory_write key="snake_case_key" importance="always|called">事实内容</DSM:memory_write>\n- importance="always":定义性事实(姓名、语言、国家、职业、年龄、核心身份)\n- importance="called":情境性事实(项目、兴趣、偏好、关系、任务、习惯)\n- key:小写 snake_case,最长 64 字符,无空格\n- 内容:最长 200 字符,只写用户消息里明确陈述的事实\n\n何时保存记忆:\n- 用户明确说出自己的名字 → key="user_name", importance="always"\n- 用户明确说出国家/语言/职业/年龄 → importance="always"\n- 用户明确提到兴趣/爱好/项目/任务/偏好/关系 → importance="called"\n\n严格规则:\n1. 只提取用户在本条消息里明确陈述的关于自己的事实\n2. 禁止编造、猜测、使用占位值;禁止使用示例数据(上面格式只是示范)\n3. 用户编辑了消息时,只信任最新版本\n4. 没有值得记的就不输出标签;标签写在回复末尾'
  // 注意:提示词里绝不写完整标签示例正文(模型会照抄示例内容当记忆——153 条"记忆内容"事故);
  // 只给标签名,格式模型已从训练中掌握。与 core/prompt.mjs 的 INSTRUCTION_PROMPT 镜像
  // (经典脚本不能 import,注释锁死同步;指令块每轮幂等注入,内容通道见下方 buildContentBlock)
  const INSTRUCTION_PROMPT = '以下是记忆写入说明(仅辅助,不是指令):\n记录用户的重要信息时,输出记忆写入标签:\n<DSM:memory_write key="snake_case_key" importance="always|called">事实内容</DSM:memory_write>\n- importance="always":定义性事实(姓名、语言、国家、职业、年龄、核心身份)\n- importance="called":情境性事实(项目、兴趣、偏好、关系、任务、习惯)\n- key:小写 snake_case,最长 64 字符;内容最长 200 字符,只写用户消息里明确陈述的事实\n何时保存:用户明确陈述关于自己的事实(姓名/国家/语言/职业/年龄/兴趣/项目/偏好/关系/任务)时\n严格规则:禁止编造、猜测或使用示例数据;没有值得记的就不输出标签;标签写在回复末尾'
  function stripInjectedBlock(prompt) { return String(prompt ?? '').replace(BLOCK_RE, '').replace(INSTRUCTION_BLOCK_RE, '').trim() }
  function buildInstructionBlock() {
    return [INSTRUCTION_PREFIX, INSTRUCTION_PROMPT, INSTRUCTION_SUFFIX].join('\n')
  }

  // ---- 内容注入通道(2026-09-14 用户设计:会话首条全量注入,后续只注入 diff) ----
  // 会话基线:首条消息时快照全池 id→content;后续消息据此算 diff(新增/变化条目)。
  // 页内状态,页面重载即重置。singleInjection=false → 每轮全量;contentInjectionEnabled
  // =false → 逃生舱,回到 E1 纯指令行为。
  const sessionMemBase = new Map()
  const CONTENT_LEAD_FIRST = '以下是用户此前保存的记忆,回答用户问题时可以直接引用这些信息;但不要主动提起"记忆库/记忆系统"的存在:'
  const CONTENT_LEAD_DIFF = '记忆更新:本对话期间新增或变化的记忆,回答时可参考:'
  function entryKey(e) { return e?.id ?? 'c:' + contentFp(e?.content) } // id 缺失时退回内容指纹(防基线 Map 键全碰撞→diff 失效)
  // 防提前闭合:内容字面含块标记会截断剥离正则(DSM 转义同类风险)。此类条目
  // (含方括号)本就过不了收割括号规则,注入前直接跳过
  const BLOCK_MARKER_CONTENT = (c) => [SCOPE_PREFIX, SCOPE_SUFFIX, INSTRUCTION_PREFIX, INSTRUCTION_SUFFIX].some((m) => String(c ?? '').includes(m))
  function allPoolEntries() {
    const out = []
    for (const m of pool.shared_pool ?? []) { if (!BLOCK_MARKER_CONTENT(m?.content)) out.push(m) }
    for (const [sid2, sp] of Object.entries(pool.session_pools ?? {})) {
      for (const m of sp?.memories ?? []) { if (!BLOCK_MARKER_CONTENT(m?.content)) out.push({ ...m, identity: sp?.identity }) }
    }
    return out
  }
  // 渲染降精度镜像(与 core/prompt.mjs renderMemoryTimestamp 同逻辑;本地时区)
  function renderTs(isoTs) {
    const d = new Date(isoTs)
    if (!Number.isFinite(d.getTime())) return null
    const age = Math.max(0, Date.now() - d.getTime())
    if (age > 5 * 86400e3) return null
    const pad = (n) => String(n).padStart(2, '0')
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    if (age > 48 * 3600e3) return date
    if (age > 2 * 3600e3) return `${date} ${pad(d.getHours())}:00`
    return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  function buildContentBlock(memories, sessionName, lead) {
    const lines = [SCOPE_PREFIX, lead]
    if (sessionName) lines.push(`[会话:${sessionName}]`)
    for (const m of memories ?? []) {
      const ts = m?.timestamp ? renderTs(m.timestamp) : null
      lines.push(ts ? `- (${ts}) ${m?.content ?? ''}` : `- ${m?.content ?? ''}`)
    }
    lines.push(SCOPE_SUFFIX)
    return lines.join('\n')
  }
  // 打分/预算镜像(与 core/selector.mjs 同逻辑)
  function bigrams(s) { const t = String(s ?? ''); const set = new Set(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); return set }
  function scoreItem(item, prompt, now) {
    const pLower = String(prompt ?? '').toLowerCase()
    const pb = bigrams(pLower)
    const c = String(item?.content ?? '')
    const cb = bigrams(c)
    let hits = 0
    for (const g of cb) if (pb.has(g)) hits += 1
    const words = pLower.split(/[^\w一-龥]+/).filter((w) => w.length >= 2)
    const cl = c.toLowerCase()
    for (const w of words) if (cl.includes(w)) hits += 2
    let score = Math.min(20, hits * 5)
    if (item?.identity && pLower.includes(String(item.identity).toLowerCase())) score += 15
    const ts = new Date(item?.timestamp).getTime()
    if (Number.isFinite(ts)) score += 10 / (1 + Math.max(0, now - ts) / 86400e3 / 7)
    if (item?.last_accessed) score += 5
    if (item?.pinned) score += 10
    return score
  }
  function selectMemories(items, prompt, budgetChars) {
    const now = Date.now()
    const scored = (items ?? []).map((item) => ({ item, score: scoreItem(item, prompt, now) }))
      .sort((a, b) => b.score - a.score || String(b.item?.timestamp ?? '').localeCompare(String(a.item?.timestamp ?? '')))
    const chosen = []
    let used = 0
    for (const { item } of scored) {
      const content = String(item?.content ?? '').trim()
      if (!content) continue
      const capped = content.length > 500 ? content.slice(0, 500) + '…' : content
      const cost = capped.length + 24 // 条目头部格式开销
      if (used + cost > budgetChars) break
      chosen.push({ ...item, content: capped })
      used += cost
    }
    return chosen
  }
  function effectiveBudget(prompt, maxInjectionChars) {
    const len = String(prompt ?? '').length
    if (len <= 5000) return maxInjectionChars
    if (len <= 12000) return Math.floor(maxInjectionChars * 0.5)
    return Math.floor(maxInjectionChars * 0.25)
  }

  // ---- 压缩指令块(PLAN §4.4 v3:一键压缩流程的注入形态) ----
  // 教训 1:方括号标记脸([压缩任务]、key: x |)会让模型把整块当系统垃圾,谎称乱码
  // 教训 2:要求保留/分配 key 对 flash 模型负担过重——删除流程(完成压缩时旧条目
  //   未被覆盖即删)不依赖 key,压缩输出用模型最熟悉的普通标签即可
  // 教训 3:让模型"只输出标签"→ 标签独占一行 → 前端把行首 <tag> 当 HTML 块吞掉,
  // DOM 里没有标签文本,收割落空。解法:要求标签跟在说明文字之后同行输出(行内
  // 标签会被前端当普通文本转义渲染 → DOM 可见 → 走与普通记忆相同的收割路径)
  const COMPRESS_INSTRUCTION = '记忆压缩任务。下面是记忆池里的旧记忆清单,每行格式:方括号内是该条的 key(英文标识),冒号后是内容。请逐条阅读后压缩合并:只合并内容明显重复或高度重叠的条目,不同主题必须各自保留、分别输出标签,任何旧记忆的信息都不得丢弃;宁可多输出几条也禁止过度合并。压缩完成后:先写一句说明,格式为 压缩完成(重复 N 条)——N 是你统计出的清单里内容完全重复或高度重叠、应直接合并或去掉的条数。验收规则(服务会严格按此验收,不满足则整批作废、旧记忆原样恢复):标签数量必须不少于"(清单总数 − N) × 三分之二"与"清单总数 × 十分之一"两者中的较大值;输出完标签后自己数一遍数量,不够就继续补齐。然后紧接着在说明文字之后、同一行内,用空格分隔地输出全部标签。每条标签必须写成完整属性形式:<DSM:memory_write key="snake_case_key" importance="always">事实内容</DSM:memory_write>。key 规则:内容未变的条目必须沿用清单里方括号中的原 key;只有合并或改写时才生成新 key(小写单词用下划线连接)。importance 按重要性写 always 或 called。重要:标签必须跟在说明后面同行,禁止独占一行,禁止用代码块——独占一行的标签会被页面过滤掉,导致记忆无法保存;即使标签很多也必须全部输出,禁止省略。输出前逐条核对原文,确保没有遗漏和编造。'
  // 提取模型自报的重复数(说明行"压缩完成(重复 N 条)"),无报告返回 0
  function extractDupReport(text) {
    const m = /压缩完成\s*[(（]\s*重复\s*(\d+)\s*条\s*[)）]/.exec(String(text ?? ''))
    return m ? Number(m[1]) : 0
  }
  function buildCompressBlock(oldItems) {
    const lines = [SCOPE_PREFIX, COMPRESS_INSTRUCTION, '', '旧记忆清单:']
    for (const it of oldItems ?? []) {
      lines.push(`- [${it.key ?? '-'}] ${it.content ?? ''}`)
    }
    lines.push(SCOPE_SUFFIX)
    return lines.join('\n')
  }

  // ---- 请求 payload 注入(DSM O() 模式:同步、防残留、改即发) ----
  // 核心注入函数:压缩块(用户显式触发)优先;常规路径 = 指令块每轮幂等(先剥旧块再拼新块,
  // 原文不变则不重发)+ 内容通道(2026-09-14 用户设计:会话首条全量、后续 diff,
  // 见上方 buildContentBlock/sessionMemBase;contentInjectionEnabled=false 关闭)
  function injectText(text, sid) {
    // 压缩模式优先:新对话第一条消息注入压缩指令块(每页一次)
    if (compressMode.active && !compressInjected) {
      compressInjected = true
      injectedSessions.add(sid)
      dispatchToContent({ type: 'compress-seen', session_id: sid }) // 背景层据此只计压缩会话的收割
      const composed = buildCompressBlock(compressMode.oldItems ?? []) + '\n\n' + stripInjectedBlock(text)
      diag('压缩模式:注入压缩指令块(' + (compressMode.oldItems?.length ?? 0) + ' 条旧记忆)')
      return composed
    }
    const clean = stripInjectedBlock(text)
    const instr = buildInstructionBlock() + '\n\n' + clean
    // 内容通道(2026-09-14 用户设计):会话首条全量注入,后续只注入 diff(新增/变化条目)
    if (settings.injectEnabled && !settings.muted && settings.contentInjectionEnabled !== false) {
      const entries = allPoolEntries()
      if (entries.length > 0) {
        const useBase = settings.singleInjection !== false
        const base = useBase ? sessionMemBase.get(sid) : null
        let chosen = null
        let sessionName = null
        let lead = CONTENT_LEAD_FIRST
        if (!base) {
          chosen = selectMemories(entries, clean, effectiveBudget(clean, settings.maxInjectionChars))
          sessionName = pool.session_pools?.[sid]?.identity || null
          if (useBase) sessionMemBase.set(sid, new Map(entries.map((e) => [entryKey(e), e.content])))
        } else {
          const diff = entries.filter((e) => !base.has(entryKey(e)) || base.get(entryKey(e)) !== e.content)
          if (diff.length > 0) {
            chosen = selectMemories(diff, clean, effectiveBudget(clean, settings.maxInjectionChars))
            for (const e of diff) base.set(entryKey(e), e.content)
            lead = CONTENT_LEAD_DIFF
          }
        }
        if (chosen && chosen.length > 0) {
          const ids = chosen.map((m) => m.id).filter(Boolean)
          if (ids.length) dispatchToContent({ type: 'touch', ids }) // 选择器自举:访问计数反哺打分
          diag('内容块注入 ' + chosen.length + ' 条, sid=' + String(sid).slice(0, 8))
          dbg('内容块注入: ' + chosen.length + ' 条, sid=' + sid)
          return buildContentBlock(chosen, sessionName, lead) + '\n\n' + instr
        }
      }
    }
    if (instr === text) return text // 幂等:无变化则原样
    dbg('指令块注入, sid=' + sid)
    return instr
  }

  // payload 多形态解析(DSM C/I/_/v 同款兼容):
  // ① 直连 prompt 字符串(主流)② messages 数组形态(edit_message 等)③ data/chat.messages 嵌套
  function maybeInject(payload) {
    const sid = String(payload.chat_session_id || payload.conversation_id || payload.chat_id || payload.id || 'default')
    lastSid = sid

    // ① prompt 直连形态
    if (typeof payload.prompt === 'string' && payload.prompt.trim().length > 0) {
      const composed = injectText(payload.prompt, sid)
      return composed !== payload.prompt ? { changed: true, payload: { ...payload, prompt: composed } } : { changed: false }
    }
    // ②③ messages 形态:改写最后一条用户消息的内容
    const msgs = Array.isArray(payload.messages) ? payload.messages
      : (Array.isArray(payload.data?.messages) ? payload.data.messages
      : (Array.isArray(payload.chat?.messages) ? payload.chat.messages : null))
    if (msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        const role = String(m?.role ?? m?.author ?? '').toLowerCase()
        if (role !== 'user' && role !== 'human') continue
        const text = typeof m.content === 'string' ? m.content
          : Array.isArray(m.content) ? m.content.map((t) => (typeof t === 'string' ? t : (t?.text ?? ''))).join('\n')
          : ''
        if (!text || !text.trim()) continue
        const composed = injectText(text, sid)
        if (composed !== text) {
          m.content = typeof m.content === 'string' ? composed : [{ type: 'text', text: composed }]
          return { changed: true, payload }
        }
        break
      }
    }
    return { changed: false }
  }

  // 编辑保存路径的"只剥不注入":上一轮注入块可能被前端带进编辑框,编辑保存时
  // 必须剥掉,否则注入块会当用户原文二次上送/存储(DSM 编辑框剥离的同源防护)
  function stripPayloadBlocks(payload) {
    let changed = false
    const cleanStr = (s) => {
      const u = String(s ?? '').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      const c = u.replace(/<DSM:memory_write(?:[^>]*)>[\s\S]*?<\/DSM:memory_write>/gi, '').replace(BLOCK_RE, '').replace(INSTRUCTION_BLOCK_RE, '')
      if (c !== String(s ?? '')) { changed = true; return c }
      return s
    }
    if (typeof payload.prompt === 'string') payload.prompt = cleanStr(payload.prompt)
    const msgs = Array.isArray(payload.messages) ? payload.messages
      : (Array.isArray(payload.data?.messages) ? payload.data.messages
      : (Array.isArray(payload.chat?.messages) ? payload.chat.messages : null))
    if (msgs) {
      for (const m of msgs) {
        if (typeof m?.content === 'string') m.content = cleanStr(m.content)
        else if (Array.isArray(m?.content)) {
          for (const t of m.content) if (t && typeof t.text === 'string') t.text = cleanStr(t.text)
        }
      }
    }
    return changed
  }

  // ---- 历史接口响应整包清洗(DSM E 模式:克隆→文本→清洗→新 Response) ----
  function scrubValue(v, depth) {
    if (v == null || depth > 8) return v
    if (typeof v === 'string') {
      if (!v.includes(TAG) && !v.includes(SCOPE_PREFIX) && !v.includes('MEMORY_SYSTEM') && !v.includes(INSTRUCTION_PREFIX)) return v
      return v.replace(/<MEMORY_SYSTEM[^>]*>[\s\S]*?<\/MEMORY_SYSTEM>/gi, '')
        .replace(/<dsmemory[^>]*>[\s\S]*?<\/dsmemory>/gi, '')
        .replace(/<DSM:[A-Za-z0-9_:]+[^>]*>[\s\S]*?<\/DSM:[A-Za-z0-9_:]+>/gi, '')
        .replace(BLOCK_RE, '').replace(INSTRUCTION_BLOCK_RE, '')
    }
    if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1))
    if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = scrubValue(x, depth + 1); return o }
    return v
  }

  // ---- fetch patch(DSM K 模式) ----
  const origFetch = window.fetch
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input instanceof Request ? input.url : String(input)))
      const isCompletion = COMPLETION_RE.test(url) && !HISTORY_RE.test(url)

      if (isCompletion && settings.injectEnabled && !settings.muted) {
        // 请求注入:body 提取(异步,无跨上下文等待)+ 同步注入
        let bodyText = null
        if (init && typeof init.body === 'string') bodyText = init.body
        else if (input instanceof Request) { try { bodyText = await input.clone().text() } catch { /* fallthrough */ } }
        else if (init && init.body) { try { bodyText = String(init.body) } catch { /* fallthrough */ } }
        let resp
        let payload = null
        if (bodyText) { try { payload = JSON.parse(bodyText) } catch { /* 非 JSON:不注入 */ } }
        if (payload && typeof payload === 'object') {
          const out = maybeInject(payload)
          if (out.changed) {
            // 完整重建 init(DSM 同款:保 method/headers/credentials/…)
            const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined))
            headers.set('content-type', 'application/json')
            const init2 = {
              method: (init && init.method) || (input instanceof Request ? input.method : 'POST'),
              headers,
              body: JSON.stringify(out.payload),
              credentials: (init && init.credentials) || (input instanceof Request ? input.credentials : undefined),
              cache: (init && init.cache) || (input instanceof Request ? input.cache : undefined),
              mode: (init && init.mode) || (input instanceof Request ? input.mode : undefined),
              redirect: (init && init.redirect) || (input instanceof Request ? input.redirect : undefined),
              referrer: (init && init.referrer) || (input instanceof Request ? input.referrer : undefined),
              referrerPolicy: (init && init.referrerPolicy) || (input instanceof Request ? input.referrerPolicy : undefined),
              keepalive: (init && init.keepalive) || (input instanceof Request ? input.keepalive : undefined),
              integrity: (init && init.integrity) || (input instanceof Request ? input.integrity : undefined),
              signal: (init && init.signal) || (input instanceof Request ? input.signal : undefined),
            }
            resp = await origFetch.call(this, typeof input === 'string' || input instanceof URL ? input : input.url, init2)
          }
        }
        if (!resp) resp = await origFetch.apply(this, arguments)
        // 源头收割(最终方案):tee 只读分支——前端拿原流(零改动零延迟),
        // 我们后台消费扫描分支提取标签。行首标签被前端吞、SPA 从 IndexedDB 恢复
        // 都不影响:标签在源头必然存在
        return teeHarvest(resp, lastSid)
      }

      if (EDIT_RE.test(url)) {
        // 编辑保存:只剥不注入——上一轮注入块可能被带进编辑框,剥掉防止当用户原文
        // 二次上送。剥后有变化则用重建 init 重发(不依赖 arguments,参数重赋值无效)
        let bodyText = null
        if (init && typeof init.body === 'string') bodyText = init.body
        else if (input instanceof Request) { try { bodyText = await input.clone().text() } catch { /* fallthrough */ } }
        if (bodyText) {
          try {
            const payload = JSON.parse(bodyText)
            if (payload && typeof payload === 'object' && stripPayloadBlocks(payload)) {
              const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined))
              headers.set('content-type', 'application/json')
              const init2 = { ...init, headers, body: JSON.stringify(payload) }
              return await origFetch.call(this, typeof input === 'string' || input instanceof URL ? input : input.url, init2)
            }
          } catch { /* 非 JSON:放行 */ }
        }
      }

      if (HISTORY_RE.test(url) && settings.harvestEnabled && !settings.muted) {
        // 历史接口响应清洗(防注入块持久化进前端历史)+ 历史数据收割
        const resp = await origFetch.apply(this, arguments)
        try {
          const text = await resp.clone().text()
          if (!MARKER_RE.test(text)) return resp
          const parsed = JSON.parse(text)
          // 从服务端原始消息里收割标签——弥补 DOM 收割的盲区:
          // 行首标签会被前端当 HTML 块吞掉、根本不渲染进 DOM(实测:压缩轮标签
          // 复制可见但 DOM 无痕迹),历史响应里的原始文本是可靠来源
          const rawMemories = parseMemoriesFromText(text)
          if (compressMode.active) {
            const dupNow = extractDupReport(text)
            if (dupNow > 0) dispatchToContent({ type: 'dup-report', dup: dupNow, session_id: lastSid })
          }
          if (rawMemories.length > 0) {
            const filtered = compressMode.active
              ? rawMemories.filter((m) => !COMPRESS_INSTRUCTION.includes(m.content) && !SYSTEM_PROMPT.includes(m.content) && !INSTRUCTION_PROMPT.includes(m.content))
              : rawMemories
            const fresh = filtered.filter((m) => {
              const mfp = contentFp(m.content)
              if (harvestedFp.has(mfp)) return false
              harvestedFp.add(mfp)
              return true
            })
            if (fresh.length > 0) {
              diag('历史响应收割 ' + fresh.length + ' 条: ' + fresh.map((m) => m.content.slice(0, 20)).join(' | '))
              dispatchToContent({ type: 'harvest', memories: fresh, session_id: lastSid, dup_report: extractDupReport(text) })
            }
          }
          // ⚠ 必须剥掉 content-encoding/content-length:fetch 已自动解压,
          // 但响应头仍声称 gzip/br——原样带回会让前端对明文二次解压 → 乱码(实测事故)
          const headers = new Headers(resp.headers)
          headers.delete('content-encoding')
          headers.delete('content-length')
          return new Response(JSON.stringify(scrubValue(parsed, 0)), { status: resp.status, statusText: resp.statusText, headers })
        } catch { return resp }
      }

      return origFetch.apply(this, arguments)
    } catch (err) {
      dbg('fetch patch 异常,放行原请求: ' + (err?.message ?? err))
      return origFetch.apply(this, arguments)
    }
  }

  // ---- XHR patch:仅请求侧同步注入(与页内缓存同源;响应收割交给 DOM 层) ----
  try {
    const XHR = window.XMLHttpRequest
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open
      const origSend = XHR.prototype.send
      XHR.prototype.open = function (method, url, ...rest) {
        try { this.__ecolinkUrl = String(url ?? '') } catch { /* ignore */ }
        return origOpen.call(this, method, url, ...rest)
      }
      XHR.prototype.send = function (body) {
        try {
          if (settings.injectEnabled && !settings.muted && COMPLETION_RE.test(this.__ecolinkUrl ?? '') && typeof body === 'string') {
            try {
              const payload = JSON.parse(body)
              if (payload && typeof payload === 'object') {
                const out = maybeInject(payload) // 多形态兼容(messages 数组等)
                if (out.changed) body = JSON.stringify(out.payload)
              }
            } catch { /* 非 JSON:放行 */ }
          }
          // 编辑保存:只剥不注入(同 fetch 侧;XHR 参数重赋值有效,直接改 body)
          if (EDIT_RE.test(this.__ecolinkUrl ?? '') && typeof body === 'string') {
            try {
              const payload = JSON.parse(body)
              if (payload && typeof payload === 'object' && stripPayloadBlocks(payload)) body = JSON.stringify(payload)
            } catch { /* 非 JSON:放行 */ }
          }
          // 历史接口响应清洗(DSM J() 同款:load 后 scrubbed + defineProperty)
          if (settings.harvestEnabled && !settings.muted && HISTORY_RE.test(this.__ecolinkUrl ?? '')) {
            this.addEventListener('load', () => {
              try {
                const raw = this.responseText
                if (typeof raw !== 'string' || !MARKER_RE.test(raw)) return
                const cleaned = JSON.stringify(scrubValue(JSON.parse(raw), 0))
                try { Object.defineProperty(this, 'responseText', { value: cleaned, writable: false, configurable: true }) } catch { /* ignore */ }
                try { Object.defineProperty(this, 'response', { value: cleaned, writable: false, configurable: true }) } catch { /* ignore */ }
              } catch { /* fail-open */ }
            })
          }
        } catch { /* fail-open */ }
        return origSend.call(this, body)
      }
    }
  } catch { /* fail-open */ }

  // ---- DOM 层收割 + 就地剥离(DSM Va/Nm 模式:定时级联 + rAF + MutationObserver) ----
  // DSM th 模式:改 DOM 前先断开观察器,防"剥离→变更→观察器→再剥离"的重入级联
  let domObserver = null
  const safeDomMutation = (fn) => {
    try { domObserver?.disconnect() } catch { /* ignore */ }
    try { return fn() } finally {
      try { if (document.body) domObserver?.observe(document.body, { subtree: true, childList: true, characterData: true }) } catch { /* ignore */ }
    }
  }
  const harvestedFp = new Set()
  function harvestAndStripNode(node) {
    try {
      const text = node.textContent || ''
      // 2026-09-25:说明行"压缩完成(重复 N 条)"可能单独成节点(不含标签)→
      // 独立上报,不能依赖标签收割的路径(此前自报数永远到不了后台)
      const dupNow = compressMode.active ? extractDupReport(text) : 0
      if (dupNow > 0) dispatchToContent({ type: 'dup-report', dup: dupNow, session_id: lastSid })
      if (!text.includes(TAG)) return
      const fp = contentFp(text)
      if (harvestedFp.has(fp)) return
      harvestedFp.add(fp)
      if (harvestedFp.size > 1000) { const k = harvestedFp.values().next().value; harvestedFp.delete(k) }
      let memories = parseMemoriesFromText(text)
      // 压缩模式兼容:模型常自创无尖括号简写("DSM:memory_write 内容"),按行兜底解析
      if (compressMode.active && memories.length === 0) {
        const lines = text.split(/\r?\n/)
        for (const line of lines) {
          const m = /^DSM:memory_write\s+(.+)$/.exec(line.trim())
          if (m && validContent(m[1].trim(), null)) memories.push({ content: m[1].trim(), importance: 'called', source: 'web', key: null })
        }
      }
      // 压缩模式:拒绝"指令自身的片段"(模型回显语法描述——实测事故)
      if (compressMode.active) {
        memories = memories.filter((m) => !COMPRESS_INSTRUCTION.includes(m.content) && !SYSTEM_PROMPT.includes(m.content) && !INSTRUCTION_PROMPT.includes(m.content))
      }
      // 按记忆内容指纹再过滤:同一内容出现在多个节点/多条消息只收一次
      // (153 条"记忆内容"事故的第二道闸)
      const fresh = memories.filter((m) => {
        const mfp = contentFp(m.content)
        if (harvestedFp.has(mfp)) return false
        harvestedFp.add(mfp)
        return true
      })
      if (fresh.length > 0 && !settings.muted) {
        diag('DOM 收割 ' + fresh.length + ' 条: ' + fresh.map((m) => m.content.slice(0, 24)).join(' | '))
        dispatchToContent({ type: 'harvest', memories: fresh, session_id: lastSid, dup_report: extractDupReport(text) })
      }
      // 剥离(DSM Gr 同款:先还原转义,再同时剥原始与转义形式,防残留 &lt; 垃圾)
      const unescaped = text.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      const cleaned = unescaped.replace(/<DSM:memory_write(?:[^>]*)>[\s\S]*?<\/DSM:memory_write>/gi, '').replace(BLOCK_RE, '').replace(INSTRUCTION_BLOCK_RE, '')
      if (cleaned !== text) {
        safeDomMutation(() => {
          if (cleaned.trim()) node.textContent = cleaned
          else {
            const parent = node.parentElement
            if (parent) { parent.setAttribute('ecolink-stripped', 'true'); parent.style.display = 'none' }
          }
        })
      }
    } catch { /* fail-open */ }
  }
  function walkDom() {
    try {
      if (!document.body) return
      // DSM 同款守卫:只遍历"含标记"的文本节点且单节点 ≤50000 字符,
      // 不做全树无差别扫描(长文档/高频 characterData 下的 CPU 尖峰)
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const t = n.textContent
          if (!t || t.length > 50000 || !MARKER_RE.test(t)) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      let n
      while ((n = walker.nextNode())) {
        if (n.textContent && n.textContent.includes(TAG)) harvestAndStripNode(n)
      }
    } catch { /* fail-open */ }
  }
  // 编辑框剥离(DSM scanner 同款):用户点"编辑"时输入框会带出注入块原文,
  // 就地剥掉,防止编辑保存时旧块原样上送二次存储
  function stripEditTextareas() {
    try {
      if (!document.body) return
      const selectors = ['textarea[class*="edit"]', 'textarea[class*="message"]', 'div[contenteditable="true"]', '[class*="edit"] textarea', '[class*="edit"] [contenteditable="true"]', 'textarea']
      for (const selector of selectors) {
        let elements
        try { elements = document.querySelectorAll(selector) } catch { continue }
        for (const el of elements) {
          const value = el.value || el.textContent || ''
          if (!MARKER_RE.test(value)) continue
          const unescaped = value.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
          const cleaned = unescaped.replace(/<DSM:memory_write(?:[^>]*)>[\s\S]*?<\/DSM:memory_write>/gi, '').replace(BLOCK_RE, '').replace(INSTRUCTION_BLOCK_RE, '')
          if (cleaned !== value) {
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
              el.value = cleaned
              try { el.dispatchEvent(new Event('input', { bubbles: true })) } catch { /* ignore */ } // React 变更感知
            } else {
              el.textContent = cleaned
            }
          }
        }
      }
    } catch { /* fail-open */ }
  }
  const schedule = [50, 150, 300, 500, 800, 1200, 2000, 3500, 5000, 8000]
  for (const t of schedule) setTimeout(walkDom, t)
  let rafStart = performance.now()
  const rafLoop = () => { walkDom(); if (performance.now() - rafStart < 3000) requestAnimationFrame(rafLoop) }
  requestAnimationFrame(rafLoop)
  // 周期兜底扫描 + 编辑框剥离(DSM 1.5s period 同款;TreeWalker 有 acceptNode 过滤,
  // 选择器有限,空闲开销可忽略)
  setInterval(() => { safeDomMutation(() => { walkDom(); stripEditTextareas() }) }, 1500)
  // 用户在编辑框里打字时也要剥(React 合成 input 冒泡到 document,DSM 同款)
  let editTimer = null
  document.addEventListener('input', () => { if (editTimer) clearTimeout(editTimer); editTimer = setTimeout(() => stripEditTextareas(), 300) }, true)
  let moTimer = null
  try {
    // DSM 内容侧同款 100ms 防抖:streaming 高频 characterData 不再每次 mutation 全量扫
    domObserver = new MutationObserver(() => { if (moTimer) clearTimeout(moTimer); moTimer = setTimeout(() => safeDomMutation(() => { walkDom(); stripEditTextareas() }), 100) })
    const startObserve = () => { try { domObserver.observe(document.body, { subtree: true, childList: true, characterData: true }) } catch { /* ignore */ } }
    if (document.body) startObserve()
    else document.addEventListener('DOMContentLoaded', startObserve, { once: true })
  } catch { /* fail-open */ }

  // 源头收割:completion 响应流 tee——appBranch 原样交付前端(零改动零延迟),
  // scanBranch 后台消费提取标签。与流重写(曾致卡死)不同:tee 不改动交付分支
  // 的任何字节与节奏。行首标签被前端当 HTML 块吞、SPA 从 IndexedDB 恢复历史
  // 都不影响——标签在源头必然存在(函数声明提升,fetch patch 可提前引用)
  function teeHarvest(resp, sessionId) {
    if (settings.muted || !settings.harvestEnabled || !resp?.ok || !resp?.body || typeof resp.body.tee !== 'function') return resp
    try {
      const [appBranch, scanBranch] = resp.body.tee()
      ;(async () => {
        try {
          const reader = scanBranch.getReader()
          const decoder = new TextDecoder('utf-8')
          let acc = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            acc += decoder.decode(value, { stream: true })
          }
          let memories = parseMemoriesFromText(acc)
          if (compressMode.active) {
            const dupNow = extractDupReport(acc)
            if (dupNow > 0) dispatchToContent({ type: 'dup-report', dup: dupNow, session_id: sessionId })
            memories = memories.filter((m) => !COMPRESS_INSTRUCTION.includes(m.content) && !SYSTEM_PROMPT.includes(m.content) && !INSTRUCTION_PROMPT.includes(m.content))
          }
          const fresh = memories.filter((m) => {
            const mfp = contentFp(m.content)
            if (harvestedFp.has(mfp)) return false
            harvestedFp.add(mfp)
            return true
          })
          if (fresh.length > 0) {
            diag('源头收割 ' + fresh.length + ' 条: ' + fresh.map((m) => m.content.slice(0, 20)).join(' | '))
            dispatchToContent({ type: 'harvest', memories: fresh, session_id: sessionId, dup_report: extractDupReport(acc) })
          }
        } catch { /* fail-open */ }
      })()
      return new Response(appBranch, { status: resp.status, statusText: resp.statusText, headers: resp.headers })
    } catch { return resp }
  }

  // ---- E6 面板手动插入(面板在隔离世界,经 CustomEvent 请求 MAIN world 执行) ----
  // React 受控输入:textarea 用原生 value setter + input 事件;contenteditable 用 insertText
  function insertIntoInput(text) {
    const value = String(text ?? '')
    if (!value) return false
    const target = document.querySelector('textarea:not([disabled]):not([readonly])') || document.querySelector('[contenteditable="true"]')
    if (!target) { dbg('未找到输入框,插入失败'); return false }
    try {
      if (target.isContentEditable) {
        target.focus()
        document.execCommand('insertText', false, value)
      } else {
        const proto = Object.getPrototypeOf(target)
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        desc?.set?.call(target, value)
        target.dispatchEvent(new Event('input', { bubbles: true }))
        target.focus()
      }
      dbg('面板插入完成(' + value.length + ' 字符)')
      return true
    } catch { return false }
  }
  window.addEventListener('ecolink:panel', (e) => {
    try {
      const d = JSON.parse(e.detail)
      if (d?.type === 'insert' && d.text) insertIntoInput(d.text)
    } catch { /* fail-open */ }
  })

  dbg('inject.js v2 已就绪(DSM 架构)')
})()
