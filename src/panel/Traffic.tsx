import { useEffect, useState } from "react";
import type { ApiRequest, RawData } from "../shared/types";
import { REDACTED, buildReport, compare, exportCurl, findBaseline, headerLines, isFailure, replayable } from "../shared/http";
import { diagnose } from "../shared/diagnostics";
import { Body, CopyButton, Diagnostics, HeaderList, StatusPill, ms, pathOf } from "./ui";
import type { Draft } from "./Tester";
import Trace from "./Trace";

export default function Traffic({ onReplay }: { onReplay: (d: Draft) => void }) {
  const [requests, setRequests] = useState<ApiRequest[]>([]);
  const [deepTabs, setDeepTabs] = useState<number[]>([]);
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
    const loadTab = () => chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t));
    loadTab();

    const onChange = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.requests) setRequests((c.requests.newValue as ApiRequest[]) ?? []);
      if (c.deepTabs) setDeepTabs((c.deepTabs.newValue as number[]) ?? []);
    };
    chrome.storage.onChanged.addListener(onChange);
    chrome.tabs.onActivated.addListener(loadTab);
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      chrome.tabs.onActivated.removeListener(loadTab);
    };
  }, []);

  if (selected) {
    return (
      <Detail
        key={selected.id} // fresh state (raw data) per request
        r={selected}
        history={requests}
        onBack={() => setSelected(undefined)}
        onSelect={setSelected}
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

  const q = query.toLowerCase();
  const shown = requests.filter(
    (r) =>
      (!thisTab || r.tabId === tab?.id) &&
      (!errorsOnly || isFailure(r)) &&
      (!q || `${r.method} ${r.url} ${r.status ?? r.error}`.toLowerCase().includes(q))
  );
  const failures = shown.filter(isFailure).length;

  return (
    <section>
      <div className="toolbar">
        <input type="search" placeholder="Filter by URL, method, status…" value={query} onChange={(e) => setQuery(e.target.value)} />
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
        <span className="muted grow">{shown.length} shown{failures ? ` · ${failures} failed` : ""}</span>
      </div>
      {deepError && <p className="warn-text">{deepError}</p>}

      <SiteAccess tab={tab} />

      {shown.length === 0 ? (
        <p className="muted empty">No API calls yet. Use your app (or reload it) and fetch/XHR requests appear here.</p>
      ) : (
        <ul className="list">
          {shown.map((r) => (
            <li key={r.id}>
              <button className={`row ${isFailure(r) ? "failed" : ""}`} onClick={() => setSelected(r)} title={r.url}>
                <StatusPill r={r} />
                <b>{r.method}</b>
                <span className="path">{pathOf(r.url)}</span>
                <span className="muted">{ms(r.durationMs)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Detail({ r, history, onBack, onSelect, onReplay }: {
  r: ApiRequest;
  history: ApiRequest[];
  onBack: () => void;
  onSelect: (r: ApiRequest) => void;
  onReplay: (d: Draft) => void;
}) {
  const [raw, setRaw] = useState<RawData>();
  useEffect(() => {
    let live = true; // ignore a slow lookup that finishes after the user opened another request
    chrome.storage.session.get(`raw:${r.id}`).then((d) => live && setRaw(d[`raw:${r.id}`] as RawData | undefined));
    return () => {
      live = false;
    };
  }, [r.id]);

  const failed = isFailure(r);
  const baseline = failed ? findBaseline(r, history) : undefined;
  const diags = diagnose(r, { baseline, responseBody: raw?.responseBody, raw, history });
  // Raw headers live only in memory; after a browser restart we fall back to the redacted copy.
  const sent = raw?.requestHeaders ?? r.requestHeaders ?? {};
  const sentHeaders = replayable(sent);
  const url = raw?.url ?? r.url;

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
        <CopyButton label="Copy cURL" text={() => exportCurl(r.method, url, { ...sentHeaders, ...(sent.origin && { origin: sent.origin }) }, raw?.requestBody)} />
        <CopyButton label="Copy report" text={() => buildReport(r, diags, baseline, raw)} />
      </div>
      <p className="muted small">Copied text has tokens, cookies, and passwords masked.</p>

      <h3>Diagnosis</h3>
      <Diagnostics items={diags} />

      <h3>Why?</h3>
      <Trace r={r} history={history} onSelect={onSelect} />

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
