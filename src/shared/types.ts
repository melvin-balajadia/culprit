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
  callSite?: string; // e.g. "src/api/orders.ts:42 loadOrders", from the debugger's initiator stack
  links?: Link[]; // earlier responses that supplied values this request used
}

// "Response A's field fed request B": ids and field paths only, never the value, so it is safe to persist.
export interface Link {
  from: string; // id of the earlier request
  fromPath: string; // where the value was in it, e.g. "response.user.id" or "header.x-csrf-token"
  to: string; // where this request used it: "path[2]", "query.userId", "header.authorization", "body.cart.id"
  confidence: "certain" | "likely";
  missing?: boolean; // the value was absent: the earlier response had null where this request needed a value
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
