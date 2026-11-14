export type ProcessScope = "main" | "renderer";

export type PublicSessionStatus = "unconfigured" | "offline" | "online";

export type EndpointSource = "attach_input" | "environment" | "session";

export interface AttachInput {
  mainUrl?: string;
  rendererUrl?: string;
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
  process: ProcessScope;
  targetId?: string;
  observedAt: string;
  kind: "console" | "exception" | "connection" | "protocol";
  level?: string;
  message: string;
  data?: unknown;
}

export interface DiagnosticError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
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
  error?: DiagnosticError;
}

export interface AttachResult {
  main: SessionSnapshot;
  renderer: SessionSnapshot;
  targets: TargetInfo[];
  selectedTarget?: TargetInfo;
  errors: DiagnosticError[];
}

export interface StatusResult {
  main: SessionSnapshot;
  renderer: SessionSnapshot;
  targets: TargetInfo[];
  selectedTarget?: TargetInfo;
}

export interface LogsInput {
  process?: ProcessScope | "all";
  level?: string;
  limit?: number;
  since?: string;
  clear?: boolean;
}
