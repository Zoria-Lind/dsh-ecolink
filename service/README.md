# dsh-ecolink-service

dsh-ecolink 的本地记忆池服务:memory.json 的**唯一写者**,浏览器扩展经 localhost POST 推送记忆,DSH 适配层只读文件(PLAN.md §3.3 / §7)。

零依赖(node:http)、零 LLM 调用、只绑 127.0.0.1。

## 启动

```bash
node service/server.mjs
```

**日常不需要手动起**:DSH 的 adapter 会探测到服务未运行并自动拉起(v1.1,`serviceAutoStart` 默认开);
另有登录自启任务兜底(`scripts/install-autostart.ps1`,不开 DSH 只刷网页时服务也在)。
手动运维:`scripts/start-service.ps1`(隐藏窗口启动)/ `scripts/stop-service.ps1`(停服务)。

默认监听 `http://127.0.0.1:17520`,记忆池落盘 `~/.dsh-memory/memory.json`(归档 `archive.json`)。

## 配置(service/config.json,或环境变量覆盖)

| 键 | 默认 | 环境变量 | 说明 |
|---|---|---|---|
| port | 17520 | ECOLLINK_PORT | 监听端口 |
| token | `""` | ECOLLINK_TOKEN | 请求头 `X-Ecolink-Token` 必须一致。**留空时启动自动生成随机 token 并写回 config.json**(需把同一 token 填进扩展 popup);**空 token 一律 401**(显式设 `ECOLLINK_TOKEN=""` 即锁死服务) |
| poolDir | `~/.dsh-memory` | ECOLLINK_POOL_DIR | 记忆池目录 |
| retentionDays | 30 | ECOLLINK_RETENTION_DAYS | 归档保留期(天) |
| autoConfirm | false(代码默认;随仓 config.json 已设 **true**) | ECOLLINK_AUTO_CONFIRM | **2026-09-14 设计纠正**:确认点从网页端入池闸门改到 DSH 侧(待实现),故随仓默认 **true** = `/memory/sync` 直入池;**false** = 进建议确认队列,popup 确认后才入池(队列代码保留,显式关断才走)。两者均在服务启动时读取,改动后需重启 |
| deepseekApiKey | `""` | ECOLLINK_DEEPSEEK_API_KEY | 备用 API 压缩用。**出于安全不再落盘 config.json**,以环境变量为默认来源(兼容读取旧字段) |

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /memory/sync | 推送记忆:`{ session_id?, memories: [{ content, importance?, source?, pinned?, action?: 'add'\|'replace', id? }], confirm? }`;session_id 缺省/null → 共享池。autoConfirm=true(当前随仓默认)或请求体 `confirm:true`(压缩闭环/手动保存等显式动作)直接入库;**autoConfirm=false 时进建议确认队列**——响应保留 `{ ok, added:0, replaced:0, archived:0 }` 并带 `queued:N` |
| POST | /memory/suggest | 显式提交建议:`{ session_id?, memories: [...] }` → `{ ok, queued }` |
| POST | /memory/suggest/confirm | `{ id }` 确认建议 → 按 sync 语义入池 `{ ok, confirmed, added, replaced, archived }` |
| POST | /memory/suggest/reject | `{ id }` 拒绝(丢弃)→ `{ ok, rejected }` |
| POST | /memory/touch | `{ ids: [] }` 记录访问时间(选择器打分 + 归档豁免) |
| POST | /memory/delete | `{ ids?: [], keys?: [] }` 按 id/key 删除(压缩闭环用) |
| POST | /memory/session | `{ session_id, name?, delete? }` 会话命名/删除 |
| POST | /memory/import-dsm | `{ entries: [{ key, value, importance }] }` DeepSeek Memory(DSM)一键导入,内容去重 |
| POST | /memory/diag | `{ msg }` 诊断事件落 service.log(截 500 字) |
| POST | /memory/compress | `{ days }`(0 合法)备用 API 压缩;需 `ECOLLINK_DEEPSEEK_API_KEY` |
| POST | /memory/snapshot | 生成快照:`{ ok, hash }`;快照落 `<poolDir>/snapshots/<hash>.json`,latest.json 指向当前 |
| GET | /memory/pool | 完整记忆池 |
| GET | /memory/recent?n=10&session_id= | 最近 N 条(可按会话过滤) |
| GET | /memory/session/{id} | 指定会话池(不存在 404) |
| GET | /memory/snapshots | 快照清单:`{ ok, latest, snapshots: [{ hash, mtimeMs }] }`(mtime 倒序) |
| GET | /memory/diff?since=<hash> | 与快照对比:`{ ok, since, current, added, removed, updated }`(同时覆盖共享池与会话池;`since=latest` 取最新快照;未知快照 404) |
| GET | /memory/suggestions | 待确认建议清单:`{ ok, suggestions: [...] }`(落盘 `<poolDir>/suggestions.json`,与 memory.json 分离 → DSH 适配层读不到未确认条目) |
| GET | /memory/stale?days=5 | 超过 N 天未更新的记忆清单(压缩流程用) |
| GET | /memory/status | 条数/会话数/归档数/池文件 |

所有请求需带 `X-Ecolink-Token: <token>`(E8 默认安全;OPTIONS 预检除外)。

所有请求落盘日志到 `<poolDir>/service.log`(1MB 轮转),排障直接读文件。

所有响应 JSON;写操作经内部队列串行化,落盘为 tmp+rename 原子写;文件损坏时自动备份并空池重启。

## 时间戳分层(§4.2)

存储永远全量 UTC;`time_precision` 落盘时算初始值,**渲染降精度由消费者按 `precisionFor` 按龄重算**:2 小时内→分钟、48 小时内→小时、5 天内→日期、更早→不渲染。

## 归档(§4.3)

超过保留期(默认 30 天)且未被访问过的非 pinned 条目 → `archive.json`(不硬删,可恢复)。每次写入后检查。

## 测试

```bash
node --test service/test.mjs   # 零 API:pool 逻辑 + HTTP 全端点 + 鉴权 + 持久化
```
