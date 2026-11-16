# 开发说明

## 环境

- Node.js 20 或更高版本。
- 包完整性测试使用系统 `tar` 命令；仅测试环境需要，MCP 运行不依赖它。
- 根目录依赖用于 MCP Server、测试和 TypeScript 构建。
- `examples/fixture` 是独立的 Electron 示例包，使用自己的 `package.json` 和 lockfile。
- 根目录使用 npm 管理构建、测试和开发依赖；公开交付以 GitHub 仓库、Skill 文件和源码为准。

## 常用命令

在仓库根目录执行：

```powershell
npm install
npm test
npm run lint
npm run build
npm run build:skill
npm run check:skill
```

`npm test` 会先构建 TypeScript 和随包 MCP，再运行契约和单元测试。测试不需要启动真实 Electron。
`npm run lint` 同时检查实现和测试源码的 TypeScript 类型，不生成测试构建产物。

## 回归测试要求

修复缺陷时，先增加能在旧实现上失败的行为测试，再修改实现。测试优先验证工具契约、状态和资源边界，不能仅断言返回值存在或连接成功。

| 边界 | 自动验证内容 |
| --- | --- |
| 协议输入 | 真实 WebSocket 发送无效 JSON、null、标量、数组、畸形响应和事件；在独立子进程中确认不会崩溃，且不会吞掉后续有效响应 |
| 请求生命周期 | 乱序响应匹配、请求超时后的继续使用、协议命令拒绝、断线后所有待处理请求失败 |
| 会话初始化 | 主进程和 renderer 在 Runtime.enable 时断开、renderer 在 Log.enable 时断开；不得报告 online，另一通道仍保留结果 |
| 可选能力 | 不支持 Log.enable 时记录告警，仍可保留已连接的 Runtime；不能把能力缺失和连接断开混为一谈 |
| 日志 | main、renderer、all 和缺省范围；level、since、limit 组合；按范围清空；无效参数不能清空证据；通过 MCP stdio 验证筛选与清空 |
| 多窗口 | URL/标题重名、可连接与不可连接 target 混合、明确 targetId；歧义不得静默选择第一个窗口 |
| 外部验收构建 | 使用真实编译器、子进程和含空格目录，验证缺少及过期 dist 的构建；不依赖外部项目下载 |
| 字节限制 | 以中文 UTF-8 序列化字节数精确触发淘汰，验证保留顺序和 clear 后的计数；超大和循环 data 不破坏已有证据 |
| Discovery | 双通道的头/体停滞、流中断、JSON/列表/target 错误、404/503、远程 WS、空列表和大小限制；错误响应取消未完成响应体 |
| 连接与退出 | 建连握手停滞、对端不响应 close frame 时实际释放 TCP；stdin EOF 后独立 MCP 进程自然退出且两条连接均关闭；非 Windows 另测 SIGTERM |
| 并发队列 | 显式 gate 阻塞 discovery，交错 attach/targets/close；断言排队期间没有提前 discovery、完成顺序和最终 target；失败操作后已排队任务仍执行 |
| IPC 证据断言 | 正反用例要求主进程 handler 和 renderer 调用侧各自出现预期证据；只有单侧、通道标错、两侧交换都失败 |
| Skill 包 | 创建并解压真实 tar 到隔离的项目/全局目录，禁止联网及加载包外模块，验证完整 MCP 初始化和工具调用；检查引用，检测篡改、缺文件和越界 manifest |
| MCP 端到端 | `tests/mcp-lifecycle.test.ts` 启动测试替身应用，经 stdio 走完 attach、evaluate、logs，并验证设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 时被拒绝 |
| 检查能力 | `tests/inspection.test.ts` 用 `tests/helpers/fake-electron-app.cjs` 测试 evaluate 的门控（`ELECTRON_DEBUG_ALLOW_EVAL=0` 时拒绝）、截断、脱敏、超时、Promise 与顶层 await；wait_for 的 log/expression 与 `WAIT_TIMEOUT`；截图写入私有目录；无障碍树渲染及节点上限 |
| 统一时间线 | main/renderer 事件共享递增 `seq`，`afterSeq` 与 `lastSeq` 可续读 |

这些测试通过只证明所覆盖的契约。外部 Electron 项目的业务操作、视觉结果和真实 Agent 宿主接入仍需分别验证，不能用测试数量或一次 CI 成功代替。

## Electron fixture

fixture 的安装和运行说明位于 [`examples/fixture/README.md`](examples/fixture/README.md)。主进程 Inspector 和 renderer CDP 的端口由运行 Agent 或测试脚本分配，仓库不固定端口，也不提交 `node_modules`、构建产物或 Electron 下载缓存。

```text
npm ci --prefix examples/fixture
node examples/fixture/package-smoke.mjs
```

Linux 无显示环境时使用 `FIXTURE_ELECTRON_NO_SANDBOX=true xvfb-run -a node examples/fixture/package-smoke.mjs`。该命令把完整 Skill 复制到系统临时目录，真实 Electron 的全部 smoke 都使用隔离安装包中的 MCP，避免仅测试源码构建而漏掉发布打包问题。

完整 smoke 包括默认、主进程失败、renderer 失败、IPC 失败、缺少 endpoint，以及真实 renderer reload、BrowserWindow 重建、Electron 正常退出后以新端口重启。生命周期测试始终使用同一个 MCP 进程，检查旧 target 清理、新 target 选择和新一轮双通道证据；清空日志后还会检查旧运行标记未混入新结果。

fixture 的父子进程 IPC 仅供测试驱动 reload、重建和退出，未添加到 MCP。生产 Server 另外提供 evaluate、wait_for、截图、DOM 快照工具；这些由 `tests/` 中的替身应用覆盖，真实 Electron 的截图要求窗口可见（隐藏或最小化的窗口会让 `Page.captureScreenshot` 超时）。

## CI

GitHub Actions 执行以下矩阵，每个组合均运行根目录测试、类型检查、脚本语法检查和完整真实 Electron smoke：

| 系统 | Node.js |
| --- | --- |
| Ubuntu | 22、24 |
| Windows | 22、24 |
| macOS | 22 |

Linux smoke 使用 `xvfb` 提供虚拟显示。Electron 使用 fixture lockfile 中的版本；本矩阵不代表所有历史 Electron 版本或未来 Node.js 版本均已实测。

## 真实 Agent 宿主

宿主 smoke 是显式运行的集成测试，需要本机已经安装并认证的 CLI、构建后的 MCP 和 fixture 依赖，可能消耗宿主模型额度；普通 `npm test` 和 CI 不调用模型。

```text
node examples/host-e2e/smoke.mjs codex <absolute-codex-executable>
node examples/host-e2e/smoke.mjs claude <absolute-claude-executable>
```

脚本在临时目录配置本次 MCP，显式提供当前 Skill 内容，启动真实 IPC 故障 fixture，再让宿主调用 attach、status、targets、logs 诊断工具。以透明 stdio trace 中的实际请求、响应和双侧 IPC 证据断言结果，不接受模型口头声称成功。测试使用命令行临时 MCP 配置和工具授权，不修改用户保存的宿主配置。成功后删除临时产物，失败则保留本机 trace 供定位；不要提交宿主日志。

本轮还在隔离副本中分别移除日志字节淘汰和将 IPC 的全量匹配弱化为任一匹配，确认新增测试均会失败。此操作用于验证断言敏感性，不修改工作区实现。

## 提交边界

一次提交应保持一个清晰目的。核心实现、测试、文档和 fixture 可以在同一次功能提交中一起提交，因为它们共同构成可验证的诊断能力；本地产物、日志、依赖安装目录和临时输出不应进入 Git。

## Skill 发布构建

`skill/electron-debug/runtime` 是受控的分发产物，作为上述产物规则的明确例外随仓库提交，使 GitHub Skill 安装也能直接运行。修改源码、锁文件或构建脚本后运行 `npm run build:skill`，提交生成文件；CI 在重建前运行 `npm run check:skill` 拒绝过期产物。构建器固定 esbuild 开发依赖版本，嵌入 MCP 版本，仅允许 Node 内置模块外置，收集实际打入 bundle 的第三方许可证，不交付原生扩展。

运行时启动器使用 Node 内置模块检查 manifest 和文件 SHA-256，随后加载 bundle。自带哈希用于检测文件不一致，不能独立认证来源。构建输入摘要绑定源码、构建脚本、package.json 和锁文件，生成内容不含本机路径或生成时间。

发布前更新 Skill 根目录 `VERSION.md`、重建运行文件并完成隔离包及真实 fixture 验证。GitHub Release tag 使用 `skill-v<Skill版本>`；发布事件触发 `.github/workflows/release.yml`，检查 tag 与 manifest 一致，在锁定依赖下重建验证，生成可重复 ZIP，并使用 GitHub OIDC 生成构建来源 attestation。工作流验证预期仓库和自身身份后上传 ZIP、SHA256SUMS 和 Sigstore bundle；不会静默覆盖已有附件。

Release 打包使用 Python 标准库，不是 MCP 运行依赖。第三方安装渠道的 CLI 可能加入自己的元数据文件，其 ZIP 与 GitHub Release ZIP 是不同产物，必须分别核验；不能拿一个 ZIP 的来源证明认证另一个 ZIP，也不能把平台“上传成功”当作“安全扫描通过”。
