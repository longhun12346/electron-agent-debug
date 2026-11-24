---
name: electron-debug
description: "Use when verifying or diagnosing a local Electron app at runtime: main-process, BrowserWindow, preload, contextBridge or IPC changes, a blank or white window, a crash, or a runtime error. Attaches to the running dev app to read main, renderer and utility logs, evaluate code, take screenshots and accessibility snapshots, and click or type in the real window."
when_to_use: "Use it whenever the project is an Electron app (electron, electron-vite or Electron Forge in package.json) and the user asks whether the app or a page still works, wants runtime or console errors checked, or wants a screenshot of the running app, even if they never say 'Electron' and even if the project has its own tests. Examples: '窗口一片白', '改了 preload 帮我确认还能用', '确认页面有没有运行时报错并截图', 'the app crashes on startup'. Not for packaged apps or for pure type and build errors."
license: MIT
---

# Electron Agent Debug

MCP 连接 Agent 已启动的 Electron 应用，返回主进程、renderer（可再加 utility process）的运行时事实；Skill 只给使用建议，验证什么、结论是什么由 Agent 决定。只适用于本地开发环境，打包后的应用（关闭调试开关或 fuse 的构建）不在范围内。

工具共 10 个：`electron_attach` `electron_targets` `electron_status` `electron_logs` `electron_wait_for` `electron_evaluate` `electron_screenshot` `electron_dom_snapshot` `electron_click` `electron_type`。输出有大小上限并按常见模式脱敏（截图不脱敏），只允许回环地址。失败结果的 `hint` 写了下一步查什么；attach 和 targets 的 `warnings` 提示证据可能不是来自要验证的窗口，先读。

## 工作流

1. **确认应用**：开发者常已开着 `pnpm dev`。先查进程命令行（Windows：`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Select CommandLine`；macOS/Linux：`ps -eo args | grep -i electron`）。已带 `--inspect=`、`--remote-debugging-port=` 就用其中的端口，不要再起第二个实例；没带才用项目已有的启动命令加这两个参数重启，端口自选空闲回环端口，不改项目脚本。各启动方式怎么传见 [references/launch.md](references/launch.md)。
2. **连接**：`electron_attach`，以返回的通道状态确认生效。只排查一侧就只连一侧；preload / IPC 要连主进程和 renderer 两个通道。多窗口时按 `electron_targets` 的 `title`、`url` 选页面。反复失败见 [references/troubleshooting.md](references/troubleshooting.md)。
3. **操作**：改了代码就交给项目的热更新或自动重启；主进程、preload 重启后原连接失效，要重新 attach。要走界面时先 `electron_dom_snapshot`，再 `electron_click` / `electron_type`（传 ref，或传 `role` 和 `name`），记下返回的 `afterSeq`；被弹层挡住就先处理弹层，不要改用 `element.click()`。原生对话框和菜单提示用户人工操作（`electron_status` 的 `dialogs` 会列出，`blocking` 为 `true` 时对应进程不响应，不要反复重试）。
4. **等待与取证**：用 `electron_wait_for` 等明确的信号，不要固定 sleep；两个通道各等各的信号。只看本次操作之后的事件：给 `log.afterSeq` 传 `afterSeq`，或给 `electron_logs` 传 `sinceAttach: true`（attach 会重放应用启动以来的历史事件）。等待结果带 `beforeAttach: true` 的是历史，不能当本次证据。主进程求值没有全局 `require`，用 `process.mainModule.require('electron')`，细节见 [references/evaluate.md](references/evaluate.md)。
5. **判定**：对照下面的证据矩阵写结论；证据不够回到第 3 步，取不到所需通道就报告 `BLOCKED`，不要归因于业务代码。

点击、输入和求值会改变应用状态，只用于验证。截图和无障碍树可能带出个人内容，汇报只引用必要片段。网络观察、断点、拖拽悬停、性能分析不提供，替代做法见 [references/alternatives.md](references/alternatives.md)。

## 证据矩阵

| 修改类型 | 至少需要的证据 |
| --- | --- |
| 主进程启动、窗口创建 | 主进程通道在线；`electron_logs` 无相关异常；`electron_evaluate`(main) 确认窗口状态 |
| renderer 白屏或前端异常 | 快照或截图显示实际页面；renderer 日志无异常；target 正确 |
| preload / contextBridge / IPC | 主进程与 renderer 各一项证据，并有覆盖调用链的回归。主进程的 IPC 自动进入时间线（`kind` 为 `ipc`），用 `electron_wait_for` 等 `IPC invoke <通道>` 即可确认调用到达主进程及结果，细节见 [references/evidence.md](references/evidence.md) |
| 原生对话框、菜单、shell 行为 | 用户人工操作并确认，Agent 用日志或求值核对结果 |
| 崩溃或意外退出 | 应用的退出码与输出、退出前的日志。renderer 崩溃时连接不断（`TARGET_CRASHED`），主进程退出则主进程通道断开 |
| 仅类型或构建问题 | 项目已有检查，无需启动应用 |

## 结论

- `PASS`：预期行为被实际回归或运行时观察证实。
- `FAIL`：预期行为可执行但结果不符，或有与修改相关的错误证据；区分已确认根因与推测。
- `BLOCKED`：缺少前提、可观察结果或必要回归。

attach 成功、无 console error 或工具返回 `ok` 都不足以判定 `PASS`。报告写明：预期行为、用到的工具与关键证据（带 seq）、target、剩余限制。

## 接入

随包运行文件是 `runtime/launch.cjs`（Node.js 20+）。先执行 `node <absolute-skill-directory>/runtime/launch.cjs --verify`；失败或文件缺失就报告 `BLOCKED`，不要下载或在本机构建。默认把它注册为本地 stdio MCP Server 并确认 10 个工具可见；宿主不能注册 MCP 时用批处理模式（`launch.cjs --run`，参数形状用 `launch.cjs --tools` 查，不要猜）。配置示例和批处理细节见 [references/mcp-setup.md](references/mcp-setup.md)，版本见 [VERSION.md](VERSION.md)。
