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
      └── 未来可按需增加表达式或截图扩展
      │
      ▼
Agent 根据用户目标进行分析
```

MCP Server 只负责连接和诊断，不负责启动或控制用户应用的生命周期。

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
    ├── Event Buffer
    ├── Diagnostic State
    └── Tool Router

Electron App
    ├── Main Process: Agent-provided Inspector endpoint
    └── Renderer: Agent-provided CDP endpoint
```

## 2. 会话模型

MCP Server 启动后不主动连接应用，第一次调用 `electron_attach` 时读取 Agent 已提供的端点并建立可用的 Session。连接由 Agent 在诊断阶段触发，Server 不尝试启动或猜测 Electron 应用。

主进程和渲染进程使用两个相互独立、可部分建立的 Session：

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

Renderer discovery 可以在尚未选定 target 时返回 target 列表；当前实现只有在选定一个可连接的 page target 后才建立 RendererSession。没有唯一 target 时，renderer Session 保持 `offline`，并返回 `TARGET_SELECTION_REQUIRED` 或 `TARGET_NOT_FOUND`。

每个请求带有递增 request id。响应通过 request id 与 Promise 对应。事件消息写入有上限的内存缓存，不阻塞工具调用。

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

只有启用对应扩展时才启用 `Page` 或 `Runtime.evaluate`。

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

未来实现 evaluate 或截图扩展时，才需要增加 `EVALUATION_DISABLED`、`EVALUATION_TIMEOUT`、
`OUTPUT_PATH_DENIED` 和 `OUTPUT_DIR_NOT_CONFIGURED` 等扩展错误码。`OUTPUT_TOO_LARGE`
当前只用于拒绝过大的 discovery 响应；日志事件使用 Session 自己的缓存上限。

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
- 如果未来实现表达式执行，默认关闭，并限制时间、并发和结果大小。
- 如果未来实现截图，解析后的路径必须位于 Agent 提供的输出目录内，并拒绝通过符号链接逃逸目录。
- 日志和异常必须有大小上限并经过可序列化处理；未来实现表达式后，其结果也必须遵守同样限制。
- stdout 只用于 MCP 协议，诊断日志写 stderr。
- discovery、WebSocket 建连和单次协议请求都必须有有限超时；一次工具调用不得等待无限期网络操作。
- WebSocket 单条协议消息必须有大小上限，不能只依赖事件缓存限制。
- 断线、target 销毁和协议错误必须转换为结构化工具结果。

## 8. 技术栈

- Node.js 22+
- TypeScript
- MCP TypeScript SDK
- `ws`
- 原生 `fetch`
- Zod 参数校验

第一阶段不引入 Playwright、Electron 运行时、Chromium 下载器或桌面控制框架。
