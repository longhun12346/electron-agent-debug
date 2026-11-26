# 连接失败

attach 多次重试仍失败时，先读错误的 `hint`（区分了端口没人监听、端口上不是调试端口、主进程和 renderer 端口传反等情况；端口上是浏览器而不是 Electron 时，看结果 `warnings` 里的 `RENDERER_NOT_ELECTRON`），再排查启动方式，最后判断是否应用本身的问题：

- 环境里设有 `ELECTRON_RUN_AS_NODE=1`（部分终端和 Node 工具链会带上）时，Electron 按 Node 运行，不会创建窗口，renderer 通道不可用。启动应用前取消该变量。
- 主进程通道失败而 renderer 通道正常时，检查应用是否关闭了 `EnableNodeCliInspectArguments` fuse；关闭后 `--inspect` 会被忽略，需要改用未关闭该 fuse 的开发构建。打包后的应用不在支持范围内，不为它调整方案。
- 端口被占用或应用已提前退出：核对应用进程的输出和退出码。
- 应用该退出了但进程还在，输出里有 `Waiting for the debugger to disconnect…`：Node 会等已连接的检查器断开才让进程退出，MCP 的主进程连接就是其中一个。要退出码或要重启时，直接终止进程，或先结束 MCP 会话，不要等它自己退出。

仍无法取得所需通道时报告 `BLOCKED`，写明缺少哪个通道和已排除的原因，不要归因于业务代码。
