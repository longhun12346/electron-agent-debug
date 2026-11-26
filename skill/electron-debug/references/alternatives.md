# 未提供的能力与替代做法

| 需要 | 替代做法 | 限制 |
| --- | --- | --- |
| 看 renderer 发出的请求 | `electron_evaluate` 读 `performance.getEntriesByType('resource')`，含 `name`、`duration`，较新的 Chromium 还有 `responseStatus` | 只有 URL、状态、耗时，没有请求头和响应体；主进程发出的请求不在其中。需要这些字段时在项目代码里加日志 |
| 调用栈 | 未捕获异常的事件自带栈，直接读 `electron_logs`。要看某处是怎么被调用到的，在该位置加 `console.trace('标记')`，热更新或重启后触发，再读日志 | 栈最多保留 10 帧；`console.log`、`console.error` 等不带栈。不能改代码的位置（依赖库、打包产物）无替代 |
| 局部变量、中间值 | 在代码里 `console.log` 打印后读取日志；或直接用 `electron_evaluate` 读全局可达的状态 | 函数内部的局部变量只能靠打印 |
| 断点、单步 | 不提供。`debugger;` 在本工具连接下不会暂停，也不要自行启用调试器，暂停会冻住应用 | 代码改不了（依赖库、打包产物）时无替代 |
| 下拉选择、快捷键、拖拽、悬停 | 原生 `<select>` 用 `electron_evaluate`(renderer) 设 `value` 后派发 `change`；自定义下拉框用 `electron_click` 先点开再点选项；快捷键、拖拽、悬停用 `dispatchEvent` 模拟 | 模拟事件的 `isTrusted` 为 false；输入法组合输入（composition）也不覆盖，依赖它们的逻辑改用项目已有的测试工具 |
| 列出窗口 | `electron_evaluate`(main) 用 `process.mainModule.require('electron').BrowserWindow.getAllWindows()` | 只读窗口状态，不用于操作 |
| 内存 | main 用 `process.memoryUsage()`；renderer 用 `performance.memory`（Chromium 非标准接口） | 只是当前读数，不能做泄漏分析 |
| utility process 里的代码 | `electron_attach` 传 `utility`（fork 时的 `serviceName`，或 pid），成为独立的第三通道，再用 `electron_evaluate`(scope=`utility`) 和 `electron_logs`(process=`utility`) 观察 | 需要主进程通道在线且允许求值，细节见下面的“utility process”一节 |
| `<webview>` 里的页面 | 出现在 `targets` 里（`type` 为 `webview`），用 `electron_targets` 传它的 `targetId` 选中后，求值、日志、截图和无障碍树都作用于它；检查完再选回窗口 | 不会被自动选中；一次只连一个页面 |
| worker、跨域 iframe 里的代码 | 不能直接连接。让它们用 `postMessage` 把值传回页面，再用 `electron_evaluate`(renderer) 读取或打印；同源 iframe 可通过 `iframe.contentDocument` 读取 | 这些目标里的日志和求值不在工具范围内 |
| 原生对话框、菜单 | 提示用户人工操作 | 见 SKILL.md 工作流第 3 步 |
| 原生模块（koffi、`.node` 插件）里从 JS 调用跟到原生函数执行 | 先用本工具留下日志、触发操作，再经用户同意安装外部调试器 MCP 下断点、看栈（Windows 用 mcp-windbg，macOS/Linux 用 LLDB 的 MCP），见 [native.md](native.md) | 本工具只看 JS 层；原生栈要符号才有用，附加或下断点会冻住应用，本工具的请求会超时；崩溃和卡死没有验证过的流程 |

## utility process

- 工具通过已连接的主进程用 `app.getAppMetrics()` 找到该进程，打开调试口并连接，与 main、renderer 同时在线。不需要自己查 pid 或调用 `process._debugProcess`。
- 同名进程有多个时用 pid；一次只连一个 utility，再次 attach 其他 utility 会替换当前连接。
- 前提：主进程通道在线，且未设置 `ELECTRON_DEBUG_ALLOW_EVAL=0`。
- 调试口默认端口 9229，被占用时开口不报错也不会生效，attach 会返回 `UTILITY_INSPECTOR_UNAVAILABLE`。此时，或同时调试多个 utility 时，让 fork 带 `execArgv: ['--inspect-port=<各自空闲端口>']`（只指定端口，不自动开启）。
- 开口用的 `process._debugProcess` 是未公开接口，随 Electron 版本可能变化，以 attach 结果为准（CI 在固定的 Electron 版本上实测）。查端口用 netstat（Windows）或 lsof（macOS、Linux）；命令无法运行时，错误的 `details.portLookupError` 会给出原因。
