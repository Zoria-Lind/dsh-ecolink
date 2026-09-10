# dsh-ecolink-service

dsh-ecolink 的本地记忆池服务:memory.json 的**唯一写者**,浏览器扩展经 localhost POST 推送记忆,DSH 适配层只读文件(PLAN.md §3.3 / §7)。

零依赖(node:http)、零 LLM 调用、只绑 127.0.0.1。

## 启动

```bash
node service/server.mjs
```

默认监听 `http://127.0.0.1:17520`,记忆池落盘 `~/.dsh-memory/memory.json`(归档 `archive.json`)。

## 配置(service/config.json,或环境变量覆盖)

| 键 | 默认 | 环境变量 | 说明 |
|---|---|---|---|
| port | 17520 | ECOLLINK_PORT | 监听端口 |
| token | `""` | ECOLLINK_TOKEN | 非空时要求请求头 `X-Ecolink-Token` 一致 |
| poolDir | `~/.dsh-memory` | ECOLLINK_POOL_DIR | 记忆池目录 |
| retentionDays | 30 | ECOLLINK_RETENTION_DAYS | 归档保留期(天) |

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /memory/sync | 推送记忆:`{ session_id?, memories: [{ content, importance?, source?, pinned?, action?: 'add'\|'replace', id? }] }`;session_id 缺省/null → 共享池 |
| POST | /memory/touch | `{ ids: [] }` 记录访问时间(选择器打分 + 归档豁免) |
| POST | /memory/delete | `{ ids?: [], keys?: [] }` 按 id/key 删除(压缩闭环用) |
| POST | /memory/session | `{ session_id, name?, delete? }` 会话命名/删除 |
| POST | /memory/import-dsm | `{ entries: [{ key, value, importance }] }` DeepSeek Memory(DSM)一键导入,内容去重 |
| GET | /memory/pool | 完整记忆池 |
| GET | /memory/recent?n=10&session_id= | 最近 N 条(可按会话过滤) |
| GET | /memory/session/{id} | 指定会话池(不存在 404) |
| GET | /memory/stale?days=5 | 超过 N 天未更新的记忆清单(压缩流程用) |
| GET | /memory/status | 条数/会话数/归档数/池文件 |

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
