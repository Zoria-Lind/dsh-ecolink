> **v1.0.1（2026-11-07）**：桌面版补上「记忆池」与压缩闭环——在内置网页直接查看记忆、发起压缩并按提示完成验收；同时修复插件热重载时 `ecolink_memory` 工具重复注册导致整轮运行失败的问题。
>
> **v1.0.0（2026-11-06）**：Harness 和 DeepSeek 网页端不再孤立——同一个窗口一键切换，双端记忆按你的选择互通；网页里查到的、写下的，可以存成完整成果、带进 Harness 草稿，鼠标划一段也能入池。安全：不碰账号、不上云、不代理请求。核心接口自本版冻结：新增功能走 1.x，破坏性改动走 2.0.0。

# dsh-ecolink

**左边 Harness，右边 DeepSeek 网页？不用二选一。** 一个按钮切过去查资料、写东西，再一个按钮切回来接着干；两边的记忆不是各过各的，而是同一份本地记忆池，按你的选择互通。

一句话：**网页端和 Harness 不再是两个孤岛。**

## 安装

要求：Node.js 18+；DSH `0.2.2-rc.1`（本版实测）。

### 1. 装 DSH 适配层（必装，自带本地服务）

```bash
dsh plugin --profile web add @zoria-lind/dsh-ecolink-adapter@1.0.1
```

- Web 版 DSH 用 `--profile web`；桌面客户端用 `--profile desktop`。
- **只装 adapter 就够了**：service 已经打包在 adapter 包里，会自动拉起（`127.0.0.1:17520`），**不需要再装 `@zoria-lind/dsh-ecolink-service`**。
- 装完**重启 DSH**；打开右侧栏「记忆池」，能看到条目就说明链路通了。
- 想手动起服务：`node <仓库>/service/server.mjs`；登录自启：`scripts/install-autostart.ps1`。

### 2. 装浏览器扩展（按需；只用 DSH 内置网页可以不装）

**什么时候需要**：你在普通 Edge/Chrome 里用 DeepSeek；或者需要网页端自动注入共享池、popup 压缩/DSM 导入/会话管理、离线队列、右键菜单。**只用 DSH 桌面内置网页时不需要**——内置页自带收割、完整成果保存和划选入池。

1. 下载或克隆本仓库。
2. Edge 打开 `edge://extensions`，Chrome 打开 `chrome://extensions`。
3. 打开「开发人员模式」。
4. 点「加载解压缩的扩展」，选仓库里的 `extension/` 目录。
5. 打开 `chat.deepseek.com` 并刷新页面。

扩展会自己向本地服务要 token（`/memory/token`）。如果 popup 提示 401，重新打开 popup 会自动重取；仍失败再按提示把 `service/config.json` 里的 token 手动填进去。

> 扩展只连 `127.0.0.1`，不登录、不上传。更新扩展后，在扩展页点「重新加载」再刷新网页。

### 3. 想要同窗切换 / 划选入池 / 缩放（可选）

这不是 npm 安装，而是本地宿主补丁：需要管理员替换桌面安装的 `app.asar`，只支持 DSH 桌面 `0.2.2-rc.1`。先读 [desktop/README.md](desktop/README.md)，按里面的备份、构建、应用、回退步骤来。

### 只想要本地服务（不装 DSH）

```bash
npm i -g @zoria-lind/dsh-ecolink-service
# 或
npx ecolink-service
```

这是唯一需要单独装 service 的场景：只用浏览器扩展、不装 DSH，或者想用登录自启任务。装了 adapter 就不要再装它。

### 装完检查

- DSH 右侧栏出现「记忆池」；
- 点扩展图标，popup 能读到服务状态和池子（没装扩展就跳过这条）；
- 桌面左上角出现「DeepSeek 网页 / 返回 Harness」切换键（仅桌面补丁用户）。

## 一键切换，双端互通

- **一键切换**：DSH 桌面左上角的「DeepSeek 网页 / 返回 Harness」，同一个窗口来回切；网页保持挂载，切回来还在原对话。
- **记忆选择性互通**：共用一份 `~/.dsh-memory/memory.json`。通用记忆只在新对话开局自动带上；其他记忆留在池里，等你在侧栏明确注入，或把正文带进当前草稿。不是“整池灌进每个对话”。
- **网页 → Harness**：回答旁的“保存完整成果”把整段正文存成 artifact（一份可全文读取的文档）；Harness 侧栏直接读全文、“带入草稿”；鼠标选中一段，浮出“入记忆池”就能收进池子。
- **Harness → 网页**：`/ecolink-push` 把 DSH 侧写下的记忆写回池；网页端按预算和会话去重注入，下次接着聊。

> 同窗切换 / 划选入池 / 带入草稿由上面的第 3 步（桌面宿主补丁）提供。内置网页自带的收割/保存/划选也不需要浏览器扩展；扩展只在你用普通浏览器、需要自动注入或 popup 时才装。三者可单用，也可叠满。

## 安全：不碰账号，不上云

- **不登录、不托管、不转发账号**：插件只在你已经登录的 DeepSeek 页面里工作，不代登录、不保存密码。
- **不代理、不绕过限流、不发第三方**：请求仍由你的浏览器直发 DeepSeek；插件只在本地读写记忆，不把内容发到任何外部服务器。
- **数据只在本机**：记忆池在 `~/.dsh-memory`；本地服务只监听 `127.0.0.1`，带 token 鉴权。
- **桌面内嵌页更克制**：只收割短标签和显式保存，不把共享池注入网页、不显示记忆面板；IPC 同时校验租约、主框架和 `chat.deepseek.com` 源。
- 从实现上说，没有“代登录 / 代刷 / 外挂”这类封号风险；平台规则若有变化，仍以 DeepSeek 官方条款为准。

## 这一版还能做什么

| 场景 | 能力 |
|---|---|
| 网页里 | 模型输出的 `<DSM:memory_write>` 标签自动收割；请求前按预算注入；回答旁的“保存完整成果”把整段正文存成 artifact |
| DSH 里 | 右侧栏“记忆池”：搜索、全文分页、通用/非通用筛选与转换、显式注入当前对话 |
| 命令 | `/ecolink-list` 看目录，`/ecolink-read` 取全文，`/ecolink-diff` 只看变化，`/ecolink-push` 把 DSH 侧记忆写回池 |
| 工具 | `ecolink_memory`：给模型用的 `list` / `read`，和命令同一套数据 |
| 桌面补丁（可选） | 同一个窗口打开 DeepSeek 网页、页内划选“入记忆池”、Ctrl+滚轮/键盘缩放、把记忆正文“带入草稿” |

## 组件

| 组件 | 目录 | 说明 |
|---|---|---|
| dsh-ecolink-web | `extension/` | Chrome/Edge MV3 扩展：普通浏览器里的标签收割、请求注入、防污染、popup、完整成果保存；DSH 内置网页自带同名脚本，无需安装扩展 |
| dsh-ecolink-service | `service/` | 本地记忆池唯一写者：零依赖 HTTP 服务、事务化压缩、artifact 全文存储；adapter 包内已含，也可单独安装 |
| dsh-ecolink-adapter | `adapter/` | DSH 适配层：直读记忆池、pre-step 注入、侧栏、指定读取、模型工具；npm 包里自带 service 与自动拉起 |
| 桌面宿主补丁 | `desktop/` | 可选、实验性：同窗 DeepSeek 网页、划选入池、缩放、带入草稿；需管理员替换桌面 `app.asar`，详见 [desktop/README.md](desktop/README.md) |

## 装完之后到底能用什么

| 功能 | npm adapter + service | 浏览器扩展 | DSH 内置网页（桌面补丁） |
|---|---|---|---|
| Harness ↔ 内置网页一键切换 | ❌ | — | ✅ |
| 双端记忆选择性互通 | ✅ | ✅ | ✅ 内置页只收割，不注入 |
| 记忆侧栏、全文读取、注入、通用/非通用 | ✅ | — | ✅ |
| 内置网页短标签收割 | — | — | ✅ 自带，无需扩展 |
| 普通浏览器网页收割 / 请求注入 | — | ✅ | — |
| 网页“保存完整成果”存成文档 | — | ✅ | ✅ 内置页 |
| 侧栏“带入草稿” | ❌ 按钮不渲染 | — | ✅ |
| 页内划选“入记忆池” | ❌ | ⚠ 仅右键保存为短记忆 | ✅ 保存为完整 artifact |
| 网页端自动注入共享池 | — | ✅ | ❌ 设计上关闭 |
| popup：压缩 / DSM 导入 / 会话管理 | — | ✅ | ❌ |
| Ctrl+滚轮 / 键盘缩放 | ❌ | — | ✅ |
| 本地 service 自动拉起 | ✅ | — | ✅ |

一句话：**npm 装完得到的是 DSH 侧栏 + 服务 + 自动拉起；DSH 内置网页自带收割，不需要扩展；只有普通浏览器、自动注入和 popup 才要扩展；一键切换和划选入池要桌面补丁。**

## 1.0.0 的承诺

**稳定（1.x 内不破坏）**

- 两个 npm 包名：`@zoria-lind/dsh-ecolink-adapter`、`@zoria-lind/dsh-ecolink-service`；
- 命令：`/ecolink-list`、`/ecolink-read`、`/ecolink-diff`、`/ecolink-push`；
- 模型工具名与语义：`ecolink_memory` 的 `list` / `read`；
- 侧栏“记忆池”的核心语义：预览、分页、通用/非通用、显式注入；
- adapter 配置键与 service `/memory/*` 端点；
- 池文件与 artifact 的落盘格式。

**1.x 允许**：新增端点、新增配置键、新增可选参数、新增 UI；旧调用保持可用。

**2.0.0 才做**：删除或改语义、改配置键默认值、改落盘格式。

**不在契约内**：`desktop/` 宿主补丁（实验性，跟随 DSH 版本）、扩展对 DeepSeek 页面 DOM 的适配（页面改版时可能跟着调）。

## 兼容性

- **DSH `0.2.2-rc.1`**：本版实测。`engines.dsh` 与 `dsh.compatibility` 都只声明这个版本，不吹没跑过的宿主。
- **从 0.3.0 升级**：npm 的 `^0.3.0` 不会自动跨到 1.0.0，需要显式安装 `@zoria-lind/dsh-ecolink-adapter@1.0.0`。
- **桌面补丁**：只认 DSH 桌面 `0.2.2-rc.1` 的 `app.asar`；DSH 一升级就失效，必须重建。先看 [desktop/README.md](desktop/README.md)，里面有备份和回退。

## 记忆流动

```
网页端对话 ──吐 <DSM:memory_write> 标签──▶ 扩展收割（DOM + 历史响应双通道）
     │                                       │
     │ 注入（打分 + 预算）                    ▼
     ◀────────────────────────────── ecolink-service 落盘
                                              │
DSH 会话 ──pre-step 注入（同选择器）──◀────────┘（adapter 只读）

桌面补丁：内嵌网页 ──租约 + 受控 IPC──▶ 同一个本地 service（只收割，不注入共享池）
```

- **写入**：模型在网页对话中输出 `<DSM:memory_write>内容</DSM:memory_write>`，扩展收割后落盘；DSH 侧也可以 `/ecolink-push`。
- **读取**：网页端请求注入 + DSH pre-step 注入，共用同一套打分选择器。
- **全文**：`/ecolink-read` 和侧栏读存储正文；“保存完整成果”走 `/memory/artifact`，独立于短记忆，保留历史修订。
- **压缩**：popup 一键，双池事务——过时记忆先移入暂存池，模型产出新标签后验收，通过才提交，失败原样放回，零丢失。

## 测试

```bash
node adapter/test/smoke.mjs
DSH_ECO_STATE=<临时目录> node --test adapter/test/ui.mjs
node --test extension/test/core.test.mjs extension/test/artifact.test.mjs
node service/test.mjs
node --test service/iteration.test.mjs
```

`adapter/test/iteration.mjs` 和更完整的宿主回归需要仓库外的 `_evidence` 宿主夹具（按 SHA-256 校验的安装副本），公开 clone 里没有，属于本机验收项。桌面补丁的夹具在 `desktop/fixture/`，需要 Electron 环境和环境变量，详见 [desktop/README.md](desktop/README.md)。

## 文档

- 完整方案与阶段表：[PLAN.md](PLAN.md)
- 适配层规则与限制：[adapter/README.md](adapter/README.md)
- 服务端点与配置：[service/README.md](service/README.md)
- 桌面宿主补丁：[desktop/README.md](desktop/README.md)

## License

[MIT](LICENSE) © 2026 Zoria Lind
