import { coreTools } from "./core-tools.js";
import type { ToolDefinition } from "./definition.js";
import { inspectionTools } from "./inspection-tools.js";
import { interactionTools } from "./interaction-tools.js";

export const allTools: ToolDefinition[] = [...coreTools, ...inspectionTools, ...interactionTools];
