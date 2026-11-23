import { redact } from "./redact.js";
import type { OpenDialog, ProcessScope } from "./types.js";

/**
 * Native dialogs: the main process is told about them through a CDP binding that wraps Electron's `dialog`
 * functions. A synchronous dialog blocks the main process, so the open notice is sent before the call and every
 * request to the main process times out until the user closes it; the notice explains that timeout.
 *
 * The wrapper calls the original function with the same arguments and returns its result. Code that kept a direct
 * reference to a dialog function before the attach (`const { showMessageBox } = dialog`) is not seen, and neither are
 * the message boxes Electron itself opens for a page's alert (the renderer channel reports those).
 */
export const dialogBinding = "__electronAgentDebugDialog";

const maxText = 200;

const wrapped = [
  "showOpenDialog", "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync",
  "showMessageBox", "showMessageBoxSync", "showErrorBox", "showCertificateTrustDialog",
];

export const instrumentDialogsScript = `(async () => {
  const electron = process.mainModule ? process.mainModule.require('electron') : await import('electron');
  const dialog = electron.dialog ?? electron.default?.dialog;
  if (!dialog) return JSON.stringify({ installed: false, open: [] });
  const key = Symbol.for('electron-agent-debug.dialogs');
  const state = globalThis[key] ?? (globalThis[key] = { next: 1, open: new Map(), wrapped: new Set() });
  const notify = (payload) => {
    try { if (typeof globalThis.${dialogBinding} === 'function') globalThis.${dialogBinding}(JSON.stringify(payload)); } catch {}
  };
  const describe = (name, args) => {
    if (name === 'showErrorBox') return { title: args[0], message: args[1] };
    const options = args.find((arg) => arg && typeof arg === 'object' && !(typeof arg.isDestroyed === 'function')) ?? {};
    return { title: options.title, message: options.message ?? options.buttonLabel };
  };
  for (const name of ${JSON.stringify(wrapped)}) {
    const original = dialog[name];
    if (typeof original !== 'function' || state.wrapped.has(name)) continue;
    const sync = name.endsWith('Sync') || name === 'showErrorBox';
    const wrapper = function (...args) {
      // Electron shows a page's alert/confirm/prompt through these same functions. The renderer channel already
      // reports those as JavaScript dialogs, so calls from Electron's own code are passed through unreported.
      const caller = String(new Error().stack).split('\\n')[2] ?? '';
      if (caller.includes('electron/js2c')) return original.apply(this, args);
      const id = state.next++;
      const text = describe(name, args);
      const entry = { id, type: name, blocking: sync, title: typeof text.title === 'string' ? text.title : undefined,
        message: typeof text.message === 'string' ? text.message : undefined, openedAt: new Date().toISOString() };
      state.open.set(id, entry);
      notify({ event: 'open', ...entry });
      const done = () => { state.open.delete(id); notify({ event: 'close', id }); };
      let result;
      try {
        result = original.apply(this, args);
      } catch (error) {
        done();
        throw error;
      }
      if (result && typeof result.then === 'function') {
        result.then(done, done);
      } else {
        done();
      }
      return result;
    };
    dialog[name] = wrapper;
    state.wrapped.add(name);
  }
  return JSON.stringify({ installed: true, open: [...state.open.values()] });
})()`;

function text(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const clean = redact(value);
  return clean.length > maxText ? `${clean.slice(0, maxText)}…` : clean;
}

/** Tracks the dialogs of one channel. Keys are the app's own ids for native dialogs and `js` for the page's dialog. */
export class DialogTracker {
  private readonly open = new Map<string, OpenDialog>();

  constructor(private readonly process: ProcessScope) {}

  get list(): OpenDialog[] {
    return [...this.open.values()];
  }

  get blocking(): OpenDialog | undefined {
    return this.list.find((dialog) => dialog.blocking);
  }

  clear(): void {
    this.open.clear();
  }

  /** A JavaScript dialog (alert, confirm, prompt, beforeunload) opened in the page; it blocks the page's scripts. */
  javascriptOpened(params: Record<string, unknown>, targetId: string | undefined): OpenDialog {
    const dialog: OpenDialog = {
      process: this.process,
      kind: "javascript",
      type: typeof params.type === "string" ? params.type : "alert",
      blocking: true,
      message: text(params.message),
      targetId,
      openedAt: new Date().toISOString(),
    };
    this.open.set("js", dialog);
    return dialog;
  }

  javascriptClosed(): OpenDialog | undefined {
    const dialog = this.open.get("js");
    this.open.delete("js");
    return dialog;
  }

  /** A notice from the main-process wrapper; returns the dialog that opened or closed. */
  native(payload: unknown): { event: "open" | "close"; dialog: OpenDialog } | undefined {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(String(payload)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const id = `native-${String(record.id)}`;
    if (record.event === "close") {
      const dialog = this.open.get(id);
      this.open.delete(id);
      return dialog ? { event: "close", dialog } : undefined;
    }
    if (record.event !== "open") return undefined;
    const dialog: OpenDialog = {
      process: this.process,
      kind: "native",
      type: typeof record.type === "string" ? record.type : "dialog",
      blocking: record.blocking === true,
      title: text(record.title),
      message: text(record.message),
      openedAt: typeof record.openedAt === "string" ? record.openedAt : new Date().toISOString(),
    };
    this.open.set(id, dialog);
    return { event: "open", dialog };
  }
}

export function dialogMessage(event: "open" | "close", dialog: OpenDialog): string {
  const label = [dialog.title, dialog.message].filter(Boolean).join(": ");
  const what = `${dialog.kind === "native" ? "Native dialog" : "JavaScript dialog"} ${dialog.type}`;
  if (event === "close") return `${what} closed`;
  return `${what} opened${label ? ` (${label})` : ""}${dialog.blocking ? "; the process is blocked until the user closes it" : ""}`;
}

export const blockingDialogHint =
  "有一个对话框正在等待用户操作，进程在它关闭前不会响应；请用户在应用里关闭对话框后重试（见 electron_status 里的 dialogs）。";
