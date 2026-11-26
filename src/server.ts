import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { version } from "./version.js";
import { errorResult, toDiagnosticError } from "./errors.js";
import { SessionManager } from "./sessions/session-manager.js";
import { toolResult } from "./tools/definition.js";
import { allTools } from "./tools/index.js";

export function createMcpServer(manager = new SessionManager()): McpServer {
  const server = new McpServer({
    name: "electron-agent-debug",
    version,
  });
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (input) => tool.handler(manager, input),
    );
  }
  server.server.onclose = () => {
    void manager.close();
  };
  return server;
}

export function formatUnhandledError(error: unknown): string {
  return JSON.stringify(errorResult(toDiagnosticError(error)));
}

// A host that sets an invalid value in the server's environment would otherwise get a server that dies during
// initialize with no explanation the agent can read. Keep the server up and let every tool say what is wrong.
export function createConfigErrorServer(error: unknown): McpServer {
  const diagnostic = toDiagnosticError(error);
  const server = new McpServer({ name: "electron-agent-debug", version });
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async () => toolResult(errorResult(diagnostic), true),
    );
  }
  return server;
}

export function startServer() {
  let manager: SessionManager | undefined;
  const handle = serveStdio(() => {
    try {
      manager = new SessionManager();
    } catch (error) {
      return createConfigErrorServer(error);
    }
    return createMcpServer(manager);
  }, {
    onerror: (error) => {
      process.stderr.write(`${formatUnhandledError(error)}\n`);
    },
  });
  return {
    async close(): Promise<void> {
      await handle.close();
      await manager?.close();
    },
  };
}
