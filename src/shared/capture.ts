// Deep capture logic, free of Chrome APIs so it can be unit-tested: debugger (CDP) events go in, finished
// records come out. background.ts only wires it to chrome.debugger and fetches response bodies.
import type { ApiRequest, Headers, RawData } from "./types";
import { redactHeaders, redactUrl, toHeaders } from "./http";

// chars per body. 100 entries x (request + response) x 32k stays under chrome.storage.session's 10 MB quota.
export const BODY_LIMIT = 32_000;
const CLAIM_TTL_MS = 120_000;

// The subset of the CDP Network events' params that we read.
export interface CdpParams {
  requestId: string;
  type?: string;
  timestamp: number; // monotonic seconds
  wallTime?: number; // epoch seconds
  request?: { url: string; method: string; headers?: Record<string, string>; postData?: string };
  headers?: Record<string, string>; // requestWillBeSentExtraInfo
  response?: { status: number; statusText: string; headers?: Record<string, string> };
  errorText?: string;
  canceled?: boolean;
  corsErrorStatus?: { corsError?: string };
  initiator?: { type: string; stack?: CdpStack };
}

interface CdpStack {
  callFrames: { functionName: string; url: string; lineNumber: number }[];
  parent?: CdpStack; // the async caller, e.g. the code that awaited the fetch
}

// The first frame in the app's own code (skipping libraries such as axios or fetch wrappers in node_modules),
// as "src/api/orders.ts:42 loadOrders". Dev servers like Vite serve readable source paths.
export function callSiteOf(stack?: CdpStack): string | undefined {
  const frames = [];
  for (let s = stack, i = 0; s && i < 10; s = s.parent, i++) frames.push(...s.callFrames);
  const own = frames.filter((f) => f.url && !/^chrome-extension:/.test(f.url));
  const frame = own.find((f) => !/\/node_modules\//.test(f.url)) ?? own[0];
  if (!frame) return;
  let file = frame.url;
  try {
    file = new URL(frame.url).pathname.replace(/^\//, "") || "inline script"; // a <script> in the page itself
  } catch {
    // keep the raw url
  }
  return `${file}:${frame.lineNumber + 1}${frame.functionName ? ` ${frame.functionName}` : ""}`;
}

interface Entry {
  id: string;
  tabId: number;
  url: string;
  method: string;
  start: number; // CDP monotonic seconds
  wall: number; // epoch ms
  headers: Headers;
  body?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: Headers;
  callSite?: string;
}

// A request the debugger saw finish. background.ts fetches the response body if wanted, then calls toCapture.
export interface Finished {
  requestId: string;
  entry: Entry;
  end: number;
  extra: Partial<ApiRequest>;
  wantsBody: boolean;
}

export class DeepCapture {
  private inflight = new Map<string, Entry>();
  // requestWillBeSentExtraInfo (the wire headers, including Cookie) can arrive before requestWillBeSent.
  private early = new Map<string, Headers>();
  // Requests the debugger saw start, so webRequest doesn't record them twice. Everything else in a deep tab
  // (iframes and workers the debugger isn't attached to, calls in flight when it was turned on) is still
  // recorded by webRequest. Keyed by tab, method and URL; entries webRequest never reports expire.
  private claims = new Map<string, number[]>();

  event(tabId: number, method: string, p: CdpParams, now = Date.now()): Finished | undefined {
    const key = `${tabId}:${p.requestId}`;
    const e = this.inflight.get(key);

    switch (method) {
      case "Network.requestWillBeSent": {
        if ((p.type !== "XHR" && p.type !== "Fetch") || !p.request) {
          this.early.delete(key);
          return;
        }
        this.claim(claimKey(tabId, p.request.method, p.request.url), now);
        const wall = (p.wallTime ?? now / 1000) * 1000;
        // A redirect re-sends with the same requestId; keep the original start time.
        this.inflight.set(key, {
          id: `cdp-${p.requestId}-${Math.round(wall)}`,
          tabId,
          url: p.request.url,
          method: p.request.method,
          start: e?.start ?? p.timestamp,
          wall: e?.wall ?? wall,
          headers: { ...toHeaders(Object.entries(p.request.headers ?? {})), ...this.early.get(key) },
          body: p.request.postData,
          callSite: e?.callSite ?? callSiteOf(p.initiator?.stack)
        });
        this.early.delete(key);
        return;
      }
      case "Network.requestWillBeSentExtraInfo": {
        const wire = toHeaders(Object.entries(p.headers ?? {}));
        if (e) e.headers = { ...e.headers, ...wire };
        else this.early.set(key, wire);
        return;
      }
      case "Network.responseReceived":
        if (!e || !p.response) return;
        e.status = p.response.status;
        e.statusText = p.response.statusText;
        e.responseHeaders = toHeaders(Object.entries(p.response.headers ?? {}));
        return;
      case "Network.loadingFinished":
        if (!e) return;
        this.inflight.delete(key);
        return { requestId: p.requestId, entry: e, end: p.timestamp, extra: {}, wantsBody: true };
      case "Network.loadingFailed":
        if (!e) return;
        this.inflight.delete(key);
        return {
          requestId: p.requestId,
          entry: e,
          end: p.timestamp,
          extra: { error: p.canceled ? "net::ERR_ABORTED" : p.errorText, corsError: p.corsErrorStatus?.corsError },
          wantsBody: false
        };
    }
  }

  // Called by webRequest: true (once) if the debugger already recorded this request.
  consumeClaim(tabId: number, method: string, url: string): boolean {
    const key = claimKey(tabId, method, url);
    const times = this.claims.get(key);
    if (!times?.length) return false;
    times.shift();
    if (!times.length) this.claims.delete(key);
    return true;
  }

  // Drop in-flight state for a tab; requests that never finished (navigation, detach) would otherwise leak.
  forgetTab(tabId: number) {
    for (const map of [this.inflight, this.early]) {
      for (const key of map.keys()) if (key.startsWith(`${tabId}:`)) map.delete(key);
    }
    for (const key of this.claims.keys()) if (key.startsWith(`${tabId} `)) this.claims.delete(key);
  }

  private claim(key: string, now: number) {
    for (const [k, times] of this.claims) {
      const live = times.filter((t) => now - t < CLAIM_TTL_MS);
      if (live.length) this.claims.set(k, live);
      else this.claims.delete(k);
    }
    this.claims.set(key, [...(this.claims.get(key) ?? []), now]);
  }
}

const claimKey = (tabId: number, method: string, url: string) => `${tabId} ${method} ${url}`;

const clip = (s?: string) => (s && s.length > BODY_LIMIT ? `${s.slice(0, BODY_LIMIT)}\n…[truncated]` : s);

// Network.getResponseBody result -> text we can show; binary bodies become a short note.
export const bodyText = (res: { body: string; base64Encoded: boolean }) =>
  res.base64Encoded ? `[binary response, ~${Math.round(res.body.length * 0.75)} bytes]` : res.body;

// The saved record (secrets masked) and its session-only raw data.
export function toCapture(f: Finished, responseBody?: string): { record: ApiRequest; raw: RawData } {
  const e = f.entry;
  return {
    record: {
      id: e.id,
      tabId: e.tabId,
      url: redactUrl(e.url),
      method: e.method,
      startedAt: e.wall,
      durationMs: Math.round((f.end - e.start) * 1000),
      status: e.status,
      statusText: e.statusText,
      requestHeaders: redactHeaders(e.headers),
      responseHeaders: e.responseHeaders && redactHeaders(e.responseHeaders),
      deep: true,
      callSite: e.callSite,
      ...f.extra
    },
    raw: { url: e.url, requestHeaders: e.headers, requestBody: clip(e.body), responseBody: clip(responseBody) }
  };
}
