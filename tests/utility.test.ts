import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "../src/config.js";
import { SessionManager } from "../src/sessions/session-manager.js";

const fakeApp = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-electron-app.cjs");

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    requestTimeoutMs: 2_000,
    discoveryTimeoutMs: 1_000,
    maxLogEvents: 200,
    maxLogBytes: 200_000,
    maxProtocolMessageBytes: 1_000_000,
    allowEval: true,
    ...overrides,
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function withApp(
  extraArgs: (utilityPort: number) => string[],
  overrides: Partial<RuntimeConfig>,
  body: (manager: SessionManager, mainUrl: string) => Promise<void>,
): Promise<void> {
  const mainPort = await freePort();
  const utilityPort = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [fakeApp, `--inspect=${mainPort}`, ...extraArgs(utilityPort)],
    { stdio: "ignore" },
  );
  const manager = new SessionManager(config(overrides));
  const mainUrl = `http://127.0.0.1:${mainPort}`;
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await manager.attach({ mainUrl });
      if (result.ok && result.data.main.online) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await body(manager, mainUrl);
  } finally {
    await manager.close();
    child.kill();
  }
}

test("attaches a utility process by name alongside main", async () => {
  await withApp((port) => [`--utility-port=${port}`], {}, async (manager) => {
    const result = await manager.attach({ utility: "worker" });
    assert.ok(result.ok);
    assert.equal(result.data.main.online, true);
    assert.equal(result.data.utility.online, true);
    assert.deepEqual(result.data.errors, []);
    assert.equal(manager.status().utility.selectedTarget?.id, "4242");

    const evaluated = await manager.inspector.evaluate({ scope: "utility", expression: "1+1" });
    assert.ok(evaluated.ok);
    assert.equal(evaluated.data.value, "utility:1+1");
    const fromMain = await manager.inspector.evaluate({ scope: "main", expression: "2+2" });
    assert.ok(fromMain.ok);
    assert.equal(fromMain.data.value, "main:2+2");

    const logs = manager.logs({ process: "utility" });
    assert.ok(logs.events.length > 0);
    assert.ok(logs.events.every((event) => event.process === "utility"));
  });
});

test("attaches a utility process by pid", async () => {
  await withApp((port) => [`--utility-port=${port}`], {}, async (manager) => {
    const result = await manager.attach({ utility: 4242 });
    assert.ok(result.ok);
    assert.equal(result.data.utility.online, true);
  });
});

test("opens the inspector with process._debugProcess when none is listening", async () => {
  await withApp((port) => [`--utility-port=${port}`, "--utility-lazy"], {}, async (manager) => {
    const result = await manager.attach({ utility: "worker" });
    assert.ok(result.ok);
    assert.equal(result.data.utility.online, true);
  });
});

test("reports an unavailable inspector when the port never opens", async () => {
  await withApp((port) => [`--utility-port=${port}`, "--utility-lazy", "--utility-no-open"], {}, async (manager) => {
    const result = await manager.attach({ utility: "worker" });
    assert.ok(result.ok);
    assert.equal(result.data.utility.online, false);
    assert.equal(result.data.errors[0]?.code, "UTILITY_INSPECTOR_UNAVAILABLE");
    assert.equal(result.data.main.online, true);
  });
});

test("reports why listening ports could not be read", async () => {
  await withApp((port) => [`--utility-port=${port}`, "--utility-lazy", "--utility-no-open", "--utility-lookup-error"], {},
    async (manager) => {
      const result = await manager.attach({ utility: "worker" });
      assert.ok(result.ok);
      assert.equal(result.data.errors[0]?.code, "UTILITY_INSPECTOR_UNAVAILABLE");
      assert.equal(result.data.errors[0]?.details?.portLookupError, "spawnSync lsof ENOENT");
      assert.match(result.data.errors[0]?.message ?? "", /spawnSync lsof ENOENT/u);
    });
});

test("lists candidates when the utility name is unknown", async () => {
  await withApp((port) => [`--utility-port=${port}`], {}, async (manager) => {
    const result = await manager.attach({ utility: "missing" });
    assert.ok(result.ok);
    assert.equal(result.data.errors[0]?.code, "UTILITY_NOT_FOUND");
    assert.equal(result.data.utility.online, false);
    assert.deepEqual(
      (result.data.errors[0]?.details?.candidates as Array<{ pid: number }>).map((item) => item.pid),
      [4242, 4243, 4244],
    );
  });
});

test("asks for a pid when several utility processes share a name", async () => {
  await withApp((port) => [`--utility-port=${port}`], {}, async (manager) => {
    const result = await manager.attach({ utility: "dup" });
    assert.ok(result.ok);
    assert.equal(result.data.errors[0]?.code, "UTILITY_AMBIGUOUS");
  });
});

test("requires the main process to be online", async () => {
  const manager = new SessionManager(config());
  try {
    const result = await manager.attach({ utility: "worker" });
    assert.ok(result.ok);
    assert.equal(result.data.errors[0]?.code, "UTILITY_REQUIRES_MAIN");
  } finally {
    await manager.close();
  }
});

test("refuses to look up utility processes when evaluation is disabled", async () => {
  await withApp((port) => [`--utility-port=${port}`], { allowEval: false }, async (manager) => {
    const result = await manager.attach({ utility: "worker" });
    assert.ok(result.ok);
    assert.equal(result.data.errors[0]?.code, "EVALUATION_NOT_ALLOWED");
  });
});

test("closes the utility session when the main endpoint changes", async () => {
  await withApp((port) => [`--utility-port=${port}`], {}, async (manager, mainUrl) => {
    const attached = await manager.attach({ utility: "worker" });
    assert.ok(attached.ok && attached.data.utility.online);
    const otherPort = await freePort();
    await manager.attach({ mainUrl: `http://127.0.0.1:${otherPort}` });
    assert.equal(manager.status().utility.online, false);
    assert.notEqual(mainUrl, `http://127.0.0.1:${otherPort}`);
  });
});
