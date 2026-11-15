# 外部 Electron 项目验收

这个目录提供一个可选的真实项目验收脚本。它不会把外部项目、Electron 运行时或 Playwright 依赖加入当前 MCP Server，也不会在默认测试中访问网络。

当前目标项目是公开的 `electron-vite/electron-vite-react`，测试源快照固定到：

```text
18d31d5dcfe6637aa1dd6699babcab1849c83f98
```

外部项目需要由调用者提前准备，并且不应修改上游源代码。脚本会：

1. 使用外部项目已有的 Vite 依赖构建 Electron 主进程、preload 和 renderer。
2. 动态分配两个回环端口。
3. 启动外部 Electron 项目。
4. 启动当前 MCP Server。
5. 调用 `electron_attach`、`electron_status`、`electron_targets` 和 `electron_logs`。
6. 检查双通道状态、当前 page target 和 renderer 运行时日志。
7. 清理测试进程并输出 JSON 结果。

## 运行

先准备外部项目依赖，并确认它已经位于本地目录。Windows PowerShell 示例：

```powershell
$env:ELECTRON_E2E_PROJECT_ROOT = "D:\workspace\github\electron-vite-react-e2e"
$env:ELECTRON_E2E_ELECTRON = "D:\workspace\github\electron-agent-debug\examples\fixture\node_modules\electron\dist\electron.exe"
npm run build
npm run test:e2e:external
```

脚本会检查当前 MCP 的 `dist/index.js`；如果构建产物不存在，会自动执行一次 `npm run build`。外部项目仍然必须由调用者提前准备依赖。

`ELECTRON_E2E_ELECTRON` 是测试使用的 Electron 可执行文件；正式 CI 应该指向外部项目声明的 Electron 版本。当前本地快照因为依赖安装脚本没有下载 Electron 二进制，使用 fixture 中已有的可执行文件完成协议链路验收。

可选环境变量：

- `ELECTRON_E2E_SKIP_BUILD=true`：外部项目已经构建完成时跳过 Vite 构建。
- `ELECTRON_E2E_REPORT=<path>`：把 JSON 结果写入指定文件。
- `ELECTRON_E2E_EXPECT_RENDERER_LOG=<text>`：替换默认的 renderer 日志片段。
- `ELECTRON_E2E_NO_SANDBOX=false`：不向 Electron 添加 `--no-sandbox`。

这个脚本的成功标准是诊断适配层能提供完整双通道证据。外部项目自己的 unit test 或业务 E2E 结果应单独运行和记录；上游测试断言过期时，不应修改上游代码来掩盖结果。
