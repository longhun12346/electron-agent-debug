# 开发说明

## 环境

- Node.js 22 或更高版本。
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
```

`npm test` 会先构建 TypeScript，再运行契约和单元测试。测试不需要启动真实 Electron。
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
| Skill 包 | 创建并解压真实 tar 到隔离的项目/全局目录，逐字节比较所有文件，检查包内 Markdown 引用；缺文件、越界引用必须被检测 |

这些测试通过只证明所覆盖的契约。外部 Electron 项目的业务操作、视觉结果和真实 Agent 宿主接入仍需分别验证，不能用测试数量或一次 CI 成功代替。

## Electron fixture

fixture 的安装和运行说明位于 [`examples/fixture/README.md`](examples/fixture/README.md)。主进程 Inspector 和 renderer CDP 的端口由运行 Agent 或测试脚本分配，仓库不固定端口，也不提交 `node_modules`、构建产物或 Electron 下载缓存。

```text
npm ci --prefix examples/fixture
node examples/fixture/ci-smoke.mjs
```

Linux 无显示环境时使用 `FIXTURE_ELECTRON_NO_SANDBOX=true xvfb-run -a node examples/fixture/ci-smoke.mjs`。

完整 smoke 包括默认、主进程失败、renderer 失败、IPC 失败、缺少 endpoint，以及真实 renderer reload、BrowserWindow 重建、Electron 正常退出后以新端口重启。生命周期测试始终使用同一个 MCP 进程，检查旧 target 清理、新 target 选择和新一轮双通道证据；清空日志后还会检查旧运行标记未混入新结果。

fixture 的父子进程 IPC 仅供测试驱动 reload、重建和退出，未添加到 MCP；生产 Server 仍只有四个诊断工具。

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

脚本在临时目录配置本次 MCP，显式提供当前 Skill 内容，启动真实 IPC 故障 fixture，再让宿主调用四个诊断工具。以透明 stdio trace 中的实际请求、响应和双侧 IPC 证据断言结果，不接受模型口头声称成功。测试使用命令行临时 MCP 配置和工具授权，不修改用户保存的宿主配置。成功后删除临时产物，失败则保留本机 trace 供定位；不要提交宿主日志。

本轮还在隔离副本中分别移除日志字节淘汰和将 IPC 的全量匹配弱化为任一匹配，确认新增测试均会失败。此操作用于验证断言敏感性，不修改工作区实现。

## 提交边界

一次提交应保持一个清晰目的。核心实现、测试、文档和 fixture 可以在同一次功能提交中一起提交，因为它们共同构成可验证的诊断能力；本地产物、日志、依赖安装目录和临时输出不应进入 Git。
