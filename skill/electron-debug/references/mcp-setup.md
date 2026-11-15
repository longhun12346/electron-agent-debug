# MCP 接入说明

本文档供 Agent 在加载 `electron-debug` Skill 后配置和验证 `electron-agent-debug` MCP Server。MCP Server 与待诊断的 Electron 项目使用不同的工作目录。

## 前提

Agent 需要先确认：

- 当前 Agent 宿主支持本地 MCP stdio Server。
- `node --version` 输出满足 Node.js `>=22`。
- 当前 Electron 项目已有启动、停止或重启命令。
- 本次诊断需要主进程 Inspector、renderer CDP，或两个 endpoint。
- 项目已有可执行的测试、检查命令或回归步骤。

缺少必要前提时，Agent 应报告 `BLOCKED`，不要把 MCP 接入问题归因于 Electron 业务代码。

## 获取和构建 MCP Server

如果宿主已经配置并能看到四个核心工具，Agent 可以复用现有 MCP Server。否则，Agent 在独立目录获取源仓库并构建：

```text
git clone https://github.com/longhun12346/electron-agent-debug.git <absolute-mcp-repository-path>
cd <absolute-mcp-repository-path>
npm ci
npm run build
```

`<absolute-mcp-repository-path>` 是 MCP 源仓库目录，不能替换为待诊断 Electron 项目目录，也不能指向 Skill 的安装目录。

构建完成后，MCP Server 入口是：

```text
<absolute-mcp-repository-path>/dist/index.js
```

MCP Server 使用本地 stdio 通信，不监听固定端口，也不会启动 Electron 应用。

## 更新已配置的 MCP Server

Skill 包和单独获取的 MCP 源码有各自的更新流程。宿主已经显示四个工具，只能证明接入可用，不能证明运行的是本次修复后的代码。

用户要求升级或同步修复时：

1. 从宿主的实际配置确定 MCP 入口及其源码目录，记录当前源码提交。不要在待诊断 Electron 项目目录执行 MCP 更新。
2. 获取本次任务要求的分支、标签或提交。源码目录有本地修改时，不覆盖或重置这些修改；可以在独立目录获取目标版本，并将宿主入口切换到该目录。
3. 按宿主提供的方式停止旧 MCP Server，在目标源码目录执行 `npm ci`、`npm run build`。源码变化后必须重新构建，不能复用旧 `dist`。
4. 按宿主要求重新启动或刷新 Server，确认配置指向刚构建的入口，记录目标源码提交，并重新验证四个核心工具可见。
5. 继续诊断时，使用本次实际运行的 Electron endpoint 重新 attach，再读取状态、target 和日志。

分支、源码目录、宿主配置入口和 endpoint 由 Agent 根据本次任务确定。普通诊断可以复用现有可用版本，不需要每次自动拉取或升级 MCP。

## 配置宿主

Agent 需要根据当前宿主实际的 MCP 配置入口添加 Server。下面是配置概念示例，不能直接假设适用于所有宿主：

```json
{
  "mcpServers": {
    "electron-agent-debug": {
      "command": "node",
      "args": [
        "<absolute-mcp-repository-path>/dist/index.js"
      ]
    }
  }
}
```

配置要求：

- 使用 MCP 源仓库的实际绝对路径。
- 不写死 Electron 项目的路径、调试端口或 target id。
- 只有确认不存在可用配置时才新增 Server，避免重复注册。
- 按宿主要求刷新或重启 MCP 配置。
- 不把 MCP 配置提交到待诊断 Electron 项目，除非该项目明确要求项目级配置。

如果使用环境变量提供 endpoint，值必须是本次运行实际使用的本地 discovery 地址：

```text
ELECTRON_DEBUG_MAIN_URL=<agent-provided-loopback-endpoint>
ELECTRON_DEBUG_CDP_URL=<agent-provided-loopback-endpoint>
```

可选的运行时保护参数：

```text
ELECTRON_DEBUG_REQUEST_TIMEOUT_MS=<optional-request-timeout>
ELECTRON_DEBUG_DISCOVERY_TIMEOUT_MS=<optional-discovery-timeout>
ELECTRON_DEBUG_MAX_LOG_EVENTS=<optional-event-limit>
ELECTRON_DEBUG_MAX_LOG_BYTES=<optional-byte-limit>
ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES=<optional-protocol-message-limit>
```

端点也可以在调用 `electron_attach` 时直接传入。端口由 Agent 或项目启动脚本动态决定，MCP 不提供默认端口、不扫描端口。

## 验证 MCP 接入

宿主刷新后，Agent 需要确认：

1. MCP Server 初始化成功。
2. `tools/list` 返回以下四个工具：
   - `electron_attach`
   - `electron_status`
   - `electron_targets`
   - `electron_logs`
3. Server 启动失败时，读取 stderr 中的错误。
4. 如果无法完成初始化或工具不可见，报告 `BLOCKED`。

MCP Server 启动成功不代表 Electron 应用已经启动，也不代表 endpoint 可用。

## 准备 Electron endpoint

Agent 使用 Electron 项目已有命令启动应用，并确认实际 endpoint：

- 主进程问题：Node Inspector discovery endpoint。
- renderer 问题：Chromium CDP discovery endpoint。
- preload 或 IPC 问题：两个 endpoint。

端点必须是回环 HTTP(S) discovery URL。MCP 会从 discovery 响应中读取 WebSocket 地址，并再次校验回环地址。

Agent 需要确认：

- Electron 进程仍在运行。
- endpoint 返回当前运行的 target 列表。
- 多窗口场景已经确定要检查的窗口。
- 端口没有被假设为固定值。

## 最小调用顺序

完成 MCP 和 Electron 前提后，按以下顺序收集证据：

1. `electron_attach`
2. `electron_status`
3. 需要 renderer 时调用 `electron_targets`
4. `electron_logs`

项目代码修改后，Agent 根据修改范围使用项目已有方式重启 Electron 或 reload renderer，再次执行 attach 和证据收集。

MCP 只提供连接、状态、target、日志和结构化错误。项目测试、业务回归、DOM、视觉结果和最终 `PASS`、`FAIL`、`BLOCKED` 判断由 Agent 自己完成。

## 不应做的事情

- 不自动启动、停止或重启 Electron。
- 不扫描端口或猜测 endpoint。
- 不执行页面代码、表达式或 DOM 操作。
- 不把 MCP 源仓库目录与 Electron 项目目录混用。
- 不因为 MCP attach 成功就直接输出 `PASS`。
- 不把缺少应用、endpoint、target 或回归步骤误判为用户代码失败。
