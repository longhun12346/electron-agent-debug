import { z } from "zod";
import { parseAttachInput } from "../config.js";
import { errorResult, toDiagnosticError } from "../errors.js";
import { defineTool, toolResult } from "./definition.js";

const attachSchema = z.object({
  mainUrl: z.string().max(2048).optional(),
  rendererUrl: z.string().max(2048).optional(),
  utility: z.union([z.string().min(1).max(256), z.number().int().positive()]).optional(),
  targetId: z.string().max(256).optional(),
  url: z.string().max(4096).optional(),
  title: z.string().max(1024).optional(),
  clearSelection: z.boolean().optional(),
  instrument: z.array(z.enum(["ipc", "dialogs"])).max(2).optional(),
});

const targetsSchema = z.object({
  rendererUrl: z.string().max(2048).optional(),
  targetId: z.string().max(256).optional(),
  url: z.string().max(4096).optional(),
  title: z.string().max(1024).optional(),
  clearSelection: z.boolean().optional(),
});

const logsSchema = z.object({
  process: z.enum(["main", "renderer", "utility", "all"]).optional(),
  level: z.string().max(32).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
  since: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "since 必须是有效的日期时间字符串",
  }).optional(),
  afterSeq: z.number().int().min(0).optional(),
  sinceAttach: z.boolean().optional(),
  clear: z.boolean().optional(),
});

export const coreTools = [
  defineTool({
    name: "electron_attach",
    title: "Attach to Electron diagnostics",
    description:
      "连接 Agent 提供的本地主进程 Inspector 和/或 renderer CDP endpoint；不启动 Electron；应用由 Agent 用项目已有命令启动（加 --inspect 和 --remote-debugging-port）。" +
      "utility 传 utility process 的名字（fork 的 serviceName）或 pid：工具通过已连接的主进程找到它并打开调试口，作为独立的第三通道，与主进程、renderer 同时在线；需要主进程在线且允许执行代码。" +
      "允许执行代码时，attach 默认在主进程里装上 IPC 追踪和原生对话框追踪的包装（应用重启前不会移除）；instrument 传 [\"ipc\"]、[\"dialogs\"] 或 [] 可以只装一部分或都不装，不传沿用上一次的选择，结果的 instrumented 列出实际装了什么。",
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
    description: "读取三个通道（主进程、renderer、utility）的 Session、target 和事件数量，并返回当前 lastSeq（回归前记下它，之后用 afterSeq 读取新事件）。不执行应用代码。",
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
    description: "读取当前 MCP Server 进程内有界缓存的统一时间线：主进程、renderer 和 utility 的事件，按 seq 排序。返回 lastSeq，下次用 afterSeq 只读取之后的事件。sinceAttach 为 true 时，每个通道只返回它最近一次连接之后的事件，不含 attach 时重放的应用历史输出，可替代自己记录 lastSeq。缓冲区满时最旧的事件会被丢弃：droppedThroughSeq 是被丢弃的最大 seq，gap 为 true 表示所请求的范围内可能有事件缺失，应缩短取证间隔或调大 ELECTRON_DEBUG_MAX_LOG_EVENTS。",
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
