# 需求说明

## 0. 项目定位

本项目是一个面向编码 Agent 的 Electron 双通道诊断能力和使用指南，不是通用 Electron 调试器，也不是业务验收系统。

核心场景是：Agent 修改 Electron 项目代码后，Agent 自行准备或确认应用已经通过项目命令启动，再按照 Skill 指引连接运行中的应用，获取运行时事实和证据。

项目价值来自以下组合：

- 同时观察 Electron 主进程和渲染进程。
- 把 preload、contextBridge 和 IPC 问题放到两个进程之间联合诊断。
- 通过 Skill 指导 Agent 选择通道、检查顺序和证据类型。
- 默认只连接本地已启动应用，不接管应用生命周期。
- 返回适合 Agent 消化的结构化状态、日志、异常和诊断结果。

## 1. 背景

Electron 应用的主进程和渲染进程使用不同的调试入口：

- 主进程通过 Node Inspector 暴露 Agent 提供的调试 endpoint。
- 渲染进程通过 Chromium DevTools Protocol 暴露 Agent 提供的调试 endpoint。

编码 Agent 需要同时查看两个进程的状态，才能处理白屏、窗口创建失败、preload 注入失败、IPC 失效、主进程异常和前端运行时错误等问题。

现有大型 Electron 调试工具的工具数量和依赖较多。本项目采用轻量实现，只提供 Agent 调试真正需要的最小工具集，并通过一个 Skill 固定调试流程。

## 2. 目标

### 2.1 产品目标

让本地编码 Agent 能够在需要诊断 Electron 应用时，基于 Skill 指引连接 Agent 已准备或确认运行的应用，并获得以下能力：

1. 识别主进程 Inspector 和渲染进程 CDP 是否可用。
2. 选择正确的渲染窗口。
3. 根据修改范围判断主进程、preload/IPC 或渲染进程。
4. 读取两个进程的日志和异常；只有在核心证据不足时，才按需使用可选诊断扩展。
5. 根据修改范围重启 Electron 或 reload 当前窗口。
6. 重新读取日志和状态，为 Agent 自己的分析和报告提供证据；截图只作为可选证据产物。

### 2.2 技术目标

- MCP Server 使用 stdio 与 Agent 通信。
- MCP Server 使用 WebSocket 连接 Node Inspector 和 CDP。
- 只允许连接回环地址：`127.0.0.1`、`::1` 或 `localhost`。
- 不设置任何固定端口。Agent 按诊断范围提供实际 endpoint；至少提供一个 endpoint 才能执行 attach。
- 核心对外工具数量控制在第一阶段 4 个：attach、status、targets 和 logs。
- `renderer_screenshot` 和 `electron_evaluate` 都属于可选诊断扩展，不阻塞核心链路交付。
- 启用 evaluate 扩展时，每次表达式执行必须有超时和结果大小限制。
- 渲染进程 reload 或窗口销毁后能够在下一次工具调用时重新发现 target。
- 连接断开后由内部 SessionManager 在下一次工具调用时进行有限恢复，工具返回明确的连接状态。

### 2.3 轻量性判定

以下条件是第一阶段保持轻量的硬约束：

- 核心 MCP 工具只有 `electron_attach`、`electron_status`、`electron_targets` 和 `electron_logs`。
- MCP Server 只连接已运行的应用，不启动、停止、重启、扫描或猜测应用。
- 只管理一个 Agent 会话和当前 page target，不递归管理 iframe、worker、webview 或多客户端共享状态。
- 只在工具调用期间进行有限恢复，不运行持续轮询或无限期后台重连。
- 截图和 evaluate 默认不实现；即使实现，也不能成为核心验收前提。
- 不引入 Playwright、浏览器下载器、桌面自动化框架或完整 CDP 封装。

## 3. Agent 前提契约

MCP Server 不负责猜测项目入口、选择开发命令或启动 Electron。

Agent 按诊断范围向 MCP Server 提供 endpoint：

- 需要主进程诊断时提供主进程 Inspector endpoint。
- 需要渲染进程诊断时提供渲染进程 CDP endpoint。
- 至少提供一个 endpoint 才能执行 attach；缺少的另一个通道返回独立的未配置状态。

Agent/Skill 上下文中的前提：

- 项目工作目录。
- 应用启动或重启命令，或者已经运行的 Electron 应用。
- 本次修改的预期行为或可观察的回归操作。
- 项目已有的测试、检查命令或可观察回归步骤；MCP Server 不替 Agent 执行业务操作。
- 多窗口场景下的 target 选择条件。

按需配置：

- 诊断输出目录：只有启用并调用 `renderer_screenshot` 扩展时必需。
- `electron_evaluate` 权限：只有启用并调用 `electron_evaluate` 扩展时需要显式开启。
- 项目特有的 preload API、IPC channel 或固定检查表达式。

Agent 可以通过终端或项目已有脚本启动、停止和重启应用；这些动作不属于 MCP Server 的能力。

Agent 需要先准备或确认 Electron 应用已经通过项目已有命令启动，并提供实际的 Inspector/CDP endpoint，例如：

```powershell
electron --inspect=<main-inspector-port> --remote-debugging-port=<renderer-cdp-port> .
```

实际项目的启动参数可能由 `npm run dev`、Vite、Webpack 或自定义脚本注入。MCP Server 不假设 Electron 的入口文件，也不修改用户的启动脚本。Agent 如果无法确定启动命令或实际 endpoint，应报告前提缺失，不应把应用问题误判为代码问题。

Agent 提供的环境变量：

```text
ELECTRON_DEBUG_MAIN_URL=<agent-provided-loopback-main-url>
ELECTRON_DEBUG_CDP_URL=<agent-provided-loopback-renderer-url>
ELECTRON_DEBUG_ALLOW_EVAL=false
ELECTRON_DEBUG_OUTPUT_DIR=<agent-provided-output-dir>
ELECTRON_DEBUG_MAX_EVAL_MS=3000
ELECTRON_DEBUG_MAX_OUTPUT_BYTES=65536
```

开发者明确允许执行诊断代码时设置：

```text
ELECTRON_DEBUG_ALLOW_EVAL=true
```

endpoint 配置只接受用于 discovery 的本地 HTTP(S) URL；MCP 不接受 Agent 直接传入任意 WebSocket URL。discovery 返回的 WebSocket 地址必须再次校验协议和回环主机，不能因为它来自本地 HTTP 响应就跳过校验。

## 4. MCP 工具需求

### P0：核心诊断能力

#### `electron_attach`

连接主进程 Inspector 和渲染进程 CDP，并返回：

- 主进程连接状态
- 渲染进程 target 列表
- 当前选中的 target
- Inspector/CDP 端点
- 协议错误

输入可以包含本次连接使用的 endpoint：

```json
{
  "mainUrl": "http://127.0.0.1:<agent-chosen-main-port>",
  "rendererUrl": "http://127.0.0.1:<agent-chosen-renderer-port>",
  "targetId": "<optional-target-id>",
  "url": "<optional-target-url>",
  "title": "<optional-target-title>"
}
```

endpoint 解析优先级为：

1. 本次 `electron_attach` 输入。
2. MCP Server 启动时的 `ELECTRON_DEBUG_MAIN_URL`、`ELECTRON_DEBUG_CDP_URL`。
3. 当前 Server 中已经建立的同一通道 Session 配置，用于幂等重连。
4. 没有默认值。

要求：重复调用必须幂等；endpoint 不存在或不可用时返回可读错误，不得让 MCP Server 退出。主进程和渲染进程必须独立连接；一个端点不可用时，另一个端点仍应返回可用状态和观察结果。只有请求无法处理或全部 endpoint 缺失时，工具才返回顶层错误。endpoint 发生变化时，必须先关闭旧 Session，再创建新 Session。

#### `electron_status`

返回：

- 主进程是否在线
- 当前渲染 target 是否在线
- 主进程和渲染 target 的公开 Session 状态：`unconfigured`、`offline` 或 `online`。`connecting` 和 `stale` 只作为内部过渡状态，不要求 Agent 依赖。
- Electron target URL、标题和类型
- 最近一次连接时间
- 最近一次断开原因
- 最近的 console/exception 数量
- 当前 endpoint 配置来源：`attach_input`、`environment` 或 `session`

#### `electron_targets`

读取并返回渲染进程 CDP targets，至少包含：

- target id
- type
- title
- URL
- webSocketDebuggerUrl
- favicon URL（如果存在）

输入可以包含 `targetId`、`url` 或 `title`；这些条件只用于选择当前 page target，不改变发现到的 target 列表。只有发现单个可用 page target 时才允许自动选择；存在多个候选且 Agent 没有提供选择条件时，返回 `TARGET_SELECTION_REQUIRED`。

#### `electron_logs`

读取最近的主进程和渲染进程日志，支持：

- 按进程筛选
- 按级别筛选
- 按时间范围筛选
- 限制返回条数
- 清空内存缓存

至少收集 `consoleAPICalled`、`exceptionThrown` 和协议连接错误。日志只代表 Session 建立之后观察到的事件，不承诺提供 attach 之前的历史日志。`clear` 只清空当前 MCP Server 进程内对应 Session 的有界内存缓存，不删除项目日志、不影响 Electron 应用，也不影响其他 Server 进程。

### 可选扩展：受控诊断表达式

#### `electron_evaluate`

在主进程或当前渲染 target 执行短时诊断表达式，通过 `scope` 参数选择上下文。Skill 默认只提供只读表达式，但 MCP 不承诺能够静态证明表达式没有副作用：

```json
{
  "scope": "main",
  "expression": "process.type"
}
```

要求：

- 仅在 `ELECTRON_DEBUG_ALLOW_EVAL=true` 时可用。
- 默认超时 3 秒，调用者可降低但不能超过安全上限。
- 返回值必须 JSON 可序列化；不可序列化值转为摘要。
- 限制返回内容大小。
- Skill 必须优先使用状态、日志和固定检查，只有无法完成验证时才调用此工具。
- 禁止无限循环、阻塞 I/O、主动退出进程或修改生产数据。
- “只读”是 Skill 的使用约束，不是 MCP 能够完全静态证明的属性；表达式可能产生副作用。
- 超时或连接断开时返回明确的工具错误，不得把调用视为验证成功。

### 可选扩展：`renderer_screenshot`

截取当前渲染 target 的页面截图并写入受控输出目录。

返回：

- 绝对文件路径
- 图片格式
- 页面 URL
- 截图时间

只有启用该扩展时才需要输出目录；默认只允许写入 `ELECTRON_DEBUG_OUTPUT_DIR`。

重连、target 重新发现和 Session 重建属于 MCP Server 内部行为，不单独暴露为工具。`electron_attach` 必须幂等，并在连接失效时重新发现端点和 target。

### P1：可选调试增强

#### `debugger_breakpoint`

支持设置和删除基于 URL、行号和列号的断点，分别支持主进程和渲染进程。

#### `debugger_control`

支持 pause、resume、stepOver、stepInto、stepOut 和读取最近一次暂停的调用栈。

#### `ipc_trace`

记录指定 IPC channel 的发送方向、参数摘要、时间和结果。默认不记录完整敏感参数。

P1 不属于第一阶段交付，也不属于当前项目的核心目标。只有在核心 4 个工具已经稳定提供编码后验证所需的运行时事实时，才评估是否需要接入已有调试能力。

## 5. Skill 需求

Skill 不直接实现协议连接，负责指导 Agent 使用 MCP 工具。

Skill 必须明确以下判断规则：

- 启动、窗口创建、文件系统、数据库、自动更新、IPC handler 和进程崩溃问题，优先检查主进程。
- DOM、页面白屏、前端异常、事件绑定、网络请求和视觉问题，优先检查渲染进程。
- preload、contextBridge 和 IPC 问题必须同时检查主进程与渲染进程。
- 主进程代码或 preload 修改后必须重启 Electron。
- 渲染进程代码修改后优先 reload 当前 target。
- 调用 `electron_evaluate` 前必须说明目的、执行上下文和预期结果，避免执行破坏性表达式。
- 启用 evaluate 扩展时，先收集日志和状态，再执行表达式；不能一开始就盲目修改运行时状态。
- 每次编码修改由 Agent/Skill 根据预期行为和观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`。
- `PASS` 必须有可复核的运行时证据；`FAIL` 必须指出异常或不符合预期的观察结果；`BLOCKED` 必须说明缺少的前提。
- MCP Server 只返回工具调用状态、结构化观察结果和连接错误，不判断业务是否修复成功。
- `FAIL` 不要求已经确定根因；证据不足时，Agent 必须标明根因未确定或仅为当前最可能原因。
- 对于 preload/IPC 问题，至少保留主进程和渲染进程各一项证据。

## 6. 非功能需求

### 安全

- 只允许 `127.0.0.1`、`::1` 或 `localhost`。
- 不接受 Agent 传入任意远程 WebSocket URL。
- 主进程和渲染进程执行代码默认关闭，使用环境变量显式开启。
- 可选截图的解析后路径必须位于 Agent 提供的输出目录内，并拒绝通过符号链接逃逸目录。
- 日志、异常和表达式结果必须经过大小限制和可序列化处理，不能无界回显敏感内容。
- 错误信息不得泄露环境变量、完整本地路径以外的敏感内容。

### 稳定性

- 单个 WebSocket 断开不得导致 MCP Server 退出。
- 工具调用必须返回结构化错误。
- 对 reload、窗口关闭、Electron 重启和 target id 变化进行处理。
- 事件缓存使用上限，避免无限增长。

### 性能

- 普通状态查询目标响应时间小于 1 秒。
- 表达式执行默认超时 3 秒。
- 单次工具返回内容默认不超过 64 KB。
- 不主动持续截图、不主动持续抓取网络，除非 Agent 显式调用。
- 不进行无限期后台重连；断线恢复只在工具调用或 `electron_attach` 时进行有限尝试。

## 7. 非目标

- 由 MCP Server 主动启动、停止或重启用户的 Electron 应用。
- 代替用户选择开发命令、入口文件或窗口。
- 提供完整桌面 UI 自动化。
- 提供完整网络录制、性能分析、heap snapshot、HAR 导出或源码级调试器。
- 连接公网或局域网中的远程 Electron 应用。

### 职责边界

- Agent/Skill 负责最终验收、问题归属、根因解释和是否修复的判断。
- MCP Server 负责连接、协议、target、日志、状态、受控诊断和证据产物。
- MCP Server 不读取源码、不修改项目文件、不执行 git 操作，也不替代 Agent 的代码分析。
- MCP Server 不管理 Electron 应用生命周期；启动、停止和重启由 Agent 使用项目已有的开发命令完成。
- Agent 必须在调用 MCP 前准备工作目录、调试端点和本次修改的预期行为或回归操作。
- Agent 如果无法提供这些前提，应报告前提缺失，而不是宣称代码失败或修复成功。
- 主进程和渲染进程使用独立 Session；preload 和 IPC 问题由 Agent 联合使用两个 Session 判断。
- 第一阶段只处理当前 Electron page target，不递归管理 iframe、worker、webview 或其他浏览器 target。
- `electron_evaluate` 是唯一允许执行表达式的工具，且默认关闭；其他工具只观察或生成受控证据。
- fixture 负责启动应用、注入故障和定义预期行为；MCP Server 只负责连接 fixture 并返回观察结果。

## 8. 验收标准

### 连接

- Agent 至少提供一个有效的本地 endpoint 后，可以在 3 秒内完成 attach；缺少的通道返回独立的未配置状态。
- Agent 提供的主进程 endpoint 不可用时，MCP Server 仍能保持运行，并返回主进程不可用状态。
- 渲染窗口 reload 后，Agent 可以重新发现并连接 target。

### 双进程诊断

- 主进程 console 异常和渲染进程 console 异常能够分别读取。
- Agent 可以通过状态、target 和日志结果获得主进程、渲染进程以及 preload/IPC 问题的核心运行时事实；具体 API 返回值、DOM 内容和业务结果由项目已有检查、Agent 的回归操作或可选扩展提供。

### 可选扩展

启用对应扩展后，再增加以下验收：

- `electron_evaluate(scope=main)` 能返回主进程的 `process.type` 或等价状态。
- `electron_evaluate(scope=renderer)` 能返回 `window.location.href`。
- `renderer_screenshot` 能生成可打开的 PNG 文件。

### Skill 工作流

- Agent 能根据白屏问题选择渲染进程工具。
- Agent 能根据窗口创建失败选择主进程工具。
- Agent 能识别 preload/IPC 问题需要同时检查两个端点。
- Agent 修改代码后能按规则重启或 reload，并完成回归验证。

### 安全

- 连接 `192.168.x.x` 或公网地址时被拒绝。
- 启用 evaluate 扩展且 `ELECTRON_DEBUG_ALLOW_EVAL=false` 时，`electron_evaluate` 被拒绝并给出清晰提示。
- 启用截图扩展时，截图不会写到输出目录之外。

### Agent 使用验证

- 主进程窗口创建失败的 fixture 能提供结构化主进程证据。
- 渲染进程白屏或异常的 fixture 能提供结构化渲染进程证据。
- preload/IPC 失效的 fixture 能提供结构化的两边证据。
- 应用未启动、端点不可用或缺少目标窗口时，MCP 返回结构化连接错误。
- Agent 可以根据这些能力和 Skill 指引完成自己的分析和报告。

## 9. 编码后验证流程

### 修改主进程或窗口生命周期

1. 先调用 `electron_attach` 和 `electron_status`。
2. 读取主进程日志和异常。
3. 检查渲染 target 是否存在，确认窗口创建结果。
4. 主进程或 preload 修改后重启 Electron。
5. 重新 attach，验证窗口状态、IPC 结果和渲染页面。
6. 根据 MCP 返回的观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`。

### 修改渲染进程

1. 先调用 `electron_attach`、`electron_targets` 和 `electron_logs`。
2. 选择当前目标窗口。
3. 检查页面 URL、标题、关键 DOM 或运行时异常。
4. 渲染代码修改后优先 reload 当前 target。
5. 重新读取日志；只有视觉问题或证据不足时才按需截取页面截图。
6. 根据 MCP 返回的观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`。

### 修改 preload 或 IPC

1. 同时检查主进程和渲染进程。
2. 通过项目已有检查或回归操作验证 `contextBridge` 暴露的 API 是否存在。
3. 通过项目已有检查或回归操作检查 IPC handler 是否注册以及调用是否返回；MCP 只收集两边产生的日志和异常。
4. preload 修改后重启 Electron。
5. 页面侧和主进程侧各保留一项验证证据。
6. 根据 MCP 返回的观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`。

## 10. 实现阶段

### Phase 0：协议与连接骨架

- 根据官方文档锁定 MCP SDK 包名和版本，并提交依赖锁文件。
- 初始化 TypeScript 项目并接入 MCP stdio server。
- 实现本机端点校验、端点发现和 WebSocket 会话管理。
- 确保 MCP stdio 的 stdout 不被调试日志污染。

### Phase 1：核心四工具

- 实现主进程和 renderer Session。
- 实现 `electron_attach`、`electron_status`、`electron_targets` 和 `electron_logs`。
- 实现事件归一化和有界内存缓存。
- 实现日志和异常缓存。
- 实现按工具调用触发的有限恢复。
- 处理单通道缺失、部分连接成功、target 重新发现和 target 选择不明确。

### Phase 2：fixture、Skill 和契约验证

- 创建三类最小 Electron fixture。
- 编写核心工具契约测试和端到端验收脚本。
- 完成项目级 Skill。
- 增加修改范围到诊断通道的判断规则。
- 增加重启、reload、连接恢复和证据要求。

### Phase 3：可选诊断扩展

- 只有核心链路证明不足时，才实现 `renderer_screenshot`。
- 只有项目已有检查、回归操作和固定日志仍不足以观察目标状态时，才实现 `electron_evaluate`。
- 断点、暂停、单步、调用栈、IPC trace 和 source map 继续作为未来候选。

## 11. 成功标准

一个首次接触项目的编码 Agent，在知道实际调试 endpoint、用户问题和本次修改范围的情况下，能够：

1. 通过 MCP 连接两个进程，或明确报告端点不可用。
2. 判断问题属于主进程、preload/IPC 还是渲染进程。
3. 收集完成判断所需的最小核心运行时证据，并结合项目已有检查或回归操作补足业务证据。
4. 修改代码后重新验证。
5. 根据 MCP 提供的观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`，并说明原因和证据。
