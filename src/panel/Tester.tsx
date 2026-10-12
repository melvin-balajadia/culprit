import { useState, type KeyboardEvent } from "react";
import type { ApiRequest } from "../shared/types";
import { exportCurl, fetchErrorMessage, formatJson, parseHeaderLines, sendRequest, type TestResult } from "../shared/http";
import { diagnose } from "../shared/diagnostics";
import { Body, CopyButton, Diagnostics, HeaderList, StatusPill, ms } from "./ui";

export interface Draft {
  method: string;
  url: string;
  headers: string; // "Name: value" per line
  body: string;
  origin: string; // "" sends no Origin, like cURL
  note?: string; // what a replay could not restore
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const EMPTY: Draft = { method: "GET", url: "", headers: "", body: "", origin: "" };

// fetch() can't set Origin, and by default ours is chrome-extension://…, which server CORS allowlists reject.
// A session rule rewrites it on the tester's own requests so a replay looks like the app's call.
const { HeaderOperation, ResourceType, RuleActionType } = chrome.declarativeNetRequest;
function setOriginRule(origin: string) {
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        action: {
          type: RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            origin
              ? { header: "origin", operation: HeaderOperation.SET, value: origin }
              : { header: "origin", operation: HeaderOperation.REMOVE }
          ]
        },
        condition: {
          initiatorDomains: [chrome.runtime.id], // only this extension's own requests, never the page's

          resourceTypes: [ResourceType.XMLHTTPREQUEST]
        }
      }
    ]
  });
}

export default function Tester({ draft }: { draft?: Draft }) {
  // A replay remounts this component (App gives it a new key), so every field, including a DELETE
  // confirmation armed for the previous request, starts fresh.
  const [form, setForm] = useState<Draft>(draft ?? EMPTY);
  const [outcome, setOutcome] = useState<{ r: ApiRequest; result?: TestResult }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<AbortController>();
  const [armed, setArmed] = useState(false); // second click needed for DELETE

  const set = (patch: Partial<Draft>) => {
    setForm((f) => ({ ...f, ...patch }));
    setArmed(false);
  };
  const hasBody = !["GET", "HEAD"].includes(form.method) && form.body.trim() !== "";

  async function send() {
    if (busy) return;
    setError(undefined);

    let url: URL;
    try {
      url = new URL(form.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      return setError("Enter a full http:// or https:// URL.");
    }

    let origin = "";
    if (form.origin.trim()) {
      try {
        origin = new URL(form.origin.trim()).origin;
        if (!/^https?:/.test(origin)) throw new Error();
      } catch {
        return setError("Origin must look like http://localhost:3000, or be empty.");
      }
    }

    const headers = parseHeaderLines(form.headers);
    if (hasBody) {
      const ct = headers["content-type"];
      try {
        JSON.parse(form.body);
        headers["content-type"] ??= "application/json";
      } catch (e) {
        if (ct?.includes("json")) return setError(`Body is not valid JSON: ${(e as Error).message}`);
      }
    }

    if (form.method === "DELETE" && !armed) return setArmed(true);
    setArmed(false);

    // Busy right away: the button turns into Cancel, so a second click can't fire a duplicate request.
    const ctrl = new AbortController();
    setBusy(ctrl);
    setOutcome(undefined);
    const sentHeaders = origin ? { ...headers, origin } : headers;
    const r: ApiRequest = { id: "tester", tabId: -1, url: url.toString(), method: form.method, startedAt: Date.now(), requestHeaders: sentHeaders };
    try {
      // First await, so it still counts as part of the click: grants this host so the call isn't blocked
      // by CORS. No-op if already allowed; if refused we still try, the server may allow CORS itself.
      await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }).catch(() => false);
      try {
        await setOriginRule(origin);
      } catch (e) {
        return setError(`Could not set the Origin header (${(e as Error).message}). Reload the extension and try again.`);
      }
      if (ctrl.signal.aborted) return;
      const result = await sendRequest(form.method, r.url, headers, hasBody ? form.body : undefined, ctrl.signal);
      setOutcome({
        r: { ...r, status: result.status, statusText: result.statusText, durationMs: result.durationMs, responseHeaders: result.headers },
        result
      });
    } catch (e) {
      setOutcome({ r: { ...r, durationMs: Date.now() - r.startedAt, error: fetchErrorMessage(e) } });
    } finally {
      setBusy(undefined);
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void send();
  };
  const formatBody = () => {
    const { pretty, error } = formatJson(form.body, "json");
    if (pretty) set({ body: pretty });
    setError(error && `Body is not valid JSON: ${error}`);
  };

  return (
    <section onKeyDown={onKey}>
      {form.note && <p className="warn-text">{form.note}</p>}
      <div className="toolbar">
        <select value={form.method} onChange={(e) => set({ method: e.target.value })} aria-label="Method">
          {/* A replayed method outside the list (PROPFIND, lowercase "patch") must still show as what is sent. */}
          {[...new Set([...METHODS, form.method])].map((m) => <option key={m}>{m}</option>)}
        </select>
        <input className="grow" placeholder="https://api.example.com/users/1" value={form.url}
          onChange={(e) => set({ url: e.target.value })} aria-label="URL" />
      </div>

      <label className="field">
        Headers <span className="muted">(one per line, Name: value)</span>
        <textarea rows={3} value={form.headers} onChange={(e) => set({ headers: e.target.value })}
          placeholder={"Authorization: Bearer …\nAccept: application/json"} spellCheck={false} />
      </label>

      <label className="field">
        Origin <span className="muted">(sent as if the call came from this site)</span>
        <input className="full" value={form.origin} onChange={(e) => set({ origin: e.target.value })}
          placeholder="none, like cURL (e.g. http://localhost:3000)" spellCheck={false} />
      </label>

      {!["GET", "HEAD"].includes(form.method) && (
        <label className="field">
          Body <button className="link" type="button" onClick={formatBody}>Format JSON</button>
          <textarea rows={6} value={form.body} onChange={(e) => set({ body: e.target.value })}
            placeholder='{"name": "Ada"}' spellCheck={false} />
        </label>
      )}

      <div className="toolbar">
        {busy ? (
          <button onClick={() => busy.abort()}>Cancel</button>
        ) : (
          <button className={armed ? "danger" : "primary"} onClick={send}>
            {armed ? "Confirm DELETE" : "Send"}
          </button>
        )}
        <CopyButton label="Copy cURL" text={() => exportCurl(form.method, form.url, { ...parseHeaderLines(form.headers), ...(form.origin && { origin: form.origin }) }, hasBody ? form.body : undefined)} />
        <span className="muted small grow">Ctrl+Enter to send · uses your browser session</span>
      </div>
      {armed && <p className="warn-text">DELETE can remove data. Click again to confirm.</p>}
      {error && <p className="warn-text">{error}</p>}

      {outcome && (
        <div className="result">
          <h2>
            <StatusPill r={outcome.r} /> {outcome.r.statusText || outcome.r.error}
            <span className="muted"> · {ms(outcome.r.durationMs)}{outcome.result ? ` · ${outcome.result.size.toLocaleString()} bytes` : ""}</span>
          </h2>
          <Diagnostics items={diagnose(outcome.r, undefined, outcome.result?.body)} />
          {outcome.result && (
            <>
              <h3>Response body</h3>
              <Body text={outcome.result.body} contentType={outcome.result.headers["content-type"]} />
              <details>
                <summary>Response headers</summary>
                <HeaderList headers={outcome.result.headers} />
              </details>
            </>
          )}
        </div>
      )}
    </section>
  );
}
