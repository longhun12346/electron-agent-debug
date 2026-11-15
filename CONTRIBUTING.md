# 开发说明

## 环境

- Node.js 22 或更高版本。
- 根目录依赖用于 MCP Server、测试和 TypeScript 构建。
- `examples/fixture` 是独立的 Electron 示例包，使用自己的 `package.json` 和 lockfile。
- 根目录使用 npm 管理构建、测试和开发依赖；公开交付以 GitHub 仓库、Skill 文件和源码为准。

## 常用命令

在仓库根目录执行：

```powershell
npm install
npm test
npm run lint
npm run build
```

`npm test` 会先构建 TypeScript，再运行契约和单元测试。测试不需要启动真实 Electron。
`npm run lint` 同时检查实现和测试源码的 TypeScript 类型，不生成测试构建产物。

## 回归测试要求

修复缺陷时，先增加能在旧实现上失败的行为测试，再修改实现。测试优先验证工具契约、状态和资源边界，不能仅断言返回值存在或连接成功。

| 边界 | 自动验证内容 |
| --- | --- |
| 协议输入 | 真实 WebSocket 发送无效 JSON、null、标量、数组、畸形响应和事件；在独立子进程中确认不会崩溃，且不会吞掉后续有效响应 |
| 请求生命周期 | 乱序响应匹配、请求超时后的继续使用、协议命令拒绝、断线后所有待处理请求失败 |
| 会话初始化 | 主进程和 renderer 在 Runtime.enable 时断开、renderer 在 Log.enable 时断开；不得报告 online，另一通道仍保留结果 |
| 可选能力 | 不支持 Log.enable 时记录告警，仍可保留已连接的 Runtime；不能把能力缺失和连接断开混为一谈 |
| 日志 | main、renderer、all 和缺省范围；level、since、limit 组合；按范围清空；无效参数不能清空证据；通过 MCP stdio 验证筛选与清空 |
| 多窗口 | URL/标题重名、可连接与不可连接 target 混合、明确 targetId；歧义不得静默选择第一个窗口 |
| 外部验收构建 | 使用真实编译器、子进程和含空格目录，验证缺少及过期 dist 的构建；不依赖外部项目下载 |

这些测试通过只证明所覆盖的契约。外部 Electron 项目的业务操作、视觉结果和真实 Agent 宿主接入仍需分别验证，不能用测试数量或一次 CI 成功代替。

## Electron fixture

fixture 的安装和运行说明位于 [`examples/fixture/README.md`](examples/fixture/README.md)。主进程 Inspector 和 renderer CDP 的端口由运行 Agent 或测试脚本分配，仓库不固定端口，也不提交 `node_modules`、构建产物或 Electron 下载缓存。`examples/fixture/ci-smoke.mjs` 会动态分配端口并验证默认、主进程、renderer、IPC 和缺少 endpoint 五种场景。

## CI

GitHub Actions 在 Ubuntu 和 Windows 上执行根目录测试、类型检查、fixture 语法检查和真实 Electron smoke。Linux smoke 使用 `xvfb` 提供虚拟显示。

## 提交边界

一次提交应保持一个清晰目的。核心实现、测试、文档和 fixture 可以在同一次功能提交中一起提交，因为它们共同构成可验证的诊断能力；本地产物、日志、依赖安装目录和临时输出不应进入 Git。
