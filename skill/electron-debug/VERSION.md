# 版本记录

## 1.2.0

- MCP 0.3.0：同一入口新增批处理模式 `launch.cjs --run`，从 stdin 读取 JSON 工具调用数组并在同一进程内顺序执行，不需要注册 MCP；工具集合与 MCP 完全一致。
- SKILL.md 的接入部分改为二选一：注册 MCP，或使用批处理模式。已注册 MCP 的宿主无需任何改动。
- Node.js 要求从 22 放宽到 20，运行文件按 Node 20 构建。

## 1.1.0

- MCP 0.2.0：统一日志时间线增加 `seq` 游标。MCP 只 attach，不启动、停止或重启应用；启动应用并暴露 `--inspect` 与 `--remote-debugging-port` 由 Agent 负责。
- 新增 `electron_evaluate`、`electron_wait_for`、`electron_screenshot`、`electron_dom_snapshot`；求值默认开启（仅回环 endpoint），宿主设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 可禁用；协议单条消息上限默认提高到 256 MiB（与 Puppeteer、Playwright 一致），大型 renderer 不再因 1009 被断开；日志脱敏覆盖 JSON 字符串化后的内容。
- 新增 `ELECTRON_DEBUG_OUTPUT_DIR`；输出统一有界并脱敏。
- SKILL.md 精简为使用建议和证据矩阵。旧宿主配置无需更改入口，但需确认 8 个工具可见。

## 1.0.4

- 在 description 中明确 Electron 代码变更验证、白屏和运行时错误等触发场景。
- 工作流程图增加框线及箭头，便于阅读与平台识别；诊断能力和 Agent 职责不变。

## 1.0.3

- MCP 0.1.1 与 Skill 一起交付，包含运行时 JavaScript 依赖；使用时无需额外下载、依赖安装或构建。
- 增加本地完整性启动器、构建输入摘要和第三方许可证。
- 增加触发条件表格、标准使用章节、ASCII 工作流程与错误处理。
- 旧宿主配置需切换到本版本的 `runtime/launch.cjs`。
- GitHub Release 来源证明绑定对应 tag 的源码提交；构建输入摘要见 `runtime/manifest.json`。平台包的发布版本与扫描结果由安装渠道提供。

## 1.0.2

补充独立 MCP 源码更新说明。本版本的独立下载和构建方式已由 1.0.3 的随包运行方式替代。

## 1.0.1

提供 Electron 双通道诊断流程、四个 MCP 工具接入说明与 Agent 自行验收边界。
