# 原生模块（koffi、`.node` 插件）：跟踪调用、定位错误结果、崩溃和卡死

本工具只看 JS 层。原生代码里的问题要用原生调试器，这类调试器已有成熟的 MCP，不要自己造：先用本工具留下 JS 侧证据，再经用户同意安装外部调试器 MCP 配合，两边的证据按 `seq` 和时间对上。已验证的平台是 Windows（mcp-windbg 加 cdb）；macOS、Linux 的 LLDB 部分只依据官方文档，没有实测。

## 先选场景

| 症状 | 看哪一节 |
| --- | --- |
| 开发原生模块，想看某次 JS 调用进入原生函数后的参数和执行过程；或原生函数的返回值不符合预期 | 场景一 |
| 问题出在应用启动时就跑完的原生初始化 | 场景二 |
| 应用没有 JS 异常就退出（Windows 退出码常见 `0xC0000005`，macOS、Linux 常见 `SIGSEGV`、`SIGABRT`），或主进程请求一直超时、`electron_status` 的 `dialogs` 为空、页面也没有死循环 | 场景三（没有实测） |

只是 JS 异常、renderer 崩溃（`TARGET_CRASHED`）或普通的 IPC 失败，不用走这里。三个场景都先做下面的“准备”。

## 准备

### 1. 留下 JS 侧证据

原生调试器看不到 JS 在做什么，这部分只有本工具能给：

- 退出码和退出前最后几条日志（带 `seq`）。
- 触发它的操作：`electron_click`、`electron_type` 返回的 `afterSeq`，或最后一条 `IPC invoke <通道>`。
- 主进程的 pid 和命令行（工作流第 1 步查过的那条）；utility 进程用 `electron_attach` 结果里的 pid。
- 调用原生函数的 JS 位置和参数形状：读项目代码，必要时加一行 `console.log` 后复现。

### 2. 找原生源码和符号

函数结果不符合预期时，必须对着源码调试，不能凭函数名猜实现。先确认三样东西：

1. **符号**：模块旁有 `.pdb`（macOS、Linux 是 dSYM 或带调试信息的库）。调试器里 `lm m <模块>` 显示 `private pdb symbols` 才有源码行号和局部变量；只有导出符号时，只能看到函数名和反汇编。
2. **源码在哪**：PDB 记着构建时的源文件路径，附加后用 `ln <模块>!<函数>+0x20` 能看到（形如 `h:\...\xxx.cpp(369)`），多半是构建机上的路径，本机没有。先在本机找：项目的同级目录、README 或 docs 提到的原生仓库、依赖缓存。
3. **源码要和二进制对得上**：同一个仓库可能有多份副本或分支。用 `ln` 给出的行号核对，该行附近应是你要调试的函数；再对照提交日期和库的构建时间。

找不到源码，或有多份拿不准时，问用户：原生仓库在哪，哪个分支或提交对应这份二进制，能不能给带调试信息的 debug 构建。没有源码就只能调试到系统 API、参数和返回值这一层（`uf <函数>` 看反汇编，在它调用的系统函数上下断点），并在报告里写明这个限制。不要凭记忆描述原生实现。

### 3. 选并安装调试器 MCP

安装会运行第三方代码，也会让 Agent 获得附加进程、读写内存的能力。先告诉用户装什么、从哪来，得到同意再装，只用下面的官方或项目主页渠道。装好后新注册的 MCP 通常要重载或新开会话才可见，看不到工具就请用户重载，不要自己反复重试。

| 平台 | 选择 | 安装要点 |
| --- | --- | --- |
| Windows | [mcp-windbg](https://github.com/svnscha/mcp-windbg)，驱动 `cdb.exe`、`kd.exe` | 先装 Windows SDK 的 Debugging Tools 或商店版 WinDbg。Claude Code：`/plugin marketplace add svnscha/mcp-windbg`，再 `/plugin install mcp-windbg-uvx@mcp-windbg`（需要 `uv`）；或 `pip install mcp-windbg` 后 `claude mcp add mcp-windbg -s user -e _NT_SYMBOL_PATH="SRV*C:\Symbols*https://msdl.microsoft.com/download/symbols" -- python -m mcp_windbg`。其他宿主按其文档，命令都是 `python -m mcp_windbg`。微软也提供官方 WinDbg MCP（WinDbg 1.2610.1001.0 起） |
| macOS、Linux | LLDB 自带的 MCP，见 [LLDB 文档](https://lldb.llvm.org/use/mcp.html) | 注册 `lldb-mcp`：`claude mcp add lldb --transport stdio -- /path/to/lldb-mcp`。新会话默认异步，创建后先执行 `script lldb.debugger.SetAsync(False)`。Linux 想用 gdb 的话社区有 [dbgmcp](https://github.com/ramenhost/dbgmcp) 等，质量自行判断 |

工具名以安装后宿主列出的为准，mcp-windbg 常用的有 `list_dumps`、`open_cdb_dump`、`open_cdb_remote`、`run_cdb_command`、`wait_for_break`、`send_ctrl_break`。

### 4. 附加调试器（Windows）

经用户同意后，在后台启动调试服务端，目标进程会被暂停：

```text
cdb -server npipe:pipe=eadbg -noio -pd -lines -p <主进程 pid>
```

再用 `open_cdb_remote` 连 `npipe:Pipe=eadbg,Server=.`。

- `-server` 必须是第一个参数。`-noio` 让服务端不读写控制台，后台运行不用保持 stdin。`-pd` 让退出时不终止被调试进程。`-lines` 打开行号信息。
- 用命名管道，不要用 `tcp:port=`：TCP 会监听在 `0.0.0.0` 且没有认证，局域网内的机器能连上来控制进程。
- `open_cdb_remote` 的初始输出会列出目标进程的**全部环境变量**，环境里的令牌会进入上下文。启动应用时只传必要的变量（例如 `env -i` 加 `SystemRoot`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP`）；Git Bash 里 `PATH` 要写成 `/c/...` 形式，写 `C:\...;...` 会被改坏。这段输出还包含全部模块列表，很长，`include_modules=false` 不会缩短它。
- 符号路径和源码路径在会话里各用一条独立命令：`.sympath <pdb 目录>`、`.srcpath <源码目录>`。它们会把整行当路径，后面不能用分号接别的命令。再 `.reload /f <模块>.dll`，`lm m <模块>` 显示 `private pdb symbols` 才算成功。（命令行里的 `-y`、`-srcpath` 选项是官方文档里的写法，没有实测。）

## 场景一：跟踪一次 JS 调用进入原生函数

1. 应用用 `--inspect` 启动（要看 renderer 再加 `--remote-debugging-port`），用本工具 attach，确认 JS 侧能触发那次调用，记下怎么触发（点击、IPC 或求值）。
2. 按“准备 4”附加调试器，设好符号和源码路径。
3. 下断点：`bu <模块>!<函数>`（模块还没加载时也能设，用 `bl` 确认），或源码行断点 ``bu `<模块>!<文件>.cpp:<行号>` ``；然后 `g`。选应用自己很少调用的函数：Electron 内部也会调用的系统函数（如 `GetTickCount64`）会被无关线程反复命中。
4. 触发 JS 调用，但不要等它返回。断点命中后主进程被冻住，`electron_evaluate` 等结果会超时。用 `electron_click`、`electron_type` 触发，或求值里写 `setTimeout(() => 调用, 0)` 后立即返回。
5. 用 `wait_for_break` 等命中。`g` 之后第一次通常立即返回 `Target resumed`，后面几次可能阻塞到命中、输出直接带 `Breakpoint N hit`，两种都正常。命中期间本工具的 `electron_attach` 会返回 `MAIN_INSPECTOR_UNAVAILABLE`（超时），这是预期现象，不是连接坏了。
6. 看现场（下面列出）。查完用 `bc *` 清断点，用 `bl` 确认已清空（进程在运行时，`bc *` 的输出是自动中断的提示，不是清除成功的确认），再 `g` 放行。进程继续后重新 `electron_attach`，读日志和求值结果，核对 JS 看到的返回值和调试器里看到的是否一致。
7. 退出用 `qqd`，应用继续运行；工具会报 `Debugger process exited (exit code 0x80010008)`，这是正常结果。**不要**停在断点上直接退出（实测 `qq` 会让应用随之退出），也不要用 `qd`（在远程客户端里它只退出客户端，被暂停的应用会一直冻着）。

**看现场**

- `kn` 看栈：只有最上面两三帧可信（原生函数、koffi），再往上是乱码；没有 JS 帧，把 JS 侧的调用和这次命中对上，靠本工具的日志和 `seq`。
- 参数：x64 前四个参数在 `rcx`、`rdx`、`r8`、`r9`，字符串参数用 `da @rcx`。
- 源码：`lsa @rip,3` 看当前行附近；`dv /t` 看局部变量（一次只能给一个变量名）；`dx -r0 <表达式>` 看对象和 STL 容器，默认会展开宽字符串的每个字符，输出很长，加 `-r0` 只输出一行；变量是指针还是引用看 `dv /t` 里的类型，指针用 `->`，引用或对象用 `.`。
- 单步：`p`、`t`、`gu`。
- **含中文等非 ASCII 的字符串在调试器里不可靠**：`dv` 会把 UTF-8 字节按系统代码页显示成乱码，`dx -r0` 可能什么都不输出且不报错。要看真实内容就看原始字节：窄字符串用 `db <字面地址>`，宽字符串用 `dw <字面地址>`，再按 UTF-8 或 UTF-16 解码（`db` 不认被当成符号的变量名，要用 `dv` 显示出来的地址）。
- release 构建开着优化：局部变量会显示 `value unavailable` 或过期的值，断点行也可能偏几行。要精确单步就请用户给 debug 构建。

### 返回值不符合预期时

这是最常见的需求。先分清是原生函数的行为，还是 JS 对它的假设有误：

1. 写下预期和实际：入参、返回值（或返回 NULL、错误码）、日志里的报错，以及触发方式。
2. 读原生源码和头文件里的契约，对照 JS 侧的假设和注释。很多“结果不对”其实是两边理解不一致，比如排序依据、路径格式、编码。
3. 在关键行下源码行断点（循环里、排序前、各个 `return` 之前），用命中次数和中间值定位。预期命中三次、实际只命中一次，说明循环提前退出了；`return -1` 或 `return NULL` 之前的断点能告诉你从哪个分支返回；入参到了原生是否正确，要看原始字节（编码问题常见于“注释写 UTF-8、实现却按系统代码页解释”，只有含非 ASCII 字符的输入才出错）。
4. 用证据下结论：原生按契约工作（改 JS 侧的假设）、原生有缺陷（改原生源码，重新构建后重启应用再验证）、入参有误（改 JS 侧）。结论里写明依据：源码行、变量值、JS 返回值。

### 改了原生代码之后：编译、部署、再验证

1. **构建用 Debug**（MSVC 的 `/Od /Zi`）：局部变量全部可见，单步和源码行一一对应。PDB 里记的是本机的绝对路径，符号和源码都自动找到，不用设路径。
2. **部署前先停应用**：原生库被应用加载后，Windows 上不能覆盖，重新链接会报 `LNK1168`。按 pid 停掉应用（不要按进程名），重新构建，再启动，重新 `electron_attach` 和附加调试器（pid 变了）。在 Git Bash 里运行 `.bat` 要写成 `cmd //c "C:\完整\路径\build.bat"`，相对路径会找不到文件。
3. **优先让应用加载新产物，不要覆盖用户在用的那份**：先看项目怎么定位原生库，环境变量或配置通常可以指向新文件。
4. **调试期间别触发热重启**：`electron-vite dev --watch` 这类开发工具在源码改动后会重启主进程，旧进程被杀，调试器和本工具的连接随之断开，pid 也变了。调试原生代码时不要改会触发重启的 JS 源码，或者不带 `--watch` 启动；重启后重新附加、重新设断点、重新 `electron_attach`。这一条依据开发工具的行为，没有单独实测。

## 场景二：启动期的原生调用

附加发生在应用启动之后，启动时就跑完的原生初始化已经执行过。两种做法都在 Windows 上实测过：应用在启动阶段调用原生函数，断点在调用发生时命中，放行后应用正常完成启动。

**做法一，`--inspect-brk`**（社区调试 Node 原生插件的常规做法）：把启动参数里的 `--inspect` 换成 `--inspect-brk`，应用会在第一行用户代码之前等待。此时 `electron_attach` 能连上，但 `electron_evaluate` 会超时，也不会让应用继续。流程：启动应用并等待，附加调试器、下断点、`g`，再发一条 `Runtime.runIfWaitingForDebugger` 放行，断点命中。放行用 Node 22 以上自带的 WebSocket，几行就够：

```js
const [target] = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.runIfWaitingForDebugger" }));
ws.onmessage = () => setTimeout(() => process.exit(0), 200);
```

项目的启动工具是否支持 `--inspect-brk`，以它的文档为准（electron-vite 的写法没有实测）。

**做法二，让应用在调试器下启动**：

```text
cdb -server npipe:pipe=eadbg -noio -pd -lines -c "bu <模块>!<函数>; g" <electron 可执行文件> <应用参数>
```

可执行文件和它的参数写在最后。这种方式不依赖 `--inspect-brk`，模块还没加载时 `bu` 会等它加载后生效。第一次 `open_cdb_remote` 可能超时，再试一次；由调试器启动的进程会使用调试堆，应用会变慢。官方文档的 `-hd` 选项可以关掉它，想在模块一加载就中断可用 `sxe ld:<模块>`，这两个都没有实测。

## 场景三：崩溃和卡死

这一节只依据官方文档写成，没有在真实的崩溃或卡死上验证过，待办见 `docs/plan.md`。

**崩溃后分析（首选，不干扰应用）**：需要有 dump。应用没有生成 dump 时，复现前先配置：Windows 用 WER LocalDumps（注册表 `HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps`，需要管理员权限）或 Sysinternals ProcDump，参数以各自文档为准。拿到 dump 后用 `list_dumps` 找文件，`open_cdb_dump` 打开，它会先跑 `!analyze -v`；再用 `run_cdb_command` 看 `kb`（调用栈）、`lm`（模块，确认崩溃在哪个 DLL 或 `.node`）。

**卡死（进程还活着）**：经用户同意后按“准备 4”附加，附加会暂停进程。`run_cdb_command` 执行 `~*kn` 看所有线程的栈，找出主线程停在哪个原生函数。查完先 `g` 放行，再 `qqd` 断开。没有要跟的调用时不要下断点单步：断点会冻住整个进程，包括 inspector，本工具的请求都会超时。

**判读**：栈顶在你调用的 DLL 里，通常是传参、结构体布局或内存生命周期的问题（对照函数原型核对类型、指针指向的内存是否还有效）；栈顶在 koffi 或 Electron 里，先怀疑调用方式或版本，再看对应项目的 issue。这是经验判断，以实际栈为准。没有符号只能看到模块名加偏移。

## 注意事项

- **凭据**：调试器的初始输出会带出目标进程的全部环境变量，dump 和内存里也可能有令牌、密码、用户数据。先判断环境里有没有凭据，有的话告诉用户，并只引用必要片段；mcp-windbg 有 `--filter-script` 可对输出做脱敏，用法见其文档。
- **会冻住应用**：附加和断点都会让整个进程停下，本工具的所有请求在这期间超时。查完要放行再断开。
- **热重启**会杀掉被调试的进程，见场景一“改了原生代码之后”。
- **报告里把证据按来源分开**：JS 侧（本工具的日志、`seq`）和原生侧（调试器的栈、变量）。原生证据只能证明停在哪、值是多少，不能单独证明原因；写成已确认还是推测，由你判断。

