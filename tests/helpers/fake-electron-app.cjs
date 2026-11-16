"use strict";
// Test double for an Electron app: exposes loopback discovery + debugger WebSockets that answer a few CDP methods.
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");

const options = {};
for (const argument of process.argv.slice(2)) {
  const [name, value = "true"] = argument.replace(/^--/, "").split("=");
  options[name] = value;
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const axNodes = [
  { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Fixture" }, childIds: ["2", "3", "4"] },
  { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Save" }, childIds: ["5"],
    properties: [{ name: "disabled", value: { value: true } }] },
  { nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Name" }, value: { value: "token=abcdef123456" } },
  { nodeId: "4", parentId: "1", ignored: true, role: { value: "none" }, childIds: ["6"] },
  { nodeId: "5", parentId: "2", role: { value: "StaticText" }, name: { value: "Save" } },
  { nodeId: "6", parentId: "4", role: { value: "heading" }, name: { value: "Settings" }, properties: [{ name: "level", value: { value: 2 } }] },
];

let polls = 0;

function answer(scope, socket, message) {
  const reply = (result) => socket.send(JSON.stringify({ id: message.id, result }));
  if (message.method === "Runtime.enable") {
    reply({});
    if (scope === "renderer") {
      socket.send(JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: { type: "log", args: [{ value: "renderer ready" }] },
      }));
    }
    return;
  }
  if (message.method === "Runtime.evaluate") {
    const expression = message.params.expression;
    if (expression === "never") return;
    if (expression === "throw") {
      reply({
        result: { type: "object", subtype: "error" },
        exceptionDetails: {
          text: "Uncaught", lineNumber: 0, columnNumber: 6,
          exception: { description: "Error: boom password=hunter2hunter2" },
        },
      });
      return;
    }
    if (expression === "big") return reply({ result: { type: "string", value: "x".repeat(5000) } });
    if (expression === "secret") return reply({ result: { type: "object", value: { token: "abc12345678", ok: true } } });
    if (expression === "nan") return reply({ result: { type: "number", unserializableValue: "NaN" } });
    if (expression === "poll") return reply({ result: { type: "boolean", value: ++polls >= 3 } });
    if (expression === "undefined") return reply({ result: { type: "undefined" } });
    // Real Chromium: replMode accepts top-level await but does not await plain promises; non-repl mode is the reverse.
    if (expression === "await-top-level") {
      if (!message.params.replMode) {
        return reply({
          result: { type: "object", subtype: "error" },
          exceptionDetails: {
            text: "Uncaught", lineNumber: 0, columnNumber: 0,
            exception: { description: "SyntaxError: await is only valid in async functions and the top level bodies of modules" },
          },
        });
      }
      return reply({ result: { type: "object", value: { awaited: true } } });
    }
    if (expression === "plain-promise") {
      return reply({ result: { type: "object", value: message.params.replMode ? {} : { awaited: true } } });
    }
    return reply({ result: { type: "string", value: `${scope}:${expression}` } });
  }
  if (message.method === "Page.captureScreenshot") return reply({ data: png });
  if (message.method === "Accessibility.getFullAXTree") return reply({ nodes: axNodes });
  reply({});
}

function serve(scope, port) {
  const server = createServer((request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([
      scope === "main"
        ? { id: "main", type: "node", title: "Main", url: "",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/main` }
        : { id: "page-1", type: "page", title: "Fixture", url: "app://fixture",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` },
    ]));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.on("message", (raw) => answer(scope, socket, JSON.parse(raw.toString()))));
  server.listen(Number(port), "127.0.0.1");
}

const mainPort = options.inspect;
const rendererPort = options["remote-debugging-port"];
if (mainPort) serve("main", mainPort);
if (rendererPort) serve("renderer", rendererPort);

process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
