import type { ApiRequest, Headers, RawData } from "./shared/types";
import { endpointKey, isFailure, isOk, redactHeaders, redactUrl, toHeaders } from "./shared/http";
import { BODY_LIMIT, DeepCapture, bodyText, toCapture, type CdpParams } from "./shared/capture";
import { LineageIndex } from "./shared/lineage";
import { ShapeBook, parseShape } from "./shared/shape";

const MAX_REQUESTS = 100;
const FLUSH_MS = 250;
const FILTER: chrome.webRequest.RequestFilter = {
  urls: ["http://*/*", "https://*/*"],
  types: ["xmlhttprequest"] // covers fetch() and XHR
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
chrome.action.setBadgeBackgroundColor({ color: "#d93025" }).catch(console.error);

// Captures are buffered and written in one batch: a chatty page (polling, analytics) would otherwise rewrite
// the whole history, and broadcast it to every listener, once per request.
// All writes, including Clear, go through one promise chain so a read-modify-write never resurrects cleared data.
let buffer: { r: ApiRequest; raw?: RawData }[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let queue = Promise.resolve();
const enqueue = (task: () => Promise<void>) => (queue = queue.then(task).catch(console.error));

function save(r: ApiRequest, raw?: RawData) {
  buffer.push({ r, raw });
  timer ??= setTimeout(() => {
    timer = undefined;
    const batch = buffer.reverse(); // newest first, like the history
    buffer = [];
    if (!batch.length) return; // cleared while waiting
    void enqueue(async () => {
      const { requests = [] } = (await chrome.storage.local.get("requests")) as { requests?: ApiRequest[] };
      const next = [...batch.map((b) => b.r), ...requests].slice(0, MAX_REQUESTS);
      // Raw data first, so a row never shows up in the panel before its bodies exist.
      const raws = Object.fromEntries(batch.filter((b) => b.raw).map((b) => [`raw:${b.r.id}`, b.raw]));
      if (Object.keys(raws).length) {
        try {
          await chrome.storage.session.set(raws);
        } catch {
          // Over quota (large or non-ASCII bodies): drop the bodies of the older half of history and retry once,
          // so the newest captures keep theirs.
          await chrome.storage.session.remove(next.slice(MAX_REQUESTS / 2).map((r) => `raw:${r.id}`));
          await chrome.storage.session.set(raws).catch(console.error);
        }
      }
      await chrome.storage.local.set({ requests: next });
    });
  }, FLUSH_MS);
}

// Which earlier response supplied each value a request used. Memory only; holds fingerprints, not values.
const lineage = new LineageIndex();
// Each endpoint's usual response shape, learned from its successes. Paths and types only; kept across Clear
// so drift alerts don't have to relearn.
const shapes = new ShapeBook();

function clearHistory() {
  buffer = [];
  lineage.clear();
  return enqueue(() => chrome.storage.local.set({ requests: [] }));
}

// History changed (new entry, trim, or clear): drop orphaned raw data and refresh per-tab error badges.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.requests) return;
  const next = (changes.requests.newValue ?? []) as ApiRequest[];
  const old = (changes.requests.oldValue ?? []) as ApiRequest[];

  const keep = new Set(next.map((r) => r.id));
  const gone = old.filter((r) => !keep.has(r.id)).map((r) => `raw:${r.id}`);
  if (gone.length) chrome.storage.session.remove(gone).catch(console.error);

  const counts = new Map<number, number>(old.map((r) => [r.tabId, 0]));
  for (const r of next) counts.set(r.tabId, (counts.get(r.tabId) ?? 0) + (isFailure(r) ? 1 : 0));
  for (const [tabId, n] of counts) {
    chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {}); // tab may be closed
  }
});

// ---- Metadata capture (webRequest) ----

// Kept in memory only: a service-worker restart drops in-flight entries, which then just lack duration/headers.
const pending = new Map<string, { start: number; headers?: Headers }>();

// Tabs under deep capture are recorded by the debugger instead. Persisted so a worker restart remembers them.
const deepTabs = new Set<number>();
const ready = chrome.storage.session
  .get("deepTabs")
  .then(({ deepTabs: ids = [] }) => (ids as number[]).forEach((id) => deepTabs.add(id)));
const syncDeep = () => chrome.storage.session.set({ deepTabs: [...deepTabs] });

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    // Fires again after each redirect with the same requestId; keep the first start time.
    if (d.tabId >= 0 && !pending.has(d.requestId)) pending.set(d.requestId, { start: d.timeStamp });
    return undefined;
  },
  FILTER
);

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    const p = pending.get(d.requestId);
    if (p) p.headers = toHeaders((d.requestHeaders ?? []).map((h) => [h.name, h.value ?? ""]));
  },
  FILTER,
  ["requestHeaders", "extraHeaders"]
);

type Details = { requestId: string; tabId: number; url: string; method: string; timeStamp: number; initiator?: string };

// Our own requests (tester, chain re-runs) are never history, whichever context sends them.
const OWN_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

function finish(d: Details, extra: Partial<ApiRequest>) {
  if (d.tabId < 0 || d.initiator === OWN_ORIGIN) return;
  const p = pending.get(d.requestId);
  pending.delete(d.requestId);
  void ready.then(() => {
    if (deepTabs.has(d.tabId) && deep.consumeClaim(d.tabId, d.method, d.url)) return;
    const record: ApiRequest = {
      id: `${d.requestId}-${d.timeStamp}`,
      tabId: d.tabId,
      url: redactUrl(d.url), // the raw URL (tokens in the query) only lives in session memory
      method: d.method,
      startedAt: p?.start ?? d.timeStamp,
      durationMs: p ? Math.round(d.timeStamp - p.start) : undefined,
      requestHeaders: p?.headers && redactHeaders(p.headers),
      ...extra
    };
    const raw: RawData = { url: d.url, requestHeaders: p?.headers };
    // No bodies here, so these calls can use values from deep-captured responses but can't supply any.
    record.links = lineage.link(record, raw);
    save(record, raw);
  });
}

chrome.webRequest.onCompleted.addListener(
  (d) =>
    finish(d, {
      status: d.statusCode,
      statusText: d.statusLine.replace(/^HTTP\/\S+\s+\d+\s*/, ""), // "HTTP/1.1 404 Not Found" -> "Not Found"
      responseHeaders: redactHeaders(toHeaders((d.responseHeaders ?? []).map((h) => [h.name, h.value ?? ""])))
    }),
  FILTER,
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener((d) => finish(d, { error: d.error }), FILTER);

// ---- Deep capture (Chrome DevTools Protocol, opt-in per tab) ----

const deep = new DeepCapture();


// Record network events for a page, and auto-attach to its iframes and workers (flat child sessions) so
// their calls get bodies too. Children report back through Target.attachedToTarget, handled below.
async function watchNetwork(target: chrome.debugger.DebuggerSession) {
  await chrome.debugger.sendCommand(target, "Network.enable", { maxPostDataSize: BODY_LIMIT });
  await chrome.debugger
    .sendCommand(target, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    .catch(() => {}); // best effort: without it, iframe and worker calls are still listed via webRequest
}

async function setDeep(tabId: number, on: boolean) {
  await ready; // a just-woken worker must load the saved set first, or it would re-add this tab afterwards
  const target = { tabId };
  if (on) {
    await chrome.debugger.attach(target, "1.3");
    // Marked before enabling: auto-attach reports existing iframes and workers while it is being set up,
    // and the event handler ignores tabs that aren't in deepTabs.
    deepTabs.add(tabId);
    try {
      await watchNetwork(target);
    } catch (err) {
      deepTabs.delete(tabId);
      await chrome.debugger.detach(target).catch(() => {}); // don't leave Chrome's debugging banner up for nothing
      throw err;
    }
  } else {
    deepTabs.delete(tabId);
    deep.forgetTab(tabId);
    await chrome.debugger.detach(target).catch(() => {});
  }
  await syncDeep();
}

// Fires when the tab closes or the user dismisses Chrome's "is debugging this browser" bar.
chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (tabId === undefined) return;
  deep.forgetTab(tabId);
  void ready.then(() => {
    if (deepTabs.delete(tabId)) return syncDeep();
  });
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined || !params || !deepTabs.has(tabId)) return;
  if (method === "Target.attachedToTarget") {
    const { sessionId } = params as { sessionId: string };
    void watchNetwork({ tabId, sessionId }).catch(() => {}); // the frame or worker may already be gone
    return;
  }
  const done = deep.event(tabId, method, params as CdpParams, Date.now(), source.sessionId);
  if (!done) return;
  let body: string | undefined;
  if (done.wantsBody) {
    try {
      const res = await chrome.debugger.sendCommand(source, "Network.getResponseBody", { requestId: done.requestId });
      body = bodyText(res as { body: string; base64Encoded: boolean });
    } catch {
      // Body not available (204, evicted, cached). Best effort.
    }
  }
  const { record, raw } = toCapture(done, body);
  record.links = lineage.link(record, raw);
  lineage.add(record, raw, done.entry.responseHeaders);
  // A success whose shape differs from this endpoint's usual one (missing field, new null).
  const shape = isOk(record) ? parseShape(raw.responseBody) : undefined;
  if (shape) {
    const drift = shapes.check(endpointKey(record.method, raw.url ?? record.url), shape);
    if (drift.length) record.drift = drift;
  }
  save(record, raw);
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const task = msg?.type === "deep" ? setDeep(msg.tabId, msg.on) : msg?.type === "clear" ? clearHistory() : undefined;
  if (!task) return;
  task.then(
    () => respond({}),
    (err) => respond({ error: String(err?.message ?? err) })
  );
  return true; // async response
});
