# 开发说明

## 环境

- Node.js 20 或更高版本。
- 包完整性测试使用系统 `tar` 命令（bsdtar 和 GNU tar 均可，包括 Windows 上 Git Bash 自带的 GNU tar）；仅测试环境需要，MCP 运行不依赖它。
- 根目录依赖用于 MCP Server、测试和 TypeScript 构建。
- `examples/vue-vite-app` 是独立的 Electron 示例包（electron-vite、Vue 3），使用自己的 `package.json` 和 lockfile，要求 Node.js 20.19 或更高（electron-vite 6 的要求）。
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
| 检查能力 | `tests/inspection.test.ts` 用 `tests/helpers/fake-electron-app.cjs` 测试 evaluate 的门控（`ELECTRON_DEBUG_ALLOW_EVAL=0` 时拒绝）、截断、超时、Promise 与顶层 await；wait_for 的 log/expression 与 `WAIT_TIMEOUT`；截图写入私有目录；无障碍树渲染及节点上限 |
| 统一时间线 | main/renderer/utility 事件共享递增 `seq`，`afterSeq` 与 `lastSeq` 可续读；缓冲区淘汰或拒收事件后 `droppedThroughSeq` 与 `gap` 如实报告，`clear` 重置；`sinceAttach` 按通道只返回最近一次连接之后的事件，连接事件被淘汰后边界仍然保留 |
| 答非所问的调用 | `tests/answers.test.ts`：`clear` 只删除返回的事件；`warn` 和 `warning` 读到同一批事件；每个工具拒绝不认识的参数；很长的 title、url 不会让结果跟着变长；事件带应用产生它的时间；崩溃的页面说明怎么恢复；通道没连上的表达式等待立即返回；应用内脚本不用动态 `import()` |
| 平台描述 | `tests/platform-description.test.ts` 核对 `docs/platform-description.md` 的简要描述长度、工具数量和 Node.js 版本与代码一致 |
| 真实应用 | `examples/vue-vite-app` 是 electron-vite、Vue 3、Pinia、Vue Router 的任务板（主进程里还有一个搜索索引的 utility process），`smoke.mjs` 在真实 Electron 上逐项断言：开发服务器下热更新不重载页面、改主进程后 Electron 重启并用同一组端口重新 attach、构建产物从 `file:` 加载、ES module 构建的主进程里仍能取到 Electron 的 API；换名的 IPC 通道、没人监听的消息、字段缺失、数据文件损坏、窗口创建失败、preload 找不到六类故障；attach utility process；两个窗口加 DevTools 时按标题选窗口、重放的噪声被 `sinceAttach` 排除并如实报告 `gap`、快照截断；页面崩溃后 `TARGET_CRASHED` 并在 reload 后恢复、硬退出的退出码；reload、窗口重建、整个应用以新端口重启而 MCP 进程不变；evaluate、wait_for、截图、日志渲染、IPC（含二进制参数按长度计）与对话框追踪；可信的点击和输入。单元测试用假端口，只证明逻辑；新增一类真实问题时，先在这个应用里加上能复现它的形态 |
| evaluate 重试 | 只在代码没有开始执行时换模式重试：编译期 `SyntaxError`（无 `stackTrace`）和 `await` 前只有空白的 `await (…)`；运行期抛出的 `SyntaxError` 不重试。假端口按真实 V8 的 `stackTrace` 有无区分，真实冒烟逐项复核 |

这些测试通过只证明所覆盖的契约。外部 Electron 项目的业务操作、视觉结果和真实 Agent 宿主接入仍需分别验证，不能用测试数量或一次 CI 成功代替。

## 真实 Electron 示例

[`examples/vue-vite-app`](examples/vue-vite-app/README.md) 是 electron-vite、Vue 3、Pinia、Vue Router 的任务板，数据经 IPC 存在 JSON 文件里，主进程另有一个做搜索索引的 utility process。所有真实 Electron 验证都在这里：主进程 Inspector 和 renderer CDP 的端口由测试脚本动态分配，仓库不固定端口，也不提交 `node_modules`、构建产物或 Electron 下载缓存。

```text
npm ci --prefix examples/vue-vite-app
node examples/vue-vite-app/package-smoke.mjs
```

`package-smoke.mjs` 把完整 Skill 复制到系统临时目录（目录名带空格），全部场景都使用隔离安装包中的 MCP，避免仅测试源码构建而漏掉发布打包问题。只跑几个场景、直接用源码构建的 MCP：`node examples/vue-vite-app/smoke.mjs <场景…>`。Linux 无显示环境时在前面加 `TEST_ELECTRON_NO_SANDBOX=true xvfb-run -a`。

应用里的故障和启动开关只属于测试，不是 MCP Server 的配置，也不会出现在 Skill 的指引里。生产 Server 提供 evaluate、wait_for、截图、DOM 快照、click、type 工具；边界情况由 `tests/` 中的替身应用覆盖，替身对 Chromium 行为的模拟必须以真实 smoke 观察到的行为为准。真实 Electron 的截图要求窗口可见（隐藏或最小化的窗口会让 `Page.captureScreenshot` 超时）。

## CI

GitHub Actions 执行以下矩阵，每个组合均运行根目录测试、类型检查、脚本语法检查和完整真实 Electron smoke：

| 系统 | Node.js |
| --- | --- |
| Ubuntu | 20、22、24 |
| Windows | 20、22、24 |
| macOS | 20、22 |

Linux smoke 使用 `xvfb` 提供虚拟显示。这些组合使用 Vue 示例 lockfile 中的 Electron 版本。另有 `electron-versions` 任务，在 Ubuntu 和 Windows 上用 Electron 43、44 和最新稳定版各运行一次 utility、inspection、interaction、windows 和 crash-and-exit 场景：utility 通道依赖未公开的 `process._debugProcess`，evaluate 的重试依赖 V8 的报错措辞，这两处最容易随 Electron 主版本变化。矩阵不代表所有历史 Electron 版本或未来 Node.js 版本均已实测。

`npm test` 通过 `scripts/run-tests.mjs` 列出测试文件再交给 `tsx --test`，因为 Windows 的 shell 和 Node 20 都不会展开 `tests/*.test.ts`。`.github/dependabot.yml` 每周检查 GitHub Actions、根目录和 Vue 示例的依赖；根目录依赖会改变随包 bundle，所以这类 PR 需要先运行 `npm run build:skill` 并提交生成文件，`check:skill` 才会通过。

## 真实 Agent 宿主

宿主 smoke 是显式运行的集成测试，需要本机已经安装并认证的 CLI、构建后的 MCP 和 `examples/vue-vite-app` 的依赖，可能消耗宿主模型额度；普通 `npm test` 和 CI 不调用模型。

```text
node examples/host-e2e/smoke.mjs codex <absolute-codex-executable> [--scenario <name|all>]
node examples/host-e2e/smoke.mjs claude <absolute-claude-executable> [--scenario <name|all>]
```

场景定义在 `examples/host-e2e/scenarios.mjs`，默认运行 `ipc`，`--scenario all` 依次运行全部：

| 场景 | 任务 | 断言（只看真实 MCP 流量） |
| --- | --- | --- |
| `ipc` | 数据文件损坏，页面加载时 IPC 失败，两侧都要有证据 | 调用 attach、status、targets、logs；两个通道在线；日志含 main 的 `tasks:list` handler 错误（带 `SyntaxError`）和 renderer 的 `load tasks failed` |
| `renderer` | 缺字段（`missing-field`），添加任务后页面异常，读错误和页面内容 | 按下 Add 之后读到 `TypeError … reading 'name'` 和 `[Vue warn]`；无障碍树里计数器比列出的行多 |
| `main-window` | `window.json` 损坏，窗口没出现，判断责任在哪一侧 | main 在线、renderer 离线；读到主进程的 `Could not create the main window` 日志和原因 |
| `inspect` | 健康应用，逐项取证 | wait_for 条件成立；main 通道求值得到 1 个窗口；无障碍树含种子任务；截图已保存；读到无 error 级别的日志 |
| `utility` | 连接 `task-indexer` utility process 读值 | attach 带 `utility` 且 main 与 utility 同时在线；`scope: utility` 的 `indexer.size()` 为 2 |
| `devtools-windows` | 开发构建：DevTools 加两个窗口，选对窗口再读取 | 工具连到标题为 `Task Board` 的窗口而不是设置窗口；无障碍树读到 `Tasks` 标题；主进程报告 2 个窗口 |
| `click-add` | IPC 通道名不一致（`ipc-channel`），按钮不按就什么都不会发生：自己输入并按下 Add，再读两侧证据 | 用 `electron_click` 按下 Add，按下之后读到 renderer 的 `Error invoking remote method 'tasks:add'` 和主进程的 `Error occurred in handler for 'tasks:add'` |
| `stale-add` | 处理已修好（`stale-add`），但 attach 会重放旧的失败，只有现在按下才知道真相 | 按下 Add 之后读到页面列出 3 个任务，或追踪里 `tasks:add` 成功；重放的旧失败不算 |
| `sync-mismatch` | 按钮什么都不做，没有报错：消息发到了没人监听的 IPC 通道 | 按下 Sync 之后读到该通道没有监听者的 IPC 事件（attach 时要传 `instrument: ["ipc"]`） |

每个场景还带一份脚本化的参考解法。`node examples/host-e2e/reference.mjs [场景名…]` 不调用模型，直接对真实的 Vue 应用回放参考解法并套用同样的断言（CI 里有单独一步），用来保证场景能用现有工具完成、断言接受正确的运行。新增场景时先写参考解法并让它通过，再让真实宿主跑。

脚本在临时目录配置本次 MCP，显式提供当前 Skill 内容，按场景的 `app` 字段启动真实的 Vue 应用，再让宿主执行场景任务。以透明 stdio trace 中的实际请求、响应断言结果，不接受模型口头声称成功。测试使用命令行临时 MCP 配置和工具授权，不修改用户保存的宿主配置。成功后删除临时产物，失败则保留本机 trace 供定位；不要提交宿主日志。

## 提交边界

一次提交应保持一个清晰目的。核心实现、测试、文档和示例应用可以在同一次功能提交中一起提交，因为它们共同构成可验证的诊断能力；本地产物、日志、依赖安装目录和临时输出不应进入 Git。

## Skill 发布构建

`skill/electron-debug/runtime` 是受控的分发产物，作为上述产物规则的明确例外随仓库提交，使 GitHub Skill 安装也能直接运行。修改源码、锁文件或构建脚本后运行 `npm run build:skill`，提交生成文件；CI 在重建前运行 `npm run check:skill` 拒绝过期产物。构建器固定 esbuild 开发依赖版本，嵌入 MCP 版本，仅允许 Node 内置模块外置，收集实际打入 bundle 的第三方许可证，不交付原生扩展。

运行时启动器使用 Node 内置模块检查 manifest 和文件 SHA-256，随后加载 bundle。自带哈希用于检测文件不一致，不能独立认证来源。构建输入摘要绑定源码、构建脚本、package.json 和锁文件，生成内容不含本机路径或生成时间。

发布前更新 Skill 根目录 `VERSION.md`、重建运行文件并完成隔离包及真实示例应用验证。GitHub Release tag 使用 `skill-v<Skill版本>`；发布事件触发 `.github/workflows/release.yml`，检查 tag 与 manifest 一致，在锁定依赖下重建验证，生成可重复 ZIP，并使用 GitHub OIDC 生成构建来源 attestation。工作流验证预期仓库和自身身份后上传 ZIP、SHA256SUMS 和 Sigstore bundle；不会静默覆盖已有附件。

Release 打包使用 Python 标准库，不是 MCP 运行依赖。第三方安装渠道的 CLI 可能加入自己的元数据文件，其 ZIP 与 GitHub Release ZIP 是不同产物，必须分别核验；不能拿一个 ZIP 的来源证明认证另一个 ZIP，也不能把平台“上传成功”当作“安全扫描通过”。

### 发布清单

1. 改 `package.json` 和 `package-lock.json` 的版本（MCP），在 `skill/electron-debug/VERSION.md` 顶部写新的 Skill 版本和变更；新增参数、错误码或行为变化要同步 `SKILL.md`、`docs/requirements.md`、`docs/architecture.md`。
2. 运行 `npm test`（含 `build:skill`）、`npm run lint`、`npm run check:skill`，并提交重新生成的 `runtime/` 文件。
3. 同步 `docs/platform-description.md`：工具数量、支持的系统与 Node.js 版本、新增的能力或限制。`tests/platform-description.test.ts` 核对简要描述长度、工具数量、Node.js 版本，以及文中的环境变量、错误码、参数名和工具名是否存在于源码。这些要人工对照：带条件的能力（如 IPC 追踪、原生对话框、`instrument`）有没有把条件写全；不脱敏、attach 会改动应用、求值和点击会改变状态这几条风险是否仍在“使用须知”里；用词是否与 `SKILL.md` 一致；“功能简介”不超过约 250 字、“不适用场景”不超过 3 条；版本号和来源链接是否是最新的。
4. 推送后等待 CI 全部通过，包括 `electron-versions`。
5. 在发布平台上更新，发布范围保持平台上原有的值；公开发布后等安全扫描结果。简要描述和详细描述用 `node scripts/platform-text.mjs brief`、`node scripts/platform-text.mjs detail` 取出再传给平台的命令行，不要用 Python 的 `print()` 取：Windows 上它往管道写的是系统代码页（GBK），平台会把这些字节当 UTF-8 存下来显示成乱码（1.7.2 发布时发生过）。
6. 发布后把平台返回的记录读回来核对，例如 `oneskill skill-detail --skill-id <id> | node scripts/platform-text.mjs --verify`，退出码非 0 就是平台上的文字和文件不一致。终端里的回显看着正常不能说明平台存下的内容正确。
7. 同一个 Skill 版本号只对应一份包内容。发布后发现要改包里的任何文件（包括只改 `VERSION.md`），就升版本号再发，不要用同一个版本号在不同渠道发出内容不同的包。
