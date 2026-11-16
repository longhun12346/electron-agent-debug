import { z } from "zod";
import { errorResult } from "../errors.js";
import type { WaitCondition } from "../sessions/inspector.js";
import { defineTool, toolResult } from "./definition.js";

const scopeSchema = z.enum(["main", "renderer"]);

const evaluateSchema = z.object({
  scope: scopeSchema,
  expression: z.string().min(1).max(50_000),
  awaitPromise: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  maxResultBytes: z.number().int().min(256).max(1_048_576).optional(),
});

const waitSchema = z.object({
  log: z.object({
    contains: z.string().min(1).max(500),
    process: z.enum(["main", "renderer", "all"]).optional(),
    level: z.string().optional(),
    afterSeq: z.number().int().min(0).optional(),
  }).optional(),
  expression: z.object({
    scope: scopeSchema,
    expression: z.string().min(1).max(50_000),
  }).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  intervalMs: z.number().int().min(50).max(5_000).optional(),
});

const screenshotSchema = z.object({
  format: z.enum(["png", "jpeg"]).optional(),
  quality: z.number().int().min(1).max(100).optional(),
});

const snapshotSchema = z.object({
  maxNodes: z.number().int().min(1).max(2_000).optional(),
});

export const inspectionTools = [
  defineTool({
    name: "electron_evaluate",
    title: "Evaluate JavaScript in the main or renderer process",
    description:
      "在主进程 Inspector 或当前选中的 renderer target 中执行一段 JavaScript（Runtime.evaluate，默认 await Promise，支持顶层 await，默认超时 3s）。" +
      "结果按值返回，超过 maxResultBytes 时截断，并对常见密钥字段做脱敏。主进程全局没有 require，请用 process.mainModule.require('electron')。" +
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
      "等待一个条件成立，超时返回 WAIT_TIMEOUT。二选一：log（事件消息包含 contains，默认也检查已缓存事件，可用 afterSeq 只看之后的事件）、" +
      "expression（反复执行表达式直到返回真值，规则同 electron_evaluate）。",
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
      "默认系统临时目录，仅保留最近 50 张）。不返回图像内容，请用文件读取工具查看。",
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
      "不在页面中执行脚本，可用于附加模式。",
    inputSchema: snapshotSchema,
    handler: async (manager, input) => {
      const result = await manager.inspector.domSnapshot(input);
      return toolResult(result, !result.ok);
    },
  }),
];
