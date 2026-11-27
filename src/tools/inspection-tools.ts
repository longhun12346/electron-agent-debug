import { z } from "zod";
import { errorResult } from "../errors.js";
import type { WaitCondition } from "../sessions/inspector.js";
import { defineTool, toolResult } from "./definition.js";

const scopeSchema = z.enum(["main", "renderer", "utility"]);

const evaluateSchema = z.strictObject({
  scope: scopeSchema,
  expression: z.string().min(1).max(50_000),
  awaitPromise: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  maxResultBytes: z.number().int().min(256).max(1_048_576).optional(),
});

const waitSchema = z.strictObject({
  log: z.strictObject({
    contains: z.string().min(1).max(500),
    process: z.enum(["main", "renderer", "utility", "all"]).optional(),
    level: z.string().optional(),
    afterSeq: z.number().int().min(0).optional(),
    sinceAttach: z.boolean().optional(),
  }).optional(),
  expression: z.strictObject({
    scope: scopeSchema,
    expression: z.string().min(1).max(50_000),
  }).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  intervalMs: z.number().int().min(50).max(5_000).optional(),
});

const screenshotSchema = z.strictObject({
  format: z.enum(["png", "jpeg"]).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  maxWidth: z.number().int().min(100).max(8_000).optional(),
});

const snapshotSchema = z.strictObject({
  maxNodes: z.number().int().min(1).max(2_000).optional(),
  interactive: z.boolean().optional(),
  maxText: z.number().int().min(20).max(2_000).optional(),
});

export const inspectionTools = [
  defineTool({
    name: "electron_evaluate",
    title: "Evaluate JavaScript in the main, renderer or utility process",
    description:
      "在主进程 Inspector、当前选中的 renderer target 或已连接的 utility process 中执行一段 JavaScript（Runtime.evaluate，默认 await Promise，支持顶层 await，默认超时 3s；顶层 let/const 与之前调用的声明重名时改在块内执行，声明不保留）。" +
      "结果按值返回，超过 maxResultBytes 时截断，不做脱敏。主进程全局没有 require，请用 process.mainModule.require('electron')。" +
      "默认开启，宿主可在 MCP 配置的 env 中设置 ELECTRON_DEBUG_ALLOW_EVAL=0 禁用（此时返回 EVALUATION_NOT_ALLOWED）。表达式可修改应用状态，只用于验证。",
    inputSchema: evaluateSchema,
    handler: async (manager, input) => {
      const result = await manager.inspector.evaluate(input);
      return toolResult(result, !result.ok);
    },
  }),
  defineTool({
    name: "electron_wait_for",
    title: "Wait for a runtime condition",
    description:
      "等待一个条件成立，超时返回 WAIT_TIMEOUT。二选一：log（事件消息包含 contains，默认也检查已缓存事件，包括 attach 时重放的应用历史输出；" +
      "afterSeq 只看之后的事件，sinceAttach 只看各通道最近一次连接之后的事件。命中该通道最近一次连接之前的事件时结果带 beforeAttach: true，它不是本次连接期间产生的）、" +
      "expression（反复执行表达式直到返回真值，规则同 electron_evaluate；所在通道没有连接时立即返回 SESSION_DISCONNECTED，不等到超时，先 electron_attach）。",
    inputSchema: waitSchema,
    handler: async (manager, input) => {
      const conditions: WaitCondition[] = [];
      if (input.log) conditions.push({ kind: "log", ...input.log });
      if (input.expression) conditions.push({ kind: "expression", ...input.expression });
      if (conditions.length !== 1) {
        return toolResult(errorResult({
          code: "INVALID_ARGUMENT",
          message: "log、expression 必须且只能提供一个",
          retryable: false,
        }), true);
      }
      const result = await manager.inspector.waitFor({
        condition: conditions[0]!,
        timeoutMs: input.timeoutMs,
        intervalMs: input.intervalMs,
      });
      return toolResult(result, !result.ok);
    },
  }),
  defineTool({
    name: "electron_screenshot",
    title: "Capture a renderer screenshot",
    description:
      "对当前选中的 renderer target 截图，保存为本地文件并返回路径、大小和 target（目录由 ELECTRON_DEBUG_OUTPUT_DIR 指定，" +
      "默认系统临时目录，仅保留最近 50 张）。不返回图像内容，请用文件读取工具查看。" +
      "默认按页面的 CSS 尺寸截图（高分屏不会放大两三倍），maxWidth 可再缩小以节省读取图片的开销，大于 CSS 宽度时最多取到屏幕实际分辨率；返回图片的 width、height 和屏幕的 deviceScaleFactor。",
    inputSchema: screenshotSchema,
    handler: async (manager, input) => {
      const result = await manager.inspector.screenshot(input);
      return toolResult(result, !result.ok);
    },
  }),
  defineTool({
    name: "electron_dom_snapshot",
    title: "Snapshot the renderer accessibility tree",
    description:
      "读取当前 renderer 的无障碍树并渲染为缩进文本（role \"name\" value 及 disabled/checked 等状态），有节点数上限。" +
      "不在页面中执行脚本，可用于附加模式。可点击或可输入的元素带 [ref=kqx12] 标记，传给 electron_click、electron_type；" +
      "同一元素在同一页面的多次快照里 ref 不变，只有最近一次快照里的 ref 可用；ref 只在本进程内有效（批处理每次执行都是新进程）。" +
      "页面很长（如几百条的列表）时默认 400 行会被截断（truncated 为 true），后面的元素拿不到 ref：" +
      "传 interactive: true 只列可交互元素和标题，或直接用 role 和 name 调用 electron_click、electron_type。" +
      "名字、值和状态超过 120 个字符会以 ... 截断，传 maxText（20 到 2000）调整；链接地址原样输出。",
    inputSchema: snapshotSchema,
    handler: async (manager, input) => {
      const result = await manager.inspector.domSnapshot(input);
      return toolResult(result, !result.ok);
    },
  }),
];
