# Agent 宿主集成测试

这是可选的真实宿主测试，要求已安装并认证的 Codex 或 Claude Code CLI、Node.js 20+、构建后的 MCP 和 `examples/fixture` 的 Electron 依赖。模型调用可能计费；普通测试与 CI 不运行这些命令。

在仓库根目录执行：

```text
npm ci
npm run build
npm ci --prefix examples/fixture
node examples/host-e2e/smoke.mjs codex <absolute-codex-executable>
node examples/host-e2e/smoke.mjs claude <absolute-claude-executable>
```

不传可执行文件路径时从 PATH 查找所选宿主。Linux 无图形环境时，在测试命令前使用 `FIXTURE_ELECTRON_NO_SANDBOX=true xvfb-run -a`。

测试启动动态端口的真实 Electron fixture，通过本次临时 MCP 配置连接透明 stdio relay，并显式向宿主提供 Skill 内容。relay 只记录 MCP 协议流量，生产 Server 无需修改。测试检查：

- 宿主实际调用了 attach、status、targets、logs 这几个诊断工具（该测试只覆盖它们；MCP 另有生命周期和检查工具，由单元和 stdio 测试覆盖）。
- attach/status 的真实返回报告主进程和 renderer 在线。
- targets 返回窗口且选中了 target。
- logs 同时包含主进程 IPC handler 错误和 renderer 调用错误，通道必须正确。

整个宿主运行上限 120 秒，不修改已保存的用户 MCP 配置。成功时删除临时文件；失败时输出本机临时目录，保留 MCP trace 和宿主日志供定位。日志可能包含本机路径和模型响应，发布前应自行检查。

此测试证明指定已安装 CLI 可以执行诊断，不验证宿主的全局/项目级 Skill 自动发现、所有认证方式或用户应用的业务正确性。安装包的完整性由根目录 packaging 测试单独验证。
