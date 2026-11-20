# field 应用

一个更接近真实开发构建的 Electron 示例。`examples/fixture` 是最小应用，只有一个窗口、CJS 主进程、几行日志，故障全部在页面加载后自己触发；这个目录补上它没有的形态，因为这些形态已经各暴露过最小 fixture 发现不了的缺陷：

| 形态 | 做法 | 暴露过的问题 |
| --- | --- | --- |
| ESM 主进程 | `package.json` 的 `type` 为 `module`，入口 `main.mjs`，没有 `require` | 主进程求值的写法、动态 `import()` 不可用 |
| 两个窗口加 DevTools | 启动时打开 `Field App`、`Field Settings` 两个窗口，并给第一个窗口打开独立的 DevTools | 全新 attach 因多出 `devtools://` 窗口选不到页面 |
| 嘈杂的控制台 | 页面加载时打印 800 行，attach 时会被整体重放 | 缓冲区溢出、`gap`、`sinceAttach` |
| 很大的页面 | 1500 行列表，远超无障碍树默认的 400 个节点 | 快照被截断，标题和按钮要排在前面 |
| 要按下才发生 | `Save` 按钮点击后经 preload 调主进程 `field:save`；`FIELD_FAULT=save` 时处理函数抛错 | 评估出的点击不是可信事件，但处理函数会执行 |
| 页面崩溃和进程硬退出 | 运行器通过父进程 IPC 发 `crash-renderer`、`reload`、`exit`（退出码 3）、`quit` | 页面崩溃后状态仍显示在线；检查器连着时进程不退出 |

运行：

```text
npm run build
npm ci --prefix examples/fixture
node examples/field-app/field-smoke.mjs
```

Electron 二进制来自 `examples/fixture` 的依赖。`field-smoke.mjs` 在真实 Electron 上走完上表的每一项并断言结果，已加入 `ci-smoke.mjs` 和 CI 的 Electron 版本矩阵。`host-e2e` 的 `devtools-windows` 与 `click-save` 场景也使用这个应用。

父进程 IPC 命令只供测试运行器使用，没有加到 MCP。
