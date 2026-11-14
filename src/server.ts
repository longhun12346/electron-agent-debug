import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { errorResult, toDiagnosticError } from "./errors.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerCoreTools } from "./tools/core-tools.js";

export function createMcpServer(): McpServer {
  const manager = new SessionManager();
  const server = new McpServer({
    name: "electron-agent-debug",
    version: "0.1.0",
  });
  registerCoreTools(server, manager);
  return server;
}

export function formatUnhandledError(error: unknown): string {
  return JSON.stringify(errorResult(toDiagnosticError(error)));
}

export function startServer() {
  return serveStdio(() => createMcpServer(), {
    onerror: (error) => {
      process.stderr.write(`${formatUnhandledError(error)}\n`);
    },
  });
}
