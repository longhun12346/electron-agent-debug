import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { version } from "./version.js";
import { errorResult, toDiagnosticError } from "./errors.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerCoreTools } from "./tools/core-tools.js";

export function createMcpServer(manager = new SessionManager()): McpServer {
  const server = new McpServer({
    name: "electron-agent-debug",
    version,
  });
  registerCoreTools(server, manager);
  server.server.onclose = () => {
    void manager.close();
  };
  return server;
}

export function formatUnhandledError(error: unknown): string {
  return JSON.stringify(errorResult(toDiagnosticError(error)));
}

export function startServer() {
  let manager: SessionManager | undefined;
  const handle = serveStdio(() => {
    manager = new SessionManager();
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
