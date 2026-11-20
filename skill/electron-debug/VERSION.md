# 版本记录

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
