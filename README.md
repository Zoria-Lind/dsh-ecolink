# dsh-ecolink

打通 **DeepSeek 网页版**与**本地 DSH** 的记忆生态:网页端记住的,DSH 直接用;DSH 里产生的,网页端也能读到。同一份结构化本地记忆池(`~/.dsh-memory/memory.json`)。

## 组件

| 组件 | 目录 | 说明 |
|---|---|---|
| dsh-ecolink-web | `extension/` | Chrome/Edge MV3 扩展:网页端标签收割(DSM 兼容格式)、请求注入(打分+预算+会话去重)、防污染三件套、popup 面板(配置/会话管理/DSM 导入/压缩) |
| dsh-ecolink-service | `service/` | 本地记忆池唯一写者:零依赖 HTTP 服务、时间戳分层、归档、**事务化压缩(暂存池 → 动态下限验收 → 提交/回滚,零丢失)**、请求日志 |
| dsh-ecolink-adapter | `adapter/` | DSH 适配层:直读记忆池、pre-step 注入、`#记忆名` 过滤 |

## 快速开始

```bash
# 1. 启动服务(记忆池唯一写者)——日常不需要手动起:
#    DSH 的 adapter 会自动拉起(serviceAutoStart 默认开);
#    登录自启任务兜底:scripts/install-autostart.ps1(不开 DSH 也能用)
node dsh-ecolink/service/server.mjs

# 2. 加载扩展
#    Edge: edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选 extension/

# 3. DSH 挂载适配层(npm 安装,推荐)
dsh plugin --profile web add @zoria-lind/dsh-ecolink-adapter

#    或本地路径(开发):
#    dsh plugin --profile web add D:/dsh/dsh-plugins/dsh-ecolink/adapter
```

服务默认 `http://127.0.0.1:17520`,零外部网络请求、零遥测;记忆数据只落在本机。
运维脚本:scripts/start-service.ps1(隐藏启动)/ stop-service.ps1(停止)/ install-autostart.ps1 / uninstall-autostart.ps1(登录自启)。

## 记忆流动

```
网页端对话 ──吐 <DSM:memory_write> 标签──▶ 扩展收割(DOM + 历史响应双通道)
     │                                       │
     │ 注入(打分+预算)                        ▼
     ◀────────────────────────────── ecolink-service 落盘
                                              │
DSH 会话 ──pre-step 注入(同选择器)──◀─────────┘ (adapter 只读)
```

- 写入:模型在网页对话中输出 `<DSM:memory_write>内容</DSM:memory_write>`(兼容
  DSM 的 key/importance 属性格式),扩展收割后落盘
- 读取:请求注入(网页端)/ pre-step 注入(DSH),同一套打分选择器
- 压缩(0.2.0,双池事务):popup 一键,网页端免费模型为主、API 压缩(`deepseek-chat`)为辅。
  开始压缩 = 过时记忆从主池移入**暂存池**(staging.json,全程留落盘副本);模型输出的新标签
  作为普通记忆写回主池;验收通过 → 清空暂存池,不达标/失败 → 暂存池**原样放回主池(零丢失)**。
  验收公式与完整流程见 `service/README.md`

## 测试

```bash
node --test extension/test/core.test.mjs   # 扩展核心 14 项
node --test service/test.mjs               # 服务 14 项
node adapter/test/smoke.mjs                # 适配层 76 项
```

## 文档

- 完整方案与阶段表:`PLAN.md`
- 组件细节见各目录 README

## License

[MIT](LICENSE) © 2026 Zoria Lind
