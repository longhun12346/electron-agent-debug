# Electron 诊断 fixture

这个 fixture 用于验证 attach-only MCP 诊断适配层的最小真实链路。它不会替 MCP Server 管理应用生命周期；启动、停止和端口分配由 Agent 或测试脚本负责。

## 安装

```powershell
cd examples/fixture
npm install
```

fixture 使用独立的 `package.json` 和 `package-lock.json`，不会把 Electron 运行时依赖加入根 MCP Server。

## 运行 smoke

先为主进程 Inspector 和 renderer CDP 分配两个可用的本地端口，再设置：

- `FIXTURE_MAIN_PORT`
- `FIXTURE_RENDERER_PORT`

端口没有默认值，也不要求使用固定端口。设置好环境变量后，在 fixture 目录运行：

```powershell
node smoke.mjs
```

要验证 MCP 的真实 stdio 链路，先在仓库根目录执行 `npm run build`，然后运行：

```powershell
node mcp-smoke.mjs
```

脚本会自行启动 fixture 和 MCP Server，并输出 attach、status 和 logs 的结果。MCP Server 只连接脚本提供的 endpoint，不负责猜测入口或扫描端口。

要一次验证默认态、主进程窗口故障、renderer 故障、IPC 故障和缺少 endpoint 的 `BLOCKED` 场景，可以运行：

```powershell
node ci-smoke.mjs
```

这个脚本负责动态分配端口，并把端口通过环境变量传给 smoke 流程；它不会把任何端口写入项目配置。

## 故障场景

通过 `FIXTURE_FAULT` 选择可重复的故障：

- `main-window`：主进程窗口创建失败。
- `renderer`：renderer 报告运行时异常。
- `ipc`：IPC handler 调用失败。
- `blocked-smoke.mjs`：没有提供 endpoint 时返回结构化前提错误，由 Agent 判断为 `BLOCKED`。

例如在 PowerShell 中：

```powershell
$env:FIXTURE_FAULT = "renderer"
node mcp-smoke.mjs
```

故障开关只属于 fixture 验证。Agent 仍需根据用户目标、项目回归步骤和 MCP 返回的运行时事实自行判断 `PASS`、`FAIL` 或 `BLOCKED`。
