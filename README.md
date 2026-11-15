# electron-agent-debug

一个面向编码 Agent 的轻量 Electron 双通道诊断能力和使用指南。

项目只提供两类内容：

1. 通过 MCP 提供连接主进程 Node Inspector 和渲染进程 Chromium DevTools Protocol 的诊断能力。
2. 通过 Skill 指导 Agent 根据修改范围选择通道、收集证据和进行验证。

项目不替 Agent 判断业务是否正确，也不由 MCP Server 启动、停止或验收用户的 Electron 应用。Agent 可以使用项目已有命令准备和重启应用。

项目由两部分组成：

1. 通过 stdio 暴露给 Agent 的轻量 MCP Server。
2. 一个项目级 Electron Debug Skill，规定编码后的诊断顺序、工具选择和证据要求。

GitHub 仓库是 Skill、MCP Server 源码和文档的权威分发来源。Agent 需要自行从当前仓库加载 Skill，并把构建后的 MCP Server 配置到当前宿主；仓库内容不会自动修改宿主配置。

Skill 可以全局安装供多个 Electron 项目使用，也可以作为项目级规则随单个项目使用。全局目录、项目级目录和加载方式由 Agent 宿主决定；两种安装方式都不会自动注册 MCP。

## 安装 Skill

使用支持 Agent Skills 的宿主时，可以从 GitHub 直接安装项目级 Skill：

```powershell
npx skills add longhun12346/electron-agent-debug --skill electron-debug
```

希望在多个项目中复用时，可以安装到全局 Skill 目录：

```powershell
npx skills add longhun12346/electron-agent-debug --skill electron-debug --global
```

Skill 安装只负责让 Agent 能加载诊断流程，不会自动配置或启动 MCP Server。MCP 配置、Electron 应用启动和 endpoint 准备仍由 Agent 根据当前宿主和项目完成。

核心 MCP 工具只有四个：`electron_attach`、`electron_status`、`electron_targets` 和 `electron_logs`。当前版本不提供截图、表达式执行、DOM 操作或断点调试；这些能力由 Agent 使用项目已有测试或其他工具完成。

## 适用场景

Agent 需要先准备或确认 Electron 应用已经通过项目已有命令启动，并把实际的 Inspector/CDP endpoint 提供给 MCP Server。端口由项目和 Agent 决定，示意为：

```powershell
electron --inspect=<main-inspector-port> --remote-debugging-port=<renderer-cdp-port> .
```

Agent 可以使用本项目完成：

- 主进程启动失败、窗口创建和运行时异常验证。
- preload、contextBridge 和 IPC 联调。
- 页面白屏、前端异常、target URL 和运行时日志验证。
- 主进程和渲染进程日志收集。
- 当前窗口 target 选择和重新发现。
- 修复后的 reload、连接恢复和状态检查。
- 为 Agent 判断 `PASS`、`FAIL` 或 `BLOCKED` 提供结构化运行时证据。

## 设计边界

- 只连接 Agent 已准备或确认运行的本地 Electron 应用。
- 默认只允许 `127.0.0.1`、`::1` 或 `localhost`。
- 不负责启动、停止、打包或发布 Electron 应用。
- 不提供通用桌面自动化、完整网络录制、性能分析、heap snapshot 或 HAR 导出。
- 不以替代 VS Code 源码级断点和单步调试为目标。
- 不提供截图、表达式执行、DOM 操作、业务自动化或源码级断点调试。

## Agent 使用诊断流程

当 Agent 需要验证 Electron 修改时，Skill 指导它执行以下流程；项目不监听文件保存，也不自动启动验证：

1. Agent 配置并验证 MCP Server，加载本项目 Skill。
2. 根据修改文件和用户问题判断主进程、渲染进程或双进程范围。
3. 调用 `electron_attach`，确认本次诊断所需的调试通道；未提供的通道保持未配置。
4. 调用 `electron_status`、`electron_targets` 和 `electron_logs` 建立修改前后的运行时证据。
5. 使用项目已有测试或其他 Agent 工具完成 DOM、业务操作和视觉验证。
6. 根据修改范围执行 Electron 重启或当前 target reload。
7. 重新读取状态、target 和日志；视觉、DOM 和业务交互由项目已有测试或其他 Agent 工具补充。
8. 由 Agent 结合用户目标、项目回归结果和 MCP 返回的观察结果完成自己的判断和报告。

## 项目文档

- [需求说明](docs/requirements.md)
- [架构设计](docs/architecture.md)
- [实施方案与调研结论](docs/plan.md)
- [社区方案对比](docs/community-comparison.md)
- [接入说明](docs/integration.md)
- [Agent 调试 Skill](skill/electron-debug/SKILL.md)
- [开发说明](CONTRIBUTING.md)

## 本地开发

```powershell
npm install
npm test
npm run lint
```

真实 Electron fixture 的安装、动态端口和故障场景见 [examples/fixture/README.md](examples/fixture/README.md)。

## 开发状态

当前阶段：核心 MCP Server、双 Session、契约测试、本地协议模拟测试、最小 Electron fixture、Agent 调试 Skill 和外部 Electron 项目 opt-in E2E harness 已实现；项目保持 attach-only 轻量边界。
