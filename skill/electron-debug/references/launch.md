# 启动参数与改动生效

在 SKILL.md 工作流第 1、3 步之外的细节。

参数含义见 Electron 官方文档：[调试主进程](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)、[命令行开关](https://www.electronjs.org/docs/latest/api/command-line-switches)。参数怎么传进 Electron 取决于启动方式，并以 `electron_attach` 返回的通道状态确认是否生效。

## 改动生效

各项目工具行为不同，本 Skill 未统一验证，以 `electron_status` 和日志实际观察为准。renderer 改动等热更新完成。主进程、preload 改动若被开发工具自动重启，原连接随进程失效，需重新 `electron_attach`，并确认重启后的进程仍带有 `--inspect` 和 `--remote-debugging-port`（是否沿用取决于项目的启动工具）。项目没有热更新时，才由 Agent 重启应用，或对 renderer 用 `location.reload()`（`electron_evaluate`；eval 被禁用时改用项目已有的刷新方式）。

## 启动参数

`<I>` 是主进程调试端口，`<R>` 是 renderer 调试端口，都自选空闲端口。命令行参数传不进去时（最后一行），不要靠猜环境变量：`ELECTRON_EXTRA_LAUNCH_ARGS` 对 Electron 没有作用（实测）。

| 项目的启动方式 | 怎么传 |
| --- | --- |
| `electron .`，或构建后直接运行 | `electron . --inspect=<I> --remote-debugging-port=<R>` |
| electron-vite（脚本是 `electron-vite dev`） | `electron-vite dev --inspect <I> --remoteDebuggingPort <R>`；脚本被包了一层时设环境变量 `V8_INSPECTOR_PORT=<I>`、`REMOTE_DEBUGGING_PORT=<R>` 再照常运行 |
| Electron Forge | `electron-forge start --inspect-electron -- --remote-debugging-port=<R>`（官方文档的写法，未实测；主进程端口以 `electron_attach` 的结果为准） |
| vite-plugin-electron（脚本是 `vite`） | 插件固定用 `electron . --no-sandbox` 启动，命令行参数和 `ELECTRON_EXTRA_LAUNCH_ARGS` 都传不进去。先构建（如 `vite build`），再按第一行用 `electron .` 运行；这样跑的是构建产物，不带开发服务器的热更新 |
