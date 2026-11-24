# 取证细节

补充 SKILL.md 的证据矩阵和工作流第 4 步。

## IPC

主进程通道在线且未禁用求值时，时间线自动记录主进程收到的每条 IPC（`kind` 为 `ipc`）：`invoke` 的成功或失败与错误信息，`send` / `sendSync` 没有监听者时为 warn。只记录通道名、耗时、结果和参数大小，不含参数值。用 `electron_wait_for` 等 `IPC invoke <通道>` 即可确认调用到达主进程以及结果。main 侧证据也可以在 renderer 触发调用后，用 `electron_evaluate`(main) 读副作用，如文件是否落盘、状态是否变化。

## 崩溃

renderer 页面崩溃时连接不会断：`electron_status` 的 renderer 变为 offline 且 `error.code` 为 `TARGET_CRASHED`，日志里有 `Target crashed` 事件，各个 renderer 工具立即返回 `TARGET_CRASHED`；页面重新加载后同一连接自动恢复，日志出现 `Target reloaded after crash`。主进程崩溃或退出则整个主进程通道断开（`SESSION_DISCONNECTED`）。

## 其他

- `ELECTRON_DEBUG_ALLOW_EVAL=0` 时 `electron_evaluate` 和表达式型等待返回 `EVALUATION_NOT_ALLOWED`，点击和输入也一起禁用；attach、targets、日志、状态、截图和快照仍可用。
- `electron_logs` 的 `gap` 为 `true` 说明缓冲区满过、有事件被丢弃，缩短取证间隔，或调大 `ELECTRON_DEBUG_MAX_LOG_EVENTS`。
- `electron_status` 的 `dialogs` 列出正在等用户操作的对话框；`blocking` 为 `true` 时对应进程在关闭前不响应，超时的 `hint` 会说明，不要反复重试。
