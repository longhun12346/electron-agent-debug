import { z } from "zod";
import { parseAttachInput } from "../config.js";
import { errorResult, toDiagnosticError } from "../errors.js";
import { defineTool, toolResult } from "./definition.js";

const attachSchema = z.object({
  mainUrl: z.string().optional(),
  rendererUrl: z.string().optional(),
  targetId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  clearSelection: z.boolean().optional(),
});

const targetsSchema = z.object({
  rendererUrl: z.string().optional(),
  targetId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  clearSelection: z.boolean().optional(),
});

const logsSchema = z.object({
  process: z.enum(["main", "renderer", "all"]).optional(),
  level: z.string().optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
  since: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "since 必须是有效的日期时间字符串",
  }).optional(),
  afterSeq: z.number().int().min(0).optional(),
  clear: z.boolean().optional(),
});

export const coreTools = [
  defineTool({
    name: "electron_attach",
    title: "Attach to Electron diagnostics",
    description:
      "连接 Agent 提供的本地主进程 Inspector 和/或 renderer CDP endpoint；不启动 Electron；应用由 Agent 用项目已有命令启动（加 --inspect 和 --remote-debugging-port）。",
    inputSchema: attachSchema,
    handler: async (manager, input) => {
      const parsed = parseAttachInput(input);
      const result = await manager.attach(parsed);
      return toolResult(result, !result.ok);
    },
  }),
  defineTool({
    name: "electron_status",
    title: "Read Electron diagnostic status",
    description: "读取两个通道的 Session、target 和事件数量，不执行应用代码。",
    inputSchema: z.object({}),
    handler: async (manager) => toolResult({ ok: true, data: manager.status() }),
  }),
  defineTool({
    name: "electron_targets",
    title: "List and select Electron targets",
    description:
      "发现 renderer page targets，并按 targetId、url 或 title 选择当前 target；可用 clearSelection 清除旧选择。",
    inputSchema: targetsSchema,
    handler: async (manager, input) => {
      const result = await manager.refreshTargets(input);
      return toolResult(result, !result.ok);
    },
  }),
  defineTool({
    name: "electron_logs",
    title: "Read Electron diagnostic logs",
    description: "读取当前 MCP Server 进程内有界缓存的统一时间线：主进程和 renderer 的事件，按 seq 排序。返回 lastSeq，下次用 afterSeq 只读取之后的事件。",
    inputSchema: logsSchema,
    handler: async (manager, input) => {
      try {
        return toolResult({ ok: true, data: manager.logs(input) });
      } catch (error) {
        return toolResult(errorResult(toDiagnosticError(error, "INVALID_ARGUMENT")), true);
      }
    },
  }),
];
