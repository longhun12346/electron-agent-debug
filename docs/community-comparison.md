# 社区方案对比

调研时间：2026-11-14。

社区项目更新较快，下面的 star、commit 和工具数量只作为当前快照，不作为质量保证。重点比较它们是否适合本项目的目标：双通道、attach-only、编码后验证和轻量实现。

## 1. 主要项目

| 项目 | 调试通道 | 公开范围 | 生命周期 | 对当前目标的适配度 |
|---|---|---|---|---|
| [amafjarkasi/electron-mcp-server](https://github.com/amafjarkasi/electron-mcp-server) | Renderer CDP + 主进程 Node Inspector | README 列出 111 个工具 | 支持 start、attach、stop、discover 和自动化 | 能力最完整，但明显过重 |
| [iamvinitk/electron-mcp](https://github.com/iamvinitk/electron-mcp) | Renderer CDP + 主进程 Node Inspector | 约 20 个工具 | 支持 spawn 和 attach | 架构最接近，但维护和测试信号较弱 |
| [halilural/electron-mcp-server](https://github.com/halilural/electron-mcp-server) | Renderer CDP | 4 个工具 | attach、截图、日志、命令 | 轻量，但缺少主进程通道 |
| [holepunchto/electron-devtools-mcp](https://github.com/holepunchto/electron-devtools-mcp) | Renderer CDP | 继承 Chrome DevTools MCP 工具 | 连接和切换 CDP 实例 | 可作为 renderer 层参考，不能覆盖主进程 |
| [kvenLin/electron-debug](https://github.com/kvenLin/electron-debug) | Renderer CDP + 主进程调试 | HTTP daemon + Skill | 有状态 daemon、目标切换和诊断命令 | Skill 思路有参考价值，但不是 MCP 适配层 |
| [electron-stagewright](https://github.com/electron-stagewright/electron-stagewright) | Electron 自动化和诊断 | 截图、console、对话框、trace 证据 | 偏测试和证据采集 | 可借鉴证据产物设计，不作为底层依赖 |

## 2. 逐项判断

### amafjarkasi/electron-mcp-server

这是目前社区中最完整的参考实现之一。仓库页面显示 102 stars、133 commits，并且 README 将工具矩阵列为 111 个工具，覆盖启动、attach、截图、DOM、网络、性能、heap、断点、主进程、IPC 和安全审计。

它证明了“双通道 + Agent 调试”方向有实际社区需求，但也说明完整调试器会迅速膨胀。当前项目不应直接复制它的工具面，也不应将它作为运行时依赖。

可借鉴：

- 双通道 Session 模型。
- 主进程和 renderer 分开的工具语义。
- attach 和 start 的生命周期区分。
- 输出根目录和允许路径限制。

不采用：

- 111 工具的公开接口。
- 应用启动、停止、进程扫描。
- 网络、性能、heap、断点和 UI 自动化。

### iamvinitk/electron-mcp

这是架构上最接近当前项目的社区方案：同时使用 renderer CDP 和 Node Inspector，支持 spawn 或 attach，并使用按 Session 缓存的连接。

但仓库页面当前显示只有 1 commit、1 star，README 明确写着没有单元测试，验证主要依赖运行中的 Electron 应用。因此它适合作为协议和 Session 设计参考，不适合作为直接依赖或生产基础。

可借鉴：

- 两个调试通道的连接方式。
- 主进程和 renderer 的 Session 分离。
- ring buffer 日志。
- target 连接缓存。

需要重新设计：

- attach-only 生命周期。
- 回环地址和 WebSocket 地址二次校验。
- 更小的工具集。
- fixture 和自动化验收。
- evaluate 安全边界。

### halilural/electron-mcp-server

这是比较接近轻量路线的实现，README 只列出 4 个工具：窗口信息、截图、向 Electron 发送命令和读取日志。它通过 Agent 提供的 `--remote-debugging-port` 连接运行中的 Electron，不需要修改应用代码。

它适合证明 renderer-only 的最小工具面，但没有主进程 Node Inspector，因此不能处理窗口创建失败、主进程崩溃和 IPC handler 注册等问题。

可借鉴：

- 少量工具覆盖基本观察能力。
- attach 已运行应用。
- 截图和日志作为 Agent 证据。

当前项目需要额外补充：

- 主进程 Session。
- preload/IPC 双边验证。
- 结构化 `PASS`、`FAIL`、`BLOCKED`。

### holepunchto/electron-devtools-mcp

这是基于 Chrome DevTools MCP 的 Electron 适配器，重点处理 Electron 的 CDP 连接差异，包括 Electron 检测、实例切换和 Puppeteer 兼容问题。

它适合作为 renderer CDP 兼容性参考，但它的目标仍然是把 Electron 当作一个可连接的 Chromium 实例，不能代替主进程 Inspector 和 Agent 诊断 Skill。

### kvenLin/electron-debug

这个项目的价值不在 MCP 协议，而在 Skill 和 daemon 工作流。它提供状态、target、evaluate、截图、console 等 HTTP API，并声称支持主进程调试。

它说明“Skill + 常驻状态服务”是一个可行组合。当前项目可以借鉴它的工作流思想，但不需要再引入一个单独 HTTP daemon，因为 MCP Server 本身已经是常驻进程。

### electron-stagewright

这个项目强调诊断证据的稳定性：截图可以写入指定目录，并返回路径、字节数、尺寸和内容哈希；截图前还可以等待新 frame，以避免 Agent 读到旧画面。

当前项目可以借鉴以下思想：

- 截图必须写入受控目录。
- 返回文件路径和元数据。
- 截图应尽量等待页面稳定。
- 证据应能被后续步骤复核。

不需要引入其完整测试自动化能力。

## 3. 社区趋势

社区方案大致分成三类：

1. **完整 Electron 调试器**：双通道、很多工具、同时负责启动和自动化。
2. **轻量 renderer MCP**：少量 CDP 工具，主要解决截图、DOM、console 和 evaluate。
3. **Skill/daemon 或诊断证据工具**：强调工作流、连接状态和可复核产物。

当前项目处在第二类和第三类的交界处，但需要增加主进程通道。这是一个比完整 Electron 调试器更窄、比 renderer-only MCP 更完整的定位。核心只覆盖 attach、status、targets 和 logs；截图与 evaluate 不进入核心承诺。

## 4. 复用策略

不直接依赖上述任一项目，原因是：

- 完整方案的工具面超出当前目标。
- renderer-only 方案缺少主进程诊断。
- Skill/daemon 方案的协议和生命周期与本项目不同。
- 社区项目的安全策略、协议兼容性和测试覆盖仍需自行审核。

建议只复用设计思路：

- 使用 CDP/Node Inspector 的双 Session。
- 使用 ring buffer 收集运行时事件。
- 使用固定 target 选择规则。
- 使用受控目录保存诊断产物。
- 使用 Skill 编排编码后的验证顺序。

底层实现仍保持本项目自己的小型 MCP Server。

## 5. 最终决策

采用“自建薄适配层 + 借鉴社区设计”的方案：

- 核心公开工具固定为 4 个，截图和 evaluate 仅作为未来候选扩展，不属于当前实现。
- 只 attach 已运行的本地 Electron。
- 主进程和 renderer 各使用一个 Session。
- reconnect、target 重新发现和缓存作为内部能力。
- 先实现三类 fixture 和 Agent 使用验证。
- P1 调试功能暂不进入开发承诺。
