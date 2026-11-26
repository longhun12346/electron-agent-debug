# 示例

| 目录 | 内容 | 运行 |
| --- | --- | --- |
| [`vue-vite-app`](vue-vite-app/README.md) | electron-vite、Vue 3、Pinia、Vue Router 的任务板：开发服务器、热更新、主进程重启、构建产物，六类故障，utility process、多窗口、崩溃与退出、检查与交互。所有真实 Electron 验证都在这里，CI 里运行 | `node examples/vue-vite-app/package-smoke.mjs` |
| [`host-e2e`](host-e2e/README.md) | 让真实的 Agent 宿主（Codex、Claude Code）在上面的应用里完成排错任务，只看真实的 MCP 流量来判定；也有不调用模型的脚本化参考解法，CI 里运行 | `node examples/host-e2e/reference.mjs` |
| [`external-e2e`](external-e2e/README.md) | 对外部项目 `electron-vite/electron-vite-react` 的双通道验收，opt-in，不属于默认测试 | `npm run test:e2e:external` |
| [`native-eval`](native-eval/README.md) | 原生模块调试流程的评估：三个故意写错的原生函数、一个最小应用和三条评估（Windows 和 Linux 验证过，macOS 只写了没测），不在 CI 里运行 | 见该目录 README |

应用必须由测试脚本启动，并开放主进程 Inspector 和渲染进程 CDP，端口由脚本动态分配。MCP Server 本身不负责启动或停止应用。应用里的故障开关只属于验证，不是 MCP Server 的配置。

每个故障场景都要有：一个可以故意引入的缺陷、缺陷状态下的运行时观察结果、修复态（或无故障态）的运行时观察结果，以及应用未启动或端点不可用时的结构化连接错误。
