# 桌面宿主补丁（实验性）

把 DSH 桌面端变成“同一个窗口里既有 Harness、也有 DeepSeek 网页”的形态，并补上影子会话、页内划选入池、缩放和“带入草稿”。

**这不是 npm 功能，也不在 dsh-ecolink 1.x 的稳定契约里。** 它直接改桌面安装的 `resources/app.asar`，需要管理员权限；DSH 一升级就失效，必须按当前版本重建。先备份、再动手。

## 适用基线

- DSH 桌面 **`0.2.2-rc.1`**（`prepare-host.mjs` 会校验 `resources/app.asar` 里的版本，不是这个版本直接报错）。
- Electron 44.7.0（随该版本 DSH 提供）。
- Windows。补丁逻辑本身不绑定盘符，但应用/回退步骤以 PowerShell 为例。

## 它能做什么

- **同窗 DeepSeek**：左上角透明切换键，在同一个窗口打开/返回 `chat.deepseek.com`；切回 Harness 时网页保持挂载，再打开还在原处。
- **影子会话（v1.1.0）**：在网页右上角把当前对话绑定到一个 DSH 项目会话；「同步到 Harness」把已完成的网页问答写进绑定会话，「交办给 DSH」直接派任务，Harness 的回答按 Markdown 回显在原网页对话里。Harness 侧行尾显示 ⇄ 标识，左上角「刷新同步」或 Ctrl+R 可补齐两端。
- **划选入池**：在用户消息或回答正文里划选，浮出“入记忆池”，保存为完整 artifact（不是短记忆）。
- **记忆池与压缩**：在内置网页右下角打开「记忆池」，查看内容或开始压缩。按提示开启网页新对话并发送消息，等回答完成后回到记忆池点击「完成压缩」。桌面包直接使用扩展的压缩按钮、提示和验收代码。
- **缩放**：鼠标在网页上 Ctrl+滚轮缩放；页面聚焦时 Ctrl+`+` / `-` / `0` 放大、缩小、重置。
- **带入草稿**：DSH 侧栏记忆池里的“带入草稿”，把已加载完整的正文插进当前对话输入框，由你决定发不发。

## 目录里有什么

| 文件 | 作用 |
|---|---|
| `prepare-host.mjs` | 从原始 `app.asar` 生成补丁包（主进程 + preload + guest preload + 记忆桥） |
| `patch-host.mjs` | 对主进程/preload 做定点替换；锚点不唯一或漂移就报错，不猜 |
| `memory-bridge.mjs` | 读取 `resources/ecolink-desktop.json` 或环境变量，建立到本地 service 的受控桥 |
| `build-guest.mjs` | 把扩展的 `inject.js` / `content.js` / `artifact.js` 与 `selection.cjs`、`shadow.cjs`、`zoom.cjs` 组装成 `ecolink-guest.cjs` |
| `build-compression.mjs` | 构建时复用扩展的记忆面板、压缩界面和后台流程 |
| `selection.cjs` | 页内划选按钮 |
| `shadow.cjs` | 网页侧影子会话面板、同步清单与回显 |
| `shadow-markdown.cjs` | 回显 Markdown 渲染（链接/图片只渲染为可点文本，不加载远程资源） |
| `vendor/marked.umd.js` | 打包进 guest preload 的 Marked（MIT，许可证见同目录） |
| `zoom.cjs` | 内嵌页缩放 |
| `fixture/` | Electron/Edge 夹具，给改动补丁本身时用；日常使用不需要 |

## 构建

1. **备份**桌面安装的 `resources/app.asar`，放到安装目录之外。
2. 找一个输出路径（不能已存在，`prepare-host` 用 `wx` 打开）。
3. 在仓库根目录执行（把两个路径换成你的）：

```bash
node --input-type=module -e "import { prepareHost } from './desktop/prepare-host.mjs'; await prepareHost(process.argv[1], process.argv[2])" "<安装目录>/resources/app.asar" "<输出目录>/app.asar"
```

4. 检查输出包能启动、四个 JavaScript 入口语法正常（构建脚本内部会生成 `main` / `preload` / `guest` / `compression`，也可自行导出复核）。

## 安装与回退

1. 完全退出 DSH 桌面端（确认进程为 0）。
2. 在 `resources/` 放 `ecolink-desktop.json`，指向你自己的 service 配置：

```json
{"serviceConfig":"<DSH profile>/node_modules/@zoria-lind/dsh-ecolink-adapter/service/config.json"}
```

   或者不用 sidecar，启动前设置 `DSH_ECOLINK_BRIDGE_PORT` 与 `DSH_ECOLINK_BRIDGE_TOKEN` 环境变量。

3. 用管理员权限把生成的 `app.asar` 替换到 `resources/app.asar`。
4. 用普通权限启动 DSH。
5. **回退**：退出 DSH，把备份的 `app.asar` 换回去。

如果第一次打开时 service 还没生成 `config.json`，桥会静默关闭；先让 DSH 跑一次让 adapter 拉起 service，再重启即可。

## 边界与隐私

- 桥只连 `127.0.0.1`，带 `X-Ecolink-Token`；只接受租约所属 guest 的主框架、且 URL 必须是 `https://chat.deepseek.com` 的 IPC。
- 记忆列表通过桌面桥加载到隔离面板。开启压缩后，原扩展流程会把符合条件的旧记忆带入网页新对话。压缩进度保存在 DSH 的本地用户数据目录。
- 网页分区是持久的（`persist:dsh-ecolink-chat`），登录状态跨重启保留；账号凭据不迁移到其他应用。
- 补丁会把构建当次的扩展脚本嵌进 `ecolink-guest.cjs`。**扩展改了就要重新打补丁**，否则内嵌页还是旧脚本。
- DSH 更新、重装或修复安装都会覆盖 `app.asar`，补丁随之消失；升级后按本文件重建。

## 夹具（可选）

```bash
# 网页侧合成测试（需要本机 Edge）
DSH_ECO_STATE=<临时目录> ECO04B_EDGE=<Edge 路径> node desktop/fixture/edge.mjs

# Electron 侧（需要已构建的补丁包和独立 profile）
ECO04B_FIXTURE=<独立目录> electron.exe <fixture-app> --user-data-dir=<独立 profile>
```

夹具用合成网页和临时记忆文件，不碰真实账号与真实池。
