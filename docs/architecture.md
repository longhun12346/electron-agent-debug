# 架构设计

## 0. 设计目标

架构服务于“Agent 驱动的 Electron 运行时诊断”场景：

```text
Agent 修改代码
      │
      ▼
调用 Electron Debug Skill
      │
      ▼
MCP 诊断适配层
      │
      ├── 主进程 Inspector
      └── 渲染进程 CDP
      │
      ▼
状态、日志和异常
      │
      └── 按需执行表达式、等待条件、截图、无障碍树快照
      │
      ▼
Agent 根据用户目标进行分析
```

MCP Server 只 attach 到 Agent 已启动的应用，不启动、停止或重启应用。工具不包含项目专属逻辑，也不替 Agent 做业务回归。

## 1. 总体结构

```text
Coding Agent
    │ MCP stdio
    ▼
electron-agent-debug MCP Server
    ├── Target Discovery
    │     ├── GET main Inspector /json/list
    │     └── GET renderer CDP /json/list
    ├── Main Inspector Session
    │     └── WebSocket → Agent-provided main endpoint
    ├── Renderer CDP Session
    │     └── WebSocket → Agent-provided renderer endpoint
    ├── Utility Session（可选）
    │     └── WebSocket → 经主进程定位的 utility process 调试口
    ├── Event Buffer（main / renderer / utility 共享递增 seq 的统一时间线）
    ├── Inspector (evaluate / wait_for / screenshot / dom_snapshot)
    ├── Diagnostic State
    └── Tool Router

Electron App
    ├── Main Process: Agent-provided Inspector endpoint
    └── Renderer: Agent-provided CDP endpoint
```

## 2. 会话模型

MCP Server 启动后不主动连接应用。第一次调用 `electron_attach` 时读取 Agent 已提供的端点并建立 Session。Server 不猜测或扫描 Electron 应用。

attach、targets 刷新和 close 经同一个操作队列串行执行；Inspector 的 evaluate、wait_for、截图和快照不排队，避免长时间等待阻塞连接操作。

主进程和渲染进程使用两个相互独立、可部分建立的 Session（utility 通道见下）：

```text
SessionManager
├── MainSession
│   ├── endpoint
│   ├── websocket
│   ├── enabled domains
│   └── event buffer
└── RendererSession
    ├── target id
    ├── endpoint
    ├── websocket
    ├── enabled domains
    └── event buffer
```

`electron_attach` 带 `utility` 参数时另建第三个 UtilitySession，结构与 MainSession 相同。它没有 Agent 提供的 endpoint：`SessionManager` 通过已连接的主进程求值调用 `app.getAppMetrics()` 找到进程，用 netstat（Windows）或 lsof（macOS/Linux）查它监听的回环端口，没有调试口时调用 `process._debugProcess(pid)` 打开。因此它要求主进程通道在线且未禁用求值；主进程 endpoint 变化或被移除时一并关闭。一次只保留一个 utility 连接。

Renderer discovery 可以在尚未选定 target 时返回 target 列表；当前实现只有在选定一个可连接的 page target 后才建立 RendererSession。没有唯一 target 时，renderer Session 保持 `offline`，并返回 `TARGET_SELECTION_REQUIRED` 或 `TARGET_NOT_FOUND`。

每个请求带有递增 request id。响应通过 request id 与 Promise 对应。事件消息写入有上限的内存缓存，不阻塞工具调用。缓冲区满时丢弃最旧的事件，`electron_logs` 用 `droppedThroughSeq` 和 `gap` 告知调用方所请求的范围内是否可能有事件缺失。

SessionManager 还要记录面向诊断的状态：

```text
DiagnosticState
├── lastAttachAt
├── lastDisconnectAt
├── lastDisconnectReason
├── selectedTarget
├── mainEventCount
└── rendererEventCount
```

重连、target 重新发现和 Session 重建是 `SessionManager` 的内部行为，不单独暴露为 MCP 工具。`electron_attach` 和 `electron_targets` 在需要时进行有限恢复和重新发现；不启动无限期后台重连。reload 或 Electron 重启后的新 target 不继承旧 target 的在线结论，必须重新选择并重新观察。

Skill/Agent 使用统一结论状态；MCP Server 不替 Agent 判断业务是否验收通过：

```text
PASS     Agent 根据运行时证据确认预期行为
FAIL     Agent 根据观察结果判断存在异常或结果不符合预期
BLOCKED  Agent 根据 MCP 的连接错误判断缺少应用、端点、target 或其他验证前提
```

## 3. 端点发现

主进程 discovery endpoint（由 Agent 提供）：

```text
GET ${ELECTRON_DEBUG_MAIN_URL}/json/list
```

渲染进程 discovery endpoint（由 Agent 提供）：

```text
GET ${ELECTRON_DEBUG_CDP_URL}/json/list
```

渲染进程从 discovery 返回的 `type=page` targets 中选择当前窗口；对外返回发现到的 page targets，只有带有 `webSocketDebuggerUrl` 的 target 才能建立诊断 Session。选择优先级：

1. 显式 target id。
2. 完整 URL 匹配。
3. 标题匹配。
4. 只有单个可连接 page target 时自动选择；多个可连接候选时要求 Agent 提供选择条件。

## 4. 协议能力

主进程和渲染进程不能假设拥有完全相同的协议能力。

主进程优先启用：

- `Runtime`

主进程日志根据 Node Inspector 实际支持的 Runtime/Console 事件收集。

渲染进程优先启用：

- `Runtime`
- `Log`

实现时应按 Session 能力处理协议差异；某个 domain 不支持或启用失败时，返回局部能力状态，不得让 MCP Server 退出。核心 Session 只启用日志和状态所需的 domain。

按需使用的能力：

- `Runtime.evaluate`：`electron_evaluate`、expression 型 `electron_wait_for`（主进程与 renderer 各自的 Session），受下文的门控约束。
- `Page.captureScreenshot`：`electron_screenshot`。窗口被隐藏或最小化时 Chromium 不响应，调用以超时失败并提示显示窗口。
- `Accessibility.getFullAXTree`：`electron_dom_snapshot`，不在页面执行脚本，附加模式也可用。

## 5. 错误模型

工具必须返回结构化错误：

```json
{
  "ok": false,
  "error": {
    "code": "MAIN_INSPECTOR_UNAVAILABLE",
    "message": "主进程 Inspector 不可用，请确认 Agent 提供的 endpoint 对应已启动的应用",
    "retryable": true,
    "details": {}
  }
}
```

推荐错误码：

- `INVALID_ENDPOINT`
- `ENDPOINT_NOT_CONFIGURED`
- `ENDPOINT_CONFIG_INVALID`
- `NON_LOOPBACK_ENDPOINT`
- `MAIN_INSPECTOR_UNAVAILABLE`
- `RENDERER_CDP_UNAVAILABLE`
- `TARGET_NOT_FOUND`
- `TARGET_SELECTION_REQUIRED`
- `SESSION_DISCONNECTED`
- `PROTOCOL_ERROR`

utility 通道增加以下错误码：

- `UTILITY_REQUIRES_MAIN`
- `UTILITY_NOT_FOUND`、`UTILITY_AMBIGUOUS`
- `UTILITY_INSPECTOR_UNAVAILABLE`

协议请求超时使用 `PROTOCOL_ERROR`，并在 `details` 中带 `reason: "timeout"`、`method` 和 `timeoutMs`，供调用方按结构而不是按消息文本识别。

检查能力增加以下错误码：

- `INVALID_ARGUMENT`
- `EVALUATION_NOT_ALLOWED`、`EVALUATION_FAILED`
- `WAIT_TIMEOUT`
- `SCREENSHOT_FAILED`、`SNAPSHOT_FAILED`

`OUTPUT_TOO_LARGE` 当前只用于拒绝过大的 discovery 响应；日志事件使用 Session 自己的缓存上限，evaluate 结果超过 `maxResultBytes` 时在成功结果中标记 `truncated`，文本按 UTF-8 字节截断且不拆开多字节字符。

## 6. Skill 与 MCP 的边界

MCP Server 负责：

- 端点连接
- 协议消息
- target 管理
- 事件缓存
- 工具返回值
- 安全约束
- 支持 Agent 判断 `PASS`、`FAIL` 或 `BLOCKED` 的结构化观察数据

Skill 负责：

- 问题分类
- 工具选择顺序
- 编码修改后的重启/reload/reconnect 判断
- 证据收集要求
- 诊断结果格式和结论状态

Skill 不应该复制 WebSocket 协议逻辑，也不应该自己实现一套 MCP 工具。

MCP 工具的 `ok` 只表示本次工具调用是否成功，不表示用户代码是否修复成功。工具成功时返回观察结果，工具失败时返回连接、协议或参数错误；最终验收结论由 Skill/Agent 结合用户目标和观察结果生成。

`electron_attach` 允许部分成功：主进程和 renderer 的状态分别返回，单个通道不可用不应掩盖另一个通道的观察结果。只有请求参数或必需配置无法处理时才使用顶层 `ok: false`。

## 7. 安全和限制

- 只允许连接回环地址。
- HTTP discovery 返回的 WebSocket 地址也必须重新校验。
- 表达式执行（`electron_evaluate`、expression 型 `wait_for`）默认开启（只连接回环地址）；宿主可在 MCP 配置的 `env` 中设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 禁用，此时返回 `EVALUATION_NOT_ALLOWED`。执行有超时（默认 3 秒，上限 30 秒）和结果大小限制（默认 64 KiB，上限 1 MiB）。
- 截图写入 `ELECTRON_DEBUG_OUTPUT_DIR`（默认系统临时目录下的 `electron-agent-debug`），目录权限 0700、文件权限 0600，文件名由工具生成，只保留最近 50 张；不返回图像内容。
- 日志事件（`message` 和 `data`）、异常和 evaluate 结果都经过脱敏（token、secret、password、api key、authorization、cookie 等键值和 Bearer 令牌；以及不带键名但形态明确的 JWT、GitHub / Slack / npm / AWS / Google 前缀令牌、`sk-` 密钥、PEM 私钥块和 URL 中的密码），并有大小上限。
- 异常事件渲染为 `Uncaught <描述>` 加调用栈的文本；`console.trace`、`console.assert` 附带调用栈（最多 10 帧）。事件的 `data` 只保留定位所需的少量字段，不透传协议原始对象。
- MCP 不托管应用进程：应用的 stdout、stderr 和退出码由启动它的 Agent 自行捕获，不进入时间线。
- stdout 只用于 MCP 协议，诊断日志写 stderr。
- discovery、WebSocket 建连和单次协议请求都必须有有限超时；一次工具调用不得等待无限期网络操作。
- WebSocket 单条协议消息必须有大小上限，不能只依赖事件缓存限制。
- 断线、target 销毁和协议错误必须转换为结构化工具结果。

## 8. 技术栈

- Node.js 20+
- TypeScript
- MCP TypeScript SDK
- `ws`
- 原生 `fetch`
- Zod 参数校验

第一阶段不引入 Playwright、Electron 运行时、Chromium 下载器或桌面控制框架。
