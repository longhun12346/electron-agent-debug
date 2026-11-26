# 原生模块调试评估

用来衡量 electron-debug Skill 的原生模块调试流程（`references/native.md`、`native-startup.md`）。它不在 CI 里运行，只在 Windows 上做过。里面有三个故意写错的原生函数、一个调用它们的最小 Electron 应用，和三条评估。

## 内容

| 路径 | 说明 |
| --- | --- |
| `native/native_eval.cpp`、`native/build.bat` | 三个导出函数 `sum_sizes`、`has_subdir`、`init_slots`，各有一处错误；Debug 构建，带 PDB |
| `app/` | 用 koffi 加载这个 DLL 的最小 Electron 应用，窗口里有 Sum sizes 和 Find subfolder 两个按钮；`init_slots` 在启动时调用一次 |
| `evals.json` | 三条评估：`early-exit`（循环提前结束）、`code-page`（UTF-8 路径按系统代码页读）、`startup-call`（启动时只调用一次的原生函数） |

评估的格式按 Anthropic 的 Skill 写作指南：`query`、`files`、`expected_behavior`，另加 `setup`、`root_cause` 和 `must_not`。`root_cause` 是标准答案，不要给被评估的 Agent 看。

## 前提

- Windows，Visual Studio 的 C++ 工具（`build.bat` 用 `vswhere` 找 `vcvars64.bat`，找不到就设环境变量 `VCVARS`）。
- Node.js 20+，在本目录执行 `npm install`（装 Electron 和 koffi）。
- Windows 调试工具里的 `cdb.exe`，Agent 经你同意安装 mcp-windbg（见 `references/native.md`）。
- `code-page` 这条要求系统代码页不是 UTF-8（例如简体中文 Windows 的 936），否则错误不会出现。

## 运行方式

1. 把整个 `examples/native-eval` 复制到一个临时目录再评估，因为 Agent 会修改源码；仓库里的这份要保持带错误。
2. 在副本里构建并启动：

```text
cmd //c "<副本>\native\build.bat"
npm install
npm start
```

   `npm start` 带 `--inspect=9229 --remote-debugging-port=9222`。`startup-call` 评估不要用它，而是让 Agent 自己决定怎么启动。
3. 在测试目录里放好 `evals.json` 里 `setup` 描述的文件。
4. 让装好 Skill 的 Agent 回答 `query`，保存完整的对话和工具调用记录。
5. 对着 `expected_behavior` 逐条检查，再看 `must_not`。每一条是“做到 / 没做到”，不打总分。

## 状态

这三条评估和三处原生错误在这台 Windows 机器上复现过：`sum_sizes` 对测试目录返回 10 而不是 100，`has_subdir` 对“资料”返回 0，`init_slots(200)` 返回 64，应用启动时打印 `worker slots: 64 (requested 200)`。评估本身还没有对任何 Agent 跑过，所以没有基线，也不知道现在能通过几条。
