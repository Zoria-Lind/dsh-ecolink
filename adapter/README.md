# dsh-ecolink-adapter

dsh-ecolink 的 DSH 适配层(v1):直读本地记忆池(`~/.dsh-memory/memory.json`,只读),
经 `agent/pre-step` 维持 DSM:memory_write 指令通道(E1),提供 `/ecolink-push` 显式写回(E4)
与记忆 skill 按需读取(E2),打通"网页端记住 → DSH 直接用;DSH 产出 → 网页端可用"。

> **v0.1.1 变更摘要(E0–E8)**:离线队列并发丢条目修复(E0,extension/core/queue.mjs);
> 指令/内容通道分离——指令每轮幂等注入(plugin 快照消息,不改写用户消息、不碰前缀缓存),
> 内容默认不注入、由 skill 按需 read,`contentInjectionEnabled` 为逃生舱(E1);
> 记忆 skill `ecolink-memory` 运行时注册(E2);服务端快照/hash/diff 三端点(E3);
> `/ecolink-push` 写回(复用 /memory/sync,source:'dsh',service 唯一写者)(E4);
> 建议确认队列(sync 进队列、确认才入池;未确认条目不进 DSH 上下文)(E5);
> 网页端只读面板 + chrome.alarms badge(E6);静音 + 黑名单(E7);服务默认安全(E8)。
>
> **v1.1(2026-09-14)**:service 自动拉起——探测到 17520 未监听就本机 spawn 拉起
> (apply + pre-step 60s 节流;仅本地 URL;`serviceAutoStart` 默认开)。E5 设计纠正:
> 确认点改到 DSH 侧(待实现),随仓 config.json 设 `autoConfirm: true`,网页收割直入池。

## 安装(link 挂载,与 token-optimizer 同款)

```bash
dsh plugin --profile web add D:/dsh/dsh-plugins/dsh-ecolink/adapter
```

## 机制

- **只读池文件**:mtime 缓存(文件变化立即重读,TTL 5s 兜底);唯一写者是 ecolink-service
- **指令通道(E1,默认开)**:每轮 pre-step 末尾追加一条 `source.kind='plugin'` 的
  `[dsh-ecolink 指令]` 快照消息(照抄内核 dsh-time-context 形态:prepend 注册 + await next +
  createUserMessage;决策里的 messages 只喂本步请求、不写会话事件)。剥旧追加 → 每轮幂等不叠加
- **内容通道(E1,默认关)**:`contentInjectionEnabled: true` 恢复旧行为——改写用户消息注入
  记忆块(2-gram 打分 + 时间衰减 + 预算 + 长提示词缩减 + singleInjection 会话去重)
- **`/ecolink-push`(E4)**:斜杠命令,把指定要点 POST 到 service 的 `/memory/sync`
  (source:'dsh');token 未配置时自动读同仓 `service/config.json`;service 是唯一写者
- **记忆 skill(E2)**:注册 `ecolink-memory`,指引模型用 read 按需读池原文(引用前必须核对)
- **service 自动拉起(v1.1)**:apply 时与每次 pre-step(60s 节流)探测 `serviceUrl/memory/status`;
  任何 HTTP 响应(含 401)= 已活;网络错误 = 未运行 → spawn 同仓 `service/server.mjs`
  (detached + 无窗口)。仅对 127.0.0.1/localhost/::1 生效;service 目录缺失(独立发布包)静默跳过。
  与登录自启任务兼容:端口已监听就不会重复起
- **fail-open**:池不存在/读失败/任何异常 → 静默放行,绝不破坏请求
- 只处理 `source.kind='user'` 的真实用户消息(DSH runtime-context 快照直接放行)

## 配置(cordis.patch.yml)

```yaml
adapter:
  enabled: true
  poolPath: '~/.dsh-memory/memory.json'
  poolTtlMs: 5000
  injectEnabled: true            # 总开关(false = 两个通道全关)
  singleInjection: true          # 内容通道专用(指令通道天然每轮幂等)
  maxInjectionChars: 3000        # 内容通道注入预算
  instructionEnabled: true       # E1 指令通道
  contentInjectionEnabled: false # E1 内容逃生舱
  skillName: 'ecolink-memory'    # E2 skill 注册名
  serviceUrl: 'http://127.0.0.1:17520' # E4 写回目标
  serviceToken: ''               # E4;留空自动读同仓 service/config.json(E8 自动生成)
  serviceAutoStart: true         # v1.1;探测到服务未运行就自动拉起(仅本地 URL 生效)
```

## 测试

```bash
node adapter/test/smoke.mjs   # 66 项,零 API
```

## 已知限制

- 会话过滤靠 `#记忆名` 显式调用;DSH CLI 的 `--resume <session>` 只接受会话 id,
  "按命名会话自动绑定"待 DSH 提供 `--session` 能力后再做
- 与 token-optimizer / behavior-enhancer 的联动开关(两插件中 `memory_bridge` 占位节)
  待适配层稳定后启用
- `inject.js` 仍是经典脚本,INSTRUCTION_PROMPT/BLOCK_RE 等与 core/*.mjs 镜像维护
  (注释锁死);彻底消除镜像需要构建期注入(P5/0D 结论)
- adapter npm 发布口径未解决:`src/modules/memoryInject.js` 跨目录 import `extension/core/*`,
  npm `files` 无法引用包根之外路径(E8#5 有据缓办;Junction 挂载不受影响)
