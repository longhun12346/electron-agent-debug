import { z } from "zod";
import { errorResult, toDiagnosticError } from "./errors.js";
import { SessionManager } from "./sessions/session-manager.js";
import { allTools } from "./tools/index.js";

const MAX_STEPS = 100;
const MAX_INPUT_BYTES = 1_048_576;

const stepsSchema = z.array(z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  continueOnError: z.boolean().optional(),
})).min(1).max(MAX_STEPS);

export interface BatchStepResult {
  tool: string;
  ok?: boolean;
  skipped?: true;
  result?: unknown;
}

export interface BatchResult {
  ok: boolean;
  results: BatchStepResult[];
}

export async function runBatch(input: unknown, manager: SessionManager): Promise<BatchResult> {
  const parsed = stepsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      results: [{
        tool: "(batch)",
        ok: false,
        result: errorResult({
          code: "INVALID_ARGUMENT",
          message: `批处理输入必须是 1-${MAX_STEPS} 个 {tool, arguments?, continueOnError?} 的数组：${parsed.error.message}`,
          retryable: false,
        }),
      }],
    };
  }

  const results: BatchStepResult[] = [];
  let stopped = false;
  for (const step of parsed.data) {
    if (stopped) {
      results.push({ tool: step.tool, skipped: true });
      continue;
    }
    const outcome = await runStep(step.tool, step.arguments ?? {}, manager);
    results.push({ tool: step.tool, ...outcome });
    if (!outcome.ok && !step.continueOnError) stopped = true;
  }
  return { ok: results.every((entry) => entry.ok === true), results };
}

async function runStep(
  name: string,
  args: Record<string, unknown>,
  manager: SessionManager,
): Promise<{ ok: boolean; result: unknown }> {
  const tool = allTools.find((candidate) => candidate.name === name);
  if (!tool) {
    return {
      ok: false,
      result: errorResult({
        code: "INVALID_ARGUMENT",
        message: `未知工具：${name}；可用：${allTools.map((candidate) => candidate.name).join(", ")}`,
        retryable: false,
      }),
    };
  }
  const input = tool.inputSchema.safeParse(args);
  if (!input.success) {
    return {
      ok: false,
      result: errorResult({
        code: "INVALID_ARGUMENT",
        message: `${name} 参数无效：${input.error.message}`,
        retryable: false,
      }),
    };
  }
  try {
    const output = await tool.handler(manager, input.data);
    return { ok: output.isError !== true, result: output.structuredContent };
  } catch (error) {
    return { ok: false, result: errorResult(toDiagnosticError(error)) };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) throw new Error(`批处理输入超过 ${MAX_INPUT_BYTES} 字节`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runBatchFromStdin(): Promise<void> {
  const manager = new SessionManager();
  let batch: BatchResult;
  try {
    let input: unknown;
    try {
      input = JSON.parse(await readStdin());
    } catch (error) {
      throw new Error(`无法读取批处理 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    batch = await runBatch(input, manager);
  } catch (error) {
    batch = {
      ok: false,
      results: [{ tool: "(batch)", ok: false, result: errorResult(toDiagnosticError(error, "INVALID_ARGUMENT")) }],
    };
  } finally {
    await manager.close();
  }
  process.stdout.write(`${JSON.stringify(batch)}\n`);
  process.exitCode = batch.ok ? 0 : 1;
}
