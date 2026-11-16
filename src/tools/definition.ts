import type { z } from "zod";
import type { SessionManager } from "../sessions/session-manager.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: true;
};

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<Record<string, unknown>>;
  handler: (manager: SessionManager, input: any) => Promise<ToolResult>;
}

export function toolResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true as const } : {}),
  };
}

export function defineTool<S extends z.ZodObject<any>>(definition: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  handler: (manager: SessionManager, input: z.infer<S>) => Promise<ToolResult>;
}): ToolDefinition {
  return definition;
}
