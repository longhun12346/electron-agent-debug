import { discoverMain } from "./discovery.js";
import { DiagnosticException } from "./errors.js";
import { evaluateExpression } from "./evaluate.js";
import type { DiagnosticSession } from "./sessions/diagnostic-session.js";

export interface UtilityLocation {
  pid: number;
  name: string;
  endpoint: string;
  websocketUrl: string;
}

export interface UtilityLocateOptions {
  main: DiagnosticSession;
  allowEval: boolean;
  discoveryTimeoutMs: number;
  query: string | number;
}

interface UtilityProcess {
  pid: number;
  name: string;
}

const listScript = `(async () => {
  const electron = process.mainModule ? process.mainModule.require('electron') : await import('electron');
  const app = electron.app ?? electron.default.app;
  return JSON.stringify(app.getAppMetrics()
    .filter((m) => m.serviceName === 'node.mojom.NodeService')
    .map((m) => ({ pid: m.pid, name: m.name ?? '' })));
})()`;

function portsScript(pid: number): string {
  return `(() => {
  const cp = process.getBuiltinModule ? process.getBuiltinModule('child_process') : process.mainModule.require('child_process');
  const pid = ${pid};
  const ports = new Set();
  const add = (value) => {
    const i = value.lastIndexOf(':');
    if (/^(127\\.0\\.0\\.1|\\[?::1\\]?)$/.test(value.slice(0, i))) ports.add(Number(value.slice(i + 1)));
  };
  if (process.platform === 'win32') {
    const out = cp.execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    for (const line of out.split(/\\r?\\n/)) {
      const p = line.trim().split(/\\s+/);
      if (p.length >= 5 && p[3] === 'LISTENING' && Number(p[4]) === pid) add(p[1]);
    }
  } else {
    let out = '';
    try {
      out = cp.execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', timeout: 3000 });
    } catch (error) {
      out = error.stdout ? String(error.stdout) : '';
    }
    for (const line of out.split('\\n')) if (line[0] === 'n') add(line.slice(1));
  }
  return JSON.stringify([...ports]);
})()`;
}

async function evaluateJson<T>(main: DiagnosticSession, expression: string, timeoutMs = 5_000): Promise<T> {
  const result = await evaluateExpression(main, {
    expression,
    awaitPromise: true,
    timeoutMs,
    maxResultBytes: 65_536,
  });
  if (typeof result.value !== "string") {
    throw new DiagnosticException("EVALUATION_FAILED", "主进程没有返回预期的 JSON 字符串");
  }
  return JSON.parse(result.value) as T;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findInspector(
  options: UtilityLocateOptions,
  processInfo: UtilityProcess,
): Promise<{ endpoint: string; websocketUrl: string } | undefined> {
  const ports = await evaluateJson<number[]>(options.main, portsScript(processInfo.pid));
  for (const port of ports) {
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      const found = await discoverMain(endpoint, { timeoutMs: options.discoveryTimeoutMs });
      if (found.websocketUrl) return { endpoint, websocketUrl: found.websocketUrl };
    } catch {
      // Not an inspector port; try the next listening port.
    }
  }
  return undefined;
}

export async function locateUtilityInspector(options: UtilityLocateOptions): Promise<UtilityLocation> {
  if (!options.main.isConnected) {
    throw new DiagnosticException(
      "UTILITY_REQUIRES_MAIN",
      "连接 utility process 需要先连接主进程（mainUrl），工具通过主进程查找进程并打开调试口",
    );
  }
  if (!options.allowEval) {
    throw new DiagnosticException(
      "EVALUATION_NOT_ALLOWED",
      "宿主已通过 ELECTRON_DEBUG_ALLOW_EVAL=0 禁用执行代码，无法通过主进程查找 utility process",
    );
  }

  const processes = await evaluateJson<UtilityProcess[]>(options.main, listScript);
  const query = options.query;
  const matches = processes.filter((item) => typeof query === "number" ? item.pid === query : item.name === query);
  if (matches.length !== 1) {
    throw new DiagnosticException(
      matches.length === 0 ? "UTILITY_NOT_FOUND" : "UTILITY_AMBIGUOUS",
      matches.length === 0
        ? `没有找到匹配的 utility process：${String(query)}`
        : `有多个同名 utility process，请改用 pid：${String(query)}`,
      { details: { candidates: matches.length === 0 ? processes : matches }, retryable: matches.length === 0 },
    );
  }
  const target = matches[0]!;

  let inspector = await findInspector(options, target);
  if (!inspector) {
    const opened = await evaluateJson<{ available: boolean }>(
      options.main,
      `JSON.stringify({ available: typeof process._debugProcess === 'function' && (process._debugProcess(${target.pid}), true) })`,
    );
    if (!opened.available) {
      throw new DiagnosticException("UTILITY_INSPECTOR_UNAVAILABLE", "当前运行时没有 process._debugProcess，无法打开 utility 调试口");
    }
    for (let attempt = 0; attempt < 15 && !inspector; attempt += 1) {
      await sleep(200);
      inspector = await findInspector(options, target);
    }
  }
  if (!inspector) {
    throw new DiagnosticException(
      "UTILITY_INSPECTOR_UNAVAILABLE",
      "没有在 utility process 上发现调试口：默认端口 9229 可能已被占用（打开失败时不会报错），或系统缺少 netstat/lsof。" +
        "可在 fork 的 execArgv 中加 --inspect-port=<空闲端口> 后重试",
      { retryable: true, details: { pid: target.pid, name: target.name } },
    );
  }
  return { pid: target.pid, name: target.name, ...inspector };
}
