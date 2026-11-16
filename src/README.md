# Source

这里是 Electron 诊断 MCP 的 TypeScript 源码。当前公开的 MCP 工具共 8 个：

- 连接与观察：`electron_attach`、`electron_status`、`electron_targets`、`electron_logs`。
- 运行时检查：`electron_evaluate`、`electron_wait_for`、`electron_screenshot`、`electron_dom_snapshot`。

`evaluate` 与表达式型 `wait_for` 默认开启，宿主设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 后返回 `EVALUATION_NOT_ALLOWED`。MCP 不启动应用。截图目录由 `ELECTRON_DEBUG_OUTPUT_DIR` 指定。所有输出结构化、有界、脱敏，且只连接回环地址。

断点、业务自动化、原生菜单替身和 CLI 入口目前没有实现。重连、target 重新发现和事件缓存属于内部能力。
