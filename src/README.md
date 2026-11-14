# Source

第一阶段实现一个 attach-only Electron 诊断适配层，核心公开 4 个 MCP 工具：

- `electron_attach`
- `electron_status`
- `electron_targets`
- `electron_logs`

可选扩展工具：

- `renderer_screenshot`
- `electron_evaluate`

截图和 evaluate 不属于核心诊断链路，只有在真实验证需要时才实现。重连、target 重新发现和事件缓存属于内部能力。
