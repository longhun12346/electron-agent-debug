# 求值的细节

`electron_evaluate` 和表达式型 `electron_wait_for` 的行为细节，补充 SKILL.md 工作流第 5 步。

表达式可修改应用状态，只用于验证。顶层的 `let`、`const` 可以在多次调用中重复声明，但与已有声明重名时本次改在块内执行，声明不保留到下一次调用；需要跨调用保留的值挂到 `globalThis`。主进程求值的全局作用域没有 `require`（ESM 主进程也一样），用 `process.mainModule.require('electron')` 或 `process.getBuiltinModule('fs')`；主进程的求值不支持动态 `import()`。顶层 `await` 可以直接写；`await (…)` 只在它前面没有其他语句时才会被自动按顶层 await 重试，前面有语句时报错里会提示把操作数放进变量再 await，或包进 `(async () => { … })()`。
