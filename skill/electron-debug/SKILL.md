---
name: electron-debug
description: "Use when verifying or diagnosing a local Electron app at runtime: main-process, BrowserWindow, preload, contextBridge or IPC changes, a blank or white window, a crash, or a runtime error. Attaches to the running dev app to read main, renderer and utility logs, evaluate code, take screenshots and accessibility snapshots, and click or type in the real window."
when_to_use: "Use it whenever the project is an Electron app (electron, electron-vite or Electron Forge in package.json) and the user asks whether the app or a page still works, wants runtime or console errors checked, or wants a screenshot of the running app, even if they never say 'Electron' and even if the project has its own tests. Examples: '窗口一片白', '改了 preload 帮我确认还能用', '确认页面有没有运行时报错并截图', 'the app crashes on startup'. Not for packaged apps or for pure type and build errors."
license: MIT
---

# Electron Agent Debug

MCP 提供能力，Skill 只给建议。MCP 连接已运行的应用并返回运行时事实（也可不注册 MCP，用批处理模式调用同一组工具，见「接入」）；启动应用由 Agent 用项目已有方式完成；Agent 决定验证什么、执行业务回归并自行判断结果。

适用范围：本地开发环境中由开发命令启动的 Electron 应用。打包后的应用（安装包、已关闭调试开关或 fuse 的构建）不在支持范围内，不保证可连接。

## 工具

| 类别 | 工具 | 作用 |
| --- | --- | --- |
| 连接 | `electron_attach` / `electron_targets` | 连接已运行的应用（主进程、renderer，可再加 utility process）；多窗口时明确选择 target（应用自己打开的 DevTools 窗口和 `<webview>` 不参与自动选择，不会造成歧义） |
| 观察 | `electron_status` / `electron_logs` / `electron_wait_for` | 状态、统一时间线（main / renderer / utility，带 `seq`）、等待日志或表达式 |
| 检查 | `electron_evaluate` / `electron_screenshot` / `electron_dom_snapshot` | 主进程、renderer 或 utility 求值、截图（保存为文件）、无障碍树文本（可交互元素带 `[ref=…]`） |
| 交互 | `electron_click` / `electron_type` | 按快照里的 ref 点击、输入，页面收到真实事件（`isTrusted` 为 true） |

文本输出有大小上限，并按常见模式脱敏（尽力而为；截图不脱敏）。只允许回环地址。

失败的结果保留底层报错（`message`），并尽量附带 `hint`：下一步该查什么。attach 和 targets 的结果另有 `warnings`：不妨碍连接，但证据可能不是来自要验证的窗口或应用，处理前先读。

## 工作流

按顺序做；第 6 步证据不够时回到第 3 步。

1. **确认应用**：开发者常已开着 `pnpm dev`。先查进程命令行（Windows：`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Select CommandLine`；macOS/Linux：`ps -eo args | grep -i electron`）。已带 `--inspect=`、`--remote-debugging-port=` 就直接用其中的端口，不要再启动第二个实例。没带或没在运行，才用项目已有的启动命令加这两个参数重启，端口自选空闲回环端口，不改项目脚本；各启动方式怎么传见 [references/launch.md](references/launch.md)。
2. **连接**：`electron_attach`，以返回的通道状态确认参数生效。只排查一侧就只连一侧，preload / IPC 才需要主进程和 renderer 两个通道；没连接的一侧返回 `SESSION_DISCONNECTED`，不影响另一侧。多窗口应用里遇到 `TARGET_SELECTION_REQUIRED`，对照 `targets` 的 `title` 和 `url` 选择；`TARGET_CHANGED` 警告说明原来的页面已被替换，先确认新页面就是要验证的窗口。attach 前应用可能还没打开端口，失败时稍后重试，反复失败见 [references/troubleshooting.md](references/troubleshooting.md)。
3. **触发改动或操作**：
   - 改了代码：优先交给项目的热更新或自动重启，不要重复手动操作。主进程、preload 改动若被自动重启，原连接随进程失效，需重新 attach，并用 `electron_status` 确认新进程仍带调试端口。
   - 要走界面（按钮、表单、跳转）：先 `electron_dom_snapshot`，再 `electron_click` 或 `electron_type`（传 ref，或传 `role` 和 `name`；批处理模式里上一次的 ref 无效，用 `role` 和 `name`）。`ELEMENT_COVERED` 说明被弹层挡住，先处理弹层，不要改用 `element.click()`。记下返回的 `afterSeq`。
   - 弹出原生对话框或菜单的步骤，提示用户人工操作，等用户确认后再继续。`electron_status` 的 `dialogs` 列出正在等用户操作的对话框；`blocking` 为 `true` 时对应进程在关闭前不响应，超时的 `hint` 会说明，不要反复重试。
4. **等就绪信号**：`electron_wait_for` 等明确的信号（日志或表达式），不要用固定 sleep。信号只应在目标状态下为真：任务取终态（如 `state === 'completed'`）而不是字段存在。`elapsedMs` 为 0 说明条件在等待前已经为真，先怀疑条件太宽。需要两个通道的证据时，分别等每个通道的信号：各通道走各自的连接，先发生的事件可能后到。
5. **取证**：
   - 只看本次操作之后的事件：给 `electron_wait_for` 的 `log.afterSeq` 传操作返回的 `afterSeq`，或给 `electron_logs` 传 `sinceAttach: true`。attach 后缓冲区里带有应用启动以来的历史事件（上限默认 500 条），每个新进程都会重放；批处理模式每次都是新进程，`seq` 不能跨次使用，同一次执行内用 `sinceAttach`。
   - 等待结果带 `beforeAttach: true` 说明命中的是历史事件，不能当作本次操作的证据。`gap` 为 `true` 说明缓冲区满过、有事件被丢弃，缩短取证间隔或调大 `ELECTRON_DEBUG_MAX_LOG_EVENTS`。
   - 求值：`electron_evaluate` 默认可用；`ELECTRON_DEBUG_ALLOW_EVAL=0` 时返回 `EVALUATION_NOT_ALLOWED`，点击和输入也一起禁用。主进程求值的全局作用域没有 `require`，用 `process.mainModule.require('electron')` 或 `process.getBuiltinModule('fs')`，也不支持动态 `import()`；跨调用保留的值挂到 `globalThis`。其他细节见 [references/evaluate.md](references/evaluate.md)。
   - 截图用 `electron_screenshot`，返回文件路径，用文件读取工具查看；窗口隐藏或最小化时会超时。
6. **判定**：对照下面的证据矩阵，按「结论」写报告。证据不够就回到第 3 步，仍取不到所需通道时报告 `BLOCKED`，不要归因于业务代码。

点击、输入和求值都会改变应用状态，只用于验证。截图不脱敏，`electron_dom_snapshot` 只按常见密钥模式脱敏，都可能带出个人内容，汇报只引用必要片段。本工具集不提供网络观察、断点、拖拽悬停快捷键和性能分析，也连不上 worker 和跨域 iframe，替代做法见 [references/alternatives.md](references/alternatives.md)。

## 证据矩阵

| 修改类型 | 至少需要的证据 |
| --- | --- |
| 主进程启动、窗口创建 | `electron_attach` 的主进程通道在线；`electron_logs` 无相关异常；`electron_evaluate`(main) 确认窗口状态 |
| renderer 白屏或前端异常 | `electron_dom_snapshot` 或 `electron_screenshot` 显示实际页面；renderer 日志无异常；target 正确 |
| preload / contextBridge / IPC | 主进程与 renderer 各一项证据，并有覆盖调用链的回归（例如 renderer 调用后读取 main 的结果）。主进程通道在线且未禁用求值时，时间线自动记录主进程收到的每条 IPC（`kind` 为 `ipc`）：`invoke` 的成功或失败与错误信息，`send`/`sendSync` 没有监听者时为 warn；只有通道名、耗时、结果和参数大小，不含参数值。用 `electron_wait_for` 等 `IPC invoke <通道>` 即可确认调用到达主进程以及结果。main 侧证据可在 renderer 触发调用后，用 `electron_evaluate`(main) 读副作用，如文件是否落盘、状态是否变化（`process.mainModule.require('fs')`） |
| 原生对话框、菜单或 shell 行为 | 由用户人工操作并确认；Agent 用 `electron_logs` 或 `electron_evaluate` 核对结果 |
| 崩溃或意外退出 | 应用进程的退出码与输出（Agent 启动时自行捕获）、`electron_logs` 中退出前的异常。renderer 页面崩溃时连接不会断：`electron_status` 的 renderer 变为 offline 且 `error.code` 为 `TARGET_CRASHED`，日志里有 `Target crashed` 事件，各个 renderer 工具立即返回 `TARGET_CRASHED`；页面重新加载后同一连接自动恢复，日志出现 `Target reloaded after crash`。主进程崩溃或退出则整个主进程通道断开（`SESSION_DISCONNECTED`） |
| 仅类型或构建问题 | 项目已有检查，无需启动应用 |

## 结论

- `PASS`：预期行为被实际回归或运行时观察证实。
- `FAIL`：预期行为可执行但结果不符，或有与修改相关的错误证据；区分已确认根因与推测。
- `BLOCKED`：缺少前提、可观察结果或必要回归。

attach 成功、无 console error 或工具返回 `ok` 都不足以判定 `PASS`。报告包含：预期行为、使用的工具与关键证据、target、剩余限制。

## 报告示例

```text
结论：FAIL
预期：点击 Save 后保存成功
操作：electron_click role=button name=Save（afterSeq 41），target 为 Field App
证据：主进程 `IPC invoke field:save failed: Error: field save handler failure`（seq 42）；
      renderer `FIELD_SAVE_CALL_FAILURE`（seq 43）；页面状态变为 save-failed
根因：已确认在主进程的 field:save 处理函数抛出错误
剩余限制：未验证保存成功后的持久化
```

## 接入

随包运行文件见 `runtime/launch.cjs`，需要 Node.js 20+。先执行 `node <absolute-skill-directory>/runtime/launch.cjs --verify`。校验失败或文件缺失时报告 `BLOCKED`，不要下载或在本机构建。之后选一种接入方式，两种提供同样的 10 个工具。默认注册 MCP；宿主不能注册 MCP，或只做一次性检查时用批处理模式：

- **注册 MCP**：把同一入口注册为本地 stdio MCP Server，并确认工具可见。适合需要多轮、跨调用保持连接的诊断。
- **不注册 MCP**：执行 `node <absolute-skill-directory>/runtime/launch.cjs --run`，在 stdin 传入 JSON 数组 `[{"tool":"electron_attach","arguments":{...}},{"tool":"electron_logs"}]`，同一进程内按顺序执行，stdout 输出 `{ok, results}`。进程退出后连接和日志缓存随之消失，每次执行都要从 `electron_attach` 开始。参数的形状（嵌套对象、枚举值）用 `launch.cjs --tools [工具名 ...]` 查（可以一次传几个名字，不传则列全部），输出每个工具的描述和 JSON Schema，不要猜，例如 `electron_wait_for` 的 `expression` 是 `{scope, expression}` 对象而不是字符串。

详见 [MCP 接入说明](references/mcp-setup.md)，版本见 [VERSION.md](VERSION.md)。
