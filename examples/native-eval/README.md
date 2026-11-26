# 原生模块调试评估

用来衡量 electron-debug Skill 的原生模块调试流程（`references/native.md`、`native-startup.md`）。它不在 CI 里运行。里面有三个故意写错的原生函数、一个调用它们的最小 Electron 应用，和三条评估。

## 内容

| 路径 | 说明 |
| --- | --- |
| `native/native_eval.cpp` | 三个导出函数 `sum_sizes`、`has_subdir`、`init_slots`，各有一处错误；Windows、Linux、macOS 用同一个文件 |
| `native/build.bat`、`native/build.sh` | Debug 构建：Windows 出 `native_eval.dll` 加 PDB，Linux 出 `libnative_eval.so`，macOS 出 `libnative_eval.dylib` 加 dSYM |
| `app/` | 用 koffi 加载这个库的最小 Electron 应用，窗口里有 Sum sizes 和 Find subfolder 两个按钮；`init_slots` 在启动时调用一次 |
| `evals.json` | 三条评估：`early-exit`（循环提前结束）、`code-page`（路径的编码被读错）、`startup-call`（启动时只调用一次的原生函数）。顶层字段是 Windows 的评分表，`posix` 是 Linux 和 macOS 的 |

`code-page` 在两个平台上是同一类错误、不同的写法：Windows 是 UTF-8 路径交给 ANSI 接口，按系统代码页读；Linux 和 macOS 是路径被当成 Latin-1 再编码一次。两者都只在名字含非 ASCII 字符时出错。

评估的格式按 Anthropic 的 Skill 写作指南：`query`、`files`、`expected_behavior`，另加 `setup`、`root_cause` 和 `must_not`。`root_cause` 是标准答案，不要给被评估的 Agent 看。

## 前提

- Node.js 20+，在本目录执行 `npm install`（装 Electron 和 koffi）。
- **Windows**：Visual Studio 的 C++ 工具（`build.bat` 用 `vswhere` 找 `vcvars64.bat`，找不到就设环境变量 `VCVARS`）；`cdb.exe`，Agent 经你同意安装 mcp-windbg（见 `references/native.md`）。`code-page` 这条要求系统代码页不是 UTF-8（例如简体中文 Windows 的 936），否则错误不会出现。
- **Linux**：`g++`（或设 `CXX`）；gdb 或 lldb 命令行。Electron 需要 libnss3、libnspr4、libasound2 等系统库。
- **macOS**：Xcode 命令行工具（`clang++`、`dsymutil`）、lldb。这一份没有在 macOS 上构建或运行过。

## 运行方式

1. 把整个 `examples/native-eval` 复制到一个临时目录再评估，因为 Agent 会修改源码；仓库里的这份要保持带错误。
2. 在副本里构建并启动：

```text
cmd //c "<副本>\native\build.bat"        # Windows
sh <副本>/native/build.sh                # Linux、macOS
npm install
npm start
```

   `npm start` 带 `--inspect=9229 --remote-debugging-port=9222`。`startup-call` 评估不要用它，而是让 Agent 自己决定怎么启动。Linux 上如果 Electron 报沙箱错误，在命令里加 `--no-sandbox`。
3. 在测试目录里放好 `evals.json` 里 `setup` 描述的文件。
4. 让装好 Skill 的 Agent 回答 `query`，保存完整的对话和工具调用记录。
5. 对着 `expected_behavior`（Linux、macOS 用 `posix` 里的那份）逐条检查，再看 `must_not`。每一条是“做到 / 没做到”，不打总分。

## 状态

三处原生错误在两个平台上都复现过。Windows：`sum_sizes` 对测试目录返回 10 而不是 100，`has_subdir` 对“资料”返回 0，`init_slots(200)` 返回 64，应用启动时打印 `worker slots: 64 (requested 200)`。Linux（Ubuntu 26.04，WSL2）：同样的三个值；用 gdb 17 和 LLDB 21 在调试器下启动应用，都在 `init_slots` 断下，读到 `requested = 200`，`finish` 得到返回值 64。评估本身还没有对任何 Agent 跑过，所以没有基线，也不知道现在能通过几条。
