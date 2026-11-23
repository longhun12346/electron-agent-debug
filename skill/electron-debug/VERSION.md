# 版本记录

## 1.5.0

- MCP 0.6.0：新增 `electron_click` 和 `electron_type`，工具从 8 个变为 10 个。依据：社区里点赞最多的 Electron 需求是让 Agent 能操作界面；此前证据矩阵要求覆盖调用链的回归，但只能用 `element.click()`，事件的 `isTrusted` 为 false。
- `electron_dom_snapshot` 给可点击、可输入的节点标上 `[ref=eN]`，结果新增 `refCount`。同一页面里同一元素的 ref 在多次快照间不变；只接受当前页面最近一次快照里的 ref，别的页面或已移除的元素返回 `REF_STALE`，未知的返回 `REF_NOT_FOUND`。
- `electron_click`：滚动到可见处，点击元素中心，用 CDP `Input.dispatchMouseEvent`。点击前做命中检测，中心被其他元素挡住时返回 `ELEMENT_COVERED` 并说明挡住它的元素，不点击；禁用返回 `ELEMENT_DISABLED`，没有可点区域返回 `ELEMENT_NOT_VISIBLE`。支持 `doubleClick`。
- `electron_type`：聚焦、默认全选替换（`clear: false` 时追加），用 `Input.insertText` 写入，支持中文，React 这类受控输入框也能保留输入；`submit` 时按 Enter。不可编辑时返回 `ELEMENT_NOT_EDITABLE`。返回输入后的值，密码框脱敏。
- 两个工具都返回 `afterSeq`，交给 `electron_wait_for` 等待结果，不内置隐式等待。`ELECTRON_DEBUG_ALLOW_EVAL=0` 时一起禁用（`INTERACTION_NOT_ALLOWED`）。输入事件超时且页面不可见时，`hint` 提示先恢复最小化的窗口。
- 在真实 Electron 43、2x 缩放下实测：坐标无需按缩放换算；滚动后的命中检测要换成文档坐标（否则返回 “No node found at given location”，已修正）；隐藏窗口可以输入，最小化窗口可能丢弃点击。新增 `examples/fixture/interaction-smoke.mjs`，覆盖可信事件、滚动、遮挡、禁用、受控输入框、中文、提交和过期 ref，加入 CI 和 Electron 版本矩阵。
- 不做：拖拽、悬停、快捷键、原生 `<select>` 的键盘选择、输入法组合输入。SKILL.md 的替代做法表相应更新。
- 已注册 MCP 的宿主需要刷新工具列表，确认 10 个工具可见；原有工具的参数和字段不变。

## 1.4.0

依据社区同类工具的 issue 调研：用户反馈最集中的是连错页面、attach 失败原因不明、截图太大和被对话框卡住。

- MCP 0.5.0：失败的结果保留底层报错，新增可选的 `hint` 字段说明下一步。attach 失败时区分端口没有进程监听（附启动参数、`ELECTRON_RUN_AS_NODE`、fuse 的排查）、端口有响应但不是调试端口、端口不响应，以及主进程和 renderer 端口传反（此前把 renderer 端口当 `mainUrl` 会连上一个页面，“主进程”求值实际在窗口里执行）。底层的 `fetch failed` 补上系统错误码（如 `ECONNREFUSED`）。
- `electron_attach`、`electron_targets` 的结果新增 `warnings`：renderer 端口的 User-Agent 不含 Electron（例如占用 9222 的 Chrome）时返回 `RENDERER_NOT_ELECTRON`；原来检查的页面消失、自动改选了另一个页面时返回 `TARGET_CHANGED`，附前后两个页面的 title 和 url。传 `clearSelection` 表示有意切换，不再提示。
- `<webview>` 出现在 target 列表里，可用 `targetId` 显式选择并检查；不参与自动选择，一个窗口加一个 webview 不会造成歧义。`TARGET_SELECTION_REQUIRED`、`TARGET_NOT_FOUND`、`SESSION_DISCONNECTED` 都附 `hint`。
- `electron_screenshot` 默认按页面的 CSS 尺寸截图，高分屏（2x、3x）不再成倍放大；新增 `maxWidth` 进一步缩小，大于 CSS 宽度时最多取到屏幕实际分辨率。结果新增图片的 `width`、`height` 和 `deviceScaleFactor`。
- `electron_status` 新增 `dialogs`（各通道快照里也有）：页面的 JavaScript 对话框（`alert`、`confirm`、`prompt`、`beforeunload`），以及主进程通过 `dialog` 模块打开的原生对话框，标明是否阻塞进程。对话框打开和关闭写入日志（`kind` 为 `dialog`），文本脱敏并截断。阻塞的对话框期间请求超时时，错误的 `hint` 说明原因。原生对话框通过在主进程包装 `dialog` 的函数实现，只在允许求值时启用；attach 之前已持有函数引用的代码、Electron 为页面 alert 打开的消息框不经过包装（后者由 renderer 通道报告）。
- renderer Session 额外启用 `Page` 域，用于接收对话框事件。
- 真实 Electron 冒烟新增：2x 缩放下截图尺寸、多窗口加 `<webview>` 的选择、alert 与原生对话框的报告和清除、端口传反的提示、窗口重建后的 `TARGET_CHANGED`。
- 工具集合不变，原有字段和参数不变，只新增可选参数和字段；已注册 MCP 的宿主无需改动配置。

## 1.3.4

- MCP 0.4.4：`electron_logs` 新增 `sinceAttach`。传 `true` 时每个通道只返回它最近一次连接之后的事件，不含 attach 时重放的应用历史输出；与 `afterSeq` 取较大者，`gap` 也按各通道的边界计算。注册 MCP 和批处理模式都适用，SKILL.md 不再要求在批处理里手工以 `Session connected` 事件为界。
- 修复：应用已经打开 DevTools（开发构建常在启动时打开）时，全新的 `electron_attach` 会把 `devtools://` 窗口当作第二个 page，返回 `TARGET_SELECTION_REQUIRED` 且 renderer 通道离线。现在自动选择时忽略 `devtools://` 窗口，它仍在 target 列表里，也可以用 `targetId` 显式选择。真实 Electron 上已复现并验证。
- 修复：renderer 页面崩溃后连接仍开着，`electron_status` 继续显示 online，请求要等超时才失败，日志里也没有任何记录。现在 renderer Session 启用 `Inspector` 域：崩溃后状态变为 offline 并带 `TARGET_CRASHED`，各个 renderer 工具立即返回该错误，日志写入 `Target crashed`；页面重新加载后同一连接自动恢复。新增错误码 `TARGET_CRASHED`。
- 修复：`electron_evaluate` 的顶层 await 重试改为按“代码没有开始执行”判断，不再匹配 V8 的报错措辞。此前 `await import(…)` 这类编译报错措辞不同的写法不会重试；现在任何编译期 `SyntaxError` 都会换模式重试，`await (…)` 前面只有空白时也会重试。运行期抛出的 `SyntaxError`（如 `JSON.parse`）已经执行过，不会重试；`await` 前有其他语句时不重试，报错会提示怎么写。主进程的求值不支持动态 `import()`，SKILL.md 改为推荐 `process.mainModule.require` 和 `process.getBuiltinModule`。
- 事件缓冲在写入时记下每条事件的大小，淘汰时不再重新序列化；对结果没有影响。
- 工具集合不变，只多一个可选参数，已注册 MCP 的宿主无需改动配置。
- 仓库侧：`examples/host-e2e` 扩成 ipc、renderer、main-window、inspect、utility、devtools-windows、click-save 七个任务场景，覆盖全部 8 个工具，并有不依赖模型的参考解法在 CI 中验证；新增 `examples/field-app`（ESM 主进程、两个窗口加 DevTools、嘈杂控制台、大页面、要按下才发生的保存、崩溃和硬退出）及其真实 Electron 冒烟，也加入 Electron 版本矩阵；平台描述存入 `docs/platform-description.md` 并由测试核对工具数量和 Node.js 版本；新增 Dependabot 配置。这些不进入 Skill 包。
- 新增 `launch.cjs --tools [工具名 ...]`：打印工具的描述和 JSON Schema（一行 JSON，不连接应用、不读 stdin），给不注册 MCP、没有 `tools/list` 的批处理调用方查参数形状。可以一次传多个名字，按给的顺序输出、去重；有不存在的名字时报全部不存在的名字，不返回部分结果。依据真实宿主实验：宿主给 `electron_wait_for` 的 `expression` 传了字符串，白白浪费一次调用；一次传两个名字则得到用法错误。工具集合和参数不变；`launch.cjs` 的用法变为 `[--verify | --run | --tools [tool-name ...]]`。
- SKILL.md 新增「启动参数」：按启动方式给出怎么传 `--inspect` 和 `--remote-debugging-port`（`electron .`、electron-vite、Electron Forge、vite-plugin-electron），并写明 `ELECTRON_EXTRA_LAUNCH_ARGS` 无效。依据同一次实验：宿主猜了这个环境变量，用了约 9 步才改成先构建再运行。
- SKILL.md 补充：应用该退出但进程还在（Node 等已连接的检查器断开）时，直接终止进程或先结束 MCP 会话。

## 1.3.3

- MCP 0.4.3：`electron_logs` 的结果新增 `droppedThroughSeq` 和 `gap`。缓冲区满时最旧的事件会被丢弃，此前用 `afterSeq` 续读的调用方无法发现中间缺了事件；现在 `gap` 为 `true` 表示所请求的范围内可能有事件缺失。`clear` 会重置对应缓冲区的丢弃记录。
- `electron_status` 的结果新增 `lastSeq`，回归前可直接取得基线，不必先读一次日志。
- 工具集合和参数不变，原有字段不变，已注册 MCP 的宿主无需改动配置。
- 脱敏新增按形态识别、不依赖键名的秘密：JWT、GitHub / Slack / npm / AWS / Google 前缀令牌、含数字的 `sk-` 密钥、PEM 私钥块（含被截断的）和 URL 中的密码。普通的 kebab-case 名称、UUID 和哈希不受影响。
- evaluate 的真实 Electron 冒烟补充了“重复声明加顶层 await”的组合，以及主进程（Node inspector）上的同类调用，覆盖重试链的最后一步。
- CI 新增 Electron 版本矩阵（43、44 和最新稳定版，Linux 与 Windows），对 utility 和 evaluate 冒烟分别运行；检查矩阵补上 Windows 和 macOS 上的 Node 20。
- 文档对齐当前实现：移除 `electron_logs` 的 `app` 范围和“由工具启动应用”的过期表述，补充 evaluate 的执行顺序说明。

## 1.3.2

- MCP 0.4.2：未捕获异常的日志事件改为可读文本（`Uncaught Error: …` 加调用栈），不再是整段协议 JSON；`data` 收敛为 `url`、`line`、`column`（从 1 起算）。`console.trace` 和 `console.assert` 的事件附带调用栈，最多 10 帧。
- 日志事件的 `data` 现在与 `message` 一样脱敏；此前异常和浏览器日志的 `data` 原样返回，可能带出密钥。浏览器日志的 `data` 收敛为 `source` 和 `url`。
- `electron_evaluate` 修复重复声明：先前一次调用留下的顶层 `let`/`const` 会让后续同名声明报 `has already been declared`，现在改在块内执行并返回结果（该次声明不保留）。
- evaluate、wait_for、截图、无障碍树以及上述异常和调用栈的渲染，新增真实 Electron 的 CI 冒烟（Windows、macOS、Linux）。
- SKILL.md 的「调用栈」替代做法改为直接读异常事件或使用 `console.trace`。读取异常事件 `data` 原始字段的调用方需要改读 `message`。

## 1.3.1

- MCP 0.4.1：utility 通道已在 Windows、macOS 和 Linux 的真实 Electron 上通过 CI 验证（Electron 版本以 fixture lockfile 为准）。查端口的 netstat 或 lsof 无法运行时，`UTILITY_INSPECTOR_UNAVAILABLE` 的消息和 `details.portLookupError` 会给出原因，不再与“调试口未打开”混为一谈。
- `electron_evaluate` 结果超过 `maxResultBytes` 时按 UTF-8 字节截断，且不拆开多字节字符；此前按字符数截断，中文等内容可能超出上限。
- 协议请求超时的错误在 `details` 中带 `reason: "timeout"`、`method` 和 `timeoutMs`。
- 工具集合和参数不变，已注册 MCP 的宿主无需改动配置。

## 1.3.0

- MCP 0.4.0：`electron_attach` 新增 `utility` 参数（utility process 的 `serviceName` 或 pid），作为独立的第三通道，不占用 `mainUrl`，可与主进程、renderer 同时在线。工具通过已连接的主进程用 `app.getAppMetrics()` 找到进程，必要时调用 `process._debugProcess(pid)` 打开调试口，再用 netstat（Windows）或 lsof（macOS/Linux）找到监听端口并连接。
- `electron_evaluate` 的 `scope`、`electron_logs` 与 `electron_wait_for` 的 `process` 新增 `utility`；`electron_attach` 和 `electron_status` 的结果新增 `utility` 通道状态。工具仍为 8 个。
- 新增错误码 `UTILITY_REQUIRES_MAIN`、`UTILITY_NOT_FOUND`（附候选列表）、`UTILITY_AMBIGUOUS`、`UTILITY_INSPECTOR_UNAVAILABLE`。需要主进程在线且未禁用求值；默认调试口 9229 被占用时开口无提示地失败，可在 fork 的 `execArgv` 加 `--inspect-port=<空闲端口>`。仅在 Windows 上实测，`process._debugProcess` 为未公开接口。
- SKILL.md 的 utility 一行改为使用 `utility` 参数。

## 1.2.0

- MCP 0.3.0：同一入口新增批处理模式 `launch.cjs --run`，从 stdin 读取 JSON 工具调用数组并在同一进程内顺序执行，不需要注册 MCP；工具集合与 MCP 完全一致。
- SKILL.md 的接入部分改为二选一：注册 MCP，或使用批处理模式。已注册 MCP 的宿主无需任何改动。
- Node.js 要求从 22 放宽到 20，运行文件按 Node 20 构建。
- `electron_dom_snapshot` 和 `electron_screenshot` 返回的 `url` 改为取当前导航历史条目，SPA 路由切换后不再沿用 attach 时的旧地址。
- SKILL.md 补充：就绪信号的选择与 `elapsedMs` 为 0 的排查、attach 后的历史事件与 `afterSeq`、截图和快照不脱敏、preload/IPC 的主进程证据取法、无网络观察工具时用 `performance.getEntriesByType('resource')` 查看请求。
- SKILL.md 新增「未提供的能力与替代做法」：网络请求、调用栈、局部变量、断点、点击输入、窗口列表、内存、原生对话框。
- SKILL.md 明确适用范围为本地开发环境，打包后的应用不在支持范围内。
- SKILL.md 补充 utility process 的两种开调试口方式（fork 时 `--inspect`；运行中用 `app.getAppMetrics()` 取 pid 后调用 `process._debugProcess(pid)`，端口冲突时配合 `--inspect-port`），开口后按主进程方式 attach；另补充 webview、worker、跨域 iframe 的处理思路。工具不变。

## 1.1.0

- MCP 0.2.0：统一日志时间线增加 `seq` 游标。MCP 只 attach，不启动、停止或重启应用；启动应用并暴露 `--inspect` 与 `--remote-debugging-port` 由 Agent 负责。
- 新增 `electron_evaluate`、`electron_wait_for`、`electron_screenshot`、`electron_dom_snapshot`；求值默认开启（仅回环 endpoint），宿主设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 可禁用；协议单条消息上限默认提高到 256 MiB（与 Puppeteer、Playwright 一致），大型 renderer 不再因 1009 被断开；日志脱敏覆盖 JSON 字符串化后的内容。
- 新增 `ELECTRON_DEBUG_OUTPUT_DIR`；输出统一有界并脱敏。
- SKILL.md 精简为使用建议和证据矩阵。旧宿主配置无需更改入口，但需确认 8 个工具可见。

## 1.0.4

- 在 description 中明确 Electron 代码变更验证、白屏和运行时错误等触发场景。
- 工作流程图增加框线及箭头，便于阅读与平台识别；诊断能力和 Agent 职责不变。

## 1.0.3

- MCP 0.1.1 与 Skill 一起交付，包含运行时 JavaScript 依赖；使用时无需额外下载、依赖安装或构建。
- 增加本地完整性启动器、构建输入摘要和第三方许可证。
- 增加触发条件表格、标准使用章节、ASCII 工作流程与错误处理。
- 旧宿主配置需切换到本版本的 `runtime/launch.cjs`。
- GitHub Release 来源证明绑定对应 tag 的源码提交；构建输入摘要见 `runtime/manifest.json`。平台包的发布版本与扫描结果由安装渠道提供。

## 1.0.2

补充独立 MCP 源码更新说明。本版本的独立下载和构建方式已由 1.0.3 的随包运行方式替代。

## 1.0.1

提供 Electron 双通道诊断流程、四个 MCP 工具接入说明与 Agent 自行验收边界。
