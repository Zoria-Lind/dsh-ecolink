# dsh-ecolink-adapter

v1.1.0 新增影子会话：把一条 DeepSeek 网页对话绑定到一个 DSH 项目会话，网页问答可同步进 Harness，Harness 的回答会回显在网页里；配合桌面宿主补丁支持双端「刷新同步」与「交办给 DSH」。影子会话接口挂在 `/api/ecolink-shadow`，属于 1.x 新增能力。

v1.0.1 修复插件热重载（如装新插件触发 config reload）时旧实例的 `ecolink_memory` 工具尚未注销、`register` 抛 “already registered” 导致整轮运行失败的问题；桌面宿主补丁新增记忆池与压缩闭环（仍属实验性本地补丁，不属于 npm 契约）。

v1.0.0 起提供指定全文读取、记忆侧栏与通用/非通用分类、网页完整成果保存，并配套可选的桌面宿主补丁（同窗 DeepSeek 网页、划选入池、缩放、带入草稿）。核心接口自 1.0.0 起冻结：新增功能走 1.x，破坏性改动走 2.0.0；桌面宿主补丁是实验性本地补丁，不属于 npm 契约。仅在 DSH `0.2.2-rc.1` 实测，`engines.dsh` 与 `dsh.compatibility` 都只声明该版本。发布包需由仓库根目录的 `scripts/build-npm-pkgs.mjs` 生成镜像布局，不能直接把 adapter 子目录当作完整包。

## 安装与包关系

- DSH 用户只装 `@zoria-lind/dsh-ecolink-adapter` 即可；npm 包里自带 `service/`，适配层会自动拉起本地服务，不需要再装 `@zoria-lind/dsh-ecolink-service`。
- `@zoria-lind/dsh-ecolink-service` 是可选独立形态：不装 DSH、只用浏览器扩展，或需要登录自启时单独安装。
- 浏览器扩展不是 DSH 内置网页的前置条件；只有普通浏览器、网页端自动注入或 popup 功能才需要它。

## 指定读取

- `/ecolink-list 搜索词`：目录和短摘要。
- `/ecolink-read 完整条目名称`：存储正文；同名先返回候选。
- `/ecolink-read {"ref":"目录返回的ref","version":"返回版本","offset":0,"limit":2000}`：按 `nextOffset` 续读，直到 null。名称中有空格和中文也支持。
- 模型工具 `ecolink_memory` 提供相同的 `list` / `read`，注册在当前 agent 自有工具层；optimizer 懒加载时仍保留。
- `/ecolink-diff`：只推进本对话已显示的变化目录，不把摘要当全文；其他对话有独立进度。

池名用于分组，条目名称/key、ID 和 ref 用于定位内容。目录最多20条，正文每页最多4000个 Unicode 码点；分页期间内容变化会要求刷新版本。

## DSH 侧栏

在原生右侧栏选择“记忆池”，搜索、预览、翻页、注入。面板捕获其所属对话 ID，切换对话后丢弃过期响应。点击只将选定快照排入该对话，不自动发起新模型请求；状态区分“待进入上下文”和“已进入上下文”。

旧记忆和新建普通记忆默认非通用。通用只在新对话第一次构建上下文时选择并保存快照；改成通用不追补当前或已存在的对话。改回非通用只影响后续对话，不撤回已经进入上下文的内容。恢复、分支和重复点击通过宿主会话记录去重。元数据修改由现有 ecolink-service 唯一写入，并校验版本。

`adapter.enabled` 为总开关，`injectEnabled` 控制新对话通用自动注入，`instructionEnabled` 控制短记忆指令；显式点击单独处理。`maxInjectionChars` 为每步参考资料预算（默认3000，包含来源包装）。全文超预算会明确拒绝，可选择标明范围的当前页；开局超预算的通用条目显示遗漏数量。旧 `contentInjectionEnabled` 保留读取兼容但不再启用旧式自动选文，避免绕过分类。

池文件只读，地址来自 `poolPath`；服务 URL 与 token 由后端配置使用，浏览器侧不接收文件路径或凭据。服务不可用时仍可读取已有池文件，类型修改失败明确提示。注入排队必须取得宿主持久化确认，失败保留待处理记录并允许重试。首次注入所需宿主接口不可用时不会假报成功。

## 网页完整成果

回答正文旁的“保存完整成果”打开命名编辑框，排除思考区。匹配完整原始流会自动预填；旧回答或扩展更新前的回答会自动读取当前对话历史原文。按回答 ID 或完整文本对应，不用前缀或最近一条猜测。复杂排版无法唯一对应时，可从当前对话已读取的回答列表中选择并核对全文，无需手动复制；读取失败可重试，正文为空不能保存。历史原文来自网页已登录的同源只读接口，不产生模型请求；未知或截断协议不假报完整。

原有自动短标签功能继续独立工作：记忆写入说明、流式/历史/DOM 收割和离线入池均保留。源流先解码 JSON 再拼接跨片段标签；离线队列在凭据过期时只刷新重试一次，失败保留待发内容。全文捕获异常不应阻断短标签。Chrome/Edge 更新时都须重载既有扩展并刷新网页，才能加载新 MAIN world 拦截器。

保存保留空白、Markdown、代码和标签字面量，正文上限1.5MB；目录摘要和自动短记忆独立。完整成果默认非通用且不参与自动短记忆筛选或压缩。同名保存须确认并校验旧版本；服务保留历史全文，当前面板读取最新版本，暂未提供旧版本浏览界面。断网/失败不会报成功或清空编辑框；同一内容重试采用相同请求 ID 防重复。关闭页面前未保存的编辑内容需要自行保留。

## 桌面宿主补丁

同窗 DeepSeek 网页、页内划选入池、缩放与“带入草稿”由仓库 `desktop/` 提供：需要管理员替换桌面安装的 `app.asar`，基线 DSH `0.2.2-rc.1`，实验性，DSH 升级后需重建。它不属于 npm 包和 1.0.0 稳定契约，详见 [desktop/README.md](../desktop/README.md)。

## 验收

所有命令必须在隔离 HOME、临时目录和虚构池下运行，不能用真实记忆测试：

```powershell
node adapter/test/smoke.mjs
node --test adapter/test/iteration.mjs adapter/test/ui.mjs
node --test extension/test/core.test.mjs extension/test/artifact.test.mjs
node service/test.mjs
node --test service/iteration.test.mjs
```

宿主夹具来自已记录 SHA256 的安装版本；测试复用实际 Session、工具参数校验、pre-step 与 flush 代码，其余运行环境为测试协作者。UI 验收执行实际组件/事件代码，但使用最小 DOM/React 替身，不等于真实桌面浏览器验收。没有真实模型调用、费用或省 token 收益测量。
