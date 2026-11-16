---
name: electron-debug
description: Use when validating Electron main-process, BrowserWindow, renderer, preload, or IPC changes, or investigating a blank window, crash, or runtime error in a local Electron app. Attach to the running app, then collect logs, evaluate in main/renderer, screenshot, and accessibility snapshot through the bundled MCP runtime for Agent-led verification.
license: MIT
---

# Electron Agent Debug

MCP 提供能力，Skill 只给建议。MCP 连接已运行的应用并返回运行时事实；启动应用由 Agent 用项目已有方式完成；Agent 决定验证什么、执行业务回归并自行判断结果。

## 工具

| 类别 | 工具 | 作用 |
| --- | --- | --- |
| 连接 | `electron_attach` / `electron_targets` | 连接已运行的应用；多窗口时明确选择 target |
| 观察 | `electron_status` / `electron_logs` / `electron_wait_for` | 状态、统一时间线（main / renderer，带 `seq`）、等待日志或表达式 |
| 检查 | `electron_evaluate` / `electron_screenshot` / `electron_dom_snapshot` | 主进程或 renderer 求值、截图（保存为文件）、无障碍树文本 |

文本输出有大小上限，并按常见模式脱敏（尽力而为；截图不脱敏）。只允许回环地址。

## 使用建议

1. **自行启动应用并暴露所需端口**：用项目已有的启动命令，按需加上 `--inspect=<主进程端口>`（主进程）和/或 `--remote-debugging-port=<renderer 端口>`（renderer）（端口自选空闲回环端口），再用 `electron_attach` 传入对应的 `http://127.0.0.1:<端口>`。两个通道可以只连一个：只排查主进程问题就只连主进程，只排查页面问题就只连 renderer；preload / IPC 才需要两个都连。对没连接的一侧调用工具会返回 `SESSION_DISCONNECTED`，不影响已连接的一侧。不改项目脚本。参数如何传到 Electron 取决于项目的启动方式，由 Agent 读项目配置自行判断，并以 `electron_attach` 返回的通道状态确认是否生效。参数含义见 Electron 官方文档：[调试主进程](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)、[命令行开关](https://www.electronjs.org/docs/latest/api/command-line-switches)。
2. 用 `electron_wait_for` 等待明确的就绪信号（日志或表达式），不要用固定 sleep。attach 前应用可能还没打开端口，失败时稍后重试。
3. 改动生效优先交给项目自带的热更新或自动重启，不要重复手动操作：renderer 改动等热更新完成；主进程、preload 改动若被开发工具自动重启，原连接随进程失效，需重新 `electron_attach`，并用 `electron_status` 确认重启后的进程仍带有 `--inspect` 和 `--remote-debugging-port`（是否沿用取决于项目的启动工具）。项目没有热更新时，才由 Agent 重启应用，或对 renderer 用 `location.reload()`（`electron_evaluate`；eval 被禁用时改用项目已有的刷新方式）。无论哪种方式，都先用 `electron_wait_for` 等到就绪信号再取证据。
4. `electron_evaluate` 和表达式型 `electron_wait_for` 默认可用；宿主设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 后返回 `EVALUATION_NOT_ALLOWED`，此时仍可用 attach、targets、日志、状态、截图和 `electron_dom_snapshot`。表达式可修改应用状态，只用于验证。主进程求值的全局作用域可能没有 `require`（例如 ESM 或打包后的主进程），需要时用 `process.mainModule.require('electron')`。
5. 会弹出原生对话框或菜单的步骤，提示用户人工操作，等用户确认后再继续；不要等待自动化完成。
6. `electron_screenshot` 返回文件路径，用文件读取工具查看。窗口隐藏或最小化时截图会超时，先显示窗口。

## 连接失败

attach 多次重试仍失败时，先排查启动方式，再判断是否应用本身的问题：

- 环境里设有 `ELECTRON_RUN_AS_NODE=1`（部分终端和 Node 工具链会带上）时，Electron 按 Node 运行，不会创建窗口，renderer 通道不可用。启动应用前取消该变量。
- 主进程通道失败而 renderer 通道正常时，检查应用是否关闭了 `EnableNodeCliInspectArguments` fuse（常见于打包后的构建）；关闭后 `--inspect` 会被忽略，需要改用未关闭该 fuse 的构建。
- 端口被占用或应用已提前退出：核对应用进程的输出和退出码。

仍无法取得所需通道时报告 `BLOCKED`，写明缺少哪个通道和已排除的原因，不要归因于业务代码。

## 证据矩阵

| 修改类型 | 至少需要的证据 |
| --- | --- |
| 主进程启动、窗口创建 | `electron_attach` 的 main 通道在线；`electron_logs` 无相关异常；`electron_evaluate`(main) 确认窗口状态 |
| renderer 白屏或前端异常 | `electron_dom_snapshot` 或 `electron_screenshot` 显示实际页面；renderer 日志无异常；target 正确 |
| preload / contextBridge / IPC | main 与 renderer 各一项证据，并有覆盖调用链的回归（例如 renderer 调用后读取 main 的结果） |
| 原生对话框、菜单或 shell 行为 | 由用户人工操作并确认；Agent 用 `electron_logs` 或 `electron_evaluate` 核对结果 |
| 崩溃或意外退出 | 应用进程的退出码与输出（Agent 启动时自行捕获）、`electron_logs` 中退出前的异常 |
| 仅类型或构建问题 | 项目已有检查，无需启动应用 |

## 结论

- `PASS`：预期行为被实际回归或运行时观察证实。
- `FAIL`：预期行为可执行但结果不符，或有与修改相关的错误证据；区分已确认根因与推测。
- `BLOCKED`：缺少前提、可观察结果或必要回归。

attach 成功、无 console error 或工具返回 `ok` 都不足以判定 `PASS`。报告包含：预期行为、使用的工具与关键证据、target、剩余限制。

## 接入

随包运行文件见 `runtime/launch.cjs`，需要 Node.js 22+。先执行 `node <absolute-skill-directory>/runtime/launch.cjs --verify`，再把同一入口注册为本地 stdio MCP Server，并确认工具可见。校验失败或文件缺失时报告 `BLOCKED`，不要下载或在本机构建。详见 [MCP 接入说明](references/mcp-setup.md)，版本见 [VERSION.md](VERSION.md)。
