# dsh-ecolink-web

dsh-ecolink 的 Chrome/Edge MV3 扩展:在 chat.deepseek.com 钩住 `/api/v0/chat/completion`,
请求前注入记忆块(打分+预算+会话去重),回复里的 `<DSM:memory_write>` 标签经 DOM 收割,
落盘到本地记忆池(经 `dsh-ecolink-service`)。

> 架构 v2(2026-09-10):按已上架多版的 DeepSeek Memory(DSM)v1.5.0 稳定性架构重写。
> v1 曾两次卡死页面——教训:①改浏览器 API 返回契约(IDBRequest→Promise)会让调用方
> 回调永不触发、整个应用挂起;②重写 completion 响应流风险极高。v2 两条都移除了。

## 加载(开发)

1. 先启动服务:`node dsh-ecolink/service/server.mjs`
2. Edge:`edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选 `dsh-ecolink/extension/`
3. 打开 chat.deepseek.com;服务未启动时记忆进离线队列(badge 数字),重连自动补发

## 架构(v2)

| 文件 | 世界 | 职责 |
|---|---|---|
| `core/harvest.mjs` | —(纯函数,单测) | 标签提取/清洗/黑名单/DSM 属性格式(key/importance) |
| `core/selector.mjs` | —(纯函数,单测) | 打分排序/预算/#记忆名(⚠ 页内内联镜像,改这里必须同步 inject.js) |
| `core/prompt.mjs` | —(纯函数,单测) | 注入块组装/剥离(⚠ 同上,须与 inject.js 内联版同步) |
| `core/queue.mjs` | —(纯函数,单测) | 离线队列 + 指数退避 + 保序 |
| `background.js` | service worker(ESM) | 配置存储、池缓存(get-settings 供 content 推送)、收割/touch 转发、右键手动保存、badge |
| `content.js` | 隔离世界 | 注入 MAIN world 脚本 + 配置/池推送(CustomEvent,页内同步缓存)+ 事件转发 |
| `inject.js` | MAIN world | fetch/XHR 请求侧同步注入、历史接口响应整包清洗、DOM 树收割+剥离 |

### 关键机制

- **注入 = 页内同步**:content 经 CustomEvent(`ecolink:cu`)推送配置+池(加载/45s 周期/按需),
  请求时零跨上下文等待;singleInjection 用页内 Set(DSM 同构);空池也注入"仅系统提示词"块
  (教模型吐标签,防空池死锁)
- **收割 = DOM 树扫描**(DSM Va/Nm 模式):TreeWalker + 定时级联(50ms~8s)+ rAF 3s +
  MutationObserver → 内容指纹去重(Set,cap 1000)→ 提取(纯文本与 DSM 属性格式)→
  就地剥离(空了隐藏父元素)。**不碰 completion 响应流**;标签可能短暂闪现后消失(DSM 同款代价)
- **防污染**:历史类接口(chat_session/fetch_page/conversation)响应整包清洗(clone→text→scrub→
  new Response);DOM 剥离兜底。**无 IndexedDB 钩子**(改 IDB 契约曾卡死页面)
- **fail-open 铁律**:任何异常 → 静默放行原请求;`localStorage` 排障开关:
  `ecolink_kill`(页面侧全退出)/ `ecolink_debug`(三层日志)

## popup(点击扩展图标)

- **压缩过时记忆(一键流程,PLAN §4.4 v3)**:[开始压缩] → 后台从服务拉超过
  `compressMinAgeDays`(默认 5 天)的旧记忆清单 → 提示开新对话 → 新对话第一条消息
  自动注入压缩指令块(要求模型压缩合并 + 逐条比对原文自查 + 按原 key 输出)→
  [完成压缩] → 后台比对:内容未变的旧条目删除,已被新内容覆盖的保留
- **配置面板**:bridgeUrl/token/注入预算/过时天数/三个总开关
- **会话管理**:列出全部会话池(命名/重命名/删除)
- **DSM 一键导入**:读 chrome.storage 的 `dsm_memories` → `/memory/import-dsm`(内容去重)

## 配置(chrome.storage.local `ecolink_config`)

| 键 | 默认 | 说明 |
|---|---|---|
| bridgeUrl | `http://127.0.0.1:17520` | 本地服务地址 |
| token | `""` | 与服务端一致时启用鉴权 |
| injectEnabled | true | 注入总开关 |
| harvestEnabled | true | 收割总开关 |
| singleInjection | true | 每页每会话只注入一次 |
| maxInjectionChars | 3000 | 注入预算(长提示词自动缩减) |
| compressMinAgeDays | 5 | 压缩流程的"过时"门槛(天) |
| tagName | `DSM:memory_write` | 记忆标签名 |

## 测试

```bash
node --test extension/test/core.test.mjs   # 核心纯函数 10 项(零浏览器)
```

浏览器胶水层无 node 单测,靠 chat.deepseek.com 现网验证(debug 日志三层定位)。
