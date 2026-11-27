# 实战复盘：让 AI Agent 从 Electron 的 JS 调用一路调试到 C++ 原生断点

> 当 Electron 应用通过 `koffi` 或 `.node` 调用原生模块返回值不对时，普通 Coding Agent 只能对着 JS 源码干猜。本文以本仓库自带的 `examples/native-eval` 为例，完整展示 `electron-agent-debug` 如何把调试链路从 Renderer / Main 进程一直打通到 C++ 原生源码断点，完成“定位 → 修改 → 编译部署 → 验证”闭环。

## 场景背景

Electron 桌面应用里经常用 `koffi` 或 N-API（`.node`）封装 C/C++/Rust 能力（文件遍历、音视频、硬件通信等）。一旦原生函数返回了错误结果：

- 浏览器类 MCP（`chrome-devtools-mcp` / Playwright）只能看到 Renderer，看不到主进程；
- 即使能看到主进程日志，JS 层也只看到一个错误的返回值（例如 `30` 而不是 `100`，或者中文路径返回 `0`），完全不知道原生代码内部发生了什么。

`examples/native-eval` 内置了三个典型的真实原生 Bug（Windows / Linux / macOS 共用同一份 `native_eval.cpp`）：

1. **`sum_sizes`（循环提前退出）**：递归统计目录大小，预期 `100`，实际返回 `30`（或 `10`）。
2. **`has_subdir`（编码误读）**：查找含中文名称（如“资料”）的子目录返回 `0`（Windows 下 UTF-8 误传 ANSI 接口按代码页 936 解释；Linux/macOS 下被当成 Latin-1 二次编码）。
3. **`init_slots`（启动即执行的原生调用）**：应用启动时只调用一次 `init_slots(200)`，实际只分配了 `64`。

---

## 完整排查闭环（以 `sum_sizes` 为例）

### 第 1 步：用 `electron-agent-debug` 留下 JS 侧证据

Agent 不直接猜原生代码，而是先连接正在运行的 Electron 应用，固定 JS 侧事实：

1. 启动应用（带 `--inspect=9229 --remote-debugging-port=9222`），调用 `electron_attach` 连接主进程和 Renderer。
2. 通过 `electron_dom_snapshot` 找到界面上的 **Sum sizes** 按钮，调用 `electron_click` 触发（或用 `electron_evaluate` 在主进程直接调用），记下：
   - 返回的 `afterSeq`（用于对齐主进程与 Renderer 统一日志时间线）
   - 主进程 `pid`
   - 调用原生函数的 JS 位置与传入参数、实际返回值 `30`（预期 `100`）。

此时已经排除了“前端没触发”或“IPC 传参错位”的可能，问题被 100% 锁定在原生函数内部。

### 第 2 步：经用户同意，接入外部调试器并下源码行断点

按照 `electron-debug` Skill 的原生调试指引：

- 确认本机存在原生源码（`native/native_eval.cpp`）和调试符号（Windows 为 `.pdb`，Linux 为 DWARF，macOS 为 `.dSYM`）。
- 经用户同意后，接入外部调试器附加到主进程 `pid`：
  - **Windows**：`mcp-windbg`（驱动 `cdb`）
  - **Linux / macOS**：`gdb` 或 `lldb` 命令行
- 在 `sum_sizes` 的循环关键行和 `return` 前下源码行断点。

### 第 3 步：触发调用，命中断点定位根因

通过 `electron_click` 触发 JS 调用（注意：不要在 `electron_evaluate` 里同步等待返回值，因为断点命中后整个主进程会暂停）：

- 断点命中后查看调用栈、局部变量与循环执行轨迹；
- 预期递归分支应命中 3 次，实际只命中 1 次后就停在了多写的一行 `break;` 上——循环在处理完第一个子目录后直接退出了。
- （若是 `has_subdir` 中文路径问题，则直接检查传入字符串的**原始字节**，立刻就能看出 UTF-8 字节被当成系统代码页或 Latin-1 解释。）

### 第 4 步：放行 → 修改源码 → 编译部署 → 重启并重新验证

1. 先在调试器中放行并断开附加。
2. 删除 `native_eval.cpp` 中多余的 `break;`。
3. **先停止 Electron 应用再重新构建**（Windows 上若应用未退出，DLL 被占用会导致链接报 `LNK1168`）。
4. 重新启动应用、调用 `electron_attach` 重新连接，再次触发操作，确认返回值变为 `100`，给出带 `seq` 证据的 `PASS` 结论。

---

## 为什么这套流程有效？

- **不靠猜**：JS 侧的 `afterSeq`、参数、主进程 `pid` 与原生侧的断点、变量值首尾衔接，每一步都是运行时事实。
- **不造轮子**：`electron-agent-debug` 保持 10 个轻量工具专注 JS/Electron 层，把原生断点交给成熟的 `cdb` / `gdb` / `lldb`，由 Skill 串成一条可复用的工作流。

## 立即体验

安装 `electron-debug` Skill（仅需 Node.js 20+，运行时零安装）：

```bash
npx skills add longhun12346/electron-agent-debug --skill electron-debug
```

或作为 Claude Code 插件一键安装（含内置 MCP）：

```text
/plugin marketplace add longhun12346/electron-agent-debug
/plugin install electron-debug@electron-agent-debug
```

完整评估样例与构建脚本见 [examples/native-eval/README.md](../examples/native-eval/README.md)。
