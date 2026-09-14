# dsh-ecolink 方案 v2(原 dsh-memory-bridge,2026-09-10 更名)

> 更新日期:2026-09-10。
> 命名:用户认为 "memory-bridge" 体现不出"打通 DSH 与 DeepSeek 网页版生态"的完整价值,
> 更名 **dsh-ecolink**;组件命名:dsh-ecolink-web(浏览器扩展)/ dsh-ecolink-service(bridge 本地服务)
> / dsh-ecolink-adapter(DSH 适配层)。已发布的 token-optimizer v2.1 / behavior-enhancer v1.1 中
> 联动配置节名保持 `memory_bridge:` 不变(已上架,不动配置键)。
> v1 → v2 修订依据:对 `dsh-memory-bridge_template/` 下三个真实上架扩展的源码调研
> (deepseek-memory v1.5.0 / WebTool-DeepSeek / DeepSeek++),全部机制均有验证过的先例。

---

## 0. 一句话定位

打通 **chat.deepseek.com 网页版** 与 **本地 DSH** 的记忆系统,共享同一份结构化本地记忆池。
网页端记住的,DSH 直接用;DSH 里产生的,网页端也能读到。

## 1. 范围与明确不做的事

| 范围 | 决策 |
|---|---|
| 网页端 | **仅 DeepSeek 网页版**(chat.deepseek.com)。豆包/ChatGPT 等通用适配层**不做**,以后有机会再说 |
| 多设备云同步 | 不做(WebDAV 方案 deepseek-pp 有现成实现,将来可抄,但不在本计划内) |
| DeepSeek 原生记忆 API | 不存在公开可用端点(三模板均未使用),**不依赖、不调用** |
| 记忆模型调用 | 扩展与 bridge 服务**零 LLM 调用**;压缩在用户正常网页对话中完成 |

## 2. 核心设计原则

| 原则 | 说明 |
|---|---|
| 隔离与适配 | 扩展、bridge 服务、DSH 适配层三者独立,通过配置文件决定是否打通 |
| 零 Token 消耗 | 扩展/bridge 不调用任何 LLM;**所有需要"大脑"的动作(压缩/合并/重写)在免费网页对话中完成,删了重写不心疼**;万不得已的 API 调用(如 text2img 视觉摘要)只用 Flash 系列,永不用 Pro |
| 时间戳分层 | 全量存储 + 渲染降精度(见 §4.3) |
| 用户可控 | 所有阈值、路径、开关由用户配置,不强加默认值 |
| 会话隔离 | 直接用 DeepSeek 原生 `chat_session_id` + 用户命名映射(见 §3.2) |
| 改版容错 | 页面/API 结构变化时静默降级,绝不拦截或破坏原始请求(见 §9) |

## 3. 关键机制(调研修订)

### 3.1 网页端数据通道:v1 的 postMessage 假设作废

DeepSeek 网页不会为扩展发消息。三个模板的共同做法,也是本方案的唯一通道:

```
MV3 扩展(document_start content script)
  → 注入 MAIN world 脚本(web_accessible_resources)
  → patch window.fetch + XMLHttpRequest
  → 钩住 /api/v0/chat/completion
```

真实请求 payload(WebTool `DeepSeekRequest`,已实测字段):

```json
{
  "prompt": "用户输入(单字符串,非 messages 数组)",
  "chat_session_id": "...",
  "parent_message_id": "..." ,  // null = 该会话第一条消息
  "thinking_enabled": true,
  "search_enabled": false,
  "model_type": "...",
  "ref_file_ids": [],
  "preempt": false
}
```

**网页端记忆写入**(两条路,均不依赖原生记忆功能):

| 路径 | 实现 | 状态 |
|---|---|---|
| 标签收割(主) | 注入的 MEMORY_SYSTEM 提示词指示模型在回复末尾输出 `<DSM:memory_write>` 标签;扩展在 **SSE 流内过滤并收割**(WebTool 的 ReadableStream 重写模式,标签永不进 DOM) | 用户现网每天在用,已验证 |
| 手动保存(兜底) | 用户在网页端选中文本 → 右键/快捷键/按钮保存;模型不吐标签时仍可用 | 必做 |

**网页端记忆读取**:唯一通道是**请求 payload 注入**(三模板共同方案)。"静默注入"即:扩展在发送前把选中记忆拼进 prompt。v1 的"让网页端直接读文件"作废——网页端只能读到聊天框里的东西。

### 3.2 会话归属:v1 的时间窗猜测作废

每次 completion 请求自带 `chat_session_id`,归属是精确的:

- 扩展从请求 payload 读 `chat_session_id`,作为记忆的 `session_id`
- 新会话第一条消息 `parent_message_id === null` 时 session id 可能尚未生成 → pending 标记,路由更新后回绑(WebTool `bindPendingSingleInjectionSession` 模式)
- 用户命名(如"微积分补考")的映射关系存 bridge 层,DSH 用 `--session 微积分补考` 或 `--session <chat_session_id>` 均可过滤

### 3.3 文件写入通道:v1 的"扩展直接写 ~/.dsh-memory"作废

浏览器扩展**无文件系统写权限**(三模板全部把记忆锁死在 chrome.storage/IndexedDB,无一碰本地文件)。修正方案:

```
扩展 ──POST http://127.0.0.1:<port>/memory/sync──▶ bridge 本地服务 ──落盘──▶ ~/.dsh-memory/memory.json
```

- bridge 服务是 `memory.json` 的**唯一写者**(直接写盘者只有 service),从根上避免并发写冲突。
  **v0.1.1 更新(E4)**:DSH 侧获得显式写回通道 `/ecolink-push`——但 DSH 仍**不直接写盘**,
  只向 service 发 HTTP 请求(经 `/memory/sync`,E5 起默认进建议确认队列),落盘仍由 service 独占;
  DSH 适配层对池文件保持只读
- bridge 未启动时,扩展把记忆缓存在 chrome.storage.local 的离线队列,重连后补发
- 服务绑定 127.0.0.1 + 共享 token(E8:为空时启动自动生成并写回 config.json;空 token 一律 401),防任意本地网页调用

### 3.4 防污染三件套(新增,v1 完全没有)

注入的记忆块如果残留,会永久污染聊天历史。必须同时:

1. **API 响应重写**:fetch 返回的 Response / XHR 的 responseText 中剥离注入块
2. **DOM 清理**:React 会把标签拆成多个文本节点,需要 innerHTML 级清理 + MutationObserver(DSM 有完整的实现可抄)
3. **IndexedDB 拦截**:hook `history-message` store 的 get/getAll,防注入内容持久化(WebTool 独有,必抄)

发送侧同步做**注入块剥离**(mutate 时先把用户消息里的残留标签清掉再拼新块),保证 DeepSeek 侧存储永远干净。

### 3.5 注入去重与预算(新增)

- **singleInjection**:同一会话只注入一次记忆块(首条用户消息),后续轮次由对话历史携带 → 大幅省 token,与 token-optimizer 精神一致
- **选择器**:注入前打分排序——关键词权重(tags×20 / name×15 / content×5)+ 时间衰减 + 访问计数 + scope 分层(permanent 40% / contextual 45% / temporary 15%),在用户配置的 token 预算内精选(默认 3000,长提示词自动缩减)
- **`#记忆名` 显式调用**:用户输入 `#微积分补考 帮我…`,扩展识别前缀并只注入该会话记忆(WebTool `parseMemoryCommand` 模式)

## 4. 记忆池设计

### 4.1 文件结构

```json
{
  "version": 1,
  "shared_pool": [
    {
      "id": "uuid",
      "content": "用户偏好短标题",
      "timestamp": "2026-09-08T14:32:00Z",
      "time_precision": "hour",
      "source": "web",
      "importance": "called"
    }
  ],
  "session_pools": {
    "<chat_session_id>": {
      "identity": "微积分补考",
      "first_seen": "2026-09-08T02:11:00Z",
      "last_active": "2026-09-08T14:32:00Z",
      "memories": [
        { "id": "uuid", "content": "对 text2img 阈值不满", "timestamp": "...", "time_precision": "hour", "source": "web" }
      ]
    }
  }
}
```

- 默认写入共享池;用户通过指令或配置指定"记入某会话"时写入对应 session_pools
- 所有时间戳统一 **UTC** 存储,渲染时转本地
- `time_precision` 由 bridge 落盘时按规则计算,纯字符串操作,零 token

### 4.2 时间戳分层(修订:分层在渲染层,存储层永远全量)

| 时间段 | 渲染精度 | 说明 |
|---|---|---|
| 2 小时内 | 精确到分钟 | "刚才发生了什么" |
| 48 小时内 | 精确到小时 | "今天早上还是昨天下午" |
| 5 天内 | 精确到日期 | "三天前还是四天前" |
| 5 天后 | 不渲染时间戳,仅内容 | 内容中用户自己写的时间点自然保留 |

v1"5 天后删除时间戳"作废——删除后无法排序、无法取"最近 N 条"。改为:**存储全量 + 渲染降精度**,可逆、可排序。

### 4.3 过期与归档

- 纯规则:超过用户设定保留期(默认 30 天)且未被访问过的非 pinned 条目,移入 `archive.json`(不硬删,可恢复)
- pinned(置顶)条目豁免;DSH 侧写入的条目与网页侧同规则

### 4.4 记忆压缩(v3 修订 2026-09-10,吸收用户构想)

核心不变:扩展/bridge **零 LLM 调用**,压缩在免费网页对话中完成,结果走同一条收割链路写回。

**压缩流程(用户驱动,一键动作)**:

1. **触发**:池内超过 `compressMinAgeDays`(默认 5 天)的条目数/字数超阈值 → badge 提醒用户处理过时记忆
2. **隔离**:用户**打开新对话**执行压缩(绝不污染当前任务会话);是否压缩由用户决定,不自动
3. **注入**:popup 一键"开始压缩" → 扩展把**仅超过 5 天的旧记忆**(key 化清单)+ 压缩指令提示词注入该新对话的请求
4. **压缩与自核查**:指令要求网页端——①逐条合并压缩(去重/精简/归纳);②压缩后**逐条比对原文核查**:无遗漏、无编造、关键数字/专有名词保留;③核查修正后按原 key 输出终版标签(同 key 语义,key 是覆盖锚点)
5. **写回**:扩展收割终版标签 → bridge 落盘时**同 key 自动覆盖旧值**(已实现:pool.sync key 化 upsert);压缩前旧 key 集合与收割后新 key 集合比对,**不在新集合中的旧 key 显式删除**(多条合一场景)
6. **过期判断**:存储层永远全量 UTC,`timestamp < now - 5d` 精确比较即可——不需要靠渲染降精度(日期加减 hack)判断,渲染分层只影响显示

**新增服务端点(随 3c 实现)**:`GET /memory/stale?days=5`(返回过时记忆清单)、`POST /memory/delete`(按 id/key 删除)。压缩状态机(旧 key 集合记录 → 比对 → 删除)放 background/3c popup。

### 4.5 现网记忆导入(新增)

deepseek-memory 的记忆存在 `chrome.storage.local` 的 `dsm_memories` 键下(`{key, value, importance}` 结构)。bridge 提供**一键导入**,把用户现有网页端积累的记忆直接变成记忆池种子数据。

## 5. 功能模块

| 模块 | 归属 | 说明 |
|---|---|---|
| 请求 hook + 注入 | 扩展 MAIN world | §3.1 / §3.5 |
| 标签收割 | 扩展 SSE 流层 | §3.1 写入主路径 |
| 手动保存 | 扩展 content script | 选中文本 + 右键/popup |
| 防污染三件套 | 扩展 | §3.4 |
| 时间戳分层 | bridge 服务 | §4.2,落盘时计算 |
| 会话命名映射 | bridge 服务 | chat_session_id ↔ 用户命名 |
| 过期归档 | bridge 服务 | §4.3 |
| 离线队列 | 扩展 | chrome.storage.local 缓冲 + 重连补发 |
| 配置界面 | 扩展 popup | 路径/bridge 端口、注入预算、singleInjection 开关、时间戳分层自定义、自动压缩提醒阈值、DSH 打通开关、会话管理面板(列出全部会话 ID + 命名,可编辑/删除)、DSM 一键导入 |

## 6. 架构图

```
┌─────────────────────┐
│ chat.deepseek.com   │  (SPA,零配合)
│  fetch/XHR patch    │◀── MAIN world 注入脚本
│  ├─ 注入:记忆块      │      (打分+预算+会话去重)
│  ├─ 收割:memory_write│      (SSE 流内过滤,不进 DOM)
│  └─ 防污染:响应/DOM/ │      IndexedDB 三处清理
└─────────┬───────────┘
          │ postMessage
┌─────────▼───────────┐
│ MV3 扩展             │
│ content script + SW  │
│ + popup 配置面板     │
│ chrome.storage.local │  (记忆缓存 + 离线队列)
└─────────┬───────────┘
          │ POST http://127.0.0.1:<port>
┌─────────▼───────────┐
│ bridge 本地服务       │  随 DSH 适配层启动
│ 唯一写者:落盘/分层/  │
│ 命名映射/归档        │
└─────────┬───────────┘
          ▼
~/.dsh-memory/memory.json (+ archive.json)
          ▲
┌─────────┴───────────┐
│ DSH 适配层           │  读池+指令注入;显式写回走
│ dsh-memory-bridge-   │  /ecolink-push(HTTP,service 落盘)
│ adapter              │  与 token-optimizer /
│                      │  behavior-enhancer 联动开关
└─────────────────────┘
```

## 7. HTTP 接口(bridge 服务,127.0.0.1 + 可选 token)

```bash
POST /memory/sync            # 扩展推送新记忆/覆盖指令(E5 起默认进建议确认队列,autoConfirm=true 保留直入)
POST /memory/suggest         # 显式提交建议(队列)
POST /memory/suggest/confirm # 确认建议 → 入池
POST /memory/suggest/reject  # 拒绝建议 → 丢弃
POST /memory/touch           # 记录访问时间(选择器打分 + 归档豁免)
POST /memory/delete          # 按 id/key 删除(压缩闭环)
POST /memory/session         # 会话命名映射更新
POST /memory/import-dsm      # DSM 记忆一键导入(内容去重)
POST /memory/diag            # 诊断事件落 service.log
POST /memory/compress        # 备用 API 压缩(需 ECOLLINK_DEEPSEEK_API_KEY)
POST /memory/snapshot        # 生成池快照(snapshots/<hash>.json + latest.json)
GET  /memory/pool            # 完整记忆池(popup 查询)
GET  /memory/recent?n=10     # 最近 N 条
GET  /memory/session/{id}    # 指定会话的记忆
GET  /memory/snapshots       # 快照清单(latest 指向)
GET  /memory/diff?since=H    # 与快照对比(added/removed/updated,含会话池)
GET  /memory/suggestions     # 待确认建议清单(suggestions.json,与 memory.json 分离)
GET  /memory/stale?days=5    # 过时记忆清单(压缩流程用)
GET  /memory/status          # 条数/归档数/各会话数量
```

## 8. 与现有插件的联动(保持 v1)

### 8.1 dsh-token-optimizer v2.1

```yaml
memory_bridge:
  enabled: false
  sync_dir: "~/.dsh-memory"
  compress_on_sync: true
  compression_strategy: "time_decay"
  text2img_threshold: 1000      # 原 5000
  dynamic_resolution: true      # 640×360 / 1280×720 / 1920×1080 按字数
```

- 动态分辨率已确认可行:`render-text.ps1` 本身接受 `-width` 参数(现 hardcode 1200),多传参即可
- **分档(已确认 2026-09-09)**:≤2000 字 640×360、≤6000 字 1280×720、更长 1920×1080
- text2img 摘要自动存入记忆池(带时间戳和会话 ID);compactionDriver 压缩结果同步记忆池;记忆池注入 DSH 上下文减少重复输入
- **询问策略(已确认 2026-09-09)**:**达到阈值即弹窗询问,不限内容类型**,选项:转图摘要 / 直接阅读原文;**默认高亮与超时默认均按内容类型定**:自然语言→转图(高亮+超时默认),结构性强→读原文(高亮+超时默认);超时 2 分钟(可配置)。堵上 v2.0"纯散文自动转图"导致读不到原文细节的坑(用户实际事故:让 DSH 看方案细节结果只读到摘要)。复用 userQuestions 弹窗 + 指纹去重;askOnSkip 保留可关
- **转图结果缓存(已确认 2026-09-09)**:内容 hash → 摘要磁盘缓存,跨会话命中 0 API 调用;弹窗照常问,选"转图"时命中缓存直接复用摘要
- **摘要提示词堵漏(已确认 2026-09-09)**:摘要标记追加"引用细节前必须 read 原文文件核对,禁止凭摘要猜测"
- **联动配置节现在写入代码,enabled: false 占位**(已确认 2026-09-09),阶段 3b 完成后开开关即可

### 8.2 dsh-behavior-enhancer v1.1

```yaml
memory_bridge:
  enabled: false
  sync_on_check: true
  rollback_from_memory: true
  post_write_check: true
```

- **写后检查(已确认 2026-09-09,默认开启)**:文件写入后做轻量语法解析(JSON/YAML + 括号配对),失败自动从 `.bak`(带时间戳,保留最近 5 份)回滚并报告;**升级规则**:轻量解析发现 ≥3 个错误时弹窗询问,三个选项——**仅本次校验 / 本次+后续自动升级 / 不校验**;选"后续自动升级"后,本次会话内再遇 ≥3 错误不再询问、直接转编译器级(会话级记忆,重启重置);检查范围:仅 DSH write/edit 类工具写入的文件
- **修订**:"从记忆池找回文件正确版本"需要单独的文件快照存储(`~/.dsh-memory/files/`),记忆池本身只存聊天记忆——两者分开,快照机制在 v1.1 里独立实现
- **联动配置节现在写入代码,enabled: false 占位**(已确认 2026-09-09)
- 记忆池中的历史行为注入 behaviorPrompt:保持

## 9. 风险登记(新增)

| 风险 | 缓解 |
|---|---|
| 页面改版:`prompt` 字段名/completion 路径/parent_message_id 语义变化 | fetch+XHR 双 hook、多 payload 形态兼容、任何异常静默降级放行原请求 |
| 模型标签服从性:不吐 memory_write 标签 | 手动保存兜底 + 收割侧黑名单校验(DSM `isValidMemoryWrite` 模式) |
| 注入污染聊天历史 | §3.4 三件套 + 发送侧剥离 |
| bridge 服务未启动 | 扩展离线队列 + 重连补发 |
| 并发写 memory.json | bridge 服务唯一写者(DSH 只发请求不写盘);建议确认队列进一步收敛写入 |
| 时区错乱 | 存储统一 UTC,渲染转本地 |
| Chrome Web Store 审查 | 权限最小化(storage + chat.deepseek.com + 127.0.0.1 host_permissions);三模板均已上架,先例充分 |

## 10. 迭代阶段(修订)

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | dsh-token-optimizer v2.1:text2img 阈值 1000 + 动态尺寸 + 询问机制 | ✅ 已发布(v2.1.0) |
| 2 | dsh-behavior-enhancer v1.1:写后检查 + .bak 回滚(文件快照独立于记忆池) | ✅ 已发布(v1.1.0) |
| 3a | 扩展核心通道:fetch/XHR patch + 注入 + SSE 流收割 + 防污染三件套 | ✅ 2026-09-10 现网验证通过(收割/注入/防垃圾/防卡死全绿;架构按 DSM v1.5.0 重写,踩坑见 PROJECT-MEMORY) |
| 3b | bridge 本地服务:localhost 收 POST + 落盘 + 时间戳分层 + 会话命名 + 归档 | ✅ 2026-09-10 完成(`service/` 下 server.mjs + pool.mjs,5 项单测全绿,未与扩展联调) |
| 3c | popup 配置面板 + 会话管理 + DSM 一键导入 + 压缩提醒 | ✅ 2026-09-10 完成(popup 四区:压缩一键流程/配置/会话管理/DSM 导入;压缩状态机:开始→旧清单快照→新对话注入压缩指令→收割新 key→结束按"内容未变才删"比对删除;服务端 /memory/stale + /memory/delete;服务/扩展 README 同步) |
| 4 | DSH 适配层:直读 memory.json + `--session` 过滤 + 两个插件的联动开关 | ✅ v0(2026-09-10):`adapter/` 直读池(mtime 缓存只读)+ pre-step 注入(同源选择器+块标记幂等+singleInjection)+ `#记忆名` 过滤,8 项冒烟全过。DSH CLI 实测无 `--session`(只有 `--resume <session>` 且期望会话 id),"按命名会话自动绑定"待 DSH 能力;两插件联动开关待适配层稳定后启用 |
| 5 | 文档 + 博客 + awesome 更新 | ✅ 仓库 v0 已整备(git 08fba67,含根 README/LICENSE/三组件文档,已存档 E 盘两克隆待推 GitHub);迭代博客待 9-14 新模型后写 |
| 6 | **v0.1.1 迭代(E0–E8)+ adapter v1.1 服务自动拉起** | ✅ 代码级完成(2026-09-13/14):E0 离线队列并发修复、E1 通道分离、E2 skill、E3 快照/diff、E4 /ecolink-push、E5 建议确认队列、E6 面板+badge、E7 静音+黑名单、E8 鉴权;v1.1 serviceGuard 自动拉起 + scripts 自启。测试 12/66/14 全绿;**未提交未发布**,手工验收进行中(ZZ 清单 + 12 号文档更正) |
| 7 | **DSH 侧确认点(2026-09-14 设计纠正的待实现项)** | ⬜ 未开始:pre-step 检测到新增网页端记忆时,向用户询问"要不要扫描网页端记忆"(确认点从网页端入池闸门移至此;在实现前 DSH 侧见到的网页记忆未经确认,与设计意图一致) |

## 11. 与现有方案的差异(更新)

| 方案 | 特点 | 本方案差异 |
|---|---|---|
| DeepSeek Memory(DSM) | 网页端标签式记忆,锁死在 chrome.storage | 打通 DSH 本地文件,且可一键导入其记忆 |
| WebTool-DeepSeek / DeepSeek++ | 网页端功能最强(工具/技能/同步),记忆锁死在 IndexedDB | 只做记忆一件事,但真正落地到本地文件、跨端共享 |
| DSH 记忆插件(dsh-mneme 等) | 只在 DSH 内部跨会话记忆 | 打通网页端与 DSH |
| convoport 类 | 同步原始对话历史 | 同步结构化记忆,非原始对话 |
| dsh-token-optimizer | 压缩 DSH 输入 token | 压缩记忆池本身(由网页端完成),并联动注入 |
| dsh-behavior-enhancer | 控制 DSH 行为 | 通过记忆池 + 文件快照增强回滚与检查 |

## 12. 将来(明确搁置)

- 豆包 / ChatGPT 等网页 AI 适配层——不做,以后有机会再说
- 多设备云同步——WebDAV 方案(deepseek-pp)可抄,不在本计划
- 图片/文件记忆、与 token-optimizer 的更深联动——v3 再议
