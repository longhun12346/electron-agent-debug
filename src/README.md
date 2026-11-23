# Source

这里是 Electron 诊断 MCP 的 TypeScript 源码。当前公开的 MCP 工具共 8 个：

- 连接与观察：`electron_attach`、`electron_status`、`electron_targets`、`electron_logs`。
- 运行时检查：`electron_evaluate`、`electron_wait_for`、`electron_screenshot`、`electron_dom_snapshot`。

通道有三个：主进程 Inspector、renderer CDP，以及通过 `electron_attach` 的 `utility` 参数按需连接的 utility process。

入口 `index.ts` 有三种运行方式：默认作为 stdio MCP Server；带 `--run` 时进入批处理模式（`batch.ts`），从 stdin 读取 JSON 工具调用数组，在同一进程内顺序执行后退出；带 `--tools [工具名 ...]` 时打印所列工具（不传则全部）的描述和 JSON Schema 后退出，给没有 MCP `tools/list` 的批处理调用方查参数形状，不连接应用。三种方式共用 `tools/` 中的同一组工具定义。

`evaluate` 与表达式型 `wait_for` 默认开启，宿主设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 后返回 `EVALUATION_NOT_ALLOWED`。MCP 不启动应用。截图目录由 `ELECTRON_DEBUG_OUTPUT_DIR` 指定。所有文本输出结构化、有界、脱敏，且只连接回环地址。

断点、业务自动化、原生对话框和菜单替身目前没有实现；打开的对话框会在 `electron_status` 的 `dialogs` 里报告（`dialogs.ts`）。重连、target 重新发现和事件缓存属于内部能力。
