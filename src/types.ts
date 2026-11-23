export type ProcessScope = "main" | "renderer" | "utility";

export type EvaluateScope = "main" | "renderer" | "utility";

export type PublicSessionStatus = "unconfigured" | "offline" | "online";

export type EndpointSource = "attach_input" | "environment" | "session" | "discovered";

export interface AttachInput {
  mainUrl?: string;
  rendererUrl?: string;
  utility?: string | number;
  targetId?: string;
  url?: string;
  title?: string;
  clearSelection?: boolean;
}

export interface EndpointConfig {
  url: string;
  source: EndpointSource;
}

export interface TargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  faviconUrl?: string;
}

export interface DiagnosticEvent {
  seq?: number;
  process: ProcessScope;
  targetId?: string;
  observedAt: string;
  kind: "console" | "exception" | "connection" | "protocol" | "dialog";
  level?: string;
  message: string;
  data?: unknown;
}

export interface DiagnosticError {
  code: string;
  message: string;
  retryable: boolean;
  /** What to check or do next; the message above stays the underlying error. */
  hint?: string;
  details?: Record<string, unknown>;
}

/** A dialog that is waiting for the user: a JavaScript alert/confirm/prompt in a page, or a native Electron dialog. */
export interface OpenDialog {
  process: ProcessScope;
  kind: "javascript" | "native";
  /** alert/confirm/prompt/beforeunload, or the dialog function (showOpenDialog, showMessageBoxSync, …). */
  type: string;
  /** True when the process cannot answer anything until the dialog is closed. */
  blocking: boolean;
  title?: string;
  message?: string;
  targetId?: string;
  openedAt: string;
}

export interface SessionSnapshot {
  configured: boolean;
  online: boolean;
  status: PublicSessionStatus;
  endpoint?: string;
  endpointSource?: EndpointSource;
  selectedTarget?: TargetInfo;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  lastDisconnectReason?: string;
  eventCount: number;
  /** Dialogs waiting for the user in this channel; omitted when there are none. */
  dialogs?: OpenDialog[];
  error?: DiagnosticError;
}

export interface AttachResult {
  main: SessionSnapshot;
  renderer: SessionSnapshot;
  utility: SessionSnapshot;
  targets: TargetInfo[];
  selectedTarget?: TargetInfo;
  errors: DiagnosticError[];
  /** Things that did not stop the attach but may mean the evidence is not from the intended window or app. */
  warnings: DiagnosticError[];
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: DiagnosticError };

export interface StatusResult {
  main: SessionSnapshot;
  renderer: SessionSnapshot;
  utility: SessionSnapshot;
  targets: TargetInfo[];
  selectedTarget?: TargetInfo;
  /** Dialogs waiting for the user across all channels; omitted when there are none. */
  dialogs?: OpenDialog[];
  lastSeq: number;
}

export interface LogsInput {
  process?: ProcessScope | "all";
  level?: string;
  limit?: number;
  since?: string;
  afterSeq?: number;
  sinceAttach?: boolean;
  clear?: boolean;
}

