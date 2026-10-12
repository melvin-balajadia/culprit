import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiRequest, RawData } from "../shared/types";
import { REDACTED, buildReport, compare, endpointKey, exportCurl, findBaseline, headerLines, isFailure, replayable } from "../shared/http";
import { diagnose } from "../shared/diagnostics";
import { Body, CopyButton, Diagnostics, HeaderList, StatusPill, ms } from "./ui";
import type { Draft } from "./Tester";
import Trace from "./Trace";
import { GroupView, ListView, TimelineView, Watching } from "./Views";
import ChainRunner from "./ChainRunner";
import { parseShape, shapeDiff } from "../shared/shape";
import { traceBack } from "../shared/lineage";
import { toHar } from "../shared/export";

async function exportHar(records: ApiRequest[]) {
  const raws = Object.fromEntries(
    await Promise.all(records.map(async (r) => [r.id, (await chrome.storage.session.get(`raw:${r.id}`))[`raw:${r.id}`] as RawData | undefined]))
  );
  const blob = new Blob([toHar(records, raws, chrome.runtime.getManifest().version)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `culprit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.har`;
  link.click();
  URL.revokeObjectURL(link.href);
}

type View = "list" | "group" | "timeline";
const VIEWS: [View, string][] = [["list", "List"], ["group", "By endpoint"], ["timeline", "Timeline"]];

// Keyboard shortcuts apply only when the panel tab is visible and the user isn't typing in a field.
const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
function useKeys(active: boolean, handler: (e: KeyboardEvent) => void) {
  // The listener always calls the latest handler. Updated during commit, so a key pressed right after new
  // data renders never acts on the previous list (useEffect would run a moment after the paint).
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!typing(e) && !e.ctrlKey && !e.metaKey && !e.altKey) latest.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

export default function Traffic({ onReplay, active = true }: { onReplay: (d: Draft) => void; active?: boolean }) {
  const [requests, setRequests] = useState<ApiRequest[]>([]);
  const [view, setView] = useState<View>("list");
  const [focusIndex, setFocusIndex] = useState(-1); // -1: no keyboard focus until j/k is pressed
  const search = useRef<HTMLInputElement>(null);
  const [deepTabs, setDeepTabs] = useState<number[]>([]);
  const [pins, setPins] = useState<string[]>([]); // watched endpoint keys
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [query, setQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [thisTab, setThisTab] = useState(true);
  // The open request itself, not its id: on a busy page it can scroll out of the 100-item history while being read.
  const [selected, setSelected] = useState<ApiRequest>();
  const [deepError, setDeepError] = useState<string>();

  useEffect(() => {
    chrome.storage.local.get("requests").then((d) => setRequests((d.requests as ApiRequest[]) ?? []));
    chrome.storage.session.get("deepTabs").then((d) => setDeepTabs((d.deepTabs as number[]) ?? []));
    chrome.storage.local.get("pins").then((d) => setPins((d.pins as string[]) ?? []));
    const loadTab = () => chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t));
    loadTab();

    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.requests) setRequests((c.requests.newValue as ApiRequest[]) ?? []);
      if (c.deepTabs) setDeepTabs((c.deepTabs.newValue as number[]) ?? []);
      if (c.pins) setPins((c.pins.newValue as string[]) ?? []);
    };
    chrome.storage.onChanged.addListener(onChange);
    chrome.tabs.onActivated.addListener(loadTab);
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      chrome.tabs.onActivated.removeListener(loadTab);
    };
  }, []);

  const q = query.toLowerCase();
  const shown = requests.filter(
    (r) =>
      (!thisTab || r.tabId === tab?.id) &&
      (!errorsOnly || isFailure(r)) &&
      (!q || `${r.method} ${r.url} ${r.status ?? r.error}`.toLowerCase().includes(q))
  );
  const failures = shown.filter(isFailure).length;
  const focus = Math.min(focusIndex, shown.length - 1);
  // j/k walk the calls in the order the list and timeline show them.
  const ordered = view === "timeline" ? [...shown.slice(0, 60)].reverse() : shown;

  useKeys(active && !selected, (e) => {
    if (e.key === "/") {
      e.preventDefault();
      search.current?.focus();
    } else if (e.key === "j" || e.key === "ArrowDown") setFocusIndex(Math.min(focus + 1, ordered.length - 1));
    else if (e.key === "k" || e.key === "ArrowUp") setFocusIndex(Math.max(focus - 1, 0));
    else if (e.key === "Enter" && ordered[focus]) setSelected(ordered[focus]);
    else if (e.key === "e") setErrorsOnly((v) => !v);
    else if (e.key === "v") setView((v) => VIEWS[(VIEWS.findIndex(([k]) => k === v) + 1) % VIEWS.length][0]);
    else return;
    if (e.key !== "/") e.preventDefault();
  });

  const togglePin = (key: string) => {
    const next = pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key];
    setPins(next);
    void chrome.storage.local.set({ pins: next });
  };

  if (selected) {
    return (
      <Detail
        key={selected.id} // fresh state (raw data) per request
        r={selected}
        history={requests}
        active={active}
        onBack={() => setSelected(undefined)}
        onSelect={setSelected}
        pinned={pins.includes(endpointKey(selected.method, selected.url))}
        onTogglePin={() => togglePin(endpointKey(selected.method, selected.url))}
        onReplay={onReplay}
      />
    );
  }

  const deepOn = tab?.id !== undefined && deepTabs.includes(tab.id);
  const toggleDeep = async () => {
    setDeepError(undefined);
    try {
      const res = await chrome.runtime.sendMessage({ type: "deep", tabId: tab?.id, on: !deepOn });
      if (res?.error) setDeepError(res.error);
    } catch (err) {
      setDeepError(String((err as Error)?.message ?? err));
    }
  };

  const ViewComponent = { list: ListView, group: GroupView, timeline: TimelineView }[view];

  return (
    <section>
      <div className="toolbar">
        <input ref={search} type="search" placeholder="Filter by URL, method, status… ( / )" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors</label>
        <label><input type="checkbox" checked={thisTab} onChange={(e) => setThisTab(e.target.checked)} /> This tab</label>
      </div>

      <div className="toolbar">
        <button className={deepOn ? "on" : ""} disabled={tab?.id === undefined} onClick={toggleDeep}
          title="Attaches Chrome's debugger to this tab to record request/response bodies and exact CORS reasons. Chrome shows a banner while it is on.">
          {deepOn ? "● Deep capture on" : "Deep capture"}
        </button>
        {/* Cleared by the background so it can't race with a capture being written. */}
        <button onClick={() => chrome.runtime.sendMessage({ type: "clear" }).catch(() => {})}>Clear</button>
        <button disabled={!shown.length} onClick={() => void exportHar(shown)} title="Download what the list shows as a HAR file, masked like Copy report">
          Export HAR
        </button>
        <span className="muted grow">{shown.length} shown{failures ? ` · ${failures} failed` : ""}</span>
      </div>
      {deepError && <p className="warn-text">{deepError}</p>}

      <SiteAccess tab={tab} />
      <Watching pins={pins} history={requests} onOpen={setSelected} onTogglePin={togglePin} />

      <div className="segmented" role="group" aria-label="View">
        {VIEWS.map(([key, label]) => (
          <button key={key} aria-pressed={view === key} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="muted empty">No API calls yet. Use your app (or reload it) and fetch/XHR requests appear here.</p>
      ) : (
        <ViewComponent shown={shown} history={requests} focusedId={active ? ordered[focus]?.id : undefined} onOpen={setSelected} pins={pins} onTogglePin={togglePin} />
      )}
      <p className="muted small keys">
        Keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>/</kbd> filter · <kbd>e</kbd> errors · <kbd>v</kbd> view
      </p>
    </section>
  );
}

function Detail({ r, history, active, onBack, onSelect, onReplay, pinned, onTogglePin }: {
  r: ApiRequest;
  history: ApiRequest[];
  active: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  onBack: () => void;
  onSelect: (r: ApiRequest) => void;
  onReplay: (d: Draft) => void;
}) {
  const failed = isFailure(r);
  const baseline = failed ? findBaseline(r, history) : undefined;

  const [raw, setRaw] = useState<RawData>();
  const [baseRaw, setBaseRaw] = useState<RawData>();
  useEffect(() => {
    let live = true; // ignore a slow lookup that finishes after the user opened another request
    const load = (id: string, set: (v?: RawData) => void) =>
      chrome.storage.session.get(`raw:${id}`).then((d) => live && set(d[`raw:${id}`] as RawData | undefined));
    load(r.id, setRaw);
    if (baseline) load(baseline.id, setBaseRaw);
    return () => {
      live = false;
    };
  }, [r.id, baseline?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- baseline is derived from these ids

  // Field-level differences between the two response bodies, when both were captured.
  const now = parseShape(raw?.responseBody);
  const before = parseShape(baseRaw?.responseBody);
  const bodyChanges = now && before ? shapeDiff(now, before) : [];
  const diags = diagnose(r, { baseline, responseBody: raw?.responseBody, raw, history });
  // Raw headers live only in memory; after a browser restart we fall back to the redacted copy.
  const sent = raw?.requestHeaders ?? r.requestHeaders ?? {};
  const sentHeaders = replayable(sent);
  const url = raw?.url ?? r.url;
  const report = () => buildReport(r, diags, baseline, raw, traceBack(r, history));

  const replay = () => {
    // Never send the literal "REDACTED": leave masked headers out and say which ones to re-enter.
    const masked = Object.keys(sentHeaders).filter((k) => sentHeaders[k] === REDACTED);
    const headers = Object.fromEntries(Object.entries(sentHeaders).filter(([, v]) => v !== REDACTED));
    const notes = [];
    if (masked.length) notes.push(`Re-enter ${masked.join(", ")}: the original values are no longer in memory.`);
    if (!raw?.requestBody && !["GET", "HEAD"].includes(r.method)) {
      notes.push(r.deep ? "The request body wasn't available (too large or not sent)." : "The request body wasn't recorded. Turn on Deep capture to record bodies.");
    }
    if (raw?.requestBody?.endsWith("…[truncated]")) notes.push("The request body was truncated when recorded; fix the end before sending.");
    onReplay({ method: r.method, url, headers: headerLines(headers), body: raw?.requestBody ?? "", origin: sent.origin ?? "", note: notes.join(" ") });
  };

  useKeys(active, (e) => {
    if (e.key === "Escape") onBack();
    else if (e.key === "r") replay();
    else if (e.key === "c") void navigator.clipboard.writeText(report()).catch(() => {});
    else return;
    e.preventDefault();
  });

  return (
    <section className="detail">
      <button className="link" onClick={onBack}>← All requests</button>
      <h2>
        <StatusPill r={r} /> {r.method} <span className="url">{r.url}</span>
      </h2>
      <p className="muted">
        {new Date(r.startedAt).toLocaleTimeString()} · {ms(r.durationMs)}
        {r.error ? ` · ${r.error}` : r.statusText ? ` · ${r.statusText}` : ""}
        {r.deep ? " · deep capture" : ""}
        {r.callSite && <> · from <code>{r.callSite}</code></>}
      </p>

      <div className="toolbar">
        <button onClick={replay}>Replay in tester</button>
        <button aria-pressed={pinned} onClick={onTogglePin} title="Keep this endpoint at the top of Traffic with its latest status">
          {pinned ? "★ Watching" : "☆ Watch endpoint"}
        </button>
        <CopyButton label="Copy cURL" text={() => exportCurl(r.method, url, { ...sentHeaders, ...(sent.origin && { origin: sent.origin }) }, raw?.requestBody)} />
        <CopyButton label="Copy report" text={() => report()} />
      </div>
      <p className="muted small">
        Copied text has tokens, cookies, and passwords masked. Keys: <kbd>Esc</kbd> back · <kbd>r</kbd> replay · <kbd>c</kbd> copy report
      </p>

      <h3>Diagnosis</h3>
      <Diagnostics items={diags} />

      <h3>Why?</h3>
      <Trace r={r} history={history} onSelect={onSelect} />
      {(r.links ?? []).length > 0 && (
        <details className="rerun">
          <summary>Re-run this chain with fresh data</summary>
          <ChainRunner r={r} history={history} />
        </details>
      )}

      {failed && (
        <>
          <h3>vs. last success</h3>
          {baseline ? (
            <>
              <table className="diff">
                <thead>
                  <tr><th /><th>This request</th><th>Last success</th></tr>
                </thead>
                <tbody>
                  {compare(r, baseline).map((row) => (
                    <tr key={row.field}>
                      <th>{row.field}</th>
                      <td>{row.failed}</td>
                      <td>{row.baseline}</td>
                    </tr>
                  ))}
                  {bodyChanges.map((c) => (
                    <tr key={`body ${c.path}`}>
                      <th>body {c.path}</th>
                      <td>{c.now}</td>
                      <td>{c.before}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="link" onClick={() => onSelect(baseline)}>Open last success →</button>
            </>
          ) : (
            <p className="muted">No successful call to this endpoint captured yet. Once one succeeds, it is compared here automatically.</p>
          )}
        </>
      )}

      <h3>Response body</h3>
      <Body text={raw?.responseBody} contentType={r.responseHeaders?.["content-type"]}
        hint={r.deep ? "Body not available." : "Turn on Deep capture for this tab to record bodies."} />

      {raw?.requestBody && (
        <>
          <h3>Request body</h3>
          <Body text={raw.requestBody} contentType={r.requestHeaders?.["content-type"]} />
        </>
      )}

      <details>
        <summary>Request headers</summary>
        <HeaderList headers={r.requestHeaders} />
      </details>
      <details>
        <summary>Response headers</summary>
        <HeaderList headers={r.responseHeaders} />
      </details>
    </section>
  );
}

function SiteAccess({ tab }: { tab?: chrome.tabs.Tab }) {
  const [origins, setOrigins] = useState<string[]>([]);
  // What the user typed; until they type, suggest the current tab's site.
  const [typed, setSite] = useState<string>();
  const site = typed ?? (tab?.url?.startsWith("http") ? new URL(tab.url).origin : "");
  const [error, setError] = useState<string>();
  const required = chrome.runtime.getManifest().host_permissions ?? [];

  const refresh = () => chrome.permissions.getAll().then((p) => setOrigins(p.origins ?? []));
  useEffect(() => {
    refresh();
  }, []);

  const grant = (patterns: string[]) => chrome.permissions.request({ origins: patterns }).then(refresh);
  const grantSite = () => {
    setError(undefined);
    try {
      const u = new URL(site);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      void grant([`${u.protocol}//${u.hostname}/*`]);
    } catch {
      setError("Enter a site like https://api.example.com");
    }
  };

  return (
    <details className="access">
      <summary>Site access · {origins.length} allowed</summary>
      <p className="muted small">
        Chrome only shows a request when both the page and the API it calls are allowed. localhost is always allowed;
        an app on localhost calling https://api.example.com needs that API allowed too.
      </p>
      <div className="toolbar">
        <input placeholder="https://api.example.com" value={site} onChange={(e) => setSite(e.target.value)} />
        <button onClick={grantSite}>Allow</button>
        <button onClick={() => grant(["http://*/*", "https://*/*"])}>All sites</button>
      </div>
      {error && <p className="warn-text">{error}</p>}
      <ul className="chips">
        {origins.map((o) => (
          <li key={o}>
            {o}
            {!required.includes(o) && (
              <button aria-label={`Remove ${o}`} onClick={() => chrome.permissions.remove({ origins: [o] }).then(refresh)}>×</button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
