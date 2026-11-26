# 启动期的原生调用

应用启动时就跑完的原生初始化，附加调试器时已经执行过。先做 [native.md](native.md) 的 1 到 4，再按下面的规则选一种做法。两种都在 Windows 上实测过：断点在启动阶段的原生调用发生时命中，放行后应用正常完成启动。

**怎么选**：能自己控制启动命令，就让应用在调试器下启动；应用由开发工具启动（例如 `pnpm dev:desktop` 里的 electron），拿不到命令行，就用 `--inspect-brk`。

## 让应用在调试器下启动

```text
cdb -server npipe:pipe=eadbg -noio -pd -lines -c "bu <模块>!<函数>; g" <electron 可执行文件> <应用参数>
```

可执行文件和它的参数写在最后。模块还没加载时 `bu` 会等它加载后生效。第一次 `open_cdb_remote` 可能超时，再试一次。由调试器启动的进程会使用调试堆，应用会变慢。

## 用 `--inspect-brk`

把启动参数里的 `--inspect` 换成 `--inspect-brk`（electron-vite 这类工具的开关写法以它的 `--help` 为准，这一点没有实测），端口用实际的 `<I>`，应用会在第一行用户代码之前等待。此时 `electron_attach` 能连上，但 `electron_evaluate` 会超时，也不会让应用继续。

流程：启动应用并等待，附加调试器、下断点、`g`，再发一条 `Runtime.runIfWaitingForDebugger` 放行，断点命中。放行用 Node 22 以上自带的 WebSocket，存成 `.mjs` 文件再用 node 运行（里面用了顶层 `await`），把 `9229` 换成实际端口，几行就够：

```js
const [target] = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.runIfWaitingForDebugger" }));
ws.onmessage = () => setTimeout(() => process.exit(0), 200);
```
