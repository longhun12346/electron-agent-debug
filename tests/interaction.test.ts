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
  const refs = new RefRegistry("abc");
  const rendering = renderAxTree(nodes, 100, refs.begin("page-a"));
  assert.equal(rendering.refCount, 2);
  assert.match(rendering.text, /button "Save" \[ref=abc1\]/u);
  assert.match(rendering.text, /textbox "Name" \[ref=abc2\]/u);
  assert.match(rendering.text, /heading "Title"$/mu);
  assert.match(rendering.text, /button "Virtual"$/mu, "a node without a DOM node gets no ref");
  assert.equal(renderAxTree(nodes, 100).refCount, undefined, "no refs unless requested");
});

test("refs stay stable across snapshots of one page and expire with the page", () => {
  const save = node("3", "button", "Save", { backendDOMNodeId: 30 });
  const other = node("4", "button", "Other", { backendDOMNodeId: 40 });
  const refs = new RefRegistry("abc");
  renderAxTree([save, other], 10, refs.begin("page-a"));
  const second = renderAxTree([other, save], 10, refs.begin("page-a"));
  assert.match(second.text, /"Save" \[ref=abc1\]/u);
  assert.equal(refs.resolve("abc1", "page-a").backendNodeId, 30);

  renderAxTree([other], 10, refs.begin("page-a"));
  assert.throws(() => refs.resolve("abc1", "page-a"), /REF_NOT_FOUND|不在最近一次/u, "only the latest snapshot counts");
  assert.throws(() => refs.resolve("abc2", "page-b"), (error: { diagnostic?: { code: string } }) =>
    error.diagnostic?.code === "REF_STALE");

  const other2 = renderAxTree([save], 10, refs.begin("page-b"));
  assert.match(other2.text, /\[ref=abc3\]/u, "another page numbers on and never reuses a ref");
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

async function withPage(state: PageState, run: (manager: SessionManager, calls: string[], ref: string) => Promise<void>, overrides = {}) {
  const mock = await startPage(page(state));
  const manager = new SessionManager(config(overrides));
  try {
    assert.ok((await manager.attach({ rendererUrl: mock.endpoint })).ok);
    const snapshot = await manager.inspector.domSnapshot({});
    assert.ok(snapshot.ok);
    const ref = /\[ref=([a-z]{3}\d+)\]/u.exec(String(snapshot.data.text))![1]!;
    await run(manager, mock.calls, ref);
  } finally {
    await manager.close();
    await mock.close();
  }
}

test("a click on an exposed element sends trusted mouse events and returns afterSeq", async () => {
  await withPage({}, async (manager, calls, ref) => {
    const result = await manager.inspector.click({ ref });
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
    assert.ok((await manager.inspector.click({ role: "button", name: "Save" })).ok);
    assert.deepEqual(seen, [[30, 120]], "the vertical scroll offset (100) is added to the viewport point");
  } finally {
    await manager.close();
    await mock.close();
  }
});

test("a covered element is not clicked", async () => {
  await withPage({ hit: 99 }, async (manager, calls, ref) => {
    const result = await manager.inspector.click({ ref });
    assert.ok(!result.ok);
    assert.equal(result.error.code, "ELEMENT_COVERED");
    assert.deepEqual(result.error.details?.coveredBy, { tag: "div", id: "overlay" });
    assert.equal(calls.includes("Input.dispatchMouseEvent"), false);
  });
});

test("a hit on a child or label of the element counts as the element", async () => {
  await withPage({ hit: 99, reaches: true }, async (manager, _calls, ref) => {
    assert.ok((await manager.inspector.click({ ref })).ok);
  });
});

test("disabled, invisible and removed elements fail before any input", async () => {
  await withPage({ state: { disabled: true } }, async (manager, calls, ref) => {
    const result = await manager.inspector.click({ ref });
    assert.ok(!result.ok && result.error.code === "ELEMENT_DISABLED");
    assert.equal(calls.includes("Input.dispatchMouseEvent"), false);
  });
  await withPage({ quads: [] }, async (manager, _calls, ref) => {
    const result = await manager.inspector.click({ ref });
    assert.ok(!result.ok && result.error.code === "ELEMENT_NOT_VISIBLE");
  });
  await withPage({ resolveFails: true }, async (manager, _calls, ref) => {
    const result = await manager.inspector.click({ ref });
    assert.ok(!result.ok && result.error.code === "REF_STALE");
    assert.match(result.error.hint ?? "", /electron_dom_snapshot/u);
  });
});

test("typing checks that the element is editable and inserts the text", async () => {
  await withPage({}, async (manager, calls, ref) => {
    const result = await manager.inspector.type({ ref, text: "x" });
    assert.ok(!result.ok && result.error.code === "ELEMENT_NOT_EDITABLE");
    assert.equal(calls.includes("Input.insertText"), false);
  });
  await withPage({ state: { editable: true } }, async (manager, calls, ref) => {
    const result = await manager.inspector.type({ ref, text: "你好", submit: true });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.data.value, "typed");
    assert.equal(calls.filter((method) => method === "Input.insertText").length, 1);
    assert.equal(calls.filter((method) => method === "Input.dispatchKeyEvent").length, 2, "Enter down and up");
  });
  await withPage({ state: { editable: true, password: true } }, async (manager, _calls, ref) => {
    const result = await manager.inspector.type({ ref, text: "hunter2" });
    assert.ok(result.ok && result.data.value === "[password field]");
  });
});

test("click and type are disabled together with evaluation", async () => {
  await withPage({}, async (manager, calls, ref) => {
    for (const result of [await manager.inspector.click({ ref }), await manager.inspector.type({ ref, text: "x" })]) {
      assert.ok(!result.ok && result.error.code === "INTERACTION_NOT_ALLOWED");
    }
    assert.equal(calls.includes("DOM.resolveNode"), false);
  }, { allowEval: false });
});

test("a ref from before a target switch is rejected", async () => {
  await withPage({}, async (manager, _calls, ref) => {
    manager.renderer.clearTargetSelection();
    const result = await manager.inspector.click({ ref });
    assert.ok(!result.ok && result.error.code === "REF_STALE");
  });
});

test("each registry numbers with its own prefix, so a ref from another run is unknown", () => {
  const save = node("3", "button", "Save", { backendDOMNodeId: 30 });
  const first = new RefRegistry();
  const second = new RefRegistry();
  assert.match(first.prefix, /^[a-z]{3}$/u);
  const firstRef = /\[ref=([a-z]{3}\d+)\]/u.exec(renderAxTree([save], 10, first.begin("page")).text)![1]!;
  renderAxTree([save], 10, second.begin("page"));
  if (first.prefix !== second.prefix) {
    assert.throws(() => second.resolve(firstRef, "page"), (error: { diagnostic?: { code: string; hint?: string } }) =>
      error.diagnostic?.code === "REF_NOT_FOUND" && /role/u.test(error.diagnostic.hint ?? ""));
  }
});

test("role and name find exactly one element and refuse to guess", () => {
  const refs = new RefRegistry("abc");
  renderAxTree([
    node("1", "button", "Save", { backendDOMNodeId: 1 }),
    node("2", "button", "Delete", { backendDOMNodeId: 2 }),
    node("3", "button", "Delete", { backendDOMNodeId: 3 }),
    node("4", "link", "Save draft", { backendDOMNodeId: 4 }),
  ], 10, refs.begin("page"));
  assert.equal(refs.find({ role: "button", name: " Save " }).backendNodeId, 1, "whitespace is normalised");
  assert.throws(() => refs.find({ role: "button", name: "Delete" }), (error: { diagnostic?: { code: string; details?: { candidates?: unknown[] } } }) =>
    error.diagnostic?.code === "ELEMENT_AMBIGUOUS" && error.diagnostic.details?.candidates?.length === 2);
  assert.throws(() => refs.find({ role: "button", name: "save" }), (error: { diagnostic?: { code: string; details?: { candidates?: Array<{ name: string }> } } }) =>
    error.diagnostic?.code === "ELEMENT_NOT_FOUND" && error.diagnostic.details?.candidates?.some((entry) => entry.name === "Save") === true);
});

test("an interactive snapshot keeps refs and headings, and text repeated in a name is dropped", () => {
  const nodes = [
    node("1", "RootWebArea", "App", { childIds: ["2", "3", "6"], backendDOMNodeId: 1 }),
    node("2", "heading", "Chats", { parentId: "1", backendDOMNodeId: 2 }),
    node("3", "link", "Chat 1 last message", {
      parentId: "1", backendDOMNodeId: 3, childIds: ["4", "5"],
      properties: [{ name: "url", value: { value: `file:///app/index.html?run=${"x".repeat(40)}#c1` } }],
    }),
    node("4", "StaticText", "Chat 1", { parentId: "3" }),
    node("5", "StaticText", "last message", { parentId: "3" }),
    node("6", "paragraph", "", { parentId: "1", childIds: ["7"] }),
    node("7", "StaticText", "status text", { parentId: "6" }),
  ];
  const full = renderAxTree(nodes, 100, new RefRegistry("abc").begin("page")).text;
  assert.doesNotMatch(full, /StaticText "Chat 1"/u, "text inside the link name is not repeated");
  assert.match(full, /StaticText "status text"/u);
  assert.ok(full.includes(`[url=file:///app/index.html?run=${"x".repeat(40)}#c1]`), "link addresses are printed in full");
  const narrow = renderAxTree(nodes, 100, new RefRegistry("abc").begin("page"), { maxText: 30 }).text;
  assert.ok(narrow.includes("[url=file:///app/index.html?run=xxx...]"), "maxText cuts what it must and marks it");

  const interactive = renderAxTree(nodes, 100, new RefRegistry("abc").begin("page"), { interactive: true });
  assert.deepEqual(interactive.text.split("\n").map((line) => line.trim().split(" [")[0]),
    ['heading "Chats"', 'link "Chat 1 last message"']);
});

test("a click by role and name looks at the whole page, beyond what a snapshot shows", async () => {
  const filler = Array.from({ length: 50 }, (_, index) => node(`f${index}`, "heading", `Item ${index}`, { backendDOMNodeId: 100 + index }));
  const mock = await startPage((method, params) => {
    if (method === "Accessibility.getFullAXTree") return { nodes: [...filler, node("1", "button", "Save", { backendDOMNodeId: 7 })] };
    return page({})(method, params);
  });
  const manager = new SessionManager(config());
  try {
    assert.ok((await manager.attach({ rendererUrl: mock.endpoint })).ok);
    const snapshot = await manager.inspector.domSnapshot({ maxNodes: 10 });
    assert.ok(snapshot.ok && snapshot.data.truncated === true && !/Save/u.test(String(snapshot.data.text)));
    const result = await manager.inspector.click({ role: "button", name: "Save" });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.data.name, "Save");
    const missing = await manager.inspector.click({ role: "button", name: "Nope" });
    assert.ok(!missing.ok && missing.error.code === "ELEMENT_NOT_FOUND");
  } finally {
    await manager.close();
    await mock.close();
  }
});
