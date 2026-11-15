# Source

这里是 attach-only Electron 诊断适配层的 TypeScript 源码。当前公开且已实现的 MCP 工具只有：

- `electron_attach`
- `electron_status`
- `electron_targets`
- `electron_logs`

截图、evaluate、DOM 操作、断点和应用生命周期控制当前都未实现，也不属于核心验收前提。重连、target 重新发现和事件缓存属于内部能力。
