# electron-agent-debug

> Attach-only runtime diagnostics for Electron apps, as an MCP server plus an [Agent Skill](https://agentskills.io). It reads main, renderer and utility logs, evaluates code, takes screenshots and accessibility snapshots, and clicks and types in the real window. When a native call (koffi, `.node`) misbehaves, the Skill leaves the JS-side evidence, then guides an external debugger (WinDbg/cdb on Windows, gdb or lldb on Linux and macOS) from the JS call into the native function; verified on Windows and Linux, and on macOS only on a GitHub arm64 runner. Node.js 20+, no install step for the runtime.

一个面向编码 Agent 的 Electron 运行时诊断能力和使用指南，特色是能从 JS 调用一路调试到 koffi、`.node` 原生函数。

项目提供两类内容：

1. 通过 MCP 提供观察和检查已运行 Electron 应用的能力：主进程 Node Inspector 与渲染进程 CDP 双通道、统一日志时间线、求值、截图和无障碍树快照，并可按需连接 utility process。
2. 通过 Skill 给出使用建议和证据矩阵。Skill 只是指导，能力由 MCP 提供。

项目不替 Agent 判断业务是否正确；业务回归和最终结论由 Agent 完成。

**原生模块调试**：Electron 项目用 koffi 或 `.node` 插件调用原生代码、结果不对时，Skill 指引 Agent 先留下 JS 侧证据，再经你同意接上外部调试器（Windows 用 mcp-windbg 驱动 cdb，Linux、macOS 用 gdb 或 lldb 命令行），在原生函数上下断点，看参数和变量，对照源码定位问题，改完重新编译部署再验证；应用启动时就执行的原生调用也有对应做法。在 Windows 和 Linux 上验证过，macOS 只在 GitHub 的 arm64 runner 上试过；完整例子见下面的“示例”一节。

项目由两部分组成：

1. 通过 stdio 暴露给 Agent 的轻量 MCP Server。
2. 一个项目级 Electron Debug Skill，规定编码后的诊断顺序、工具选择和证据要求。

Skill 发布包包含已构建、带依赖的 MCP JavaScript 运行文件、完整性启动器、版本清单和许可证。正常使用只需要 Node.js 20+，无需下载额外源码、安装依赖或构建 MCP。宿主配置由 Agent 根据实际安装目录完成，注册前会先征求你的同意。

Skill 可以全局安装供多个 Electron 项目使用，也可以作为项目级规则随单个项目使用。全局目录、项目级目录和加载方式由 Agent 宿主决定；两种安装方式都不会自动注册 MCP（下面的 Claude Code 插件除外）。

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

### 作为 Claude Code 插件安装（含 MCP）

仓库自带一个 Claude Code 插件市场（`.claude-plugin/marketplace.json`），插件会同时装好 Skill 并注册内置的 MCP Server，不用手动配置。需要 Node.js 20+ 在 PATH 里：

```text
/plugin marketplace add longhun12346/electron-agent-debug
/plugin install electron-debug@electron-agent-debug
```

Claude Code 2.1.275 以上也可以一步完成：`/plugin install electron-debug --marketplace longhun12346/electron-agent-debug`。会话里的 `/plugin install` 会先打开详情面板，选好安装范围才装；提示重载时运行 `/reload-plugins`。这条路径只用本地目录验证过，没有从 GitHub 装过。插件里的 Skill 调用名带插件名前缀，在 `/` 菜单里查看。

### 其他编码 Agent（Codex、pi、DeepSeek Harness）

`npx skills add` 对 Claude Code、Codex、pi 会按宿主放进对应目录（它的支持列表里没有 dsh）；手动复制 `skill/electron-debug/`（整个目录，含 `runtime` 和 `references`）时放这里：

| 宿主 | 项目级 | 全局 |
| --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex、pi | `.agents/skills/` | `~/.agents/skills/` |
| DeepSeek Harness（dsh） | `.dsh/skills/` 或 `.agents/skills/` | `~/.dsh/skills/` 或 `~/.agents/skills/` |

MCP 要另外注册，Agent 会先征求你的同意：Codex 用 `codex mcp add electron-agent-debug -- node <Skill 目录>/runtime/launch.cjs`，pi 用 `pi mcp add electron-agent-debug --exposure direct -- node <Skill 目录>/runtime/launch.cjs`（默认的 Codemode 只能在脚本里调用），dsh 的写法见 [MCP 接入说明](skill/electron-debug/references/mcp-setup.md)。新注册的 MCP 要重载或新开会话才可见，在此之前 Agent 用 `launch.cjs --run` 批处理模式（不保留连接和日志）完成本次任务。Codex、pi、dsh 这部分只依据官方文档，没有实测。

### 让宿主稳定用上这个 Skill

宿主只凭 `description` 决定是否调用 Skill，同一句话有时触发、有时不触发（宿主自带的 `run` 等 Skill 也在竞争）。在 Electron 项目的 `CLAUDE.md` 或 `AGENTS.md` 里加一句，它每次都会进入上下文，比依赖描述匹配稳定：

```markdown
改动 Electron 主进程、preload、IPC，或遇到白屏、崩溃、运行时报错时，用 electron-debug Skill 连接正在运行的应用来验证，不要只读代码推断。
```

也可以在 Claude Code 里直接输入 `/electron-debug` 显式调用（作为插件安装时名字带插件名前缀；Codex 用 `$electron-debug`）。

## MCP 工具

| 类别 | 工具 |
| --- | --- |
| 连接 | `electron_attach`、`electron_targets` |
| 观察 | `electron_status`、`electron_logs`、`electron_wait_for` |
| 检查 | `electron_evaluate`、`electron_screenshot`、`electron_dom_snapshot` |
| 交互 | `electron_click`、`electron_type`（按快照里的 `[ref=…]` 发送真实输入） |

MCP 只 attach，不启动应用：Agent 用项目已有命令启动 Electron 并加上 `--inspect`、`--remote-debugging-port`，再用 `electron_attach` 传入实际 endpoint。`electron_evaluate` 和表达式型 `electron_wait_for` 默认开启，宿主可在 MCP 配置的 env 中设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 禁用。截图保存到 `ELECTRON_DEBUG_OUTPUT_DIR`（默认系统临时目录，保留最近 50 张）。

需要调试 utility process 时，给 `electron_attach` 传 `utility`（fork 时的 `serviceName` 或 pid）：工具通过已连接的主进程找到该进程并打开调试口，作为独立的第三通道与主进程、renderer 同时在线。需要主进程通道在线且未禁用求值；默认调试口 9229 被占用时，在 fork 的 `execArgv` 加 `--inspect-port=<空闲端口>`。`process._debugProcess` 是未公开接口；CI 在 Windows、macOS 和 Linux 上用 fixture 锁定的 Electron 版本实测，其他版本以 attach 结果为准。

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
- 依赖原生对话框的流程由用户人工操作，Agent 再用日志或求值核对结果。
- 修复后的重启、reload、连接恢复和状态检查。
- 原生模块（koffi、`.node`）的函数返回值不对时，先留下 JS 侧证据，再指引 Agent 经你同意接上外部调试器（Windows 用 mcp-windbg，Linux、macOS 用 gdb 或 lldb 命令行），从 JS 调用跟到原生函数里。这部分在 Windows 和 Linux 上验证过，macOS 只在 GitHub 的 arm64 runner 上试过，见 [native.md](skill/electron-debug/references/native.md)。
- 为 Agent 判断 `PASS`、`FAIL` 或 `BLOCKED` 提供结构化运行时证据。

## 示例：定位原生函数的错误结果

一个用 koffi 调用的原生函数 `sum_sizes`（递归统计目录大小），应用里得到 30，预期 100。这是一个故意写了常见错误的示例模块，在 Windows 上用下面的流程实际走通：

1. 用 `electron_evaluate`（main）复现：对测试目录求和得到 30。
2. 经用户同意，用 mcp-windbg 附加主进程，在循环里下三处源码行断点。
3. 触发调用后，递归那一行预期命中三次，实际只命中一次，随后停在多写的 `break;` 上：循环在第一个子目录之后提前退出。
4. 删掉 `break;`，先停应用再重新构建（否则链接会报 `LNK1168`），重启后得到 100。

每一步的命令和实测出来的坑见 [native.md](skill/electron-debug/references/native.md)。

## 设计边界

- 默认只允许 `127.0.0.1`、`::1` 或 `localhost`。
- 不启动、停止或重启应用，只连接 Agent 已启动的应用。attach 默认不往应用里装任何东西；传 `electron_attach` 的 `instrument`（`["ipc"]` 记录主进程收到的 IPC，`["dialogs"]` 监测原生对话框）才会在主进程里装记录用的包装，应用重启前不会移除。也可以设 `ELECTRON_DEBUG_ALLOW_EVAL=0` 全关。
- 输出有大小上限，**不做脱敏**：日志、报错、求值结果、页面文本、窗口地址和标题可能带出令牌、密码、cookie 等，会进入模型上下文并留在会话记录里。是否遮挡由 Agent 自己判断；只连接本地开发环境的应用，不要连接带真实生产凭据的应用。
- 不含任何项目专属逻辑。
- 点击和输入只按无障碍树 ref（或 role 和 name）操作当前页面；不提供拖拽、悬停、快捷键等通用桌面自动化，也不提供网络录制、性能分析、heap snapshot 或 JS 源码级断点调试；原生代码的断点调试交给外部调试器，Skill 里有指引。
- 不提供原生对话框或菜单的自动化替身；窗口隐藏或最小化时无法截图。

## Agent 使用诊断流程

当 Agent 需要验证 Electron 修改时，Skill 建议按以下流程执行；项目不监听文件保存，也不自动启动验证：

1. 加载本项目 Skill；`electron_*` 工具可见就直接用，否则先问用户再注册 MCP，注册生效前用批处理模式。
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

真实 Electron 示例（electron-vite、Vue 3 的任务板）的安装、动态端口和故障场景见 [examples/vue-vite-app/README.md](examples/vue-vite-app/README.md)。

## 开发状态

当前阶段：核心 MCP Server、主进程与 renderer 双 Session（可加 utility 第三通道）、求值/截图/无障碍树、统一时间线、契约与集成测试（含模拟 Electron 应用）、Agent 调试 Skill 和外部 Electron 项目 opt-in E2E harness 已实现。同一入口还提供不注册 MCP 的批处理模式（`launch.cjs --run`）。
