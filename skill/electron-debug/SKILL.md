---
name: electron-debug
description: "Verifies or diagnoses a local Electron app at runtime, and traces a JS call into native modules (koffi, .node) with an external debugger. Use when main-process, BrowserWindow, preload, contextBridge or IPC changes need checking; for a blank or white window, a crash on startup or a runtime or console error; or when a native-module call (koffi, .node addon) returns the wrong result and you need to debug from the JS call into the native function, even if the user never says 'Electron' or the project has its own tests. Attaches to the running dev app to read main, renderer and utility logs, evaluate code, take screenshots and accessibility snapshots, click or type in the real window; for native code it guides installing a debugger MCP (WinDbg/cdb on Windows) to set breakpoints, read arguments and variables, and verify the fix. Examples: '窗口一片白', '改了 preload 帮我确认还能用', '原生模块函数返回值不对，帮我从 JS 调用一路调试到原生代码', 'koffi 调的 DLL 结果不对'. Not for packaged apps, pure type or build errors, or native crashes and hangs."
license: MIT
compatibility: "Requires Node.js 20+ and an Electron app started with --inspect and --remote-debugging-port. The runtime is smoke-tested on Windows, macOS and Linux; the native-code debugging guide is verified on Windows only."
---

# Electron Agent Debug

MCP 连接 Agent 已启动的 Electron 应用，返回主进程、renderer（可选 utility process）的运行时事实。遇到 koffi、`.node` 原生模块里的问题时，再指引 Agent 接外部调试器，从 JS 调用一路跟到原生函数。Skill 只给建议，验证什么、结论是什么由你决定。只适用于本地开发环境，不含打包后的应用。

10 个工具的用法看各自的描述。失败结果的 `hint` 说明下一步查什么；attach 和 targets 的 `warnings` 提示证据可能不是来自要验证的窗口，先读。输出只有大小上限，**不做脱敏**：日志、报错、求值结果、页面文本、地址和标题可能带出令牌、密码、cookie，并进入模型上下文和会话记录。是否遮挡由你判断：只读需要的内容，不用求值去读凭据，汇报时只引用必要片段，不连接带真实生产凭据的应用。

## 原生模块调试（koffi、`.node`）

本 Skill 的特色：把调试从 JS 延伸到原生函数。JS 调用原生函数的结果不对时，不要只读 JS 猜原因：

1. 用本工具留下 JS 侧证据：触发操作的 `afterSeq`、主进程 pid、调用原生函数的 JS 位置和参数形状。
2. 找原生源码和符号；本机找不到就问用户：原生仓库在哪、哪个分支或提交对应这份二进制、能不能给 Debug 构建。
3. 经用户同意安装外部调试器 MCP（Windows：mcp-windbg 加 cdb），附加主进程，在原生函数或源码行上下断点。
4. 用 `electron_click` 或 `electron_type` 触发 JS 调用，命中后看栈、参数和变量，按 `seq` 和 JS 侧的证据对上，对照源码定位原因。
5. 改原生源码，Debug 构建，停应用、部署、重启并重新 attach，再验证。

完整步骤、命令和踩过的坑见 [references/native.md](references/native.md)，应用启动时就执行的原生调用见 [references/native-startup.md](references/native-startup.md)。只在 Windows 上验证过；原生崩溃和卡死目前没有验证过的流程。

## 工作流

先判断归属再选通道：启动、窗口创建、文件系统、数据库、自动更新、IPC handler、崩溃先查主进程；DOM、白屏、前端异常、事件绑定、网络、视觉先查 renderer；preload、contextBridge、IPC 两个通道都查。原生模块（koffi、`.node`）调用结果不对：先按本工作流留下 JS 侧证据，再走下面的“原生模块调试”。

1. **确认应用**：开发者常已开着 `pnpm dev`，先查进程命令行再决定。
   - Windows：`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`（每个进程一行；`Select` 会截断长命令行，`Format-List` 会按窗口宽度折行，都可能让末尾的参数看不全）；在 Git Bash 里整条放进 `powershell -NoProfile -Command "…"`，内层的 `"` 写成 `\"`，`$` 写成 `\$`。结果里有 renderer、gpu 等子进程，主进程是命令行里没有 `--type=` 的那个。macOS、Linux：`ps -eo args | grep -i electron`。
   - 已带 `--inspect=`、`--remote-debugging-port=` 就用其中的端口；没带的话通常用项目已有的启动命令加这两个参数重启。是否重启、能否停掉用户正在跑的实例由你判断，拿不准就问用户。各启动方式见 [references/launch.md](references/launch.md)。
2. **连接**：`electron_attach`，按返回的通道状态确认。只查一侧就连一侧，preload / IPC 连两侧。多窗口用 `electron_targets` 的 `title`、`url`（要完全相等）选页面，重名用 `targetId`。反复失败见 [references/troubleshooting.md](references/troubleshooting.md)。
3. **操作**：
   - 改了代码先交给热更新或自动重启；没有的话，renderer 用 `electron_evaluate` 执行 `location.reload()`，主进程需要重启，preload 至少要 reload，拿不准就重启，重启后重新 attach。附加了原生调试器时，重启会让调试会话失效，见 [references/native.md](references/native.md)。
   - 走界面先 `electron_dom_snapshot`，再 `electron_click` / `electron_type`（传 ref，或 `role` 加 `name`），记下 `afterSeq`；原生对话框提示用户人工操作。细节见 [references/evidence.md](references/evidence.md)。
4. **等待与取证**：
   - 先读日志和状态，再求值；用 `electron_wait_for` 等明确的信号，不用固定 sleep，两个通道各等各的。
   - 只看本次操作之后的事件：`log.afterSeq` 传 `afterSeq`；`electron_logs` 的 `sinceAttach: true` 只排除 attach 时重放的历史，不排除 attach 之后、操作之前的事件；等待结果带 `beforeAttach: true` 的是历史，不能当本次证据。`electron_logs` 默认只返回最近 100 条，要完整结果传 `limit`。
   - 主进程求值没有全局 `require`，用 `process.mainModule.require('electron')`，见 [references/evaluate.md](references/evaluate.md)。
5. **判定**：对照证据矩阵写结论；证据不够回到第 3 步，取不到所需通道就报告 `BLOCKED`，不要归因于业务代码。

## 边界

- 点击、输入和求值会改变应用状态，只用于验证。
- 允许求值时，attach 会在主进程里装 IPC 和对话框的记录包装，应用重启前移除不了：用 `instrument` 选装哪些，用 `ELECTRON_DEBUG_ALLOW_EVAL=0` 全关（求值、点击输入、utility 一并不可用），见 [references/evidence.md](references/evidence.md)。
- 网络、断点、拖拽悬停不提供，替代做法见 [references/alternatives.md](references/alternatives.md)；性能分析、内存泄漏分析不提供，也没有替代。
- 原生模块调试见上一节：本工具只看 JS 层，原生部分靠外部调试器，需要原生源码和 PDB。原生崩溃和卡死目前没有验证过的流程。

## 证据矩阵

建议收集的证据，够不够由你判断。

| 修改类型 | 证据 |
| --- | --- |
| 主进程启动、窗口创建 | 主进程在线，日志无相关异常，`electron_evaluate`(main) 确认窗口状态 |
| renderer 白屏、前端异常 | 快照或截图显示实际页面，renderer 日志无异常，target 正确 |
| preload / contextBridge / IPC | 主进程与 renderer 各一项，并有覆盖调用链的回归；用 `electron_wait_for` 等 `IPC invoke <通道>` 确认到达主进程及结果（见 evidence.md） |
| 原生对话框、菜单、shell | 用户人工操作并确认，再用日志或求值核对 |
| 崩溃、意外退出 | 应用的退出码与输出、退出前的日志；renderer 崩溃连接不断（`TARGET_CRASHED`），主进程退出则主进程通道断开 |
| 仅类型或构建问题 | 项目已有检查，无需启动应用 |

## 结论

`PASS`：预期行为被实际回归或运行时观察证实。`FAIL`：预期行为可执行但结果不符，或有与修改相关的错误证据，区分已确认根因与推测。`BLOCKED`：缺少前提、可观察结果或必要回归。attach 成功、无 console error 或工具返回 `ok` 都不足以判定 `PASS`。报告写明预期行为、用到的工具与关键证据（带 seq）、target、剩余限制。

## 接入

`electron_*` 工具已经可见就直接用，不用再注册。宿主会给工具名加前缀（如 `mcp__<服务名>__electron_attach`），以 `electron_attach` 等结尾即算可见；拿不准用 `claude mcp list`、`codex mcp list`、`pi mcp list` 查。

- **校验**：随包运行文件是 `runtime/launch.cjs`（Node.js 20+）。先执行 `node <absolute-skill-directory>/runtime/launch.cjs --verify`，失败或文件缺失就报告 `BLOCKED`，不要下载或在本机构建。
- **注册 MCP**：需要多轮取证（保持连接、累积日志）时注册为本地 stdio MCP Server。先问用户，说明会改宿主配置以及范围（用户级还是项目级），同意后再注册。新注册的 MCP 通常要重载或新开会话才可见，提醒用户去做，不要假设当前会话能用。
- **批处理模式**：重载前、用户不同意注册、宿主不能注册时，用 `launch.cjs --run` 先完成本次任务，参数形状用 `launch.cjs --tools` 查。它不保留连接和日志；同一批的参数在运行前就已写定，上一次执行的 `afterSeq`、ref 也带不到下一次。把 attach、操作、等待放进同一批，点击和输入用 `role` 加 `name`，等待用 `log.sinceAttach`（它会包含 attach 到操作之间的事件）。

详见 [references/mcp-setup.md](references/mcp-setup.md)。当前版本看 `runtime/manifest.json`；`VERSION.md` 是给人读的变更记录，不用加载。
