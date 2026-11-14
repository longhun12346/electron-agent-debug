# 开发说明

## 环境

- Node.js 22 或更高版本。
- 根目录依赖用于 MCP Server、测试和 TypeScript 构建。
- `examples/fixture` 是独立的 Electron 示例包，使用自己的 `package.json` 和 lockfile。

## 常用命令

在仓库根目录执行：

```powershell
npm install
npm test
npm run lint
npm run build
```

`npm test` 会先构建 TypeScript，再运行契约和单元测试。测试不需要启动真实 Electron。

## Electron fixture

fixture 的安装和运行说明位于 [`examples/fixture/README.md`](examples/fixture/README.md)。主进程 Inspector 和 renderer CDP 的端口由运行 Agent 或测试脚本分配，仓库不固定端口，也不提交 `node_modules`、构建产物或 Electron 下载缓存。

## 提交边界

一次提交应保持一个清晰目的。核心实现、测试、文档和 fixture 可以在同一次功能提交中一起提交，因为它们共同构成可验证的诊断能力；本地产物、日志、依赖安装目录和临时输出不应进入 Git。
