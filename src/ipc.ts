import { requireElectron } from "./app-script.js";
import type { DiagnosticEvent, ProcessScope } from "./types.js";

/**
 * IPC tracing: the main process reports each IPC message from a renderer through a CDP binding, so a failing
 * `ipcRenderer.invoke` shows up on the main side without the app logging anything.
 *
 * - invoke/handle: Electron keeps handlers in `ipcMain._invokeHandlers`, a Map. Its entries are wrapped in place and
 *   `set` wraps the ones registered later. The Map is private; without it only send/on is traced. An invoke with no
 *   handler is not traced: Electron itself prints "Error occurred in handler for '<channel>': No handler registered",
 *   which the main channel already records.
 * - send/on and sendSync: Electron delivers these with `ipcMain.emit(channel, event, ...args)`, which is wrapped.
 *   A message nobody listens to is reported with `listeners: 0`.
 *
 * Only the channel, timing, outcome, error message and argument size are kept, never argument or result values.
 * Each channel reports at most `perSecond` messages a second; the next report says how many were skipped. Channels
 * Electron uses itself are left out. `webContents.ipc` and `session`-scoped handlers are not traced.
 */
export const ipcBinding = "__electronAgentDebugIpc";

const perSecond = 20;
const maxText = 300;

export const instrumentIpcScript = `(async () => {
  const ipcMain = ${requireElectron}.ipcMain;
  if (!ipcMain) return JSON.stringify({ installed: false });
  const key = Symbol.for('electron-agent-debug.ipc');
  if (globalThis[key]) return JSON.stringify(globalThis[key].summary);
  const state = { windows: new Map(), summary: { installed: true, invoke: false, send: false } };
  globalThis[key] = state;
  const internal = (channel) => typeof channel !== 'string' || channel === 'error' ||
    /^(ELECTRON_|IMPORT_SHARED_TEXTURE)/.test(channel);
  const size = (args) => {
    try {
      let total = 0;
      for (const arg of args) {
        total += ArrayBuffer.isView(arg) || arg instanceof ArrayBuffer ? arg.byteLength : (JSON.stringify(arg)?.length ?? 0);
      }
      return total;
    } catch { return undefined; }
  };
  const notify = (record, args) => {
    const second = Math.floor(Date.now() / 1000);
    let window = state.windows.get(record.channel);
    if (!window || window.second !== second) {
      window = { second, count: 0, skipped: window?.skipped ?? 0 };
      // Channel names made per request would otherwise grow this table forever: drop entries from earlier seconds.
      if (state.windows.size > 500) {
        for (const [name, other] of state.windows) if (other.second !== second && !other.skipped) state.windows.delete(name);
      }
      state.windows.set(record.channel, window);
    }
    window.count += 1;
    if (window.count > ${perSecond}) { window.skipped += 1; return; }
    if (window.skipped) { record.skipped = window.skipped; window.skipped = 0; }
    record.argBytes = size(args);
    try {
      if (typeof globalThis.${ipcBinding} === 'function') globalThis.${ipcBinding}(JSON.stringify(record));
    } catch {}
  };
  const sender = (event) => {
    try { return { senderId: event?.sender?.id, senderUrl: event?.senderFrame?.url ?? event?.sender?.getURL?.() }; }
    catch { return {}; }
  };
  // Listeners on webContents.ipc or a frame's ipc hear a message too; ipcMain alone would call it unheard.
  const heard = (emitter, channel) => {
    try { return typeof emitter?.listenerCount === 'function' ? emitter.listenerCount(channel) : 0; } catch { return 0; }
  };
  const failure = (error) => String(error && error.stack ? String(error.stack).split('\\n')[0] : error);

  const handlers = ipcMain._invokeHandlers;
  if (handlers instanceof Map) {
    const wrap = (channel, handler) => {
      if (typeof handler !== 'function' || handler.__electronAgentDebug) return handler;
      const wrapped = function (event, ...args) {
        const started = Date.now();
        const base = { type: 'invoke', channel, ...sender(event) };
        let result;
        try {
          result = handler.call(this, event, ...args);
        } catch (error) {
          notify({ ...base, ok: false, ms: Date.now() - started, error: failure(error) }, args);
          throw error;
        }
        if (result && typeof result.then === 'function') {
          result.then(() => notify({ ...base, ok: true, ms: Date.now() - started }, args),
            (error) => notify({ ...base, ok: false, ms: Date.now() - started, error: failure(error) }, args));
        } else {
          notify({ ...base, ok: true, ms: Date.now() - started }, args);
        }
        return result;
      };
      wrapped.__electronAgentDebug = true;
      return wrapped;
    };
    for (const [channel, handler] of handlers) {
      if (!internal(channel)) Map.prototype.set.call(handlers, channel, wrap(channel, handler));
    }
    const set = handlers.set;
    handlers.set = function (channel, handler) {
      return set.call(this, channel, internal(channel) ? handler : wrap(channel, handler));
    };
    state.summary.invoke = true;
  }

  const emit = ipcMain.emit;
  ipcMain.emit = function (channel, ...rest) {
    if (internal(channel)) return emit.call(this, channel, ...rest);
    const [event, ...args] = rest;
    const started = Date.now();
    // Only a sendSync event has an own returnValue the renderer waits for. _replyChannel is no guide: Electron 43 sets
    // it only for sendSync, Electron 45 for every message (both measured).
    const base = { type: event && Object.prototype.hasOwnProperty.call(event, 'returnValue') ? 'sendSync' : 'send',
      channel, listeners: this.listenerCount(channel) + heard(event?.sender?.ipc, channel) + heard(event?.senderFrame?.ipc, channel),
      ...sender(event) };
    try {
      const handled = emit.call(this, channel, ...rest);
      notify({ ...base, ok: true, ms: Date.now() - started }, args);
      return handled;
    } catch (error) {
      notify({ ...base, ok: false, ms: Date.now() - started, error: failure(error) }, args);
      throw error;
    }
  };
  state.summary.send = true;
  return JSON.stringify(state.summary);
})()`;

interface IpcRecord {
  type?: unknown;
  channel?: unknown;
  ok?: unknown;
  ms?: unknown;
  error?: unknown;
  argBytes?: unknown;
  listeners?: unknown;
  skipped?: unknown;
  senderId?: unknown;
  senderUrl?: unknown;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length > maxText ? `${value.slice(0, maxText)}…` : value;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Turns one binding payload into a timeline event, or undefined when it is not an IPC record. */
export function ipcEvent(process: ProcessScope, payload: unknown): DiagnosticEvent | undefined {
  let record: IpcRecord;
  try {
    record = JSON.parse(String(payload)) as IpcRecord;
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
  const channel = text(record.channel);
  if (channel === undefined) return undefined;
  const type = record.type === "invoke" || record.type === "sendSync" ? record.type : "send";
  const ok = record.ok === true;
  const ms = number(record.ms) ?? 0;
  const error = text(record.error);
  const listeners = number(record.listeners);
  const unheard = type !== "invoke" && listeners === 0;
  let message = `IPC ${type} ${channel}`;
  if (!ok) message += ` failed after ${ms}ms${error ? `: ${error}` : ""}`;
  else if (unheard) message += ": no listener in the main process";
  else message += ` ok in ${ms}ms`;
  const data: Record<string, unknown> = { type, channel, ok, ms };
  for (const [name, value] of [
    ["argBytes", number(record.argBytes)], ["listeners", listeners], ["skipped", number(record.skipped)],
    ["senderId", number(record.senderId)], ["senderUrl", text(record.senderUrl)], ["error", error],
  ] as const) {
    if (value !== undefined) data[name] = value;
  }
  return {
    process,
    observedAt: new Date().toISOString(),
    kind: "ipc",
    level: !ok ? "error" : unheard ? "warning" : "info",
    message,
    data,
  };
}
