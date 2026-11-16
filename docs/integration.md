# 接入说明

本项目通过 stdio 暴露 MCP Server。它只连接 Agent 或测试脚本已经准备好的 Electron 调试 endpoint，不负责启动应用，也不负责分配端口。

## 随包启动

MCP Server 要求 Node.js 22 或更高版本。安装完整 Skill 包，核对来源及版本后执行：

```text
node <absolute-skill-directory>/runtime/launch.cjs --verify
```

校验通过后，把同一个 `runtime/launch.cjs` 入口配置为宿主的 stdio Server。随包 JavaScript bundle 已包含运行依赖，正常使用不需要下载源码、安装依赖或构建 MCP。不想修改宿主配置时，可改用 `node <absolute-skill-directory>/runtime/launch.cjs --run` 批处理模式，从 stdin 传入 JSON 工具调用数组。来源证明、完整性边界、批处理格式和升级步骤见 [随包接入说明](../skill/electron-debug/references/mcp-setup.md)。

独立源码构建仅供贡献者开发，见 [开发说明](../CONTRIBUTING.md)；不是已安装 Skill 的接入或自动恢复路径。

## Skill 的安装范围

完整 Skill 目录可以按 Agent 宿主支持的方式全局安装，也可以只放在某个项目中使用。两种方式均包含随包 MCP，但不会自动配置或启动 Server。

全局安装适合希望所有 Electron 项目都遵守同一套诊断流程的场景。使用者将 `skill/electron-debug` 完整目录复制或链接到当前 Agent 宿主的全局 Skill 目录，再按宿主要求启用或刷新 Skill。全局目录、命名方式和刷新入口由宿主决定，本项目不假设固定路径。

项目级安装适合只希望单个项目启用，或需要随项目固定 Skill 版本的场景。使用者将完整 Skill 目录放入项目采用的 Skill 目录，并按宿主规则加载入口 `SKILL.md`，或在项目级 `AGENTS.md`、instructions 或等效规则中引用入口。Agent 进入该项目时应主动加载它。

如果全局 Skill 和项目级 Skill 同时存在，应优先遵守项目级规则，并保留本 Skill 的 MCP 前提、端点安全和证据要求。项目级副本可以随项目提交，从而避免全局 Skill 更新后改变已有项目的诊断行为。

当前仓库没有跨宿主的 Skill 安装器或自动注册机制。安装完成后，Agent 仍必须单独配置 MCP，并通过 `initialize`、`tools/list` 或宿主等价界面确认 8 个工具可见（attach、status、targets、logs、evaluate、wait_for、screenshot、dom_snapshot）。

## Agent 宿主接入

宿主需要支持本地 MCP stdio Server。通用配置形式如下，路径必须替换为当前 Skill 的实际安装绝对路径：

```json
{
  "mcpServers": {
    "electron-agent-debug": {
      "command": "node",
      "args": [
        "<absolute-skill-directory>/runtime/launch.cjs"
      ]
    }
  }
}
```

具体配置文件名、字段名和入口由 Agent 宿主决定。任何支持本地 stdio MCP 的宿主在协议层都可以按这个契约接入；本项目不依赖某个宿主的专用 API。上面的 JSON 只是配置概念示意，不能直接假设适用于所有宿主，也不代表每个宿主都已经完成专门的端到端验证。

Agent 必须自行完成以下接入步骤：

1. 查找当前 Agent 宿主的 MCP 配置入口。
2. 检查 `electron-agent-debug` 是否已经配置并可用。
3. 如果未配置，先核对包来源和完整性，再使用当前 Skill 安装目录的实际绝对路径配置 `node <absolute-skill-directory>/runtime/launch.cjs`。
4. 启动或刷新 MCP 配置。
5. 验证 MCP 初始化成功，并确认工具可见。
6. 再按下方前提准备 Electron 应用和动态 endpoint。

Skill 文件随仓库提供不代表宿主已经自动注册 MCP。Agent 宿主配置文件、项目路径和刷新方式不能假设为固定值；如果 Agent 无法完成配置或初始化，应报告 `BLOCKED`。

MCP 接入和 Skill 加载是两个步骤：

1. 宿主启动 `electron-agent-debug` MCP Server。
2. Agent 读取 [Electron Debug Skill](../skill/electron-debug/SKILL.md)，或者由项目级 instructions、`AGENTS.md` 或等效规则加载它。

如果宿主能调用 MCP 但没有加载 Skill，Agent 仍需要主动遵守本文件规定的前提检查、诊断顺序和 `PASS`、`FAIL`、`BLOCKED` 规则。

也可以在启动 MCP Server 的环境中提供 endpoint：

```text
ELECTRON_DEBUG_MAIN_URL=<agent-provided-loopback-endpoint>
ELECTRON_DEBUG_CDP_URL=<agent-provided-loopback-endpoint>
```

可选的运行时保护参数如下；不提供时使用项目内置安全上限：

```text
ELECTRON_DEBUG_REQUEST_TIMEOUT_MS=<optional-request-timeout>
ELECTRON_DEBUG_DISCOVERY_TIMEOUT_MS=<optional-discovery-timeout>
ELECTRON_DEBUG_MAX_LOG_EVENTS=<optional-event-limit>
ELECTRON_DEBUG_MAX_LOG_BYTES=<optional-byte-limit>
ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES=<optional-protocol-message-limit>
ELECTRON_DEBUG_OUTPUT_DIR=<optional-screenshot-directory>
ELECTRON_DEBUG_ALLOW_EVAL=<optional, 0 or false to disable evaluation>
```

`ELECTRON_DEBUG_OUTPUT_DIR` 指定截图目录，默认系统临时目录下的 `electron-agent-debug`，只保留最近 50 张。`electron_evaluate` 和 expression 型 `electron_wait_for` 默认开启（只连接回环地址）；宿主可在 MCP 配置的 `env` 中设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 禁用，此时返回 `EVALUATION_NOT_ALLOWED`。单条协议消息上限默认 256 MiB（与 Puppeteer、Playwright 一致，Chromium 的 DevTools 服务端接收缓冲为 100 MiB、发送缓冲为 256 MiB），可用 `ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES` 调小。

如果没有通过环境变量配置，Agent 可以在调用 `electron_attach` 时直接传入本次诊断使用的 endpoint。项目不提供默认端口，也不会扫描端口。

## Agent 前提

在调用 `electron_attach` 前，Agent 需要自行确认：

- 当前 Electron 项目工作目录。
- 启动应用的已有命令，并加上 `--inspect`、`--remote-debugging-port`（端口自选）。
- 启动后，主进程 Inspector 和/或 renderer CDP 的实际 loopback endpoint。
- 本次代码修改的预期行为。
- 项目已有的测试、检查命令或回归操作。
- 多窗口场景下的 target 选择条件。

如果这些前提缺失，Agent 应报告 `BLOCKED` 或先补齐前提。MCP Server 不猜测项目入口、不扫描端口，只执行 Agent 明确给出的启动命令，也不替 Agent 执行业务回归。

## 诊断范围

按修改范围选择最小必要通道：

- 主进程、窗口生命周期和启动问题：主进程 endpoint。
- 页面加载、renderer 异常和页面行为：renderer endpoint。
- preload、contextBridge 和 IPC：两个 endpoint。
- 纯类型、构建和静态检查：先运行项目已有检查，只有需要运行时证据时才 attach。

## 诊断顺序

Agent 完成编码后，按 [Electron Debug Skill](../skill/electron-debug/SKILL.md) 选择诊断范围：

1. 写明预期行为和可观察的回归操作。
2. 使用项目已有命令启动 Electron，再用实际 endpoint 调用 `electron_attach`。
3. 调用 `electron_status`、`electron_targets` 和 `electron_logs` 收集基线证据。`electron_logs` 的 `lastSeq` 配合 `afterSeq` 可只读取之后的事件。
4. 按需用 `electron_wait_for`（log、expression）等待条件，用 `electron_evaluate`、`electron_dom_snapshot`、`electron_screenshot` 取得运行时证据。会弹出原生对话框的步骤，提示用户人工操作后再继续。
5. 使用项目已有测试或回归步骤验证修改。
6. 主进程或 preload 修改后用项目已有方式重启；renderer 修改后优先 reload。
7. 自行重启或窗口重建后重新 attach；旧 target 失效时使用 `clearSelection=true` 重新选择。
8. 再次读取状态、target 和日志；应用退出的退出码和输出由 Agent 启动应用时自行捕获。
9. Agent 根据用户目标、项目回归结果和 MCP 观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`。

工具调用成功只说明 MCP 返回了结果，不说明业务修改已经正确。截图要求窗口可见：被隐藏或最小化的窗口会使 `Page.captureScreenshot` 超时，此时 `electron_dom_snapshot` 仍可用。原生对话框和菜单由用户人工操作。MCP 不提供业务自动化和断点调试。

## 结论判断

- `PASS`：预期行为已经由项目回归或明确运行时证据证实。
- `FAIL`：预期行为可执行但结果不符合预期，或发现与修改相关的异常。
- `BLOCKED`：缺少应用、endpoint、target、预期行为或必要的回归步骤，无法完成验证。

不能仅凭连接成功、没有 console error 或日志存在输出 `PASS`。对于业务交互、断点和单步调试，使用项目已有测试或其他 Agent 工具补充证据。

## 本地验证

源码仓库中的最小 fixture 安装和运行方式见
[examples/fixture/README.md](../examples/fixture/README.md)。
CI 使用 `examples/fixture/ci-smoke.mjs` 动态分配端口，并依次验证默认态、主进程窗口故障、renderer
故障、IPC 故障和缺少 endpoint 的 `BLOCKED` 场景；fixture 只属于源码仓库的验证内容。
