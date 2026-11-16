# electron-agent-debug

一个面向编码 Agent 的 Electron 运行时诊断能力和使用指南。

项目提供两类内容：

1. 通过 MCP 提供观察和检查已运行 Electron 应用的能力：主进程 Node Inspector 与渲染进程 CDP 双通道、统一日志时间线、求值、截图、无障碍树快照和原生对话框替身。
2. 通过 Skill 给出使用建议和证据矩阵。Skill 只是指导，能力由 MCP 提供。

项目不替 Agent 判断业务是否正确；业务回归和最终结论由 Agent 完成。

项目由两部分组成：

1. 通过 stdio 暴露给 Agent 的轻量 MCP Server。
2. 一个项目级 Electron Debug Skill，规定编码后的诊断顺序、工具选择和证据要求。

Skill 发布包包含已构建、带依赖的 MCP JavaScript 运行文件、完整性启动器、版本清单和许可证。正常使用只需要 Node.js 20+，无需下载额外源码、安装依赖或构建 MCP。宿主配置由 Agent 根据实际安装目录完成。

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

应安装完整 Skill 目录，包括 `runtime` 和 `references`。安装不会自动配置或启动 MCP；Agent 核对安装来源后，使用 `node <absolute-skill-directory>/runtime/launch.cjs --verify` 检查完整性，再将同一入口配置到宿主，或不注册 MCP、改用 `launch.cjs --run` 批处理模式（见 [MCP 接入说明](skill/electron-debug/references/mcp-setup.md)）。Electron 应用启动和 endpoint 准备仍由 Agent 根据当前宿主和项目完成。

GitHub Release 的 Skill ZIP 附带构建来源证明，绑定发布工作流及源码提交；第三方安装渠道的安装包以该渠道的发布和扫描结果为准。本地完整性校验不独立证明发布者身份。配置、升级和来源验证边界见 [MCP 接入说明](skill/electron-debug/references/mcp-setup.md)。

## MCP 工具

| 类别 | 工具 |
| --- | --- |
| 连接 | `electron_attach`、`electron_targets` |
| 观察 | `electron_status`、`electron_logs`、`electron_wait_for` |
| 检查 | `electron_evaluate`、`electron_screenshot`、`electron_dom_snapshot` |

MCP 只 attach，不启动应用：Agent 用项目已有命令启动 Electron 并加上 `--inspect`、`--remote-debugging-port`，再用 `electron_attach` 传入实际 endpoint。`electron_evaluate` 和表达式型 `electron_wait_for` 默认开启，宿主可在 MCP 配置的 env 中设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 禁用。截图保存到 `ELECTRON_DEBUG_OUTPUT_DIR`（默认系统临时目录，保留最近 50 张）。

## 适用场景

Agent 启动应用后，用 `electron_attach` 连接并提供实际的 Inspector/CDP endpoint。示意：

```powershell
electron --inspect=<main-inspector-port> --remote-debugging-port=<renderer-cdp-port> .
```

Agent 可以使用本项目完成：

- 主进程启动失败、窗口创建、崩溃和退出原因验证。
- preload、contextBridge 和 IPC 联调。
- 页面白屏、前端异常、target URL 和运行时日志验证。
- 通过截图和无障碍树确认页面实际内容。
- 用原生对话框替身驱动依赖系统对话框的流程。
- 修复后的重启、reload、连接恢复和状态检查。
- 为 Agent 判断 `PASS`、`FAIL` 或 `BLOCKED` 提供结构化运行时证据。

## 设计边界

- 默认只允许 `127.0.0.1`、`::1` 或 `localhost`。
- 不启动、停止或重启应用，只连接 Agent 已启动的应用。
- 输出有大小上限，并对常见密钥字段脱敏。
- 不含任何项目专属逻辑。
- 不提供通用桌面自动化、网络录制、性能分析、heap snapshot 或源码级断点调试。
- 原生菜单不被替身覆盖；窗口隐藏或最小化时无法截图。

## Agent 使用诊断流程

当 Agent 需要验证 Electron 修改时，Skill 建议按以下流程执行；项目不监听文件保存，也不自动启动验证：

1. Agent 配置并验证 MCP Server，加载本项目 Skill。
2. 根据修改文件和用户问题判断主进程、渲染进程或双进程范围。
3. 用项目已有命令启动应用（加 `--inspect`、`--remote-debugging-port`），调用 `electron_attach` 建立诊断通道。
4. 用 `electron_wait_for` 等待就绪信号，用 `electron_status`、`electron_logs` 建立证据。
5. 执行业务回归；需要时用 `electron_evaluate`、`electron_screenshot`、`electron_dom_snapshot` 取证；原生对话框由用户人工操作。
6. 修改后由 Agent 重启应用并重新 attach，或 reload，重新收集证据。
7. 由 Agent 结合用户目标、回归结果和 MCP 返回的观察结果完成判断和报告。

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

当前阶段：核心 MCP Server、双 Session、求值/截图/无障碍树、统一时间线、契约与集成测试（含模拟 Electron 应用）、Agent 调试 Skill 和外部 Electron 项目 opt-in E2E harness 已实现。同一入口还提供不注册 MCP 的批处理模式（`launch.cjs --run`）。
