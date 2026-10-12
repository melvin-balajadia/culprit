export type Headers = Record<string, string>;

// Persisted in chrome.storage.local, so nothing secret: header values and URL query secrets are redacted.
export interface ApiRequest {
  id: string;
  tabId: number;
  url: string; // redacted; the exact URL is in RawData
  method: string;
  startedAt: number;
  durationMs?: number;
  status?: number;
  statusText?: string;
  requestHeaders?: Headers;
  responseHeaders?: Headers;
  error?: string; // no HTTP response at all, e.g. net::ERR_CONNECTION_REFUSED
  corsError?: string; // deep capture only
  deep?: boolean; // captured through the debugger
}

// Kept in chrome.storage.session (memory only, gone when the browser closes) under `raw:<id>`.
export interface RawData {
  url?: string;
  requestHeaders?: Headers;
  requestBody?: string;
  responseBody?: string;
}

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  title: string;
  explanation: string;
  nextStep: string;
}
