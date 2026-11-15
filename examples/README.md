# Electron fixture

这里放置用于验证 MCP 诊断能力和 Skill 指引的最小 Electron fixture。

具体安装、运行和故障场景说明见 [`fixture/README.md`](fixture/README.md)。

第一阶段至少包含三类可重复场景：

1. 主进程窗口创建失败。
2. 渲染进程白屏或运行时异常。
3. preload/IPC API 不存在或调用失败。

每个场景都需要提供：

- 一个可以故意引入的缺陷。
- 一个明确的运行时预期和回归操作。
- 一个修复后的运行时观察结果。
- 一个缺陷状态下的运行时观察结果。
- 应用未启动或端点不可用时的结构化连接错误。

应用必须由测试脚本启动，并开放主进程 Inspector 和渲染进程 CDP。MCP Server 本身不负责启动或停止 fixture。

fixture 的核心验收依赖 attach、status、targets 和 logs 收集运行时事实，再由测试脚本或 Agent 根据预期行为判断故障态和修复态。DOM、截图、业务交互和断点不属于当前 MCP fixture 的核心范围。

`fixture/` 提供最小 Electron 应用。启动时由 Agent 或测试脚本自行注入 Inspector/CDP 参数。

## 外部项目验收

真实的 `electron-vite/electron-vite-react` 双通道验收脚本见 [external-e2e](external-e2e/README.md)。它是 opt-in 测试，不属于默认测试，也不会把外部项目依赖加入当前 MCP Server。

可通过 `FIXTURE_FAULT=main-window`、`FIXTURE_FAULT=renderer` 或 `FIXTURE_FAULT=ipc` 选择故障态。故障开关只属于 fixture 验证，不是 MCP Server 的配置。

`fixture/smoke.mjs` 可用于启动并等待两个 discovery endpoint；`fixture/mcp-smoke.mjs` 会继续启动本项目 MCP Server，执行 attach、status 和 logs。运行前必须由 Agent 或测试脚本设置 `FIXTURE_MAIN_PORT` 和 `FIXTURE_RENDERER_PORT`。
