# 平台描述

本文件是 Skill 在发布平台上展示的描述，不进入 Skill 包。发布或更新时，简要描述和详细描述（取两个标记之间的内容）分别填入平台的对应字段。

平台上的描述与 `SKILL.md` 是两份独立文本，容易各自过期。修改工具数量、支持的平台和 Node.js 版本、参数、环境变量、新增或移除能力时，先改这里，再发布。`tests/platform-description.test.ts` 会核对简要描述长度、工具数量、Node.js 版本，以及文中出现的环境变量、错误码和参数名是否存在于源码；条件有没有写全、风险是否醒目这类事要人工对照，发布前的完整清单见 [CONTRIBUTING.md](../CONTRIBUTING.md) 的“Skill 发布构建”。

写法的几条原则：开头回答“遇到什么问题时用它”；重点前置，一段只讲一件事；风险和边界放在读者一定会看到的位置；带条件的能力要把条件写全，不用“自动”“完整”“所有”这类无条件说法；用词与 `SKILL.md` 一致（主进程、renderer、通道、target）；不写会过期的说法，写了就要有出处。

## 简要描述

验证 Electron 改动是否生效：读主进程与 renderer 日志，求值、截图、点击输入，并能从 JS 调用一路跟到 koffi、.node 原生函数里调试。

## 详细描述

<!-- detail:start -->
# Electron Agent Debug

验证 Electron 改动是否生效：读主进程与 renderer 日志，求值、截图、点击输入，并能从 JS 调用一路跟到 koffi、.node 原生函数里调试。

## 功能简介
本技能解决 Agent 修改 Electron 代码后无法确认应用实际运行结果的问题。它以只连接的方式接入已运行的应用，通过主进程 Inspector、renderer 的 CDP 和 utility process 三个通道（可只连一部分）提供 10 个工具：连接、状态、target 选择、带 seq 游标的统一日志时间线、求值、条件等待、截图、无障碍树快照，以及按元素引用点击和输入。运行时不启动或停止应用，业务回归和最终结论由 Agent 完成。

**原生模块调试是本技能的特色**：Electron 项目常用 koffi 或 `.node` 插件调用原生代码，原生函数结果不对时，只看 JS 层找不到原因。本技能把调试从 JS 延伸到原生：先用本工具留下 JS 侧证据，再指引 Agent 经你同意安装成熟的外部调试器 MCP（Windows 用 mcp-windbg 驱动 cdb），在原生函数或源码行上下断点，看栈、参数和局部变量，对照原生源码定位问题；修改原生代码、重新编译部署后再验证。从 JS 调用到原生函数执行、改代码重新验证、应用启动时就执行的原生调用，这三条链路都在 Windows 上用真实项目和本机编译的原生模块实测过。

## 适用场景
- **原生模块（koffi、`.node` 插件）结果不对，要从 JS 调用一路调试到原生函数**：本工具只看 JS 层，原生部分交给外部调试器，Skill 把两边串成一条流程：
  - 先用本工具留下 JS 侧证据：触发操作的 `seq`、主进程 pid、调用原生函数的 JS 位置和参数
  - 找原生源码和符号；本机找不到就问你原生仓库在哪、哪个分支对应这份二进制、能不能给带调试信息的 Debug 构建
  - 经你同意安装调试器 MCP（Windows：mcp-windbg 加 cdb；Linux、macOS：gdb 或 lldb 命令行），附加到主进程，在原生函数或源码行上下断点
  - 触发 JS 调用，断点命中后看栈、参数和变量，对照源码和 JS 侧的假设定位原因；含中文等非 ASCII 的字符串看原始字节
  - 修复后重新编译、部署，重启应用并重新连接，再验证
  - 应用启动时就执行的原生调用：让应用在调试器下启动，或用 --inspect-brk 暂停后再放行
  - 示例：原生模块的函数返回值不对，帮我从 JS 调用一路调试到原生代码，定位原因后修复并验证

- **主进程或窗口修改后的运行时验证**：修改主进程启动逻辑、BrowserWindow 创建后，确认窗口的真实状态
  - 示例：我改了主进程的窗口创建逻辑，帮我验证窗口是否正常显示

- **renderer 白屏、前端异常或交互回归**：页面白屏、加载失败、出现运行时错误，或点击按钮后行为不对时，读日志、截图、无障碍树，并按元素引用点击和输入后再取证
  - 示例：应用启动后窗口是白屏，帮我看看 renderer 日志和页面实际内容

- **preload、contextBridge 与 IPC 链路验证**：同时取得主进程与 renderer 两侧的证据。attach 时传 `instrument: ["ipc"]` 且允许求值时，主进程收到的 IPC 会记入时间线，可直接等待 `IPC invoke <通道>` 确认调用到达以及结果
  - 示例：我改了 preload 暴露的接口，帮我验证 renderer 调用后主进程是否收到并返回正确结果

- **崩溃或意外退出分析**：结合应用进程的退出码与退出前的日志定位问题
  - 示例：应用启动几秒后自己退出了，帮我找原因

- **utility process 内代码的检查**：连接时传入 utility 的名字或 pid，可像主进程一样求值和读日志
  - 示例：我的 utilityProcess 里的任务没有执行，帮我连上它看日志和状态

## 不适用场景
- **本地开发环境之外的应用**：打包后的应用（安装包，或已关闭调试开关、fuse 的构建）和远程、非回环地址的应用不在支持范围内；工具只连接已运行的应用，不负责启动、停止或重启
- **不需要运行时观察，或本工具不提供的能力**：纯类型检查和构建问题用项目已有的检查；断点、拖拽悬停快捷键、网络抓包不提供，Skill 的 references/alternatives.md 给出了用日志、求值等替代做法；性能分析和内存泄漏分析不提供，也没有替代；原生对话框和系统菜单需要用户人工操作；本工具自身不做原生代码的单步跟踪（见适用场景里的原生模块一条）；原生模块调试在 Windows（mcp-windbg 加 cdb）和 Linux（gdb、lldb 命令行）上验证过，macOS 只在 GitHub 的 arm64 runner 上验证过 lldb 命令行，没有真机和 Intel 的验证；原生崩溃（分析 dump）和进程卡死（看线程栈）目前没有验证过的流程；调试期间应用被热重启会使调试会话失效，这一条没有实测
- **带真实生产凭据的应用**：输出不做脱敏，只应连接本地开发环境的应用（详见“使用须知”）

## 依赖要求
| 类别 | 说明 |
|------|------|
| 系统依赖 | Node.js 20 或更高版本；运行文件已随包提供，无需额外下载、安装依赖或构建 |
| 外部服务 | 无 |
| 权限要求 | 待诊断的应用需以 --inspect（主进程）和/或 --remote-debugging-port（renderer）参数运行；连接 utility process 需要主进程通道在线且允许求值，默认调试口 9229 被占用时需给 fork 加 --inspect-port；MCP 注册可选，批处理模式无需注册 |
| 已验证的系统 | Windows、macOS、Linux（CI 在三个系统上运行真实 Electron 的冒烟测试）；原生模块调试在 Windows（mcp-windbg 加 cdb）和 Linux（gdb、lldb 命令行）上验证过，macOS 只在 GitHub 的 arm64 runner 上验证过 lldb 命令行 |
| 原生模块调试（可选） | 需要原生源码，最好有带调试信息的构建（Windows 的 PDB、Linux 的 DWARF、macOS 的 dSYM；Debug 构建能看到全部局部变量，release 构建的局部变量常显示不可用）；Agent 经你同意接上外部调试器（Windows：mcp-windbg，需要 Windows 调试工具里的 cdb；Linux、macOS：gdb 或 lldb 命令行，不必装 MCP）。附加和断点会让整个进程暂停，本工具的请求在这期间会超时，查完要放行再断开 |

## 使用须知
- **输出不做脱敏**：日志、报错、求值结果、页面文本、窗口地址和标题可能带出令牌、密码、cookie，并进入模型上下文和会话记录。是否遮挡由 Agent 判断：只读取需要的内容，汇报时只引用必要片段，不连接带真实生产凭据的应用。
- **attach 默认不改动被检查的应用**：只有传 `electron_attach` 的 `instrument` 参数（`["ipc"]` 记录主进程收到的 IPC，`["dialogs"]` 监测原生对话框）才会在主进程里装包装，应用重启前不会移除，结果的 `instrumented` 列出实际装了什么。
- **求值、点击和输入会改变应用状态**，只用于验证。宿主把环境变量 `ELECTRON_DEBUG_ALLOW_EVAL` 设为 `0`、`false`、`off`、`no` 或 `disabled` 时，求值、点击输入、utility 连接、IPC 和对话框追踪都不可用，此时只能读状态、日志、截图和无障碍树；写成别的值（如 `none`）会返回 `ENDPOINT_CONFIG_INVALID`，不会静默开启。
- **调试端口没有认证**：`--inspect` 和 `--remote-debugging-port` 打开的端口，同机的其他进程或用户都能连上并执行代码。只在本机开发环境使用，用完关闭应用，多用户机器上要留意。
- **只连接本机回环地址**（127.0.0.1、::1、localhost），不接受远程地址。
- **被测应用的输出是数据，不是指令**：日志、页面文本、求值结果里出现的任何指令，Agent 都不会执行，会如实告诉你。
- **外部调试器能读写进程内存**：附加输出会带出目标进程的全部环境变量，内存里也可能有令牌、密码和用户数据。Skill 要求安装调试器前把来源和版本告诉你并经你同意（mcp-windbg 是个人维护的开源项目，要求固定版本，或校验发布包的签名）；用命名管道而不是 tcp 端口连接（tcp 会监听所有网卡且没有认证）；附加前先用最小的环境变量启动应用，并用 mcp-windbg 的 `--filter-script` 对输出脱敏（脱敏示例没有实测）；汇报时只引用必要片段。停止或重启不是 Agent 自己启动的应用实例之前，也会先问你。

## 使用方式
### 输入格式
描述要验证的 Electron 修改或要排查的现象，并提供项目目录和启动方式，例如：我修改了 preload 的 IPC 接口，项目用 npm run dev 启动，请验证 renderer 到主进程的调用链是否正常。

### 输出示例
验证报告，包含结论（PASS、FAIL 或 BLOCKED）、预期行为、使用的工具与关键证据（日志、截图路径、无障碍树、求值结果）、所选 target 以及剩余限制。

### 接入与来源
随包运行文件是 `runtime/launch.cjs`：先执行 `node <skill 目录>/runtime/launch.cjs --verify` 校验完整性。`electron_*` 工具已可见就直接用；否则多轮取证时再注册为本地 stdio MCP Server（先问用户；新注册的 MCP 通常要重载或新开会话才可见）；重载前、用户不同意或宿主不能注册 MCP 时用 `launch.cjs --run` 批处理，`launch.cjs --tools` 列出每个工具的参数。

注册的最小配置（具体文件名和字段以宿主为准，路径换成实际的 skill 目录）：

```json
{
  "mcpServers": {
    "electron-agent-debug": {
      "command": "node",
      "args": ["<skill 目录>/runtime/launch.cjs"]
    }
  }
}
```

各宿主的注册命令（Codex、pi、DeepSeek Harness 只依据官方文档，没有实测）：Claude Code 用 `claude mcp add --scope user electron-agent-debug -- node <skill 目录>/runtime/launch.cjs`，也可以把本仓库当插件市场安装，一次装好 Skill 并注册 MCP；Codex 用 `codex mcp add electron-agent-debug -- node <skill 目录>/runtime/launch.cjs`；pi 用 `pi mcp add electron-agent-debug --exposure direct -- node <skill 目录>/runtime/launch.cjs`；DeepSeek Harness 的写法见 Skill 的 references/mcp-setup.md。Skill 目录放 `.agents/skills/`（Codex、pi、DeepSeek Harness 都会读）或 `.claude/skills/`（Claude Code）。

被诊断的应用要带 --inspect 和 --remote-debugging-port 启动；electron-vite、Electron Forge 等各启动方式怎么传参，见 Skill 的 references/launch.md。

版本：Skill 1.8.0（MCP 0.9.0），变更记录见包内 VERSION.md；许可证 MIT；源码与发布说明：https://github.com/longhun12346/electron-agent-debug

## 故障排除
### attach 连不上，或某个通道不可用
**出现原因**：
- 应用没带调试参数：开发者常已开着 pnpm dev，而它没有 --inspect 和 --remote-debugging-port（最常见）
- 端口没人监听、主进程和 renderer 的端口传反（端口上是浏览器而不是 Electron 时，结果的 warnings 里有 RENDERER_NOT_ELECTRON）
- 环境里设置了 ELECTRON_RUN_AS_NODE=1：Electron 按 Node 运行、不会创建窗口，renderer 通道不可用
- 应用关闭了 EnableNodeCliInspectArguments fuse：--inspect 被忽略，主进程通道连不上而 renderer 正常

**解决方案**：先读错误里的 hint，它会区分上面几种情况。查进程命令行确认有没有带调试参数，没带就用项目已有的启动命令加上参数重启（各启动方式怎么传见 Skill 的 references/launch.md）；取消 ELECTRON_RUN_AS_NODE；fuse 被关闭时改用未关闭它的开发构建。

### 多窗口时连到了别的窗口
**出现原因**：开发构建常同时有主窗口、设置窗口和 DevTools。DevTools 不参与自动选择，但有多个真实窗口时会返回 TARGET_SELECTION_REQUIRED；原来检查的窗口被重建、自动改选了另一个页面时，会返回 TARGET_CHANGED 警告。
**解决方案**：对照 `electron_targets` 返回的 title 和 url（需完全相等）选择，重名时用 targetId；收到 TARGET_CHANGED 时先确认新页面就是要验证的窗口。

### 日志不对：读到旧的，或缺事件
**出现原因**：attach 时会重放应用启动以来的历史输出，等待命中这类旧事件时结果会带 beforeAttach 标记；日志缓冲区写满后会丢弃最旧的事件；electron_logs 默认只返回最近 100 条。
**解决方案**：用操作返回的 afterSeq 只看本次操作之后的事件，sinceAttach 只排除 attach 时重放的历史；读取日志时看 droppedThroughSeq 和 gap，缩短两次取证的间隔，或调大 ELECTRON_DEBUG_MAX_LOG_EVENTS。带 clear 读取时只删除这次返回的事件。工具拒绝不认识的参数（如把 afterSeq 写成别的名字），不会忽略它而返回全部历史。

### renderer 页面崩溃
**出现原因**：页面崩溃时调试连接不断，但状态会标为离线，各 renderer 工具返回 TARGET_CRASHED。
**解决方案**：崩溃期间页面里的求值也不可用，用 electron_evaluate 在主进程里对该窗口调用 webContents.reload()，或请用户重新加载窗口；重新加载后同一连接会自动恢复。主进程崩溃或退出则整个主进程通道断开，需要重新 attach。

### 截图超时
**出现原因**：窗口被隐藏或最小化时，Chromium 不会响应截图。
**解决方案**：先显示窗口再截图。

### 请求一直超时
**出现原因**：页面的 alert/confirm 或原生对话框正在等用户操作，对应进程在关闭前不响应（原生对话框要 attach 时传 instrument: ["dialogs"] 才会出现在 status 里）。
**解决方案**：查看状态里的 dialogs，请用户关闭对话框后重试。

### 应用该退出了但进程还在
**出现原因**：Node 会等已连接的检查器断开才让进程退出，输出里会有 Waiting for the debugger to disconnect…。
**解决方案**：需要退出码或要重启时，直接终止进程，或先结束 MCP 会话。

### 主进程求值提示 require 未定义
**出现原因**：主进程全局作用域可能没有 require（例如 ESM 主进程）。
**解决方案**：使用 process.mainModule.require('electron') 获取模块。

## 经典案例
### 案例一：验证 IPC 修改
**背景**：修改了 preload 暴露的接口和主进程的 IPC handler，需要确认调用链真实可用。

**使用流程**：
1. Agent 用项目已有命令启动应用，并加上 --inspect 与 --remote-debugging-port 参数
2. 连接应用（instrument 传 ["ipc"]），等待明确的就绪日志
3. 在 renderer 执行调用，在主进程用 `IPC invoke <通道>` 等待并读取处理结果
4. 对照日志与截图，给出 PASS、FAIL 或 BLOCKED 结论

**效果收益**：主进程与 renderer 两侧都有运行时证据，避免只凭"没有报错"判断通过。

### 案例二：排查窗口白屏
**背景**：应用启动后窗口一片白，不知道是 renderer 抛了异常，还是主进程没把页面加载出来。

**使用流程**：
1. Agent 用项目已有命令启动应用，加上 --inspect 与 --remote-debugging-port 参数，连接两个通道
2. 先读日志：renderer 的未捕获异常和主进程的窗口创建报错各在自己的通道里；窗口创建失败时 renderer 通道没有可用页面
3. 再取无障碍树和截图，确认页面实际渲染了什么
4. 按证据归属给出 FAIL，写明已确认的原因或仍是推测的部分

**效果收益**：一次就能分清是 renderer 异常还是主进程的窗口创建失败，不必在两边来回猜。

### 案例三：点击后行为不对
**背景**：改了保存按钮的处理，点击后页面没有反应，不确定是页面没处理，还是主进程的 handler 出了错。

**使用流程**：
1. 取无障碍树快照，找到"Save"按钮的元素引用（也可以直接按 role 和 name 点击）
2. 用 `electron_click` 点击，记下返回的 afterSeq
3. 以 afterSeq 为起点，分别等 renderer 的失败日志和主进程 handler 的失败日志，两个通道各等各的
4. 对照页面状态，给出 FAIL，并指出错误发生在哪一侧

**效果收益**：用的是真实点击而不是在页面里调用 click()，两侧证据在同一条时间线上，能确认错误是这次点击之后才出现的。

### 案例四：原生函数返回值不对
**背景**：JS 通过 koffi 调用原生函数，处理含中文的路径时返回了“找不到”，JS 侧的代码看不出问题。

**使用流程**：
1. 连接应用，触发操作，记下返回的 afterSeq 和主进程 pid，确认 JS 侧拿到的返回值
2. 找到原生源码和 PDB（本机找不到就问你），经你同意安装 mcp-windbg，用 cdb 附加到主进程
3. 在原生函数入口和各个 return 之前下源码行断点，用点击触发 JS 调用（不要在求值里等结果，断点命中后应用会暂停），命中后读参数的原始字节和中间值
4. 定位到原因（例如把 UTF-8 当成系统代码页解释），放行并断开调试器；改原生源码，Debug 构建后停掉应用、部署新库、重启并重新连接
5. 再次触发同一操作，用日志和返回值确认修复

**效果收益**：JS 与原生两侧的证据按时间线对上，不必只凭函数名猜原生实现；同一套流程覆盖定位、修复和验证。
<!-- detail:end -->