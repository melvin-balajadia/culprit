import type { ApiRequest, Diagnostic, Headers, RawData } from "./types";

export const REDACTED = "REDACTED";
// Field/header names whose values are secrets. "author"/"authors" stay readable; "authorization" does not.
const SENSITIVE = /auth(?!ors?($|[-_]))|cookie|token|secret|passw|^pass$|pwd|api[-_]?key|(^|[-_])key$|session|csrf|xsrf|signature|^sig$|credential|jwt|bearer|private|^(access|refresh)$/i;
// Secrets recognised by their value, whatever field they sit in: JWTs and Bearer/Basic credentials.
const SECRET_VALUE = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*|\b(Bearer|Basic)\s+[\w~+/.=-]{8,}/g;

// Last line of defence for anything leaving the panel (clipboard exports).
export const scrub = (text: string) =>
  text.replace(SECRET_VALUE, (m) => (/^(Bearer|Basic)\s/.test(m) ? `${m.split(/\s/)[0]} ${REDACTED}` : REDACTED));
// Left out of comparisons: they differ on every request, or are added by the browser and differ between
// capture modes (webRequest vs debugger). Cookie and Origin stay in; they matter for auth and CORS.
const VOLATILE = /^(:|x-request-id$|x-correlation-id$|traceparent$|tracestate$|sentry-trace$|baggage$|x-amzn-trace-id$|if-none-match$|if-modified-since$|content-length$|sec-|accept-encoding$|accept-language$|connection$|host$|priority$|user-agent$|referer$|cache-control$|pragma$)/;
// Set by the browser; fetch() refuses or ignores them.
const BROWSER_OWNED = /^(:|host$|connection$|content-length$|cookie$|accept-encoding$|origin$|referer$|user-agent$|sec-|proxy-|keep-alive$|te$|trailer$|transfer-encoding$|upgrade$|priority$)/;

export const isSensitive = (name: string) => name !== "www-authenticate" && SENSITIVE.test(name);

export const toHeaders = (entries: Iterable<[string, string]>): Headers =>
  Object.fromEntries([...entries].map(([k, v]) => [k.toLowerCase(), v]));

export const redactHeaders = (h: Headers): Headers =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k, isSensitive(k) ? REDACTED : v]));

export const replayable = (h: Headers): Headers =>
  Object.fromEntries(Object.entries(h).filter(([k]) => !BROWSER_OWNED.test(k)));

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) u.username = u.password = REDACTED; // https://user:pass@host
    for (const k of [...u.searchParams.keys()]) if (isSensitive(k)) u.searchParams.set(k, REDACTED);
    return u.toString();
  } catch {
    return url;
  }
}

const OMITTED = " omitted]";

// JSON and form bodies get sensitive fields masked; anything else is dropped rather than risk leaking it.
export function redactBody(body?: string): string {
  if (!body) return "";
  try {
    const value = JSON.parse(body, (k, v) => (k && isSensitive(k) ? REDACTED : v));
    return JSON.stringify(value, null, 2);
  } catch {
    if (/^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(body)) {
      const p = new URLSearchParams(body);
      for (const k of [...p.keys()]) if (isSensitive(k)) p.set(k, REDACTED);
      return p.toString();
    }
    return `[${body.length} chars of non-JSON body${OMITTED}`;
  }
}

export const isOk = (r: ApiRequest) => r.status !== undefined && r.status >= 200 && r.status < 300;
export const isCancelled = (r: ApiRequest) => !!r.error && /ERR_ABORTED|Cancelled/.test(r.error);
export const isFailure = (r: ApiRequest) => (!!r.error && !isCancelled(r)) || (r.status ?? 0) >= 400;

// "GET api.example.com/users/42" and ".../users/97" are the same endpoint.
export function endpointKey(method: string, url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((s) => (/^\d+$|^(?=.*\d)[0-9a-f-]{8,}$/i.test(s) ? ":id" : s))
      .join("/");
    return `${method.toUpperCase()} ${u.host}${path}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

// history is newest-first, so this is the most recent success.
export function findBaseline(r: ApiRequest, history: ApiRequest[]): ApiRequest | undefined {
  const key = endpointKey(r.method, r.url);
  return history.find((h) => h.id !== r.id && isOk(h) && endpointKey(h.method, h.url) === key);
}

export interface DiffRow {
  field: string;
  failed: string;
  baseline: string;
}

export function compare(failed: ApiRequest, base: ApiRequest): DiffRow[] {
  const rows: DiffRow[] = [];
  const add = (field: string, a?: string, b?: string) => {
    if ((a ?? "") !== (b ?? "")) rows.push({ field, failed: a ?? "—", baseline: b ?? "—" });
  };
  const outcome = (r: ApiRequest) => (r.status !== undefined ? `${r.status}` : r.error);
  add("status", outcome(failed), outcome(base));

  const qa = new URL(failed.url).searchParams;
  const qb = new URL(base.url).searchParams;
  for (const k of new Set([...qa.keys(), ...qb.keys()])) {
    add(`query ${k}`, qa.get(k) ?? undefined, qb.get(k) ?? undefined);
  }

  if (failed.requestHeaders && base.requestHeaders) {
    const ha = failed.requestHeaders;
    const hb = base.requestHeaders;
    for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
      if (!VOLATILE.test(k)) add(`request header ${k}`, ha[k], hb[k]);
    }
  }
  add("response content-type", failed.responseHeaders?.["content-type"], base.responseHeaders?.["content-type"]);
  return rows;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(method: string, url: string, headers: Headers, body?: string): string {
  // The method comes from the monitored page and may contain shell metacharacters, so it is quoted too.
  // HEAD needs -I: with -X HEAD curl waits for a body that never comes.
  const parts = [method.toUpperCase() === "HEAD" ? `curl -I ${shellQuote(url)}` : `curl -X ${shellQuote(method)} ${shellQuote(url)}`];
  for (const [k, v] of Object.entries(headers)) if (!k.startsWith(":")) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (body) parts.push(`--data-raw ${shellQuote(body)}`);
  return parts.join(" \\\n  ");
}

// Shareable cURL: URL, headers and body masked. A body that can't be masked safely is left out with a note,
// rather than sending a placeholder string as the payload.
export function exportCurl(method: string, url: string, headers: Headers, body?: string): string {
  const safe = redactBody(body);
  const omitted = safe.endsWith(OMITTED);
  const curl = toCurl(method, redactUrl(url), redactHeaders(headers), omitted ? undefined : safe);
  return scrub(omitted ? `# request body left out: ${safe.slice(1, -1)}\n${curl}` : curl);
}

export function parseHeaderLines(text: string): Headers {
  const out: Headers = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":", 1); // skip a leading ":" of HTTP/2 pseudo headers
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// Tester variables: "name=value" per line, used as {{name}} (same syntax as the Postman export).
export function parseVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function fillVars(text: string, vars: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const filled = text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name: string) => {
    if (name in vars) return vars[name];
    missing.push(name);
    return m;
  });
  return { text: filled, missing };
}

export const headerLines = (h: Headers) =>
  Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

export function formatJson(text: string, contentType = ""): { pretty?: string; error?: string } {
  // Sniff the content only when there is no Content-Type; "[INFO] …" logs and our "[binary …]" notes aren't JSON.
  const looksJson = contentType ? /json/i.test(contentType) : /^\s*[[{]/.test(text);
  if (!looksJson) return {};
  try {
    return { pretty: JSON.stringify(JSON.parse(text), null, 2) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface TestResult {
  status: number;
  statusText: string;
  durationMs: number;
  headers: Headers;
  body: string;
  size: number;
}

export const TIMEOUT_MS = 30_000;

export async function sendRequest(
  method: string,
  url: string,
  headers: Headers,
  body: string | undefined,
  signal: AbortSignal
): Promise<TestResult> {
  const start = performance.now();
  const response = await fetch(url, {
    method,
    headers,
    body,
    credentials: "include", // reuse the browser session, like the real app would
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
  });
  const buf = await response.arrayBuffer();
  const type = response.headers.get("content-type") ?? "";
  const text = new TextDecoder().decode(buf);
  // Content-Type is often missing or generic (protobuf, wasm…); a NUL byte is a reliable binary tell.
  const binary = /^(image|audio|video|font)\/|octet-stream|pdf|zip|protobuf|wasm/i.test(type) || text.includes("\u0000");
  return {
    status: response.status,
    statusText: response.statusText,
    durationMs: Math.round(performance.now() - start),
    headers: toHeaders(response.headers.entries()),
    body: binary ? `[binary ${type || "data"}, ${buf.byteLength} bytes]` : text,
    size: buf.byteLength
  };
}

export function fetchErrorMessage(e: unknown): string {
  const name = (e as Error)?.name;
  if (name === "TimeoutError") return `Timed out after ${TIMEOUT_MS / 1000} s`;
  if (name === "AbortError") return "Cancelled";
  return (e as Error)?.message || String(e);
}

// Markdown summary meant for pasting into a ticket or chat. Everything sensitive is masked.
export function buildReport(
  r: ApiRequest,
  diagnostics: Diagnostic[],
  baseline?: ApiRequest,
  raw?: RawData,
  trace?: { chain: ApiRequest[]; culprit?: ApiRequest } // from traceBack
): string {
  const outcome = (x: ApiRequest) => (x.status !== undefined ? `${x.status} ${x.statusText ?? ""}`.trim() : x.error);
  const lines = [
    `### ${r.method} ${redactUrl(r.url)}`,
    `**Result:** ${outcome(r)}${r.corsError ? ` (CORS: ${r.corsError})` : ""} · ${r.durationMs ?? "?"} ms · ${new Date(r.startedAt).toISOString()}`,
    ...(r.callSite ? [`**Called from:** \`${r.callSite}\``] : []),
    "",
    "**Diagnosis**",
    ...(diagnostics.length ? diagnostics.map((d) => `- [${d.severity}] ${d.title}: ${d.explanation} Next: ${d.nextStep}`) : ["- Nothing unusual detected."])
  ];
  if (trace && trace.chain.length > 1) {
    lines.push("", "**Chain** (oldest first; each call used values from the ones before it)");
    trace.chain.forEach((x, i) => {
      const tag = x.id === trace.culprit?.id ? " ← culprit" : x.id === r.id ? " ← this call" : "";
      lines.push(`${i + 1}. ${x.method} ${new URL(redactUrl(x.url)).pathname} → ${outcome(x)}${tag}`);
    });
  }
  if (baseline) {
    lines.push("", "**Compared with last success**", "| field | this request | last success |", "|---|---|---|");
    for (const row of compare(r, baseline)) {
      const mask = (v: string) => (isSensitive(row.field.split(" ").pop()!) && v !== "—" ? REDACTED : v);
      lines.push(`| ${row.field} | ${mask(row.failed)} | ${mask(row.baseline)} |`);
    }
  }
  const block = (title: string, body?: string) => body && lines.push("", `**${title}**`, "```", body, "```");
  block("Request headers", r.requestHeaders && headerLines(redactHeaders(r.requestHeaders)));
  block("Request body", redactBody(raw?.requestBody));
  block("Response headers", r.responseHeaders && headerLines(redactHeaders(r.responseHeaders)));
  block("Response body", redactBody(raw?.responseBody).slice(0, 4000));
  return scrub(lines.join("\n"));
}
