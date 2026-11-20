# Agent 宿主集成测试

这是可选的真实宿主测试，要求已安装并认证的 Codex 或 Claude Code CLI、Node.js 20+、构建后的 MCP 和 `examples/fixture` 的 Electron 依赖。模型调用可能计费；普通测试与 CI 不运行这些命令。

在仓库根目录执行：

```text
npm ci
npm run build
npm ci --prefix examples/fixture
node examples/host-e2e/smoke.mjs codex <absolute-codex-executable> --scenario all
node examples/host-e2e/smoke.mjs claude <absolute-claude-executable> --scenario ipc
```

不传可执行文件路径时从 PATH 查找所选宿主。不传 `--scenario` 时只运行 `ipc`。Linux 无图形环境时，在测试命令前使用 `FIXTURE_ELECTRON_NO_SANDBOX=true xvfb-run -a`。

## 场景

场景定义在 `scenarios.mjs`，每个是编码 Agent 会拿到的一项任务：

| 场景 | 任务 | 必须出现的证据 |
| --- | --- | --- |
| `ipc` | IPC 失败，两侧都要有证据 | attach、status、targets、logs 都被调用；两个通道在线；main 和 renderer 各自的错误日志 |
| `renderer` | 页面异常，读错误和页面内容 | 可读的 `Uncaught Error: …` 日志；无障碍树里的故障状态文本 |
| `main-window` | 窗口没出现，判断责任在哪一侧 | main 在线、renderer 离线；主进程的窗口失败日志 |
| `inspect` | 健康应用，逐项取证 | 条件成立的 wait_for、main 通道求值、无障碍树、已保存的截图、日志 |
| `utility` | 连接 utility process 读值 | attach 带 `utility`，main 与 utility 同时在线；`scope: utility` 读到 `utility-ok` |
| `devtools-windows` | 开发构建：DevTools 加两个窗口，选对窗口再读取（field 应用） | 工具连到 `Field App` 窗口而不是 Settings 或 DevTools；无障碍树读到它的标题；向主进程询问了窗口数 |
| `click-save` | 按钮不按就什么都不会发生：自己按下，再读两侧证据（field 应用，保存会失败） | renderer 里执行过求值；读到 renderer 的 `FIELD_SAVE_CALL_FAILURE` 和主进程的 `FIELD_SAVE_HANDLER_FAILURE`，通道不能互换 |

前五个场景跑在最小 fixture 上，后两个跑在 `examples/field-app`，它的形态更接近真实的开发构建（见该目录的 README）。`tests/host-scenarios.test.ts` 用手工构造的流量检查每个场景的断言：空流量、选错窗口、只有单侧证据、通道互换都必须被拒绝。

宿主模型只能使用 electron-debug 的 8 个 MCP 工具，没有 shell 和文件读取。所有断言都针对透明 stdio relay 记录的真实 MCP 流量：调用了哪些工具、参数里的通道、服务器返回了什么证据。模型的最终文字不参与判定，所以“说自己成功了”不算通过。

## 不用模型的参考解法

每个场景带一份脚本化的参考解法。`reference.mjs` 对真实 fixture 回放它，并套用同样的断言：

```text
node examples/host-e2e/reference.mjs            # 全部场景
node examples/host-e2e/reference.mjs inspect    # 指定场景
```

它不调用模型，已加入 `examples/fixture/ci-smoke.mjs`，在 CI 的每个组合里运行。作用是保证场景能用现有工具完成、断言接受正确的运行。新增场景时先写参考解法并让它通过，再让真实宿主跑。

## 运行方式

测试启动动态端口的真实 Electron fixture，通过本次临时 MCP 配置连接透明 stdio relay，并显式向宿主提供 Skill 内容。relay 只记录 MCP 协议流量，生产 Server 无需修改。每个场景的宿主运行上限 180 秒，不修改已保存的用户 MCP 配置。成功时删除临时文件；失败时输出本机临时目录，保留 MCP trace 和宿主日志供定位。日志可能包含本机路径和模型响应，发布前应自行检查。

此测试证明指定已安装 CLI 在这些任务里选对了通道和工具并取得了证据，不验证宿主的全局/项目级 Skill 自动发现、所有认证方式或用户应用的业务正确性。安装包的完整性由根目录 packaging 测试单独验证。
