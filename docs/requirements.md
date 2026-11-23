# 需求说明

## 0. 项目定位

本项目是一个面向编码 Agent 的 Electron 双通道诊断能力和使用指南，不是通用 Electron 调试器，也不是业务验收系统。

核心场景是：Agent 修改 Electron 项目代码后，attach 到 Agent 已启动的应用，获取运行时事实和证据，并在需要时执行表达式、等待条件、截图和读取无障碍树。

项目价值来自以下组合：

- 同时观察 Electron 主进程和渲染进程。
- 把 preload、contextBridge 和 IPC 问题放到两个进程之间联合诊断。
- 提供能力为先：工具拥有运行时检查能力，应用启动交给 Agent；Skill 只提供指导和建议。
- 工具输出结构化、有界、脱敏、仅限回环，不含项目专属逻辑。
- 返回适合 Agent 消化的结构化状态、日志、异常和连接错误；最终诊断结论由 Agent 结合项目回归结果自行判断。

## 1. 背景

Electron 应用的主进程和渲染进程使用不同的调试入口：

- 主进程通过 Node Inspector 暴露 Agent 提供的调试 endpoint。
- 渲染进程通过 Chromium DevTools Protocol 暴露 Agent 提供的调试 endpoint。

编码 Agent 需要同时查看两个进程的状态，才能处理白屏、窗口创建失败、preload 注入失败、IPC 失效、主进程异常和前端运行时错误等问题。

现有大型 Electron 调试工具的工具数量和依赖较多。本项目保持轻量实现，只提供 Agent 调试真正需要的工具集（当前 10 个），并通过一个薄 Skill 给出使用建议。

## 2. 目标

### 2.1 产品目标

让本地编码 Agent 能够在需要诊断 Electron 应用时，连接 Agent 已启动的运行中应用，并获得以下能力：

1. 识别主进程 Inspector 和渲染进程 CDP 是否可用。
2. 选择正确的渲染窗口。
3. 根据修改范围判断主进程、preload/IPC 或渲染进程。
4. 读取已连接进程的日志和异常；执行表达式、等待条件、截图和读取无障碍树。应用进程的 stdout、退出码与退出原因由启动它的 Agent 自行捕获。当前版本不提供源码级调试，也不提供原生对话框替身。
5. 使用项目已有命令，根据修改范围重启 Electron（并重新 attach）或 reload 当前窗口。
6. 重新读取日志和状态，为 Agent 自己的分析和报告提供证据；业务级视觉判断仍由项目已有测试或 Agent 自行完成。

### 2.2 技术目标

- MCP Server 使用 stdio 与 Agent 通信。
- MCP Server 使用 WebSocket 连接 Node Inspector 和 CDP。
- 只允许连接回环地址：`127.0.0.1`、`::1` 或 `localhost`。
- 不设置任何固定端口。Agent 按诊断范围提供实际 endpoint；至少提供一个 endpoint 才能执行 attach。
- 当前对外工具共 10 个：attach、status、targets、logs（Phase 1 基线），evaluate、wait_for、screenshot、dom_snapshot，以及最小交互 click、type。会弹出原生对话框的流程由 Agent 提示用户人工操作，不提供自动化替身。
- 表达式执行必须有超时和结果大小限制，默认开启，宿主可用 `ELECTRON_DEBUG_ALLOW_EVAL=0` 禁用。
- 渲染进程 reload 或窗口销毁后，Agent 再次调用 `electron_attach` 或 `electron_targets` 时能够重新发现 target。
- 连接断开后，`electron_attach` 或 `electron_targets` 会进行有限恢复；`electron_status` 和 `electron_logs` 只返回当前已缓存的状态和事件。

### 2.3 轻量性判定

以下条件保持工具轻量：

- 不新增与诊断无关的工具；每个工具返回结构化、有界、脱敏的结果。
- MCP Server 不启动、停止或重启应用，只 attach 到 Agent 已启动的应用；不扫描或猜测应用。
- 只管理一个 Agent 会话和当前 page target，不递归管理 iframe、worker 或多客户端共享状态；webview 只能作为当前 target 显式选择。
- 只在工具调用期间进行有限恢复，不运行持续轮询或无限期后台重连。
- 不依赖业务项目的专属逻辑；evaluate 默认只连接回环地址的应用。
- 不引入 Playwright、浏览器下载器、桌面自动化框架或完整 CDP 封装。

## 3. Agent 前提契约

MCP Server 不负责猜测项目入口、选择开发命令或启动 Electron。

Agent 按诊断范围向 MCP Server 提供 endpoint：

- 需要主进程诊断时提供主进程 Inspector endpoint。
- 需要渲染进程诊断时提供渲染进程 CDP endpoint。
- 至少提供一个 endpoint 才能执行 attach；缺少的另一个通道返回独立的未配置状态。

Agent/Skill 上下文中的前提：

- 项目工作目录。
- 应用启动或重启命令，或者已经运行的 Electron 应用。
- 本次修改的预期行为或可观察的回归操作。
- 项目已有的测试、检查命令或可观察回归步骤；MCP Server 不替 Agent 执行业务操作。
- 多窗口场景下的 target 选择条件。

Agent 可以通过终端或项目已有脚本启动、停止和重启应用；这些动作不属于 MCP Server 的能力。

Agent 需要先准备或确认 Electron 应用已经通过项目已有命令启动，并提供实际的 Inspector/CDP endpoint，例如：

```powershell
electron --inspect=<main-inspector-port> --remote-debugging-port=<renderer-cdp-port> .
```

实际项目的启动参数可能由 `npm run dev`、Vite、Webpack 或自定义脚本注入。MCP Server 不假设 Electron 的入口文件，也不修改用户的启动脚本。Agent 如果无法确定启动命令或实际 endpoint，应报告前提缺失，不应把应用问题误判为代码问题。

当前版本实际支持的环境变量只有 endpoint 和运行时上限配置：

```text
ELECTRON_DEBUG_MAIN_URL=<agent-provided-loopback-main-url>
ELECTRON_DEBUG_CDP_URL=<agent-provided-loopback-renderer-url>
ELECTRON_DEBUG_REQUEST_TIMEOUT_MS=<optional-request-timeout>
ELECTRON_DEBUG_DISCOVERY_TIMEOUT_MS=<optional-discovery-timeout>
ELECTRON_DEBUG_MAX_LOG_EVENTS=<optional-event-limit>
ELECTRON_DEBUG_MAX_LOG_BYTES=<optional-byte-limit>
ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES=<optional-protocol-message-limit>
```

可选的运行时配置（宿主设置，不是 Agent 参数）：

- `ELECTRON_DEBUG_ALLOW_EVAL=0`（或 `false`）：禁用 evaluate 和 expression 型 wait_for，此时这些工具返回 `EVALUATION_NOT_ALLOWED`。默认开启，因为 endpoint 只允许回环地址。
- `ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES`：单条协议消息上限，默认且最大 256 MiB（与 Puppeteer、Playwright 的 `maxPayload` 一致）。
- `ELECTRON_DEBUG_OUTPUT_DIR`：截图输出目录，默认系统临时目录下的 `electron-agent-debug`。

endpoint 配置只接受用于 discovery 的本地 HTTP(S) URL；MCP 不接受 Agent 直接传入任意 WebSocket URL。discovery 返回的 WebSocket 地址必须再次校验协议和回环主机，不能因为它来自本地 HTTP 响应就跳过校验。

## 4. MCP 工具需求

### P0：核心诊断能力

#### `electron_attach`

连接主进程 Inspector 和渲染进程 CDP，并返回：

- 主进程连接状态
- 渲染进程 target 列表
- 当前选中的 target
- Inspector/CDP 端点
- 协议错误

输入可以包含本次连接使用的 endpoint：

```json
{
  "mainUrl": "http://127.0.0.1:<agent-chosen-main-port>",
  "rendererUrl": "http://127.0.0.1:<agent-chosen-renderer-port>",
  "targetId": "<optional-target-id>",
  "url": "<optional-target-url>",
  "title": "<optional-target-title>",
  "clearSelection": false
}
```

endpoint 解析优先级为：

1. 本次 `electron_attach` 输入。
2. MCP Server 启动时的 `ELECTRON_DEBUG_MAIN_URL`、`ELECTRON_DEBUG_CDP_URL`。
3. 当前 Server 中已经建立的同一通道 Session 配置，用于幂等重连。
4. 没有默认值。

要求：重复调用必须幂等；endpoint 不存在或不可用时返回可读错误，不得让 MCP Server 退出。主进程和渲染进程必须独立连接；一个端点不可用时，另一个端点仍应返回可用状态和观察结果。只有请求无法处理或全部 endpoint 缺失时，工具才返回顶层错误。endpoint 发生变化时，必须先关闭旧 Session，再创建新 Session。

#### `electron_status`

返回：

- 主进程是否在线
- 当前渲染 target 是否在线
- 主进程和渲染 target 的公开 Session 状态：`unconfigured`、`offline` 或 `online`。`connecting` 和 `stale` 只作为内部过渡状态，不要求 Agent 依赖。
- Electron target URL、标题和类型
- 最近一次连接时间
- 最近一次断开原因
- 最近的 console/exception 数量
- 当前 endpoint 配置来源：`attach_input`、`environment` 或 `session`
- 当前 `lastSeq`，用作之后用 `afterSeq` 读取新事件的基线

#### `electron_targets`

读取并返回 discovery 返回的渲染进程 CDP page targets，至少包含：

- target id
- type
- title
- URL
- webSocketDebuggerUrl
- favicon URL（如果存在）

输入可以包含 `targetId`、`url`、`title` 或 `clearSelection`；这些条件只用于选择当前 page target，不改变发现到的 target 列表。`clearSelection=true` 用于清除之前保存的 target 选择条件和当前选择，再按当前 target 列表重新选择。只有发现单个带有可连接 WebSocket 的 page target 时才允许自动选择；应用打开的 DevTools 窗口（URL 以 `devtools://` 开头）不参与这个计数，仍会出现在 target 列表中，也可以用 `targetId` 显式选择，只有它一个 page 时则选它。`<webview>`（`type` 为 `webview`）同样列出、可显式选择，但从不自动选择。没有可连接 target 时返回 `TARGET_NOT_FOUND`，存在多个可连接候选且 Agent 没有提供选择条件时，返回 `TARGET_SELECTION_REQUIRED`（`details.count` 不含 DevTools 和 webview）。

原来选中的页面消失后（窗口被关闭重开、换成新的 target），重新发现时若自动选中了另一个页面，结果的 `warnings` 带 `TARGET_CHANGED`（`details.previous`、`details.selected` 给出两个页面的 id、title、url）；传 `clearSelection` 或换了 endpoint 时不提示。renderer endpoint 的 `/json/version` 里 User-Agent 不含 `Electron/` 时带 `RENDERER_NOT_ELECTRON` 警告。attach 和 targets 的结果总有 `warnings` 数组。

#### `electron_logs`

读取最近的主进程和渲染进程日志，支持：

- 按进程筛选
- 按级别筛选
- 按时间范围筛选
- 限制返回条数
- 清空内存缓存

至少收集 `consoleAPICalled`、`exceptionThrown` 和协议连接错误。日志只代表 Session 建立之后观察到的事件，不承诺提供 attach 之前的历史日志。`clear` 只清空当前 MCP Server 进程内对应 Session 的有界内存缓存，不删除项目日志、不影响 Electron 应用，也不影响其他 Server 进程。

`since` 必须是可解析的日期时间字符串；格式无效时返回参数错误，不返回空日志作为替代。

`process` 可取 `main`、`renderer`、`utility` 或 `all`。三个通道的事件共享递增的 `seq` 并按其排序；结果返回 `lastSeq`，`afterSeq` 只返回其后的事件，用于续读。应用进程自己的 stdout、stderr 不进入时间线，由启动应用的 Agent 自行捕获。所有事件消息在写入缓存前脱敏。

缓冲区满时最旧的事件会被丢弃。结果同时返回 `droppedThroughSeq`（所请求范围内被丢弃的最大 `seq`，没有丢弃时为 0）和 `gap`（`droppedThroughSeq` 大于 `afterSeq`，未传 `afterSeq` 时与 0 比较；为 `true` 表示所请求的范围内可能有事件缺失）。`clear` 会重置对应缓冲区的丢弃记录，Agent 主动清空的事件不算丢失。`electron_status` 也返回当前 `lastSeq`，回归前可直接取得基线，不必先读一次日志。

attach 时 Chromium 和 Node 会把应用此前的 console 输出重放给新连接，这些事件排在该通道的 `Session connected` 事件之前。`sinceAttach: true` 让每个通道只返回它最近一次连接之后的事件；它与 `afterSeq` 取较大者，按通道分别计算，`gap` 也以各通道的边界为准。连接事件即使被淘汰或被 `clear` 清掉，边界仍然保留。

### P0：运行时检查

#### `electron_evaluate`

在主进程 Inspector、当前选中的 renderer target 或已连接的 utility process 执行 JavaScript（`Runtime.evaluate`，默认等待 Promise）。先按普通模式执行；遇到顶层 `await` 或与旧声明重名的语法错误时（代码尚未运行）改用 `replMode` 重试，仍重名则放进代码块内执行，该次声明不保留。

```json
{
  "scope": "main",
  "expression": "process.mainModule.require('electron').app.getName()"
}
```

- 宿主设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 时返回 `EVALUATION_NOT_ALLOWED`。
- 默认超时 3 秒（100 毫秒至 30 秒），结果默认最多 64 KiB（256 B 至 1 MiB）；超限时返回截断文本并标记 `truncated`。
- 返回值按值序列化，不可序列化值（如 `NaN`）转为文本；异常返回 `EVALUATION_FAILED`；结果和错误文本经过脱敏。
- 主进程全局没有 `require`，使用 `process.mainModule.require('electron')`。
- 表达式可能修改应用状态，只用于验证；超时或断线必须返回明确错误，不得视为验证成功。

#### `electron_wait_for`

等待一个条件成立，超时返回 `WAIT_TIMEOUT`（含最后的 `lastSeq` 和最近错误）。二选一：

- `log`：事件消息包含 `contains`，可限定 `process`、`level`，默认也检查已缓存事件，`afterSeq` 只看其后事件，`sinceAttach` 只看各通道最近一次连接之后的事件（规则同 `electron_logs`）。命中的事件早于该通道最近一次连接（attach 时重放的历史，或之前连接期间的输出）时，结果带 `beforeAttach: true` 和 `hint`：同样的文本常来自上一轮操作，不能证明本次操作的结果。默认不排除这些事件，因为启动期间、attach 之前发生的错误也是要读的证据。
- `expression`：按 `intervalMs`（50 毫秒至 5 秒）反复执行表达式直到返回真值，规则同 evaluate。

`timeoutMs` 默认 10 秒，上限 120 秒。

#### 错误提示与对话框

所有错误保留底层报错作为 `message`，可附可选的 `hint` 说明下一步。attach 失败按原因给出提示：端口没有进程监听（`ECONNREFUSED`，提示启动参数、`ELECTRON_RUN_AS_NODE`、`EnableNodeCliInspectArguments` fuse）、端口不响应、端口有响应但返回的不是调试协议、`mainUrl` 实际是 renderer 端口（返回 page 而没有 node target，不连接）、`rendererUrl` 实际是主进程 Inspector（只有 node target）。

`electron_status` 和各通道快照的 `dialogs` 列出等待用户操作的对话框：renderer 通过 `Page.javascriptDialogOpening/Closed` 报告页面的 JavaScript 对话框；允许求值时，主进程在 attach 后包装 `dialog` 模块的函数，通过 `Runtime.addBinding` 报告打开和关闭（Electron 自己为页面 alert 调用的不报告，避免重复）。每项含 `process`、`kind`（`javascript` / `native`）、`type`、`blocking`、脱敏截断后的 `title`/`message` 和 `openedAt`。打开和关闭写入时间线（`kind: "dialog"`）。有阻塞的对话框时请求超时，错误的 `hint` 说明原因，`details.dialog` 给出对话框。页面崩溃时对话框随页面消失，Chromium 不发 Closed 事件，记录在 `Inspector.targetCrashed` 时清除，日志写 `closed (the page crashed)`。alert 打开时 reload 不需要特殊处理：被阻塞的页面要等对话框关闭后才会导航，那时 Closed 事件已经到达（Electron 43 实测）。

#### `electron_screenshot`

对当前 renderer target 截图，保存到 `ELECTRON_DEBUG_OUTPUT_DIR`（默认系统临时目录下的 `electron-agent-debug`），返回路径、字节数、格式、图片的 `width` 和 `height`、`deviceScaleFactor`、target 和 URL，不返回图像内容。支持 `png` 和 `jpeg`（含 `quality`）。默认按 `Page.getLayoutMetrics` 的 CSS 视口尺寸截图，高分屏不成倍放大；`maxWidth`（100–8000）进一步缩小，大于 CSS 宽度时最多取到设备分辨率。取不到布局信息时按 Chromium 默认截图。目录权限 0700、文件权限 0600，只保留最近 50 张。窗口被隐藏或最小化时 Chromium 不响应，调用超时失败。

#### `electron_dom_snapshot`

读取当前 renderer 的无障碍树（`Accessibility.getFullAXTree`），渲染为缩进文本（`role "name" value=".." [状态]`），忽略的节点被穿透，已包含在父节点名字里的静态文本不再单独输出，链接 url 里超过 30 个字符的查询串缩写为 `?…`（保留 hash），输入框的值经过脱敏。节点数有上限（默认 400，最多 2000），超限标记 `truncated`。`interactive: true` 只输出带 ref 的节点和标题，长列表页面也能放下全部可交互元素（实测 150 条会话的侧栏：155 行，不截断）。不在页面执行脚本，附加模式也可使用。

可点击或可输入的节点（button、link、checkbox、radio、switch、tab、menuitem、option、treeitem、textbox、searchbox、combobox、spinbutton、slider、listbox 等）且对应 DOM 节点时，行尾带 `[ref=…]`，结果带 `refCount`。ref 由每个进程随机的三个字母前缀加序号组成（如 `kqx12`）。同一页面里同一 DOM 节点的 ref 在多次快照间不变；只接受当前选中页面最近一次快照里的 ref。前缀的作用：批处理每次执行都是新进程，若都从同一编号开始，上一次执行的 ref 在页面变化后会指向另一个元素并被静默点击（实测：Save 的 ref 点到了 Name 输入框，结果为 ok）；有了前缀，这样的 ref 返回 `REF_NOT_FOUND`，`hint` 建议改用 role 和 name。

#### `electron_click`

输入 `ref`，或 `role` 加 `name`（二选一），可选 `doubleClick`。按 role 和 name 时先读取整个页面的无障碍树（不受快照行数上限影响，并作为最近一次快照），按完全一致匹配（name 的空白归一），多个匹配返回 `ELEMENT_AMBIGUOUS` 并列出候选，没有匹配返回 `ELEMENT_NOT_FOUND` 并列出名字相近的元素。之后依次：解析 ref（不在最近一次快照里 `REF_NOT_FOUND`，属于别的页面或节点已不在文档里 `REF_STALE`）；检查禁用（`ELEMENT_DISABLED`）；`DOM.scrollIntoViewIfNeeded`；取 `DOM.getContentQuads` 最大四边形的中心（视口 CSS 像素，高分屏无需换算），没有可点区域时 `ELEMENT_NOT_VISIBLE`；在该点做 `DOM.getNodeForLocation`（加上滚动偏移换成文档坐标），命中的不是元素本身、其后代或关联 label 时返回 `ELEMENT_COVERED` 并在 `details.coveredBy` 描述挡住它的元素，不点击；最后用 `Input.dispatchMouseEvent` 发送 moved、pressed、released，页面收到的事件 `isTrusted` 为 true。返回 ref、role、name、坐标和 `afterSeq`（操作前的 `lastSeq`）。不内置等待，结果由 Agent 用 `electron_wait_for` 或 `electron_logs` 的 `afterSeq` 观察。

#### `electron_type`

元素的指定方式同 `electron_click`，另有 `text`，可选 `clear`（默认 true）、`submit`。目标必须是可编辑的文本输入、textarea 或 contenteditable 且未禁用、非只读，否则 `ELEMENT_NOT_EDITABLE`。聚焦后全选已有内容（`clear: false` 时把光标放到末尾），用 `Input.insertText` 写入，空文本且 clear 时按 Delete；`submit` 时再按 Enter。返回输入后的 `value`（密码框为 `[REDACTED]`，其余脱敏，最多 500 字符）。`insertText` 不产生 composition 事件。

点击和输入都在 `ELECTRON_DEBUG_ALLOW_EVAL=0` 时返回 `INTERACTION_NOT_ALLOWED`。输入事件超时且页面处于 hidden 状态时，`hint` 提示先恢复最小化的窗口。

重连、target 重新发现和 Session 重建属于 MCP Server 内部行为，不单独暴露为工具。`electron_attach` 必须幂等，并在连接失效时重新发现端点和 target。

### P1：可选调试增强

#### `debugger_breakpoint`

支持设置和删除基于 URL、行号和列号的断点，分别支持主进程和渲染进程。

#### `debugger_control`

支持 pause、resume、stepOver、stepInto、stepOut 和读取最近一次暂停的调用栈。

#### `ipc_trace`

记录指定 IPC channel 的发送方向、参数摘要、时间和结果。默认不记录完整敏感参数。

P1 不属于当前交付。只有现有工具仍无法提供编码后验证所需的运行时事实时，才评估是否需要接入已有调试能力。

## 5. Skill 需求

Skill 不直接实现协议连接，负责指导 Agent 使用 MCP 工具。

Skill 必须明确以下判断规则：

- 启动、窗口创建、文件系统、数据库、自动更新、IPC handler 和进程崩溃问题，优先检查主进程。
- DOM、页面白屏、前端异常、事件绑定、网络请求和视觉问题，优先检查渲染进程。
- preload、contextBridge 和 IPC 问题必须同时检查主进程与渲染进程。
- 主进程代码或 preload 修改后必须重启 Electron。
- 渲染进程代码修改后优先 reload 当前 target。
- 调用 `electron_evaluate` 前先说明目的、执行上下文和预期结果，避免执行破坏性表达式。
- 先收集日志和状态，再执行表达式；不能一开始就盲目修改运行时状态。
- 每次编码修改由 Agent/Skill 根据预期行为和观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`。
- `PASS` 必须有可复核的运行时证据；`FAIL` 必须指出异常或不符合预期的观察结果；`BLOCKED` 必须说明缺少的前提。
- MCP Server 只返回工具调用状态、结构化观察结果和连接错误，不判断业务是否修复成功。
- `FAIL` 不要求已经确定根因；证据不足时，Agent 必须标明根因未确定或仅为当前最可能原因。
- 对于 preload/IPC 问题，至少保留主进程和渲染进程各一项证据。

## 6. 非功能需求

### 安全

- 只允许 `127.0.0.1`、`::1` 或 `localhost`。
- 不接受 Agent 传入任意远程 WebSocket URL。
- 主进程或渲染进程执行代码默认开启（仅回环 endpoint），宿主可用 `ELECTRON_DEBUG_ALLOW_EVAL=0` 禁用。
- 截图写入 `ELECTRON_DEBUG_OUTPUT_DIR`（默认系统临时目录），文件名由工具生成，权限为仅当前用户可读写。
- 日志、应用输出、异常和表达式结果必须经过大小限制、可序列化处理和常见密钥脱敏，不能无界回显敏感内容。
- 错误信息不得泄露环境变量、完整本地路径以外的敏感内容。

### 稳定性

- 单个 WebSocket 断开不得导致 MCP Server 退出。
- 工具调用必须返回结构化错误。
- 对 reload、窗口关闭、Electron 重启和 target id 变化进行处理。
- 事件缓存使用上限，避免无限增长。

### 性能

- 普通状态查询目标响应时间小于 1 秒。
- 表达式执行默认超时 3 秒，上限 30 秒，结果默认 64 KiB、上限 1 MiB。
- 日志事件缓存按条数和字节数限制；DOM 快照有节点数上限（默认 400，最多 2000）。
- 不做持续网络抓取；截图、evaluate 和 wait_for 都只在工具调用期间执行，wait_for 有超时上限（120 秒）。
- 不进行无限期后台重连；断线恢复只在工具调用或 `electron_attach` 时进行有限尝试。

## 7. 非目标

- 由 MCP Server 替用户猜测开发命令、入口文件或窗口，或同时管理多个应用。
- 提供完整桌面 UI 自动化。点击和输入只到“按无障碍树 ref 操作当前页面”为止，不做拖拽、悬停、快捷键、原生 `<select>` 的键盘选择、输入法组合输入或录制回放；交互之后的验证仍由 Agent 用诊断工具完成。
- 提供完整网络录制、性能分析、heap snapshot、HAR 导出或源码级调试器。
- 连接公网或局域网中的远程 Electron 应用。

### 职责边界

- Agent/Skill 负责最终验收、问题归属、根因解释和是否修复的判断。
- MCP Server 负责连接、协议、target、日志和状态，以及受控的运行时检查（evaluate、wait_for、截图、DOM 快照）。
- MCP Server 不读取源码、不修改项目文件、不执行 git 操作，也不替代 Agent 的代码分析。
- MCP Server 只 attach 到 Agent 自行启动的应用，不管理其生命周期；不猜测入口、不扫描端口。
- Agent 必须在调用 MCP 前准备工作目录、调试端点和本次修改的预期行为或回归操作。
- Agent 如果无法提供这些前提，应报告前提缺失，而不是宣称代码失败或修复成功。
- 主进程和渲染进程使用独立 Session；preload 和 IPC 问题由 Agent 联合使用两个 Session 判断。
- 第一阶段只处理当前 Electron page target（可显式选择 webview），不递归管理 iframe、worker 或其他浏览器 target。
- 表达式执行只连接回环地址的应用，可由宿主禁用。
- fixture 负责启动应用、注入故障和定义预期行为；MCP Server 只负责连接 fixture 并返回观察结果。

## 8. 验收标准

### 连接

- Agent 至少提供一个有效的本地 endpoint 后，可以在 3 秒内完成 attach；缺少的通道返回独立的未配置状态。
- Agent 提供的主进程 endpoint 不可用时，MCP Server 仍能保持运行，并返回主进程不可用状态。
- 渲染窗口 reload 后，Agent 可以重新发现并连接 target。

### 双进程诊断

- 主进程 console 异常和渲染进程 console 异常能够分别读取。
- Agent 可以通过状态、target 和日志结果获得主进程、渲染进程以及 preload/IPC 问题的核心运行时事实；具体 API 返回值、DOM 内容和业务结果由项目已有检查或 Agent 的回归操作提供，未来扩展不属于当前前提。

### 生命周期与检查能力验收

- `electron_evaluate` 能返回主进程和 renderer 的值；异常、超大结果、不可序列化值和超时都有结构化结果；密钥被脱敏。
- evaluate 和 expression 型 wait_for 在宿主设置 `ELECTRON_DEBUG_ALLOW_EVAL=0` 时被拒绝（`EVALUATION_NOT_ALLOWED`）；DOM 快照不受限。
- `electron_screenshot` 生成可打开的 PNG 文件并只保留最近 50 张；窗口隐藏或最小化时超时失败并提示。

### Skill 工作流

- Agent 能根据白屏问题选择渲染进程工具。
- Agent 能根据窗口创建失败选择主进程工具。
- Agent 能识别 preload/IPC 问题需要同时检查两个端点。
- Agent 修改代码后能按规则重启或 reload，并完成回归验证。

### 安全

- 连接 `192.168.x.x` 或公网地址时被拒绝。
- `ELECTRON_DEBUG_ALLOW_EVAL=0` 时 evaluate 被拒绝并给出清晰提示。
- 截图只写到输出目录内，文件名由工具生成。

### Agent 使用验证

- 主进程窗口创建失败的 fixture 能提供结构化主进程证据。
- 渲染进程白屏或异常的 fixture 能提供结构化渲染进程证据。
- preload/IPC 失效的 fixture 能提供结构化的两边证据。
- 应用未启动、端点不可用或缺少目标窗口时，MCP 返回结构化连接错误。
- Agent 可以根据这些能力和 Skill 指引完成自己的分析和报告。

## 9. 编码后验证流程

### 修改主进程或窗口生命周期

1. 先调用 `electron_attach` 和 `electron_status`。
2. 读取主进程日志和异常。
3. 检查渲染 target 是否存在，确认窗口创建结果。
4. 主进程或 preload 修改后重启 Electron。
5. 重新 attach，验证窗口状态、IPC 结果和渲染页面。
6. 根据 MCP 返回的观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`。

### 修改渲染进程

1. 先调用 `electron_attach`、`electron_targets` 和 `electron_logs`。
2. 选择当前目标窗口。
3. 检查页面 URL、标题、关键 DOM 或运行时异常。
4. 渲染代码修改后优先 reload 当前 target。
5. 重新读取日志；可用 `electron_dom_snapshot` 和 `electron_screenshot` 取得页面证据，业务交互问题由项目已有测试或其他 Agent 工具补充。
6. 根据 MCP 返回的观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`。

### 修改 preload 或 IPC

1. 同时检查主进程和渲染进程。
2. 通过项目已有检查或回归操作验证 `contextBridge` 暴露的 API 是否存在。
3. 通过项目已有检查或回归操作检查 IPC handler 是否注册以及调用是否返回；MCP 只收集两边产生的日志和异常。
4. preload 修改后重启 Electron。
5. 页面侧和主进程侧各保留一项验证证据。
6. 根据 MCP 返回的观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`。

## 10. 实现阶段

### Phase 0：协议与连接骨架

- 根据官方文档锁定 MCP SDK 包名和版本，并提交依赖锁文件。
- 初始化 TypeScript 项目并接入 MCP stdio server。
- 实现本机端点校验、端点发现和 WebSocket 会话管理。
- 确保 MCP stdio 的 stdout 不被调试日志污染。

### Phase 1：核心诊断工具（基线）

- 实现主进程和 renderer Session。
- 实现 `electron_attach`、`electron_status`、`electron_targets` 和 `electron_logs`。
- 实现事件归一化和有界内存缓存。
- 实现日志和异常缓存。
- 实现按工具调用触发的有限恢复。
- 处理单通道缺失、部分连接成功、target 重新发现和 target 选择不明确。

### Phase 2：fixture、Skill 和契约验证

- 创建三类最小 Electron fixture。
- 编写核心工具契约测试和端到端验收脚本。
- 完成项目级 Skill。
- 增加修改范围到诊断通道的判断规则。
- 增加重启、reload、连接恢复和证据要求。

### Phase 3：能力优先扩展（已实现）

设计取向：Skill 只提供指导和建议，提供能力才是最重要的。工具直接拥有运行时检查能力，输出保持结构化、有界、脱敏、仅限回环，且不含任何项目专属逻辑。

- 运行时检查：`electron_evaluate`、`electron_wait_for`、`electron_screenshot`、`electron_dom_snapshot`。
- 统一时间线：main、renderer、utility 事件共享递增 `seq`，日志支持 `afterSeq` 续读和 `lastSeq`。
- Skill 收敛为薄页面：何时使用、按修改类型列出的证据矩阵、工具组合方式。

仍未实现：断点、暂停、单步、调用栈、IPC trace、source map、原生对话框和菜单替身。与 MCP 共享核心的命令行入口以批处理模式（`launch.cjs --run`）提供，`launch.cjs --tools [工具名 ...]` 打印工具描述和 JSON Schema 作为批处理调用方的 `tools/list`；跨调用保持连接的常驻 CLI 未实现。

## 11. 成功标准

一个首次接触项目的编码 Agent，在知道实际调试 endpoint、用户问题和本次修改范围的情况下，能够：

1. 通过 MCP 连接两个进程，或明确报告端点不可用。
2. 判断问题属于主进程、preload/IPC 还是渲染进程。
3. 收集完成判断所需的最小核心运行时证据，并结合项目已有检查或回归操作补足业务证据。
4. 修改代码后重新验证。
5. 根据 MCP 提供的观察结果输出 `PASS`、`FAIL` 或 `BLOCKED`，并说明原因和证据。
