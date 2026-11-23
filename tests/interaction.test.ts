import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { renderAxTree, type AxNode } from "../src/ax-tree.js";
import type { RuntimeConfig } from "../src/config.js";
import { RefRegistry } from "../src/interaction.js";
import { SessionManager } from "../src/sessions/session-manager.js";

// Ref bookkeeping and the decisions click/type make from CDP answers. Real input is covered by
// examples/fixture/interaction-smoke.mjs; here a mock page answers the CDP calls so each branch can be forced.

const node = (nodeId: string, role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({
  nodeId, role: { value: role }, name: { value: name }, ...extra,
});

test("snapshots tag only interactive nodes that map to a DOM node", () => {
  const nodes = [
    node("1", "RootWebArea", "App", { childIds: ["2", "3", "4", "5"], backendDOMNodeId: 1 }),
    node("2", "heading", "Title", { parentId: "1", backendDOMNodeId: 2 }),
    node("3", "button", "Save", { parentId: "1", backendDOMNodeId: 3 }),
    node("4", "textbox", "Name", { parentId: "1", backendDOMNodeId: 4 }),
    node("5", "button", "Virtual", { parentId: "1" }),
  ];
  const refs = new RefRegistry();
  const rendering = renderAxTree(nodes, 100, refs.begin("page-a"));
  assert.equal(rendering.refCount, 2);
  assert.match(rendering.text, /button "Save" \[ref=e1\]/u);
  assert.match(rendering.text, /textbox "Name" \[ref=e2\]/u);
  assert.match(rendering.text, /heading "Title"$/mu);
  assert.match(rendering.text, /button "Virtual"$/mu, "a node without a DOM node gets no ref");
  assert.equal(renderAxTree(nodes, 100).refCount, undefined, "no refs unless requested");
});

test("refs stay stable across snapshots of one page and expire with the page", () => {
  const save = node("3", "button", "Save", { backendDOMNodeId: 30 });
  const other = node("4", "button", "Other", { backendDOMNodeId: 40 });
  const refs = new RefRegistry();
  renderAxTree([save, other], 10, refs.begin("page-a"));
  const second = renderAxTree([other, save], 10, refs.begin("page-a"));
  assert.match(second.text, /"Save" \[ref=e1\]/u);
  assert.equal(refs.resolve("e1", "page-a").backendNodeId, 30);

  renderAxTree([other], 10, refs.begin("page-a"));
  assert.throws(() => refs.resolve("e1", "page-a"), /REF_NOT_FOUND|不在最近一次/u, "only the latest snapshot counts");
  assert.throws(() => refs.resolve("e2", "page-b"), (error: { diagnostic?: { code: string } }) =>
    error.diagnostic?.code === "REF_STALE");

  const other2 = renderAxTree([save], 10, refs.begin("page-b"));
  assert.match(other2.text, /\[ref=e3\]/u, "another page numbers on and never reuses a ref");
});

type Responder = (method: string, params: Record<string, unknown>) => unknown;

async function startPage(respond: Responder): Promise<{ endpoint: string; calls: string[]; close(): Promise<void> }> {
  const calls: string[] = [];
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const sockets = new Set<WebSocket>();
  ws.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string; params?: Record<string, unknown> };
      calls.push(message.method);
      const result = respond(message.method, message.params ?? {});
      if (result === "hang") return;
      if (result instanceof Error) {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: result.message } }));
        return;
      }
      socket.send(JSON.stringify({ id: message.id, result: result ?? {} }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  http.on("request", (_request, response) => response.end(JSON.stringify([{
    id: "page", type: "page", title: "App", url: "app://page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page`,
  }])));
  return {
    endpoint: `http://127.0.0.1:${port}`,
    calls,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => (http as Server).close(() => resolve()));
    },
  };
}

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    requestTimeoutMs: 500, discoveryTimeoutMs: 1_000, maxLogEvents: 100, maxLogBytes: 100_000,
    maxProtocolMessageBytes: 100_000, allowEval: true, ...overrides,
  };
}

interface PageState {
  hit?: number;
  state?: Record<string, boolean>;
  resolveFails?: boolean;
  quads?: number[][];
  reaches?: boolean;
}

// A page with one button (backend node 7) whose answers can be changed per test.
function page(state: PageState): Responder {
  return (method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      return { nodes: [node("1", "button", "Save", { backendDOMNodeId: 7 })] };
    }
    if (method === "DOM.resolveNode") {
      if (state.resolveFails) return new Error("No node with given id found");
      return { object: { objectId: `obj-${String(params.backendNodeId)}` } };
    }
    if (method === "Runtime.callFunctionOn") {
      const fn = String(params.functionDeclaration);
      if (fn.includes("nonText")) {
        return { result: { value: { disabled: false, editable: false, readOnly: false, password: false, ...state.state } } };
      }
      if (fn.includes("closest('label')")) return { result: { value: state.reaches ?? false } };
      if (fn.includes("localName")) return { result: { value: { tag: "div", id: "overlay" } } };
      return { result: { value: "typed" } };
    }
    if (method === "DOM.getContentQuads") return { quads: state.quads ?? [[10, 10, 50, 10, 50, 30, 10, 30]] };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 100 } };
    if (method === "DOM.getNodeForLocation") return { backendNodeId: state.hit ?? 7 };
    return {};
  };
}

async function withPage(state: PageState, run: (manager: SessionManager, calls: string[]) => Promise<void>, overrides = {}) {
  const mock = await startPage(page(state));
  const manager = new SessionManager(config(overrides));
  try {
    assert.ok((await manager.attach({ rendererUrl: mock.endpoint })).ok);
    const snapshot = await manager.inspector.domSnapshot({});
    assert.ok(snapshot.ok);
    await run(manager, mock.calls);
  } finally {
    await manager.close();
    await mock.close();
  }
}

test("a click on an exposed element sends trusted mouse events and returns afterSeq", async () => {
  await withPage({}, async (manager, calls) => {
    const result = await manager.inspector.click({ ref: "e1" });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual([result.data.x, result.data.y, typeof result.data.afterSeq], [30, 20, "number"]);
    assert.equal(calls.filter((method) => method === "Input.dispatchMouseEvent").length, 3);
    assert.ok(calls.indexOf("DOM.scrollIntoViewIfNeeded") < calls.indexOf("DOM.getContentQuads"));
  });
});

test("the hit test uses document coordinates", async () => {
  const seen: unknown[] = [];
  const mock = await startPage((method, params) => {
    if (method === "DOM.getNodeForLocation") seen.push([params.x, params.y]);
    return page({})(method, params);
  });
  const manager = new SessionManager(config());
  try {
    assert.ok((await manager.attach({ rendererUrl: mock.endpoint })).ok);
    await manager.inspector.domSnapshot({});
    assert.ok((await manager.inspector.click({ ref: "e1" })).ok);
    assert.deepEqual(seen, [[30, 120]], "the vertical scroll offset (100) is added to the viewport point");
  } finally {
    await manager.close();
    await mock.close();
  }
});

test("a covered element is not clicked", async () => {
  await withPage({ hit: 99 }, async (manager, calls) => {
    const result = await manager.inspector.click({ ref: "e1" });
    assert.ok(!result.ok);
    assert.equal(result.error.code, "ELEMENT_COVERED");
    assert.deepEqual(result.error.details?.coveredBy, { tag: "div", id: "overlay" });
    assert.equal(calls.includes("Input.dispatchMouseEvent"), false);
  });
});

test("a hit on a child or label of the element counts as the element", async () => {
  await withPage({ hit: 99, reaches: true }, async (manager) => {
    assert.ok((await manager.inspector.click({ ref: "e1" })).ok);
  });
});

test("disabled, invisible and removed elements fail before any input", async () => {
  await withPage({ state: { disabled: true } }, async (manager, calls) => {
    const result = await manager.inspector.click({ ref: "e1" });
    assert.ok(!result.ok && result.error.code === "ELEMENT_DISABLED");
    assert.equal(calls.includes("Input.dispatchMouseEvent"), false);
  });
  await withPage({ quads: [] }, async (manager) => {
    const result = await manager.inspector.click({ ref: "e1" });
    assert.ok(!result.ok && result.error.code === "ELEMENT_NOT_VISIBLE");
  });
  await withPage({ resolveFails: true }, async (manager) => {
    const result = await manager.inspector.click({ ref: "e1" });
    assert.ok(!result.ok && result.error.code === "REF_STALE");
    assert.match(result.error.hint ?? "", /electron_dom_snapshot/u);
  });
});

test("typing checks that the element is editable and inserts the text", async () => {
  await withPage({}, async (manager, calls) => {
    const result = await manager.inspector.type({ ref: "e1", text: "x" });
    assert.ok(!result.ok && result.error.code === "ELEMENT_NOT_EDITABLE");
    assert.equal(calls.includes("Input.insertText"), false);
  });
  await withPage({ state: { editable: true } }, async (manager, calls) => {
    const result = await manager.inspector.type({ ref: "e1", text: "你好", submit: true });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.data.value, "typed");
    assert.equal(calls.filter((method) => method === "Input.insertText").length, 1);
    assert.equal(calls.filter((method) => method === "Input.dispatchKeyEvent").length, 2, "Enter down and up");
  });
  await withPage({ state: { editable: true, password: true } }, async (manager) => {
    const result = await manager.inspector.type({ ref: "e1", text: "hunter2" });
    assert.ok(result.ok && result.data.value === "[REDACTED]");
  });
});

test("click and type are disabled together with evaluation", async () => {
  await withPage({}, async (manager, calls) => {
    for (const result of [await manager.inspector.click({ ref: "e1" }), await manager.inspector.type({ ref: "e1", text: "x" })]) {
      assert.ok(!result.ok && result.error.code === "INTERACTION_NOT_ALLOWED");
    }
    assert.equal(calls.includes("DOM.resolveNode"), false);
  }, { allowEval: false });
});

test("a ref from before a target switch is rejected", async () => {
  await withPage({}, async (manager) => {
    manager.renderer.clearTargetSelection();
    const result = await manager.inspector.click({ ref: "e1" });
    assert.ok(!result.ok && result.error.code === "REF_STALE");
  });
});
