# 原生模块（koffi、`.node` 插件）：从 JS 调用跟到原生函数

本工具只看 JS 层。原生函数里的问题（返回值不对、想看参数和执行过程）要用原生调试器；这类调试器已有成熟的 MCP，不要自己造：先用本工具留下 JS 侧证据，再经用户同意安装外部调试器 MCP 配合，两边的证据按 `seq` 和时间对上。已验证的平台：Windows（mcp-windbg 加 cdb）；Linux（gdb、LLDB 命令行，在 Ubuntu 26.04 上）；macOS 的 LLDB 命令行只在 GitHub 的 arm64 runner 上验证过，没有真机和 Intel 的验证。

应用启动时就跑完的原生调用见 `native-startup.md`。崩溃和卡死目前没有验证过的流程：只做“1. 留下 JS 侧证据”，并告诉用户这一限制。只是 JS 异常、renderer 崩溃（`TARGET_CRASHED`）或普通的 IPC 失败，不用走这里。

## 目录

1. 留下 JS 侧证据
2. 找原生源码和符号
3. 安装调试器 MCP
4. 附加调试器（Windows），4b（Linux、macOS）
5. 跟踪一次 JS 调用进入原生函数
6. 返回值不符合预期时
7. 改了原生代码之后
注意事项

## 1. 留下 JS 侧证据

原生调试器看不到 JS 在做什么，这部分只有本工具能给：

- 触发那次调用的操作（`electron_click`、`electron_type` 返回的 `afterSeq`，或 attach 时传 `instrument: ["ipc"]` 后的最后一条 `IPC invoke <通道>`）和退出前最后几条日志（带 `seq`）。
- 主进程的 pid 和命令行（工作流第 1 步查过的那条）；utility 进程的 pid 用 `electron_evaluate`(main) 读 `app.getAppMetrics()`。
- 调用原生函数的 JS 位置和参数形状：读项目代码，必要时加一行 `console.log` 后复现。

## 2. 找原生源码和符号

函数结果不符合预期时，必须对着源码调试，不能凭函数名猜实现。

- **符号**：调试器里 `lm m <模块>` 显示 `private pdb symbols` 才有行号和局部变量；只有导出符号时，只能看到函数名和反汇编。
- **源码**：`ln <模块>!<函数>+0x20` 会显示构建时的源文件路径和行号（多半是构建机上的路径）。先在本机找：项目的同级目录、README 或 docs 提到的原生仓库。同一个仓库可能有多份副本或分支，用这个行号和提交日期核对源码和二进制是否对得上。
- **找不到或拿不准**就问用户：原生仓库在哪，哪个分支或提交对应这份二进制，能不能给带调试信息的 debug 构建。没有源码就只能调试到系统 API、参数和返回值这一层，并在报告里写明。不要凭记忆描述原生实现。

## 3. 安装调试器 MCP

先告诉用户装什么、从哪来、哪个版本，得到同意再装：它会运行第三方代码，并让 Agent 能附加进程、读写内存。装好后新注册的 MCP 通常要重载或新开会话才可见，看不到工具就请用户重载。

- **Windows**：[mcp-windbg](https://github.com/svnscha/mcp-windbg)，个人维护的开源项目，不是 Microsoft 官方；驱动 `cdb.exe`，需要 Windows SDK 的 Debugging Tools 或商店版 WinDbg。安装时固定版本，不要装跟随分支的写法（如 `git+https://…`）：`pip install mcp-windbg==<版本>`（装之前去 PyPI 查当前版本），或下载 [Release](https://github.com/svnscha/mcp-windbg/releases) 里带签名的 `mcp-windbg.exe`，用 `Get-FileHash` 和 `Get-AuthenticodeSignature` 核对。注册方式按它的 README。
- **macOS、Linux**：不装 MCP 也行，直接用 `gdb -batch` 或 `lldb -b` 的命令行（见 4b）。要 MCP 时用 LLDB 自带的，见 [LLDB 文档](https://lldb.llvm.org/use/mcp.html)（新会话默认异步，创建后先执行 `script lldb.debugger.SetAsync(False)`）。文档里的 `lldb-mcp` 可执行文件在实测的两个版本（LLDB 21、Xcode 26.6 的 LLDB 2100）里都没有，那里要用 lldb 里的 `protocol-server` 加 `nc` 当桥，做法见 4b。

工具名以安装后宿主列出的为准，下面用到 mcp-windbg 的 `open_cdb_remote`、`run_cdb_command`、`wait_for_break`。

## 4. 附加调试器（Windows）

经用户同意后，在后台启动调试服务端，目标进程会被暂停：

```text
cdb -server npipe:pipe=eadbg -noio -pd -lines -p <主进程 pid>
```

再用 `open_cdb_remote` 连 `npipe:Pipe=eadbg,Server=.`。

- `-server` 必须是第一个参数；`-noio` 让服务端后台运行时不用保持 stdin；`-pd` 让退出时不终止被调试进程。
- 用命名管道，不要用 `tcp:port=`：TCP 会监听在 `0.0.0.0` 且没有认证，局域网内的机器能连上来控制进程。
- `open_cdb_remote` 的初始输出会列出目标进程的**全部环境变量**，令牌会进入上下文，所以附加前先做两件事：启动应用时只传必要的变量（例如 `env -i` 加 `SystemRoot`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP`）；注册 mcp-windbg 时加 `--filter-script <脚本路径>` 对输出脱敏，写法见下面。Git Bash 里 `PATH` 要写成 `/c/...` 形式，写 `C:\...;...` 会被改坏。这段输出还包含全部模块列表，很长，`include_modules=false` 不会缩短它。
- 符号路径和源码路径各用一条独立命令：`.sympath <pdb 目录>`、`.srcpath <源码目录>`，它们会把整行当路径，后面不能用分号接别的命令。再 `.reload /f <模块>.dll`，`lm m <模块>` 显示 `private pdb symbols` 才算成功。

脱敏脚本是一个 Python 文件，定义 `process_output(text, context)`，返回脱敏后的文本（`None` 表示不改）。它在 mcp-windbg 的进程里运行，等于受信任的代码，写好后给用户看过再用。下面是示意，只覆盖常见形态，没有实测，要按实际情况调整：

```python
import re

ENV_VAR = re.compile(r"\b([A-Z][A-Z0-9_]{2,})=([^\s;]+)")
TOKEN = re.compile(r"ghp_[A-Za-z0-9]{36}|eyJ[\w-]+\.[\w-]+\.[\w-]+|Bearer\s+[\w.~+/-]+=*")

def process_output(text, context):
    text = ENV_VAR.sub(r"\1=[redacted]", text)
    return TOKEN.sub("[redacted-token]", text)
```

## 4b. 附加调试器（Linux、macOS）

下面只写容易踩的几点，调试器本身的用法按你已有的知识。Linux 上用 gdb 17 和 LLDB 21 实测过命令行方式；macOS 的内容在 GitHub 的 macOS 26 arm64 runner（Xcode 26.6 的 LLDB 2100，SIP 关闭，有图形会话）上试过，没有在真机和 Intel 上试过，遇到和这里不符的地方，如实告诉用户。

- **不能附加到已经在运行的进程**：内核的 `ptrace_scope` 为 1（Ubuntu 默认）时，普通用户只能调试自己启动的子进程，gdb 报 `ptrace: Inappropriate ioctl for device`，lldb 报 `ptrace_scope is 1`。放宽它（`sysctl`、root）会改变整机的限制，由用户决定；默认改为在调试器下启动应用，如 `gdb -batch -x <命令文件> --args <electron> <应用目录> --inspect=<端口>`，lldb 用 `process launch -- <参数>`。
- Electron 会派生很多子进程：gdb 里 `set follow-fork-mode parent`，lldb 里 `settings set target.process.follow-fork-mode parent`；原生库还没加载时断点要允许 pending（gdb 的 `set breakpoint pending on`，lldb 默认就是）。没有 SUID 沙箱时 Electron 要加 `--no-sandbox`。
- 命中断点后调试器会一直阻塞，触发那次调用的要是另一个进程：把调试器的输出写进文件，用本工具的 `electron_click`、批处理或 `setTimeout` 方式的求值去触发，再读文件。启动时就跑完的调用，命令里直接 `run` 就会在启动期命中，不需要 `--inspect-brk`。
- **LLDB 的 MCP 因版本而异**：LLDB 21.1.8（Ubuntu 26.04）没有 `lldb-mcp`，只有 lldb 里的 `protocol-server start MCP listen://localhost:<端口>`，它在 TCP 上收发按行分隔的 JSON-RPC，工具叫 `lldb_command`（参数 `debugger_id`，从 1 开始；`arguments`）。宿主要的是 stdio，用 `nc localhost <端口>` 当桥即可（在 Linux 上试过），注册成 `nc` 加这两个参数的 MCP，lldb 要先启动并开着服务。Xcode 26.6 自带的 LLDB 2100 也是这样：有 `protocol-server`，没有 `lldb-mcp`（`usr/bin` 里只有 `lldb`、`lldb-dap`），`nc` 桥在那里也能用；别的版本先 `lldb -b -o "help protocol-server"` 看。
- **macOS 没有 `ptrace_scope`，可以直接附加到运行中的进程，但有两道门**（在 GitHub 的 macOS runner 上试过）。一是开发者模式（`DevToolsSecurity -status`）：关着的时候 `lldb` 附加不报错，而是一直等系统授权，在 Agent 的命令里就是卡住不返回，所以每条 lldb 命令都要加超时；没有图形界面的 ssh 会话里，据 Apple 论坛是报 `non-interactive debug session, cannot get permission to debug processes`（没试过）。开启要管理员执行 `sudo DevToolsSecurity -enable`，用户还要在 `admin` 或 `_developer` 组，这是改整机的设置，由用户决定。
  二是目标进程的签名：开发用的 Electron（ad-hoc 签名，加上 hardened runtime 的副本也一样）能直接附加；Developer ID 签名并开了 hardened runtime 的应用（试的是 Chrome）和系统应用（Finder）同样卡住、没有报错，runner 的 SIP 是关着的也一样；Apple 论坛说这类进程要有 `com.apple.security.get-task-allow`（没试过加上之后）。不要给用户装的应用重签名，也不要关 SIP，需要时在应用的副本上做并先问用户。
- macOS 上原生库的调试信息在 `.dSYM` 里，由 `dsymutil` 从 `.o` 收集：要先编成 `.o` 再链接，并留着 `.o`（一步编译链接会删掉它，得到空的 dSYM，lldb 里看不到参数，`examples/native-eval/native/build.sh` 已按这个写）；lldb 找不到时 `target symbols add <路径>.dSYM`；主进程 pid 用 `ps -eo pid,args | grep -i electron`，取没有 `--type=` 的那个。

## 5. 跟踪一次 JS 调用进入原生函数

1. 应用用 `--inspect` 启动（要看 renderer 再加 `--remote-debugging-port`），用本工具 attach，确认 JS 侧能触发那次调用。
2. 按“4”附加调试器，设好符号和源码路径。
3. 下断点：`bu <模块>!<函数>`，或源码行断点 ``bu `<模块>!<文件>.cpp:<行号>` ``，然后 `g`。选应用自己很少调用的函数：Electron 内部也会调用的系统函数（如 `GetTickCount64`）会被无关线程反复命中。
4. 触发 JS 调用，但不要等它返回：断点命中后主进程被冻住，`electron_evaluate` 等结果会超时。用 `electron_click`、`electron_type` 触发，或求值里写 `setTimeout(() => 调用, 0)` 后立即返回。
5. 用 `wait_for_break` 等命中。`g` 之后第一次通常立即返回，后面几次可能阻塞到命中，都正常。命中期间 `electron_attach` 返回 `MAIN_INSPECTOR_UNAVAILABLE` 是预期现象。
6. 放行：`bc *` 清断点，`bl` 确认（进程在运行时，`bc *` 的输出是自动中断的提示，不是清除成功的确认），`g`。进程继续后重新 `electron_attach`，读日志和求值结果，和调试器里看到的核对。
7. 断开用 `qqd`，应用继续运行；工具报 `Debugger process exited (exit code 0x80010008)` 是正常结果。不要停在断点上直接 `qq`（应用会随之退出），也不要用 `qd`（在远程客户端里它只退出客户端，被暂停的应用会一直冻着）。

**看现场的几个坑**

- `kn` 的栈只有最上面两三帧可信（原生函数、koffi），往上是乱码；没有 JS 帧，把 JS 侧的调用和这次命中对上，靠本工具的日志和 `seq`。
- `dv` 一次只能给一个变量名。`dx` 要加 `-r0`，否则会展开宽字符串的每个字符，输出很长；变量是指针还是引用看 `dv /t` 的类型，指针用 `->`，引用用 `.`。
- **含中文等非 ASCII 的字符串不可靠**：`dv` 把 UTF-8 字节按系统代码页显示成乱码，`dx -r0` 可能什么都不输出且不报错。要看真实内容就看原始字节：窄字符串 `db <字面地址>`，宽字符串 `dw <字面地址>`（`db` 不认被当成符号的变量名，要用 `dv` 显示的地址）。
- release 构建开着优化：局部变量会显示 `value unavailable` 或过期的值，断点行也会偏几行。要精确单步就请用户给 debug 构建。

## 6. 返回值不符合预期时

- 对照原生源码、头文件里的契约和 JS 侧的假设：很多“结果不对”是两边理解不一致，比如排序依据、路径格式、编码。
- 在循环里、排序前、各个 `return` 之前下源码行断点，用命中次数和中间值定位：预期命中三次、实际只命中一次，说明循环提前退出；`return -1` 或 `return NULL` 之前的断点能告诉你从哪个分支返回。
- 入参到了原生是否正确，要看原始字节。常见的是“注释写 UTF-8、实现却按系统代码页解释”，只有含非 ASCII 字符的输入才出错。
- 结论写明依据（源码行、变量值、JS 返回值）。原生有缺陷就改源码，按“7”重新构建、重启后验证。

## 7. 改了原生代码之后

- **构建用 Debug**（MSVC 的 `/Od /Zi`）：局部变量全部可见。PDB 里记的是本机的绝对路径，符号和源码都自动找到，不用设路径。
- **部署前先停应用**：库被加载后 Windows 上不能覆盖，重新链接会报 `LNK1168`。按 pid 停掉应用（不要按进程名；不是你启动的实例先问用户），重新构建，再启动，重新 `electron_attach` 和附加调试器（pid 变了）。Git Bash 里运行 `.bat` 要写成 `cmd //c "C:\完整\路径\build.bat"`，相对路径会找不到文件。
- **让应用加载新产物，不要覆盖用户在用的那份**：先看项目怎么定位原生库，环境变量或配置通常可以指向新文件。
- **调试期间别触发热重启**：`electron-vite dev --watch` 这类工具在源码改动后会重启主进程，调试器连接和 pid 随之失效，需要重新附加（主进程重启、pid 变化、端口不变在 electron-vite 6 上实测过；调试器那一侧没测）。

## 注意事项

- **凭据**：附加输出会带出全部环境变量，内存里也可能有令牌、密码、用户数据。附加前按第 4 节做脱敏；输出里仍有就告诉用户，只引用必要片段。
- **会冻住应用**：附加和断点都会让整个进程停下，本工具的请求在这期间超时。查完要放行再断开。
- **报告里把证据按来源分开**：JS 侧（本工具的日志、`seq`）和原生侧（调试器的栈、变量）。原生证据只能证明停在哪、值是多少，不能单独证明原因；写成已确认还是推测，由你判断。
