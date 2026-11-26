# Vue + Vite 示例应用

一个按现在最常见的方式搭起来的 Electron 应用：[electron-vite](https://electron-vite.org) 的开发服务器、Vue 3、Pinia、Vue Router、preload 桥接，数据经 IPC 存在一个 JSON 文件里。验证工具在真实开发流程里是否好用：热更新、主进程改动后的重启、构建产物，以及真实项目里常见的几类故障。仓库里所有真实 Electron 验证都在这里跑。

应用是一个任务板：任务列表（添加、勾选、删除、搜索、从 JSON 文件导入）、同步按钮、活动记录页（1500 行）、设置页（主题、版本信息，也能在新窗口里打开）。搜索由主进程转给一个 utility process（`task-indexer`）里的索引完成；主题用同步 IPC（`sendSync`）读取，这是老项目里常见的写法。

## 运行

```text
npm ci --prefix examples/vue-vite-app
node examples/vue-vite-app/package-smoke.mjs          # 全部场景，用 Skill 包里的 MCP
node examples/vue-vite-app/smoke.mjs                  # 全部场景，用源码构建的 MCP
node examples/vue-vite-app/smoke.mjs healthy hmr     # 指定场景
```

Linux 无显示环境用 `TEST_ELECTRON_NO_SANDBOX=true xvfb-run -a node ...`。要求 Node.js 20.19 或更高（electron-vite 6 的要求）。自己调试时：

```text
cd examples/vue-vite-app
npx electron-vite dev --watch --inspect 9229 --remoteDebuggingPort 9222
```

## 应用里的开关（只属于测试）

| 开关 | 作用 |
| --- | --- |
| `APP_DATA_DIR` | 数据目录，测试用它避开真实的用户数据 |
| `APP_FAULT=ipc-channel` | 主进程注册的通道名和 preload 调用的不一样，添加任务报 `No handler registered` |
| `APP_FAULT=silent-send` | 主进程监听的同步通道名拼错，没有任何报错 |
| `APP_FAULT=missing-field` | 主进程新增任务时漏了渲染进程要读的 `assignee` |
| `APP_FAULT=stale-add` | 第一次添加失败，之后的都成功，模拟“处理函数已经修好” |
| `APP_FAULT=preload-path` | preload 路径写错，页面里没有 `window.api` |
| `tasks.json` 内容损坏 | 页面加载任务失败 |
| `window.json` 内容损坏 | 主进程读不了窗口大小，窗口没有创建 |
| `APP_NOISE=n` | 渲染进程启动时打印 n 行热更新日志，模拟 attach 之前就很吵的控制台 |
| `APP_DEVTOOLS=true`、`APP_OPEN_SETTINGS=true` | 启动时打开 DevTools 和设置窗口，模拟开发构建 |
| `APP_INDEXER_INSPECT_PORT` | 给 `task-indexer` 指定调试端口（只是选端口，调试口默认不打开） |

## 场景

| 场景 | 做什么 | 断言 |
| --- | --- | --- |
| `healthy` | 开发服务器下 attach，添加任务，搜索，跳转到设置页 | 页面来自 `http://localhost`；整条 IPC 往返在追踪里；主进程写出的 JSON 里有新任务；搜索经 utility process 返回；导入文件的字节作为 IPC 参数，追踪里记的是它的长度（`argBytes`）；路由跳转没有重载页面；同步的主题读取被追踪为 `sendSync` |
| `hmr` | 改一个 `.vue` 文件 | 页面内容更新，`window` 上的标记和列表状态还在（没有重载） |
| `main-restart` | 改主进程源码，electron-vite 重启 Electron | 端口不变，重新 attach 后 pid 换了，页面恢复，新连接之后的证据里没有旧进程的事件 |
| `built` | `electron-vite build` 后由 Electron 直接启动 | 页面来自 `file:`，哈希路由可用 |
| `esm-main` | 主进程构建成 ES module（`APP_ESM=true`，输出 `out-esm/main/index.mjs`），再由 Electron 直接启动 | 主进程求值里没有 `require`，`process.mainModule.require('electron')` 仍可用；页面和添加任务正常 |
| `ipc-channel`、`silent-send`、`missing-field`、`damaged-data`、`bad-window-file`、`preload-path` | 六类故障 | 每一类在哪一侧、以什么形式出现：渲染进程日志、主进程日志，还是只有 IPC 追踪 |
| `utility` | 连接 `task-indexer` | 调试口默认关闭；未知名字列出候选；关闭求值时拒绝且不打开调试口；连上后能求值、日志归属正确、新任务进入索引；按 pid 也能连 |
| `windows` | 两个窗口加 DevTools，启动前很吵的控制台，1500 行的页面 | 不替 Agent 猜窗口；DevTools 不算窗口；按标题选；重放的噪声被 `sinceAttach` 排除并如实报告 `gap`；快照截断；脚本触发的点击不可信但处理函数会执行 |
| `crash-and-exit` | 页面崩溃，再让整个应用以退出码 3 退出 | `TARGET_CRASHED` 立即报出，reload 后恢复；退出码是 3；之后的新 attach 说明是哪个通道没了 |
| `lifecycle` | reload、替换窗口、整个应用以新端口重启 | 同一个 MCP 进程；换窗口时报告 `TARGET_CHANGED`；重启后没有旧运行的日志 |
| `no-endpoint` | 没有应用可连 | `ENDPOINT_NOT_CONFIGURED`；端口不通时指出是哪个通道 |
| `inspection` | 在 2x 屏幕上读取一切 | wait_for、求值（Promise、顶层 await、重复声明、截断、超时）、异常和调用栈的渲染、IPC 与对话框追踪、截图尺寸、崩溃、webview、DevTools、传反的端口 |
| `interaction` | 点击和输入 | 事件可信；被遮挡和被禁用的元素被拒绝；中文和 Vue 受控输入；ref 的稳定和过期；按角色和名称点击 |

## 跑出来的几点

- 主进程的求值环境没有全局 `require`：要用 Node 内置模块写 `process.getBuiltinModule("node:fs")`，要用 `electron` 写 `process.mainModule.require("electron")`。
- 主进程被 electron-vite 重启后，新进程在重新 attach 之前打印的启动日志，实测没有被补读；`sinceAttach` 只含重新连接之后的事件。要看启动日志，需要在启动时就已经连上，或让应用把日志写进文件。
- macOS 上 electron-vite 重启主进程时，如果工具还连着旧进程，旧进程会一直等调试器断开，继续占着调试端口，新进程报 `Starting inspector ... address already in use`，没有调试口（在 GitHub Actions 的 macOS 上出现过；Windows 和 Linux 上没有）。`main-restart` 场景在 macOS 上先断开 MCP 再改文件。
- `--inspect` 和 `--remoteDebuggingPort` 的端口在重启后保持不变，所以重新 attach 用同一组地址即可。
- 主进程求值不支持动态 `import()`（报 `A dynamic import callback was not specified`），ES module 主进程也一样；`references/evaluate.md` 已经这么写。
- 开发模式下 Vue 会重新抛出生命周期钩子里的错误，后面的更新被打断：`preload-path` 时页面只显示一个空列表，没有错误条，只有日志里有线索。
