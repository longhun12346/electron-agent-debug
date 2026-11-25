# 实施方案与调研结论

> 状态说明：本文第 1-11 节记录 Phase 0-2 的 attach 基线（4 个诊断工具，当前共 10 个）的调研和设计。项目随后转为“能力优先”方向（Skill 只提供指导，提供能力才最重要），已在 Phase 3 增加运行时检查（`electron_evaluate`、`electron_wait_for`、`electron_screenshot`、`electron_dom_snapshot`）和最小交互（`electron_click`、`electron_type`），共 10 个工具（曾实现的 `electron_launch`/`electron_stop`/`electron_restart` 已移除：各项目启动方式不同，启动应用交给 Agent）。当前契约见 [requirements.md](requirements.md) 第 4 节和 [architecture.md](architecture.md)；下文中与此冲突的“不启动应用”“当前未实现”等表述属于基线阶段的历史记录。

## 1. 最终目标

本项目为编码 Agent 提供 Electron 双通道运行时诊断能力，以及如何使用这些能力的 Skill 指导。

Agent 启动应用后，向 MCP Server 提供：

- 主进程 Node Inspector 的实际 loopback endpoint
- 渲染进程 Chromium DevTools Protocol 的实际 loopback endpoint

Agent 可以通过 MCP 和 Skill 获得：

1. 连接两个调试通道。
2. 根据修改范围判断主进程、preload/IPC 或渲染进程。
3. 读取状态、日志和异常。
4. 对已连接的应用执行表达式、等待条件、截图和读取无障碍树；原生对话框由 Agent 提示用户人工操作，业务回归仍由 Agent 使用项目已有测试或其他工具完成。
5. 根据修改范围重启 Electron 或 reload 当前窗口。
6. 向 Agent 提供状态、日志、应用退出信息和异常等运行时证据。

项目不判断业务是否通过，也不实现完整源码级调试器。项目不监听文件保存；是否发起验证由 Agent 工作流决定。

## 2. 调研结论

### 2.1 双通道是技术事实，不是人为拆分

Electron 窗口内的 DevTools 主要用于渲染进程；主进程需要通过 `--inspect` 暴露 V8 Inspector。Electron 的 Inspector 通过 Agent 提供的 TCP endpoint 提供协议连接。渲染进程通过 `--remote-debugging-port` 暴露 Agent 提供的 Chromium 调试 HTTP 和 WebSocket 入口。

因此，主进程和渲染进程需要两个独立 Session。项目不应尝试把两个端点伪装成完全相同的协议。

### 2.2 MCP Server 应保持薄

官方 MCP TypeScript SDK 已经提供 Server、工具注册和 stdio 服务能力。Phase 0 开始前应依据官方文档锁定经过验证的 SDK 包名和版本，并提交依赖锁文件；不要在没有验证 API 的情况下继续依赖旧示例或假定入口名称。

协议连接层只需要：

- Node 原生 `fetch`：读取 `/json/list`。
- `ws`：连接 Node Inspector 和 renderer CDP。
- `zod`：校验 MCP 工具参数。
- 一个小型 JSON-RPC request/response 管理器。

第一阶段不引入 Electron runtime、Playwright、浏览器下载器、桌面自动化框架或完整 CDP 封装。

### 2.3 不把完整调试器作为目标

断点、单步、网络、性能、heap snapshot、HAR 和 UI 自动化都不是编码后验证的必要条件。它们会扩大协议兼容性、Session 生命周期和测试范围。

第一阶段只验证三类缺陷：

1. 主进程窗口创建或生命周期失败。
2. 渲染进程白屏或运行时异常。
3. preload/IPC API 不存在、调用失败或结果不一致，并能通过日志、异常或项目回归操作观察到。

## 3. 方案选择

### 方案 A：自建轻量适配层

保留本仓库，自己实现核心 MCP 工具和两个调试 Session。基线阶段是 4 个诊断工具；后续按能力优先方向增加生命周期与运行时检查工具（见上方状态说明）。

优点：

- 工具数量和行为完全可控。
- 可以严格实现回环地址限制和 evaluate 门控。
- Skill、工具结果和验收场景可以围绕编码后验证设计。
- 不需要引入大型桌面自动化依赖。

缺点：

- 需要自己处理 WebSocket JSON-RPC、target 变化和 Node/CDP 协议差异。
- 需要编写 Electron fixture 和重连测试。

这是当前项目的推荐方案。

### 方案 B：复用完整 Electron MCP Server

直接使用已有 Electron MCP 项目，再通过配置或包装层限制工具。

优点是初始功能更多，缺点是通常带有启动应用、页面自动化、网络、DOM 或 IPC trace 等超出当前目标的能力。安全边界、协议兼容性和工具行为需要重新审核，最终可能比自建薄适配层更复杂。

当前项目没有代码基础，且目标非常窄，因此不推荐先引入完整实现再删功能。

### 方案 C：使用通用浏览器 MCP，再另接主进程桥接

这会把 renderer 自动化和主进程 Inspector 拆成两个 MCP 服务。Agent 需要理解两个服务的状态和错误模型，Skill 也需要额外协调，无法保持轻量。

不采用。

## 4. 对外工具契约

基线阶段（Phase 1）公开 4 个诊断工具；生命周期和运行时检查工具的契约见 [requirements.md](requirements.md) 第 4 节：

### `electron_attach`

作用：发现 Agent 提供的端点，创建或恢复可用的 Session，并在 renderer 通道可用时选择当前 page target。

输入：

```ts
{
  mainUrl?: string;
  rendererUrl?: string;
  targetId?: string;
  url?: string;
  title?: string;
  clearSelection?: boolean;
}
```

endpoint 来源按以下顺序解析：

1. 本次工具输入。
2. MCP Server 启动环境中的 `ELECTRON_DEBUG_MAIN_URL`、`ELECTRON_DEBUG_CDP_URL`。
3. 当前 Server 中已经建立的同一通道 Session 配置，仅用于幂等重连。
4. 无默认值。

输出：

```ts
{
  ok: true;
  data: {
    main: { configured: boolean; online: boolean; endpoint?: string; error?: DiagnosticError };
    renderer: { configured: boolean; online: boolean; endpoint?: string; error?: DiagnosticError };
    targets: TargetInfo[];
    selectedTarget?: TargetInfo;
    errors: DiagnosticError[];
  }
}
```

当主进程连接失败但 renderer 成功时，仍返回 `ok: true` 和两边各自的状态；`errors` 只描述不可用的通道。只有没有任何 endpoint 或输入参数无法解析时才返回 `ok: false`。

要求：

- 幂等。
- 不启动应用（由 Agent 负责）。
- 端点不可用时返回结构化错误，不退出 MCP Server。
- 连接失效时在当前工具调用内进行有限的重新 discovery 和 Session 重建。
- 主进程和 renderer 独立返回状态，允许部分成功。
- endpoint 发生变化时先关闭旧 Session，再创建新 Session。

### `electron_status`

作用：返回当前诊断状态，不主动执行应用代码。

包含：

- 主进程是否在线。
- 当前 target 是否在线。
- target URL、title、type。
- 最近连接和断开时间。
- 最近断开原因。
- 主进程和渲染进程事件数量。
- 当前能力状态。
- 对 Agent 的公开 Session 状态：`unconfigured`、`offline` 或 `online`；`connecting`、`stale` 等只属于内部实现。
- endpoint 配置来源：`attach_input`、`environment` 或 `session`。

### `electron_targets`

作用：读取 page targets，并选择当前 target。

输入可以包含 `targetId`、`url`、`title` 或 `clearSelection`；选择条件只影响当前 target，不过滤发现结果。`clearSelection=true` 用于清除之前保存的选择条件和当前 target，再按当前 target 列表重新选择。

第一阶段只支持：

- target id。
- 完整 URL。
- 标题。
- 只有单个可用 page target 时自动选择。

存在多个候选且 Agent 没有提供选择条件时返回 `TARGET_SELECTION_REQUIRED`。不实现浏览器级多 target 自动附着，也不实现 iframe、worker 和 webview 的递归管理。

### `electron_logs`

作用：读取有上限的事件缓存。

支持：

- `process=main|renderer|all`
- `level`
- `limit`
- `since`
- `clear`

至少归一化：

- console。
- exception。
- 连接和协议错误。

`clear` 只清空当前 MCP Server 进程内对应 Session 的有界内存缓存，不删除项目日志，不影响 Electron 应用，也不影响其他 Server 进程。

### `electron_evaluate`（已实现，契约见 requirements.md）

基线阶段的设计草案如下，已实现版本的差异：门控改为“默认开启，宿主可用 `ELECTRON_DEBUG_ALLOW_EVAL=0` 禁用”，结果上限默认 64 KiB 且最多 1 MiB，结果不做脱敏（后来的决定，见 requirements 第 6 节）。

作用：执行一次受控诊断表达式。

输入：

```ts
{
  scope: "main" | "renderer";
  expression: string;
  timeoutMs?: number;
}
```

约束：

- 默认超时 3000ms。
- 结果上限 64KB。
- 结果不可序列化时返回摘要。
- Skill 优先使用固定检查，evaluate 只作为兜底。
- evaluate 结果不能单独证明修复成功，必须结合目标行为或日志验证。

### `electron_screenshot`（已实现，契约见 requirements.md）

作用：在 Agent 明确需要视觉证据时，截取当前 renderer target 页面并写入受控目录（`ELECTRON_DEBUG_OUTPUT_DIR`）。不实现持续截图、视频录制和截图对比。窗口被隐藏或最小化时截图会超时。

## 5. 内部模块

```text
src/
  index.ts
  config.ts
  errors.ts
  discovery.ts
  protocol/
    json-rpc-connection.ts
  sessions/
    session-manager.ts
    diagnostic-session.ts
  targets/
    selector.ts
  events/
    event-buffer.ts
  tools/
    core-tools.ts
```

当前实现将主进程和 renderer 的协议差异收敛在共享的 `DiagnosticSession` 和 `SessionManager` 中；重连、target 重新发现、事件缓存和 Session 重建都属于内部模块，不暴露为独立 MCP 工具。截图和 evaluate 是未来候选扩展，只有核心链路无法提供足够证据时才重新评估。

## 6. 协议实现策略

### Discovery

1. 读取 Agent 提供的 HTTP endpoint 环境变量。
2. 如果 endpoint 未提供，返回 `ENDPOINT_NOT_CONFIGURED`，不探测固定端口。
3. 校验 endpoint 使用允许的 HTTP(S) 形式且主机只能是 `127.0.0.1`、`::1` 或 `localhost`。
4. 使用 `fetch` 请求 `/json/list`。
5. 校验返回的 `webSocketDebuggerUrl` 使用 `ws`/`wss` 且主机仍然是回环地址。
6. 根据 target 选择规则连接 WebSocket。

Server 不接受 Agent 直接传入任意 WebSocket URL；只信任经过协议和主机校验的 discovery 结果。

### 主进程 Session

优先启用：

- `Runtime`

日志优先使用 Node Inspector 实际提供的 Runtime/Console 事件，不假设主进程支持完整 Chromium `Log` domain。

### 渲染进程 Session

优先启用：

- `Runtime`
- `Log`

使用：

- `Runtime.consoleAPICalled`
- `Runtime.exceptionThrown`

只有启用对应扩展时才增加：

- `Page.captureScreenshot`
- `Runtime.evaluate`

Renderer discovery 可以在没有选定 page target 时返回 target 列表；当前实现只有在选定可连接的 page target 后才建立 renderer Session。没有唯一 target 时，renderer Session 保持离线并返回明确的 target 选择错误。核心实现不得把 discovery 成功当作“业务窗口已正确加载”。

### 通用 JSON-RPC

连接类只负责：

- 递增 request id。
- 将 response 匹配到 Promise。
- 分发事件。
- 请求超时。
- WebSocket close/error。
- 清理未完成请求。

领域逻辑不直接处理 WebSocket 的底层事件。

Discovery、WebSocket 建连和单次协议请求都使用有限超时；超时只表示本次工具调用无法取得结果，不表示目标 Electron 进程已经停止。

### Session 状态

```text
unconfigured  没有 Agent 提供的 endpoint
offline       endpoint 已知但当前无法连接
online        Session 可发送请求并接收事件
```

实现可以在内部使用 `connecting`、`stale` 等过渡状态，但对 Agent 的公开状态只承诺上述三个值。状态变化必须记录时间和最近错误。状态查询不应通过返回“在线”来推断业务正确性。

### 证据格式

所有观察结果都应包含最少的来源信息：

```ts
{
  process: "main" | "renderer";
  targetId?: string;
  observedAt: string;
  kind: "status" | "console" | "exception" | "connection"
    | "evaluation" | "screenshot";
  data: unknown;
}
```

证据是运行时事实，不包含业务验收结论。Agent/Skill 负责解释这些事实。

## 7. 安全和轻量约束

- 只允许 `127.0.0.1`、`localhost` 和明确允许的回环地址。
- 不允许 Agent 传入任意 WebSocket URL。
- Discovery 返回的 WebSocket URL 必须再次校验。
- stdout 只输出 MCP 协议，日志写 stderr。
- evaluate 默认只对回环 endpoint 开放，宿主可用 `ELECTRON_DEBUG_ALLOW_EVAL=0` 禁用，且其超时和结果大小有上限。
- 截图只写入宿主配置的输出目录，文件名由工具生成，权限仅当前用户可读写。
- 日志、异常和表达式结果必须有大小上限并经过可序列化处理。
- 事件缓存使用 ring buffer，按条数和字节数设上限。
- 不引入 Playwright、Electron runtime、浏览器下载器和桌面控制框架。

## 8. 分阶段计划

### Phase 0：协议与连接骨架

目标：MCP Server 能启动，并能安全发现 Agent 提供的本地 endpoint。

- 根据官方文档锁定 MCP SDK 包名和版本。
- 添加并提交依赖锁文件。
- 实现 stdio 启动入口。
- 实现配置和回环地址校验。
- 实现 HTTP discovery。
- 实现通用 WebSocket JSON-RPC 连接。

完成标准：

- MCP Server 能被客户端启动。
- stdout 没有非协议输出。
- discovery、WebSocket 建连和单次请求都有有限超时。
- endpoint 缺失时返回 `ENDPOINT_NOT_CONFIGURED`，不尝试固定端口。
- 非回环 endpoint 被拒绝。
- discovery 返回的非回环 WebSocket 地址被拒绝。

### Phase 1：核心四工具

目标：能够通过两个独立 Session 收集核心运行时证据；项目特有的业务检查由 Agent 使用已有命令或回归操作完成。

- 实现主进程和 renderer Session。
- 实现事件归一化和 ring buffer。
- 实现 `electron_attach`、`electron_status`、`electron_targets`。
- 实现 `electron_logs`。
- 实现按工具调用触发的有限恢复和 target 重新发现。
- 处理单通道缺失、部分连接成功、target 选择不明确和 target 重建。

完成标准：

- 可分别读取两个进程的异常。
- 可以读取 renderer target URL、标题和连接状态。
- endpoint 缺失、不可用和 target 不存在时返回结构化错误。
- renderer 通道在线但没有唯一目标时返回 target 选择错误，不把通道连接成功当作目标选择成功。
- 四个核心工具都可以通过 MCP 客户端调用，并且不会因为单个 Session 失败而退出 Server。

### Phase 2：fixture、Skill 和契约验证

目标：证明 MCP 能提供三类典型问题所需的核心诊断事实，Agent 能结合项目已有检查完成业务验证，Skill 能指导 Agent 找到这些事实。

- 创建主进程窗口失败 fixture。
- 创建 renderer 白屏/异常 fixture。
- 创建 preload/IPC 失败 fixture。
- 每个 fixture 提供故障态和修复态。
- 完成 Skill 中的通道选择、证据收集和使用顺序规则。
- 编写核心工具契约测试和最小端到端验收脚本。
- 增加缺少 endpoint 的 `BLOCKED` 场景验收，并让 fixture 显式覆盖 `electron_targets`。
- 增加固定外部项目 commit、动态端口和双通道工具调用的 opt-in E2E harness。
- 验证包含 MCP 运行文件的完整 Skill、源码和文档边界，并验证随包 stdio 启动入口。

完成标准：

- 三种故障都能定位到正确的诊断范围。
- 故障态返回结构化的运行时观察结果。
- 修复态返回结构化的运行时观察结果。
- 应用未启动时返回结构化连接错误。
- 契约测试覆盖 endpoint 校验、部分 attach、target 选择、Session 状态、日志上限和 `clear` 作用域。
- Skill 明确要求 Agent 提供项目检查或回归步骤，并由 Agent 输出 `PASS`、`FAIL` 或 `BLOCKED`。
- 外部项目 harness 能独立报告诊断层结果，不把上游项目自身的业务断言混入诊断结论。
- GitHub 仓库包含构建所需源码、完整 Skill 和文档；已安装 Skill 的随包 MCP 无需额外依赖安装即可初始化，且不污染 stdout。

这三个 fixture 只证明核心诊断链路可用，不代表项目覆盖所有 Electron 故障类型。

### Phase 3：能力优先扩展（已实现）

Skill 只提供指导和建议，提供能力才最重要。已实现：

- 运行时检查：`electron_evaluate`、`electron_wait_for`、`electron_screenshot`、`electron_dom_snapshot`。
- 统一 `seq` 时间线和 `afterSeq`/`lastSeq` 续读。
- 薄 Skill（证据矩阵）。

暂缓：与 MCP 共享核心的 CLI 入口（需要常驻进程）。IPC trace 已作为自动记录实现（不是独立工具）。仍未承诺：调试断点、调用栈、source map、原生对话框和菜单替身。

## 9. 风险与处理

### evaluate 的超时不等于目标代码已经停止

客户端超时只能保证 Agent 不再等待。终止执行应视协议能力做 best-effort，不能把 evaluate 作为唯一的成功依据。固定状态、日志和回归行为必须是主要证据。

### target id 会变化

保存原始选择条件，并在 target 失效后按 id、URL、title 的优先级重新匹配。

### Skill 不是文件保存钩子

Skill 只能规定 Agent 在修改后执行验证。真正的自动触发由 Agent 工作流负责，第一阶段不增加文件监听器或编辑器插件。

## 10. 推荐决策

采用方案 A：自建轻量诊断适配层。基线阶段（Phase 0-2）实现了 4 个诊断工具、fixture 和 Skill；随后按“Skill 只是指导，能力才最重要”的方向，由工具直接拥有运行时检查能力（应用由 Agent 启动，工具只 attach）。项目完成的判断标准是“Agent 能通过 MCP 获得典型问题所需的运行时事实”，而不是“项目替 Agent 完成业务验收”或“支持尽可能多的 DevTools 命令”。

轻量性由以下可检查条件约束：单个 Server 只服务一个 Agent 会话、只管理一个应用；只处理当前 page target；不扫描端口、不持续轮询、不无限期重连；输出结构化、有界、仅限回环；不含项目专属逻辑；不做通用桌面自动化或完整调试器。

## 11. 边界审查

| 边界 | MCP Server 负责 | Agent/Skill 或 fixture 负责 |
|---|---|---|
| 最终验收 | 不做业务验收，只返回观察结果和错误 | 根据用户目标判断 `PASS`、`FAIL`、`BLOCKED` |
| 源码分析 | 不读取、不修改源码 | 分析 diff、判断修改范围和预期行为 |
| 主进程/渲染进程 | 提供两个独立 Session | 决定检查单个进程还是联合检查 |
| preload/IPC | 返回两边的观察结果 | 结合主进程和 renderer 证据判断问题 |
| target | 发现和选择当前 page target | 指定目标窗口和确认目标是否正确 |
| 表达式执行 | 对本工具启动的应用提供带超时和大小限制的 evaluate；外部应用需宿主开启 | 决定是否需要执行以及如何解释结果 |
| 日志 | 采集并返回受控证据（含应用输出和统一 seq 时间线） | 判断证据是否证明用户目标已经满足 |
| 截图与 DOM 快照 | 提供截图文件和无障碍树文本 | 判断它们是否有助于证明用户目标 |
| fixture | 不启动、不注入故障 | 启动测试应用、设置故障态和预期结果 |
| 触发时机 | 不监听文件保存 | 在编码完成后按 Skill 主动发起验证 |

### 11.1 数据边界

- 事件只保留在有上限的内存缓存中；日志类工具不主动写文件，唯一写文件的是截图（`ELECTRON_DEBUG_OUTPUT_DIR`，仅当前用户可读写，保留最近 50 张）。
- 原始 console 参数、异常对象、应用输出和 evaluate 结果必须经过大小限制、可序列化处理；不做脱敏，是否遮挡由 Agent 判断。
- MCP Server 不把完整日志自动写入项目目录。
- 截图只写入输出目录，文件名由工具生成，并返回文件路径和元数据。
- 工具错误可以包含诊断细节，但不能回显环境变量中的敏感值。

### 11.2 Session 和并发边界

假设一个 MCP Server 进程服务一个 Agent 会话：

- Session 状态属于当前 Server 进程。
- attach、targets 刷新和 close 经同一个操作队列串行处理；evaluate、wait_for、截图和快照不排队。
- 多 Agent 或多项目共享同一个 Server 进程不在支持范围内。

如果未来需要多客户端共享，必须先增加显式 session id、权限隔离和 target 隔离，不能直接复用当前全局状态。

### 11.3 进程身份边界

调试端口可能被 Electron 重启后的新进程重新占用。MCP Server 不保证端口对应的是上一次连接的同一个进程，只保证返回本次 discovery 的端点、target、连接时间和能力状态。Agent 应把重新 attach 后的状态视为一次新的运行时观察。

### 11.4 工具状态和业务状态

- 工具 `ok: true` 只表示 MCP 成功完成本次请求。
- 工具 `ok: false` 表示参数、协议、连接或输出错误。
- 用户代码是否正确、修改是否满足需求、回归是否通过，属于 Agent 的业务判断。
- MCP 不定义 `PASS`、`FAIL` 或 `BLOCKED` 的业务含义，只返回事实、状态和错误。
- Skill 可以建议 Agent 如何组织分析，但不替 Agent 做业务结论。

### 11.5 配置归属

以下值必须由 Agent 或具体项目提供，不能写成产品默认值：

- 项目工作目录。
- Electron 启动、停止和重启命令。
- 主进程和 renderer 的实际 endpoint。
- target id、URL、标题或其他窗口选择条件；只有多候选 target 时必需。
- 本次修改的预期行为和回归操作。
- 项目特有的 preload API、IPC channel、DOM selector 和诊断表达式。
- 应用就绪条件，例如页面 URL、标题、关键文本或自定义健康检查。
- fixture 的故障开关和预期结果。

按需提供：

- 诊断输出目录：截图写入 `ELECTRON_DEBUG_OUTPUT_DIR`，默认系统临时目录下的 `electron-agent-debug`，只在调用 `electron_screenshot` 时使用。

以下内容属于稳定的产品或协议契约，可以固定：

- MCP 使用 stdio。
- discovery 使用 endpoint 下的 `/json/list`。
- 只允许回环地址。
- 工具名称、错误结构和 Session 边界。
- evaluate 和 expression 型 wait_for 默认开启，宿主设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 时被拒绝。
- 单个 Server 进程的单 Agent 会话假设。
- endpoint 来源优先级：工具输入、环境变量、当前 Session 配置、无默认值。

以下内容属于安全上限，可以有默认值，但不能被项目业务逻辑覆盖：

- evaluate 的最大执行时间（默认 3 秒，上限 30 秒）和结果大小（默认 64 KiB，上限 1 MiB）。
- 事件缓存最大条数和字节数。
- 截图输出路径约束：目录由宿主配置，文件名由工具生成，只保留最近 50 张。

安全上限允许 Agent 在调用时进一步收紧；没有 Agent 提供的任何 endpoint 时，MCP 不猜测、不扫描、不回退到固定值；只提供一个 endpoint 时允许部分诊断。

## 12. 待办

- 原生模块崩溃后的 dump 分析：`skill/electron-debug/references/native.md` 的场景三只按官方文档写了流程。需要在真实的原生崩溃上验证三件事：dump 怎么生成（Electron 自带的 crashpad，或 Windows 的 WER LocalDumps、ProcDump）、`open_cdb_dump` 打开后 `!analyze -v` 和 `kn` 能否定位到原生模块、符号怎么配。
- 原生进程卡死时看所有线程的栈：同一节的 `~*kn` 流程，需要在真实的卡死（原生调用阻塞主线程）上验证，并确认附加和 `qqd` 退出后应用能恢复。
- 其余没有实测的原生调试内容记在 `skill/electron-debug/VERSION.md` 1.6.2 条目的“没有实测”里（macOS、Linux 的 LLDB 流程、`-y`、`-srcpath`、`-hd` 选项、`sxe ld:`、electron-vite 的 `--inspect-brk` 写法）。target 选择条件只在存在多个候选时必需。
