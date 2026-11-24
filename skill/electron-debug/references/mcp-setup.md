# MCP 接入说明

## 目录

- 前提
- 随包运行文件
- 来源与完整性边界
- 配置宿主
- 不注册 MCP：批处理模式
- 更新与迁移
- Endpoint 与保护参数

## 前提

Agent 使用 MCP 时，宿主需支持本地 MCP stdio Server；不注册 MCP 时用下文的批处理模式。两种方式都要求本机具备 Node.js 20 或更高版本，当前 Skill 已通过任务认可的安装渠道获取。应用运行、endpoint 和业务回归由 Agent 准备。

## 随包运行文件

MCP 与 Skill 一起交付，`runtime/server.cjs` 已包含运行时 JavaScript 依赖，不依赖源码目录、外部依赖安装目录或原生扩展。入口为 `runtime/launch.cjs`。正常安装后的使用流程不需要下载源码或执行安装、构建命令。

Agent 查找当前 Skill 的实际安装目录，不假设全局目录、项目目录或宿主配置文件路径。

```text
node <absolute-skill-directory>/runtime/launch.cjs --verify
```

成功结果包含 Skill 版本、MCP 版本和构建输入摘要。启动器在加载 MCP 前检查 manifest 和运行文件的 SHA-256，拒绝缺失、损坏或不匹配的文件；失败信息写入 stderr，且不启动 MCP。

## 来源与完整性边界

同包哈希可检测文件不一致，不能独立证明发布者身份，也不能证明代码没有漏洞。哈希只覆盖 `runtime/` 里的文件；`SKILL.md` 和 `references/` 是 Agent 要照做的指引，不在其中，同样要从可信渠道获得。来源信任由用户或组织认可的安装渠道、平台扫描及发布证明建立，不能仅凭包自称可信。

GitHub Release 的 ZIP 可提供构建来源 attestation。需要核对来源时，在执行包内代码前，使用可信的 GitHub CLI 对原始 Release ZIP 验证预期仓库和工作流身份：

```text
gh attestation verify <absolute-release-zip> --repo longhun12346/electron-agent-debug --signer-workflow longhun12346/electron-agent-debug/.github/workflows/release.yml
```

该命令只验证产物来源，不下载或执行 MCP 代码。验证失败时停止；要求来源证明但没有相应证明时报告 `BLOCKED`，不要把本地哈希校验当成替代。第三方渠道的安装包使用该渠道的发布和扫描结果，不能用另一份 GitHub ZIP 的证明替它背书。

## 配置宿主

先确认包来源符合任务要求，再执行完整性检查。通过后，根据实际宿主注册以下本地入口：

```json
{
  "mcpServers": {
    "electron-agent-debug": {
      "command": "node",
      "args": ["<absolute-skill-directory>/runtime/launch.cjs"]
    }
  }
}
```

这是概念示例，字段与刷新方式以实际宿主为准。已存在相同 Server 时先核对其入口和版本，避免重复注册。刷新后确认全部 10 个工具可见：`electron_attach`、`electron_status`、`electron_targets`、`electron_logs`、`electron_evaluate`、`electron_wait_for`、`electron_screenshot`、`electron_dom_snapshot`、`electron_click`、`electron_type`。MCP 启动成功不代表 Electron 已启动或业务已通过。

## 不注册 MCP：批处理模式

宿主没有配置 MCP、或不想修改宿主配置时，完整性检查通过后直接运行同一入口：

```text
node <absolute-skill-directory>/runtime/launch.cjs --run
```

stdin 传入 JSON 数组，每项为 `{"tool": "<工具名>", "arguments": {...}, "continueOnError": false}`，`arguments` 和 `continueOnError` 可省略。工具名和参数与 MCP 完全相同。没有 MCP 就没有 `tools/list`，不要猜参数的形状，先用 `--tools` 查：

```text
node <absolute-skill-directory>/runtime/launch.cjs --tools                                   # 全部 10 个工具
node <absolute-skill-directory>/runtime/launch.cjs --tools electron_wait_for                 # 只看一个
node <absolute-skill-directory>/runtime/launch.cjs --tools electron_attach electron_logs     # 一次看几个，按给的顺序输出
```

stdout 输出一行 JSON：`{"ok": true, "tools": [{"name", "description", "inputSchema"}, ...]}`，`inputSchema` 是 JSON Schema，嵌套对象的字段在里面（例如 `electron_wait_for` 的 `expression` 是带 `scope` 和 `expression` 的对象，不是字符串）。工具名不存在时输出 `{"ok": false, "error": {...}}`（消息列出所有不存在的名字和可用的名字，不返回部分结果），退出码为 1。该命令不连接应用，也不读取 stdin。

各步骤在同一个进程、同一个连接内按顺序执行，例如：

```json
[
  {"tool": "electron_attach", "arguments": {"mainUrl": "http://127.0.0.1:9229", "rendererUrl": "http://127.0.0.1:9222"}},
  {"tool": "electron_wait_for", "arguments": {"log": {"contains": "ready"}, "timeoutMs": 15000}},
  {"tool": "electron_wait_for", "arguments": {"expression": {"scope": "renderer", "expression": "document.readyState === 'complete'"}}},
  {"tool": "electron_evaluate", "arguments": {"scope": "renderer", "expression": "document.title"}}
]
```

stdout 输出一行 JSON：`{"ok": true|false, "results": [{"tool", "ok", "result"}, ...]}`，`result` 与 MCP 工具返回的 `structuredContent` 相同。某一步失败时默认停止，后续步骤标记为 `skipped`；该步骤设置 `continueOnError: true` 则继续。全部成功时退出码为 0，否则为 1。输入上限 1 MiB、100 步。输入内容经 shell 传递时，优先用文件或 heredoc，避免引号转义。

进程退出后连接和日志缓存随之消失，下一次执行要重新 `electron_attach`；`electron_logs` 只能读到本次执行期间观察到的事件。需要跨多轮保持连接或累积日志时，改为注册 MCP。环境变量保护参数（如 `ELECTRON_DEBUG_ALLOW_EVAL=0`）在两种方式下同样生效。

## 更新与迁移

更新时从原获准渠道安装完整的新 Skill 版本，按宿主方式停止旧 MCP，把配置指向新版本的实际 `runtime/launch.cjs`，重新核对来源和完整性后刷新宿主。

旧版本如果指向独立源码目录下的入口，必须切换到随包启动器。不要继续复用旧进程或旧构建产物，不覆盖用户的源码修改。升级不需要修改待诊断 Electron 项目。

普通诊断复用当前获准版本，不在每次调用时自动联网升级。运行文件缺失、版本不符或校验失败时报告 `BLOCKED`，不自动回退到下载和执行外部代码。

## Endpoint 与保护参数

MCP 通过 stdio 通信，不监听诊断服务端口。应用由 Agent 用项目已有命令启动并带上 `--inspect`、`--remote-debugging-port`；在调用 `electron_attach` 时传入实际回环 HTTP(S) discovery URL，或通过宿主提供环境变量：

```text
ELECTRON_DEBUG_MAIN_URL=<agent-provided-loopback-endpoint>
ELECTRON_DEBUG_CDP_URL=<agent-provided-loopback-endpoint>
```

可选保护参数沿用默认值，只有诊断确有需要时调整：

```text
ELECTRON_DEBUG_REQUEST_TIMEOUT_MS=<optional-request-timeout>
ELECTRON_DEBUG_DISCOVERY_TIMEOUT_MS=<optional-discovery-timeout>
ELECTRON_DEBUG_MAX_LOG_EVENTS=<optional-event-limit>
ELECTRON_DEBUG_MAX_LOG_BYTES=<optional-byte-limit>
ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES=<optional-protocol-message-limit>
ELECTRON_DEBUG_OUTPUT_DIR=<optional-screenshot-directory>
ELECTRON_DEBUG_ALLOW_EVAL=<optional, 0, false, off, no or disabled to disable evaluation>
```

默认值和允许范围（超出范围会返回 `ENDPOINT_CONFIG_INVALID`）：

| 变量 | 默认 | 范围 |
| --- | --- | --- |
| `ELECTRON_DEBUG_REQUEST_TIMEOUT_MS` | 3000 | 100 到 30000 |
| `ELECTRON_DEBUG_DISCOVERY_TIMEOUT_MS` | 3000 | 100 到 30000 |
| `ELECTRON_DEBUG_MAX_LOG_EVENTS` | 500 | 10 到 10000 |
| `ELECTRON_DEBUG_MAX_LOG_BYTES` | 1 MiB | 4096 字节到 16 MiB |
| `ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES` | 256 MiB | 4096 字节到 256 MiB |

`ELECTRON_DEBUG_ALLOW_EVAL` 是宿主在启动 Server 时设置的开关，批处理模式（`launch.cjs --run`）下由运行它的人设置：能自己执行命令的 Agent 可以不带这个变量运行，所以它约束的是宿主配置的 MCP Server，不是一道对 Agent 的强制边界。

`ELECTRON_DEBUG_OUTPUT_DIR` 指定截图目录，默认系统临时目录下的 `electron-agent-debug`，仅保留最近 50 张。`electron_evaluate` 和表达式型 `electron_wait_for` 默认开启（endpoint 只允许回环地址）；宿主在 `env` 中设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 可禁用，此时返回 `EVALUATION_NOT_ALLOWED`。单条协议消息上限默认 256 MiB，与 Puppeteer、Playwright 一致；可用 `ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES` 调小。

端口由 Agent 动态确定；不扫描端口，不猜测 target。主进程问题使用 Inspector，renderer 问题使用 CDP，preload/IPC 使用双通道。应用重启后由 Agent 重新 `electron_attach`；窗口重建后重新发现 target。

业务测试以及最终结论由 Agent 完成，MCP 提供状态、target、日志、检查结果和结构化错误。
