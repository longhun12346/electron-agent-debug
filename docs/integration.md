# 接入说明

本项目通过 stdio 暴露 MCP Server。它只连接 Agent 或测试脚本已经准备好的 Electron 调试 endpoint，不负责启动应用，也不负责分配端口。

## 构建和启动

在仓库根目录执行：

```powershell
npm ci
npm run build
node dist/index.js
```

MCP 客户端需要把 `node dist/index.js` 作为 stdio server 启动。不同 Agent 或 MCP 客户端的配置格式可能不同，配置时使用实际仓库路径。

也可以在启动 MCP Server 的环境中提供 endpoint：

```text
ELECTRON_DEBUG_MAIN_URL=<agent-provided-loopback-endpoint>
ELECTRON_DEBUG_CDP_URL=<agent-provided-loopback-endpoint>
```

如果没有通过环境变量配置，Agent 可以在调用 `electron_attach` 时直接传入本次诊断使用的 endpoint。项目不提供默认端口，也不会扫描端口。

## Agent 前提

在调用 `electron_attach` 前，Agent 需要自行确认：

- 当前 Electron 项目工作目录。
- 启动、停止或重启应用的已有命令。
- 主进程 Inspector 和/或 renderer CDP 的实际 loopback endpoint。
- 本次代码修改的预期行为。
- 项目已有的测试、检查命令或回归操作。
- 多窗口场景下的 target 选择条件。

如果这些前提缺失，Agent 应报告 `BLOCKED` 或先补齐前提。MCP Server 不猜测项目入口、不启动 Electron，也不替 Agent 执行业务回归。

## 诊断顺序

Agent 完成编码后，按 [Electron Debug Skill](../skill/electron-debug/SKILL.md) 选择诊断范围：

1. 根据修改范围决定使用主进程、renderer 或双通道。
2. 调用 `electron_attach`。
3. 调用 `electron_status` 和 `electron_logs` 收集初始证据。
4. 必要时调用 `electron_targets` 选择窗口。
5. 使用项目已有命令重启 Electron 或 reload 当前 target。
6. 重新读取状态和日志。
7. Agent 根据用户目标、回归结果和 MCP 观察结果自行输出 `PASS`、`FAIL` 或 `BLOCKED`。

工具调用成功只说明 MCP 返回了结果，不说明业务修改已经正确。

## 本地验证

最小 fixture 的安装和运行方式见 [examples/fixture/README.md](../examples/fixture/README.md)。CI 使用 `examples/fixture/ci-smoke.mjs` 动态分配端口，并依次验证默认态、主进程窗口故障、renderer 故障和 IPC 故障。
