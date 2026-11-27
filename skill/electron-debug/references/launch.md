# 启动参数与改动生效

在 SKILL.md 工作流第 1、3 步之外的细节。

参数含义见 Electron 官方文档：[调试主进程](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)、[命令行开关](https://www.electronjs.org/docs/latest/api/command-line-switches)。参数怎么传进 Electron 取决于启动方式，并以 `electron_attach` 返回的通道状态确认是否生效。`--inspect` 和 `--remote-debugging-port` 打开的端口没有认证，同机的其他进程或用户都能连上并执行代码：只在本机开发环境用，用完关闭应用，多用户机器上要留意。

## 改动生效

各项目工具行为不同，本 Skill 未统一验证，以 `electron_status` 和日志实际观察为准。按这个顺序处理：

1. 项目有热更新或自动重启，就等它完成，不要重复手动操作。主进程、preload 的改动若被开发工具自动重启，原连接随进程失效，需重新 `electron_attach`，并确认重启后的进程仍带有 `--inspect` 和 `--remote-debugging-port`（是否沿用取决于项目的启动工具）。electron-vite 6 重启后沿用同一组端口（Windows、Linux、macOS 都看过）；但在 macOS 上，新进程可能抢在旧进程释放端口之前启动，固定的 `--inspect` 端口报 `address already in use`，新进程就没有调试口（`electron_attach` 连不上，应用输出里有 `Starting inspector … failed`）：再保存一次文件触发第二次重启，或停掉应用后用项目的启动命令重新启动。
2. 没有热更新：renderer 改动用 `electron_evaluate`（scope 为 renderer）执行 `location.reload()`；`ELECTRON_DEBUG_ALLOW_EVAL=0` 时求值不可用，改用项目已有的刷新方式。
3. 主进程改动必须重启应用。preload 改动至少要 reload 页面才会重新加载，拿不准就重启。
4. 无论哪种方式，都先用 `electron_wait_for` 等到就绪信号再取证据。

## 启动参数

`<I>` 是主进程调试端口，`<R>` 是 renderer 调试端口，都自选空闲端口。命令行参数传不进去时（最后一行），不要靠猜环境变量：`ELECTRON_EXTRA_LAUNCH_ARGS` 对 Electron 没有作用（实测）。

| 项目的启动方式 | 怎么传 |
| --- | --- |
| `electron .`，或构建后直接运行 | `electron . --inspect=<I> --remote-debugging-port=<R>` |
| electron-vite（脚本是 `electron-vite dev`） | `electron-vite dev --inspect <I> --remoteDebuggingPort <R>`；脚本被包了一层时设环境变量 `V8_INSPECTOR_PORT=<I>`、`REMOTE_DEBUGGING_PORT=<R>` 再照常运行（已在 pnpm 加 turbo 包了两层的项目上实测：`pnpm dev:desktop` 前设这两个变量，electron 的命令行里出现了 `--inspect` 和 `--remote-debugging-port`；turbo 要带 `--env-mode=loose`，变量才会传下去） |
| Electron Forge | `electron-forge start --inspect-electron -- --remote-debugging-port=<R>`（官方文档的写法，未实测；主进程端口以 `electron_attach` 的结果为准） |
| vite-plugin-electron（脚本是 `vite`） | 插件默认用 `electron . --no-sandbox` 启动。按插件文档，在 `onstart({ startup })` 里调用 `startup(['.', '--no-sandbox', '--inspect=<I>', '--remote-debugging-port=<R>'])` 可以带参数；v1.0.0 起它也认环境变量 `ELECTRON_INSPECT`、`REMOTE_DEBUGGING_PORT`（以上来自插件文档，没有实测，要改项目配置）。不想改配置：先构建（如 `vite build`），再按第一行用 `electron .` 运行，这样跑的是构建产物，不带开发服务器的热更新 |
