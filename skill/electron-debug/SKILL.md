# Electron Debug Skill

## 目标

在 Agent 完成 Electron 代码修改后，使用 `electron-agent-debug` MCP，依据明确的预期行为验证修改是否生效、定位运行时问题并保留回归证据。

应用必须已经由 Agent 准备或确认启动，并通过 Agent 提供的实际 endpoint 提供调试能力：

- 主进程 Node Inspector：Agent 提供的 loopback HTTP endpoint
- 渲染进程 CDP：Agent 提供的 loopback HTTP endpoint

## Agent 前提

在调用 MCP 前，Agent 必须自行提供或确认：

- 当前项目工作目录。
- 应用启动或重启命令，或者已经运行的 Electron 应用。
- 主进程 Inspector 和/或渲染进程 CDP endpoint；按本次诊断范围至少提供一个。
- 本次修改的预期行为或可观察的回归操作。
- 项目已有的测试、检查命令或业务回归步骤；MCP Server 不替 Agent 执行业务操作。
- 多窗口场景下的目标窗口选择条件。
- 只有计划使用截图扩展时才提供诊断输出目录。
- 只有计划使用 `electron_evaluate` 扩展时才明确启用它。
- 项目特有的 preload API、IPC channel 或固定检查表达式。

Agent 可以通过终端或项目已有脚本启动、停止和重启 Electron。MCP Server 只连接已经提供的调试端点，不猜测入口文件，也不替 Agent 选择开发命令。

如果缺少工作目录、启动方式、调试端点或可观察的预期行为，先报告缺少前提，不要把问题直接归类为代码失败。

## 编码后自调试流程

1. 先写出本次修改的预期行为和可观察的回归操作。
2. 根据本次修改的文件和用户报告判断诊断范围。
3. 调用 `electron_attach`，确认本次诊断所需的主进程 Inspector 和/或渲染进程 CDP。
4. 调用 `electron_status`，记录当前连接、target 和异常数量。
5. 调用 `electron_logs`，先收集修改后的初始运行时证据。
6. 必要时调用 `electron_targets` 选择正确窗口。
7. 只有状态、target 和日志不足以回答问题时，才调用可选的截图或 evaluate 扩展。
8. 根据修改范围重启 Electron 或 reload 当前 target；连接失效时重新调用 `electron_attach`。
9. 重新读取状态和日志；只有视觉问题或证据不足时才调用可选的 `renderer_screenshot`。
10. 根据预期行为和观察结果由 Agent 自己输出 `PASS`、`FAIL` 或 `BLOCKED`，并附上问题归属、关键证据、根因判断、修改内容和回归验证结果。

常用固定检查由 Skill 提供检查意图和可选表达式模板，不增加新的 MCP 工具。例如：

- 主进程：`process.type`、运行时状态和窗口相关状态。
- 渲染进程：`window.location.href`、`document.readyState`、`document.title`。
- preload：通过项目已有检查或可选表达式验证已约定的 `window` API 是否存在。

这些检查只能帮助收集事实，最终是否满足预期仍由 Agent 判断。MCP Server 只返回工具调用结果和运行时事实，不生成业务验收结论。

如果应用没有运行或端点不可用，说明缺少应用启动或调试端点前提；Agent 应使用已知的项目命令补齐前提，不能猜测入口文件，也不能让 MCP Server 默认启动或停止应用。

## 修改范围和诊断通道

### 主进程优先

- 应用启动失败
- BrowserWindow 没有创建
- 文件系统、数据库或自动更新异常
- 主进程崩溃
- IPC handler 没有注册
- 窗口生命周期异常

### 渲染进程优先

- 页面白屏
- DOM 或组件没有出现
- 前端 JavaScript 异常
- 点击、输入和事件绑定失效
- 页面网络请求失败
- 页面布局或视觉问题

### 双进程同时检查

- preload 暴露 API 失败
- contextBridge API 不存在
- IPC invoke/send 没有响应
- 主进程返回值和页面显示不一致

## 重启和 reload 规则

- 修改主进程代码后重启 Electron。
- 修改 preload 后重启 Electron。
- 修改 BrowserWindow 创建、窗口生命周期或 IPC handler 后重启 Electron。
- 修改渲染进程代码后优先 reload 当前 target。
- 不能确认修改属于哪个进程时，先读取状态和日志，再决定操作。

## 安全规则

- 只连接 `127.0.0.1` 或 `localhost`。
- 启用 `electron_evaluate` 扩展后，才通过 `scope=main` 或 `scope=renderer` 执行短时诊断表达式。
- 不执行无限循环、阻塞 I/O、退出进程、删除文件或修改生产数据的表达式。
- 不把完整敏感数据写入日志或截图。
- 执行可选表达式前说明目的、上下文和预期结果。
- 优先读取日志和状态，再执行表达式。
- 如果表达式超时或连接断开，停止继续执行，并先通过 `electron_attach` 恢复连接状态。

## 输出要求

每次完成诊断后，输出：

- 结论：`PASS`、`FAIL` 或 `BLOCKED`
- 预期行为：本次验证要证明什么
- 问题归属：主进程、preload/IPC 或渲染进程
- 本次修改：涉及的文件或行为
- 关键证据：日志、异常、状态值，以及按需取得的表达式结果或截图
- 根因判断：已确认、当前最可能原因或尚未确定
- 重启/reload/重新 attach 操作
- 回归验证结果

对于 preload 或 IPC 问题，至少输出一项主进程证据和一项渲染进程证据。

结论规则：

- `PASS`：Agent 根据运行时证据确认预期行为。
- `FAIL`：Agent 根据观察到的异常或不符合预期的结果作出判断。
- `BLOCKED`：Agent 根据应用未启动、调试端点不可用、target 不存在或其他缺少的验证前提作出判断。
- 不能仅凭 MCP 连接成功、没有 console error 或存在截图输出 `PASS`。
- 如果没有明确的预期行为，不能输出 `PASS`；应补充预期或报告 `BLOCKED`。
