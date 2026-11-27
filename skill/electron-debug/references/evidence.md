# 取证细节

补充 SKILL.md 的证据矩阵和工作流第 4 步。

## IPC

attach 时传 `instrument: ["ipc"]` 才会记录主进程收到的 IPC，不传就没有 `ipc` 事件；等 `IPC invoke <通道>` 超时而没有装追踪时，结果的 hint 会说明这一点。装上后（主进程通道在线且未禁用求值），时间线记录每条 IPC（`kind` 为 `ipc`）：`invoke` 的成功或失败与错误信息，`send` / `sendSync` 没有监听者时 `level` 为 `warning`。只记录通道名、耗时、结果、错误信息、参数大小和发送方（`senderId`、`senderUrl`，地址里可能带令牌），不含参数值。用 `electron_wait_for` 等 `IPC invoke <通道>` 即可确认调用到达主进程以及结果。main 侧证据也可以在 renderer 触发调用后，用 `electron_evaluate`(main) 读副作用，如文件是否落盘、状态是否变化。

## 崩溃

renderer 页面崩溃时连接不会断：`electron_status` 的 renderer 变为 offline 且 `error.code` 为 `TARGET_CRASHED`，日志里有 `Target crashed` 事件，各个 renderer 工具立即返回 `TARGET_CRASHED`；崩溃期间页面里的求值也被拒绝，所以不能在页面里执行 `location.reload()`：主进程通道在线时用 `electron_evaluate`(main) 对该窗口调用 `webContents.reload()`，否则请用户重新加载窗口。页面重新加载后同一连接自动恢复，不用重新 attach，日志出现 `Target reloaded after crash`。主进程崩溃或退出则整个主进程通道断开（`SESSION_DISCONNECTED`）。

## 其他

- `ELECTRON_DEBUG_ALLOW_EVAL=0` 时 `electron_evaluate` 和表达式型等待返回 `EVALUATION_NOT_ALLOWED`，点击和输入也一起禁用；attach、targets、日志、状态、截图和快照仍可用。
- `electron_logs` 的 `gap` 为 `true` 说明缓冲区满过、有事件被丢弃，缩短取证间隔，或调大 `ELECTRON_DEBUG_MAX_LOG_EVENTS`。
- `electron_logs` 的 `level` 取事件的 `level` 值：console 的警告和工具自己的警告（IPC 没有监听者、对话框打开）都是 `warning`，写 `warn` 也能读到；`clear` 只删除本次返回的事件，被 `limit` 或过滤条件挡在外面的保留。
- 事件的 `observedAt` 是应用产生它的时间：attach 时重放的历史输出保留原来的时间，`since` 可以按时间把它们排除。
- 带参数的工具拒绝不认识的参数（例如把 `afterSeq` 写成 `after_seq`、把 `timeoutMs` 写成 `timeout`），错误里有参数名，改对再调用；拿不准参数名用 `launch.cjs --tools <工具名>` 查。
- 表达式型 `electron_wait_for` 在所选通道没有连接时立即返回 `SESSION_DISCONNECTED`，不会等到超时；先 `electron_attach`。
- `targets` 里超过 512 个字符的 `title`、超过 4096 个字符的 `url`（`data:` 地址常见）会被截断，并给出 `titleTruncatedFrom`、`urlTruncatedFrom`；这样的页面用 `targetId` 选。

## IPC 追踪的边界

下面这些情况下时间线里**不会**出现对应的 `ipc` 事件，不能把"没有事件"当成"没有调用"：

- 没有注册处理函数的 `invoke` 不被追踪，Electron 自己会在主进程日志里打印 `No handler registered for '<通道>'`，没等到 `IPC invoke <通道>` 时先查主进程日志。
- 每个通道每秒最多记录 20 条，超出的用后一条记录里的 `skipped` 计数；Electron 自己用的内部通道不记录。
- 通过 `webContents.ipc` 或会话级注册的 `invoke` 处理函数不被追踪；`send` 类消息只要 `ipcMain`、`webContents.ipc` 或所在 frame 的 `ipc` 有监听者，就不会报"没有监听者"。
- `electron_wait_for` 的 `contains` 同时匹配成功和失败（`IPC invoke X ok in…` 与 `IPC invoke X failed after…`），要看返回事件的 `level` 或 `data.ok`。
- 追踪依赖 Electron 的私有字段 `ipcMain._invokeHandlers`；字段不存在的版本只追踪 `send` / `sendSync`，时间线里会有一条 `level` 为 `warning` 的事件说明。

## attach 会在应用里装什么

attach 默认不往应用里装任何东西。传 `instrument` 才会在主进程里装记录用的包装（`ELECTRON_DEBUG_ALLOW_EVAL` 没有关闭时）：`["ipc"]` 包装 `ipcMain.emit` 和 `ipcMain` 的 invoke 处理表，`["dialogs"]` 包装 `dialog` 的各个函数，每种各带一个 `Runtime.addBinding`。它们不上报参数值（会对参数做 JSON 序列化来计算大小），应用重启前不会移除。utility 连接还会在应用里调用未公开的 `process._debugProcess`，并在主进程里同步执行 `netstat`（Windows）或 `lsof` 查监听端口（每次最多阻塞约 3 秒）。不传 `instrument` 沿用上一次的选择，第一次是什么都不装；传 `[]` 表示不再装新的，已装上的要重启应用才会移除；结果的 `instrumented` 列出实际装了什么。要连求值、点击输入、utility 一起关掉，就设 `ELECTRON_DEBUG_ALLOW_EVAL=0`。

## 点击、输入和对话框

- 点击被弹层挡住（`ELEMENT_COVERED`）时，一般先处理弹层。`element.click()` 不是真实点击（`isTrusted` 为 false），只在你清楚后果时当退路。
- 只有最近一次快照里的 ref 可用，页面重新渲染后换 ref 或改用 `role` 加 `name`；批处理每次执行都是新进程，上一次的 ref 无效。
- 原生对话框和菜单提示用户人工操作；`electron_status` 的 `dialogs` 列出正在等用户的对话框（页面的 JavaScript 对话框总是列出，原生对话框要 attach 时传 `instrument: ["dialogs"]`），`blocking` 为 `true` 时对应进程在关闭前不响应，不要反复重试。
