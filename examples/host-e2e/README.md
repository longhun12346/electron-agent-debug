# Agent 宿主集成测试

这是可选的真实宿主测试，要求已安装并认证的 Codex 或 Claude Code CLI、Node.js 20.19+（electron-vite 6 的要求）、构建后的 MCP 和 `examples/vue-vite-app` 的依赖。模型调用可能计费；普通测试与 CI 不运行这些命令。

在仓库根目录执行：

```text
npm ci
npm run build
npm ci --prefix examples/vue-vite-app
node examples/host-e2e/smoke.mjs codex <absolute-codex-executable> --scenario all
node examples/host-e2e/smoke.mjs claude <absolute-claude-executable> --scenario ipc
```

不传可执行文件路径时从 PATH 查找所选宿主。不传 `--scenario` 时只运行 `ipc`。Linux 无图形环境时，在测试命令前使用 `TEST_ELECTRON_NO_SANDBOX=true xvfb-run -a`。

## 被测应用

所有场景都跑在 [`examples/vue-vite-app`](../vue-vite-app/README.md) 上：electron-vite 开发服务器、Vue 3、Pinia、Vue Router 的任务板，数据经 IPC 存在一个 JSON 文件里。每个场景用 `app` 字段说明怎么启动它，`app-launch.mjs` 按这个字段在动态端口上启动，并等到调试端点可用、页面已加载：

| `app` 字段 | 作用 |
| --- | --- |
| `fault` | `APP_FAULT`：`ipc-channel`、`silent-send`、`missing-field`、`stale-add` 等故障 |
| `store`、`files`、`windowless` | 数据文件内容、额外的数据文件；`windowless` 表示窗口永远创建不出来，不等页面 |
| `noise` | 渲染进程在启动时输出这么多行调试日志，attach 时被重放并撑满日志缓冲区 |
| `indexer` | 在动态端口上给 `task-indexer` utility process 开调试口 |
| `devtools`、`settingsWindow` | DevTools 与第二个窗口（标题 `Settings - Task Board`），等它们都出现且标题就绪后再交给宿主 |
| `before` | 宿主 attach 之前，runner 用自己的 MCP 会话按顺序调用的工具，结束后关闭该会话 |

单窗口场景交给宿主之前，runner 先用一个一次性会话等页面挂载完成（开发服务器第一次加载要现场编译），这个会话不经过 relay，不计入断言。

## 场景

场景定义在 `scenarios.mjs`，每个是编码 Agent 会拿到的一项任务：

| 场景 | 应用设置 | 任务 | 必须出现的证据 |
| --- | --- | --- | --- |
| `ipc` | `store` 写成损坏的 JSON | 页面加载时 IPC 失败，两侧都要有证据 | attach、status、targets、logs 都被调用；两个通道在线；main 的 `Error occurred in handler for 'tasks:list'` 带 `SyntaxError`，renderer 的 `load tasks failed` |
| `renderer` | `missing-field` | 添加任务后页面异常，读错误和页面内容 | 按下 Add 之后：renderer 的 `TypeError … reading 'name'` 异常和 `[Vue warn]`；读到的无障碍树里计数器比列出的行多 |
| `main-window` | `window.json` 损坏，`windowless` | 窗口没出现，判断责任在哪一侧 | main 在线、renderer 离线；主进程的 `Could not create the main window` 日志带原因 |
| `inspect` | 默认 | 健康应用，逐项取证 | 条件成立的 wait_for；main 通道求值得到 1 个窗口；无障碍树里有种子任务和 `1 open of 2`；已保存的截图；读到无 error 级别的日志 |
| `utility` | `indexer` | 连接 utility process 读值 | attach 带 `utility`，main 与 utility 同时在线；`scope: utility` 的 `indexer.size()` 为 2 |
| `devtools-windows` | `devtools`、`settingsWindow`、`noise: 800` | 开发构建：DevTools 加两个窗口，选对窗口再读取 | 工具连到标题为 `Task Board` 的窗口，不是设置窗口；无障碍树读到 `Tasks` 标题；向主进程询问窗口数得到 2（DevTools 不算） |
| `click-add` | `ipc-channel` | 按钮不按就什么都不会发生：自己输入并按下 Add，再读两侧证据 | 用 `electron_click` 按下 Add，不能用求值里的 `.click()`；按下之后读到 renderer 的 `Error invoking remote method 'tasks:add'` 和主进程的 `Error occurred in handler for 'tasks:add'`，两侧不能互换 |
| `stale-add` | `stale-add`，`before` 先失败一次 | 处理已修好，但 attach 会重放旧的失败，只有现在按下才知道真相 | 按下 Add 之后读到页面列出 3 个任务且计数为 3，或追踪里 `tasks:add` 成功；成功不打日志，重放的旧失败不算 |
| `sync-mismatch` | `silent-send` | 按钮什么都不做，没有报错：消息发到了没人监听的通道 | 按下 Sync 之后读到 `sync:start` 没有监听者的 IPC 事件（attach 时要传 `instrument: ["ipc"]`） |

`tests/host-scenarios.test.ts` 检查每个场景都会拒绝空流量、都带参考解法和应用设置，并用合成的流量检查错误的证据会被拒绝：错侧的消息、按下之前的事件、不是 `electron_click` 的按下、别的通道或有监听者的 IPC 事件、选错的窗口。正确的运行能通过，由下面的参考解法回放保证。

宿主模型只能使用 electron-debug 的 10 个 MCP 工具，没有 shell 和文件读取。所有断言都针对透明 stdio relay 记录的真实 MCP 流量：调用了哪些工具、参数里的通道、服务器返回了什么证据。模型的最终文字不参与判定，所以“说自己成功了”不算通过。

## 不用模型的参考解法

每个场景带一份脚本化的参考解法。`reference.mjs` 对真实应用回放它，并套用同样的断言：

```text
node examples/host-e2e/reference.mjs            # 全部场景
node examples/host-e2e/reference.mjs inspect    # 指定场景
```

它不调用模型。作用是保证场景能用现有工具完成、断言接受正确的运行；参考解法里任何一步失败都会直接报错。新增场景时先写参考解法并让它通过，再让真实宿主跑。

## 运行方式

测试启动动态端口的真实 Electron 应用，通过本次临时 MCP 配置连接透明 stdio relay，并显式向宿主提供 Skill 内容。relay 只记录 MCP 协议流量，生产 Server 无需修改。每个场景的宿主运行上限 180 秒，不修改已保存的用户 MCP 配置。成功时删除临时文件（Windows 上宿主的子进程可能还以该目录为工作目录，删除会带重试；仍删不掉时只打印警告和目录位置，不让通过的场景变成失败）；失败时输出本机临时目录，保留 MCP trace 和宿主日志供定位。日志可能包含本机路径和模型响应，发布前应自行检查。

此测试证明指定已安装 CLI 在这些任务里选对了通道和工具并取得了证据，不验证宿主的全局/项目级 Skill 自动发现、所有认证方式或用户应用的业务正确性。安装包的完整性由根目录 packaging 测试单独验证。
