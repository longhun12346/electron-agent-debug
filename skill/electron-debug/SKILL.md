---
name: electron-debug
description: Use when validating Electron main-process, BrowserWindow, renderer, preload, or IPC changes, or investigating a blank window, crash, or runtime error in a local Electron app. Attach to the running app, then collect logs, evaluate in main/renderer, screenshot, and accessibility snapshot through the bundled MCP runtime for Agent-led verification.
license: MIT
---

# Electron Agent Debug

MCP 提供能力，Skill 只给建议。MCP 连接已运行的应用并返回运行时事实（也可不注册 MCP，用批处理模式调用同一组工具，见「接入」）；启动应用由 Agent 用项目已有方式完成；Agent 决定验证什么、执行业务回归并自行判断结果。

适用范围：本地开发环境中由开发命令启动的 Electron 应用。打包后的应用（安装包、已关闭调试开关或 fuse 的构建）不在支持范围内，不保证可连接。

## 工具

| 类别 | 工具 | 作用 |
| --- | --- | --- |
| 连接 | `electron_attach` / `electron_targets` | 连接已运行的应用（主进程、renderer，可再加 utility process）；多窗口时明确选择 target |
| 观察 | `electron_status` / `electron_logs` / `electron_wait_for` | 状态、统一时间线（main / renderer / utility，带 `seq`）、等待日志或表达式 |
| 检查 | `electron_evaluate` / `electron_screenshot` / `electron_dom_snapshot` | 主进程、renderer 或 utility 求值、截图（保存为文件）、无障碍树文本 |

文本输出有大小上限，并按常见模式脱敏（尽力而为；截图不脱敏）。只允许回环地址。

## 使用建议

1. **自行启动应用并暴露所需端口**：用项目已有的启动命令，按需加上 `--inspect=<主进程端口>`（主进程）和/或 `--remote-debugging-port=<renderer 端口>`（renderer）（端口自选空闲回环端口），再用 `electron_attach` 传入对应的 `http://127.0.0.1:<端口>`。两个通道可以只连一个：只排查主进程问题就只连主进程，只排查页面问题就只连 renderer；preload / IPC 才需要两个都连。对没连接的一侧调用工具会返回 `SESSION_DISCONNECTED`，不影响已连接的一侧。不改项目脚本。参数如何传到 Electron 取决于项目的启动方式，由 Agent 读项目配置自行判断，并以 `electron_attach` 返回的通道状态确认是否生效。参数含义见 Electron 官方文档：[调试主进程](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)、[命令行开关](https://www.electronjs.org/docs/latest/api/command-line-switches)。
2. 用 `electron_wait_for` 等待明确的就绪信号（日志或表达式），不要用固定 sleep。attach 前应用可能还没打开端口，失败时稍后重试。信号只应在目标状态下为真：任务轮询取终态（如 `state === 'completed'`）而不是字段存在，页面就绪取业务元素出现而不是只比较路由。`elapsedMs` 为 0 说明条件在等待前已经为真，先怀疑条件太宽；可在触发操作前用 `electron_evaluate` 跑一次同一条件，确认此时为假。
3. 改动生效优先交给项目自带的热更新或自动重启，不要重复手动操作（各项目工具行为不同，本 Skill 未统一验证，以 `electron_status` 和日志实际观察为准）：renderer 改动等热更新完成；主进程、preload 改动若被开发工具自动重启，原连接随进程失效，需重新 `electron_attach`，并用 `electron_status` 确认重启后的进程仍带有 `--inspect` 和 `--remote-debugging-port`（是否沿用取决于项目的启动工具）。项目没有热更新时，才由 Agent 重启应用，或对 renderer 用 `location.reload()`（`electron_evaluate`；eval 被禁用时改用项目已有的刷新方式）。无论哪种方式，都先用 `electron_wait_for` 等到就绪信号再取证据。
4. `electron_evaluate` 和表达式型 `electron_wait_for` 默认可用；宿主设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 后返回 `EVALUATION_NOT_ALLOWED`，此时仍可用 attach、targets、日志、状态、截图和 `electron_dom_snapshot`。表达式可修改应用状态，只用于验证。顶层的 `let`、`const` 可以在多次调用中重复声明，但与已有声明重名时本次改在块内执行，声明不保留到下一次调用；需要跨调用保留的值挂到 `globalThis`。主进程求值的全局作用域可能没有 `require`（例如 ESM 主进程），需要时用 `process.mainModule.require('electron')`。
5. 会弹出原生对话框或菜单的步骤，提示用户人工操作，等用户确认后再继续；不要等待自动化完成。
6. `electron_screenshot` 返回文件路径，用文件读取工具查看。窗口隐藏或最小化时截图会超时，先显示窗口。
7. attach 后缓冲区里可能已带有应用启动以来的历史事件（上限默认 500 条），并被重新编号；每个新进程都会重放一遍，`seq` 在不同进程间不可比。注册 MCP 时，回归前用 `electron_status` 或 `electron_logs` 记下 `lastSeq`，之后用 `afterSeq` 只看新事件；`electron_logs` 返回的 `gap` 为 `true` 说明缓冲区满过、所请求的范围内可能有事件被丢弃，缩短两次取证的间隔，或在 MCP 配置里调大 `ELECTRON_DEBUG_MAX_LOG_EVENTS`。批处理模式每次都是新进程，`seq` 不能跨次使用：同一次执行内，以对应通道（`process` 字段）最后一条 `Session connected` 事件为界，它之前是重放的历史，之后才是本次观察到的事件。
8. 截图不脱敏；`electron_dom_snapshot` 只按常见密钥模式脱敏。两者都可能带出聊天标题、账号等个人内容。汇报只引用必要片段，不整段贴出。
9. 本工具集不提供网络观察、断点、真实输入和性能分析，替代做法见下节。

## 未提供的能力与替代做法

| 需要 | 替代做法 | 限制 |
| --- | --- | --- |
| 看 renderer 发出的请求 | `electron_evaluate` 读 `performance.getEntriesByType('resource')`，含 `name`、`duration`，较新的 Chromium 还有 `responseStatus` | 只有 URL、状态、耗时，没有请求头和响应体；主进程发出的请求不在其中。需要这些字段时在项目代码里加日志 |
| 调用栈 | 未捕获异常的事件自带栈，直接读 `electron_logs`。要看某处是怎么被调用到的，在该位置加 `console.trace('标记')`，热更新或重启后触发，再读日志 | 栈最多保留 10 帧；`console.log`、`console.error` 等不带栈。不能改代码的位置（依赖库、打包产物）无替代 |
| 局部变量、中间值 | 在代码里 `console.log` 打印后读取日志；或直接用 `electron_evaluate` 读全局可达的状态 | 函数内部的局部变量只能靠打印 |
| 断点、单步 | 不提供。`debugger;` 在本工具连接下不会暂停，也不要自行启用调试器，暂停会冻住应用 | 代码改不了（依赖库、打包产物）时无替代 |
| 点击、输入 | `electron_evaluate`(renderer) 调用 `element.click()` 或 `dispatchEvent`；表单输入需用原生 setter 赋值后再派发 `input` 事件 | 事件的 `isTrusted` 为 false，依赖真实输入的逻辑覆盖不到，改用项目已有的测试工具 |
| 列出窗口 | `electron_evaluate`(main) 用 `process.mainModule.require('electron').BrowserWindow.getAllWindows()` | 只读窗口状态，不用于操作 |
| 内存 | main 用 `process.memoryUsage()`；renderer 用 `performance.memory`（Chromium 非标准接口） | 只是当前读数，不能做泄漏分析 |
| utility process 里的代码 | `electron_attach` 传 `utility`（fork 时的 `serviceName`，或 pid）。工具通过已连接的主进程用 `app.getAppMetrics()` 找到该进程，打开调试口并连接，成为独立的第三通道，与 main、renderer 同时在线，之后用 `electron_evaluate`(scope=`utility`) 和 `electron_logs`(process=`utility`) 观察。不需要自己查 pid 或调用 `process._debugProcess`。同名进程有多个时用 pid；一次只连一个 utility，再次 attach 其他 utility 会替换当前连接 | 需要主进程通道在线且未设置 `ELECTRON_DEBUG_ALLOW_EVAL=0`。调试口默认端口 9229，被占用时开口不报错也不会生效，attach 会返回 `UTILITY_INSPECTOR_UNAVAILABLE`；此时（或同时调试多个 utility 时）让 fork 带 `execArgv: ['--inspect-port=<各自空闲端口>']`（只指定端口，不自动开启）。开口用的 `process._debugProcess` 是未公开接口，查端口用 netstat（Windows）或 lsof（macOS/Linux）；已在 Windows、macOS、Linux 上用 fixture 锁定的 Electron 版本实测；CI 另在 Linux、Windows 上对 Electron 43、44 和最新稳定版运行同样的冒烟，其他版本以 attach 结果为准。查端口的命令无法运行时，错误的 `details.portLookupError` 会给出原因 |
| webview、worker、跨域 iframe 里的代码 | 不能直接连接。让它们用 `postMessage` 把值传回页面，再用 `electron_evaluate`(renderer) 读取或打印；同源 iframe 可通过 `iframe.contentDocument` 读取 | 这些目标里的日志和求值不在工具范围内 |
| 原生对话框、菜单 | 提示用户人工操作 | 见使用建议第 5 条 |

## 连接失败

attach 多次重试仍失败时，先排查启动方式，再判断是否应用本身的问题：

- 环境里设有 `ELECTRON_RUN_AS_NODE=1`（部分终端和 Node 工具链会带上）时，Electron 按 Node 运行，不会创建窗口，renderer 通道不可用。启动应用前取消该变量。
- 主进程通道失败而 renderer 通道正常时，检查应用是否关闭了 `EnableNodeCliInspectArguments` fuse；关闭后 `--inspect` 会被忽略，需要改用未关闭该 fuse 的开发构建。打包后的应用不在支持范围内，不为它调整方案。
- 端口被占用或应用已提前退出：核对应用进程的输出和退出码。

仍无法取得所需通道时报告 `BLOCKED`，写明缺少哪个通道和已排除的原因，不要归因于业务代码。

## 证据矩阵

| 修改类型 | 至少需要的证据 |
| --- | --- |
| 主进程启动、窗口创建 | `electron_attach` 的 main 通道在线；`electron_logs` 无相关异常；`electron_evaluate`(main) 确认窗口状态 |
| renderer 白屏或前端异常 | `electron_dom_snapshot` 或 `electron_screenshot` 显示实际页面；renderer 日志无异常；target 正确 |
| preload / contextBridge / IPC | main 与 renderer 各一项证据，并有覆盖调用链的回归（例如 renderer 调用后读取 main 的结果）。main 侧证据可在 renderer 触发调用后，用 `electron_evaluate`(main) 读副作用，如文件是否落盘、状态是否变化（`process.mainModule.require('fs')`） |
| 原生对话框、菜单或 shell 行为 | 由用户人工操作并确认；Agent 用 `electron_logs` 或 `electron_evaluate` 核对结果 |
| 崩溃或意外退出 | 应用进程的退出码与输出（Agent 启动时自行捕获）、`electron_logs` 中退出前的异常 |
| 仅类型或构建问题 | 项目已有检查，无需启动应用 |

## 结论

- `PASS`：预期行为被实际回归或运行时观察证实。
- `FAIL`：预期行为可执行但结果不符，或有与修改相关的错误证据；区分已确认根因与推测。
- `BLOCKED`：缺少前提、可观察结果或必要回归。

attach 成功、无 console error 或工具返回 `ok` 都不足以判定 `PASS`。报告包含：预期行为、使用的工具与关键证据、target、剩余限制。

## 接入

随包运行文件见 `runtime/launch.cjs`，需要 Node.js 20+。先执行 `node <absolute-skill-directory>/runtime/launch.cjs --verify`。校验失败或文件缺失时报告 `BLOCKED`，不要下载或在本机构建。之后二选一，两种方式提供同样的 8 个工具：

- **注册 MCP**：把同一入口注册为本地 stdio MCP Server，并确认工具可见。适合需要多轮、跨调用保持连接的诊断。
- **不注册 MCP**：执行 `node <absolute-skill-directory>/runtime/launch.cjs --run`，在 stdin 传入 JSON 数组 `[{"tool":"electron_attach","arguments":{...}},{"tool":"electron_logs"}]`，同一进程内按顺序执行，stdout 输出 `{ok, results}`。进程退出后连接和日志缓存随之消失，每次执行都要从 `electron_attach` 开始。

详见 [MCP 接入说明](references/mcp-setup.md)，版本见 [VERSION.md](VERSION.md)。
