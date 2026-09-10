# dsh-ecolink-adapter

dsh-ecolink 的 DSH 适配层(v0):直读本地记忆池(`~/.dsh-memory/memory.json`,只读),
在 DSH 的 `agent/pre-step` 注入与当前消息相关的记忆,打通"网页端记住 → DSH 直接用"。

## 安装(link 挂载,与 token-optimizer 同款)

```bash
dsh plugin --profile web add D:/dsh/dsh-plugins/dsh-ecolink/adapter
```

## 机制

- **只读池文件**:mtime 缓存(文件变化立即重读,TTL 5s 兜底);唯一写者是 ecolink-service
- **注入**:与网页端同源的选择器(2-gram 打分 + 时间衰减 + 预算 + 长提示词自动缩减)+
  块标记幂等剥离(DSH 每 step 重发 inbox,防残留)
- **会话去重**:singleInjection,每 DSH 会话只注入一次,后续轮次由对话历史携带
- **#记忆名 过滤**:提示词里 `#微积分补考` 命中网页端命名的会话池 → 只注入该池
- **fail-open**:池不存在/读失败/任何异常 → 静默放行,绝不破坏请求
- 只处理 `source.kind='user'` 的真实用户消息(DSH runtime-context 快照直接放行)

## 配置(cordis.patch.yml)

```yaml
adapter:
  enabled: true
  poolPath: '~/.dsh-memory/memory.json'
  poolTtlMs: 5000
  injectEnabled: true
  singleInjection: true
  maxInjectionChars: 3000
```

## 测试

```bash
node adapter/test/smoke.mjs   # 8 项,零 API
```

## 已知限制(v0)

- 会话过滤靠 `#记忆名` 显式调用;DSH CLI 的 `--resume <session>` 只接受会话 id,
  "按命名会话自动绑定"待 DSH 提供 `--session` 能力后再做
- 与 token-optimizer / behavior-enhancer 的联动开关(两插件中 `memory_bridge` 占位节)
  待适配层稳定后启用
