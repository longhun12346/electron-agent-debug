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
  // A lookup tool that exits non-zero still ran (lsof does so when nothing matches); one that never ran is reported.
  let failure;
  const run = (file, args) => {
    try {
      return cp.execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    } catch (error) {
      if (typeof error.status !== 'number') failure = String(error.message).split('\\n')[0].slice(0, 300);
      return error.stdout ? String(error.stdout) : '';
    }
  };
  if (process.platform === 'win32') {
    const out = run('netstat', ['-ano', '-p', 'tcp']);
    for (const line of out.split(/\\r?\\n/)) {
      const p = line.trim().split(/\\s+/);
      if (p.length >= 5 && p[3] === 'LISTENING' && Number(p[4]) === pid) add(p[1]);
    }
  } else {
    const out = run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
    for (const line of out.split('\\n')) if (line[0] === 'n') add(line.slice(1));
  }
  return JSON.stringify({ ports: [...ports], error: failure });
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

const processWaitAttempts = 15;
const portWaitAttempts = 30;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface InspectorSearch {
  inspector?: { endpoint: string; websocketUrl: string };
  portLookupError?: string;
}

async function findInspector(
  options: UtilityLocateOptions,
  processInfo: UtilityProcess,
): Promise<InspectorSearch> {
  const { ports, error } = await evaluateJson<{ ports: number[]; error?: string }>(
    options.main,
    portsScript(processInfo.pid),
  );
  for (const port of ports) {
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      const found = await discoverMain(endpoint, { timeoutMs: options.discoveryTimeoutMs });
      if (found.websocketUrl) return { inspector: { endpoint, websocketUrl: found.websocketUrl } };
    } catch {
      // Not an inspector port; try the next listening port.
    }
  }
  return { portLookupError: error };
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

  // An agent usually attaches right after starting the app, often before the app has forked its utility process, so
  // a missing process is looked for again for a short while before it is reported.
  const query = options.query;
  let processes: UtilityProcess[] = [];
  let matches: UtilityProcess[] = [];
  for (let attempt = 0; ; attempt += 1) {
    processes = await evaluateJson<UtilityProcess[]>(options.main, listScript);
    matches = processes.filter((item) => typeof query === "number" ? item.pid === query : item.name === query);
    if (matches.length > 0 || attempt >= processWaitAttempts) break;
    await sleep(200);
  }
  if (matches.length !== 1) {
    throw new DiagnosticException(
      matches.length === 0 ? "UTILITY_NOT_FOUND" : "UTILITY_AMBIGUOUS",
      matches.length === 0
        ? `没有找到匹配的 utility process：${String(query)}`
        : `有多个同名 utility process，请改用 pid：${String(query)}`,
      {
        details: { candidates: matches.length === 0 ? processes : matches },
        retryable: matches.length === 0,
        hint: matches.length === 0
          ? "等了约 3 秒仍没有这个进程：确认名字是 utilityProcess.fork 的 serviceName（candidates 列出了现有的 utility process），" +
            "或 fork 发生在某个操作之后，先触发它再 attach。"
          : "用 candidates 里的 pid 作为 utility 参数。",
      },
    );
  }
  const target = matches[0]!;

  let search = await findInspector(options, target);
  if (!search.inspector) {
    const opened = await evaluateJson<{ available: boolean }>(
      options.main,
      `JSON.stringify({ available: typeof process._debugProcess === 'function' && (process._debugProcess(${target.pid}), true) })`,
    );
    if (!opened.available) {
      throw new DiagnosticException("UTILITY_INSPECTOR_UNAVAILABLE", "当前运行时没有 process._debugProcess，无法打开 utility 调试口");
    }
    // The inspector of a freshly signalled process takes longer to listen on slower machines (seen on macOS CI).
    for (let attempt = 0; attempt < portWaitAttempts && !search.inspector; attempt += 1) {
      await sleep(200);
      search = await findInspector(options, target);
    }
  }
  if (!search.inspector && search.portLookupError) {
    throw new DiagnosticException(
      "UTILITY_INSPECTOR_UNAVAILABLE",
      `无法读取 utility process 的监听端口：${search.portLookupError}。查端口需要 netstat（Windows）或 lsof（macOS/Linux）`,
      { details: { pid: target.pid, name: target.name, portLookupError: search.portLookupError } },
    );
  }
  if (!search.inspector) {
    throw new DiagnosticException(
      "UTILITY_INSPECTOR_UNAVAILABLE",
      "没有在 utility process 上发现调试口：默认端口 9229 可能已被占用（打开失败时不会报错）。" +
        "可在 fork 的 execArgv 中加 --inspect-port=<空闲端口> 后重试",
      { retryable: true, details: { pid: target.pid, name: target.name } },
    );
  }
  return { pid: target.pid, name: target.name, ...search.inspector };
}
