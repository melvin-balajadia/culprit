import { useEffect, useState, type KeyboardEvent } from "react";
import type { ApiRequest } from "../shared/types";
import { exportCurl, fetchErrorMessage, fillVars, formatJson, parseHeaderLines, parseVars, sendRequest, type TestResult } from "../shared/http";
import { diagnose } from "../shared/diagnostics";
import { Body, CopyButton, Diagnostics, HeaderList, StatusPill, ms, pathOf } from "./ui";
import { requestHosts, setOriginRule } from "./origin";

export interface Draft {
  method: string;
  url: string;
  headers: string; // "Name: value" per line
  body: string;
  origin: string; // "" sends no Origin, like cURL
  note?: string; // what a replay could not restore
}

interface Saved {
  name: string;
  draft: Draft;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const EMPTY: Draft = { method: "GET", url: "", headers: "", body: "", origin: "" };

export default function Tester({ draft }: { draft?: Draft }) {
  // A replay remounts this component (App gives it a new key), so every field, including a DELETE
  // confirmation armed for the previous request, starts fresh.
  const [form, setForm] = useState<Draft>(draft ?? EMPTY);
  const [outcome, setOutcome] = useState<{ r: ApiRequest; result?: TestResult }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<AbortController>();
  const [armed, setArmed] = useState(false); // second click needed for DELETE
  const [saved, setSaved] = useState<Saved[]>([]);
  const [varsText, setVarsText] = useState("");
  const [saveName, setSaveName] = useState<string>(); // set while naming a request to save

  useEffect(() => {
    chrome.storage.local.get("saved").then((d) => setSaved((d.saved as Saved[]) ?? []));
    chrome.storage.local.get("vars").then((d) => setVarsText((d.vars as string) ?? ""));
  }, []);

  const keepSaved = (next: Saved[]) => {
    setSaved(next);
    void chrome.storage.local.set({ saved: next });
  };
  const save = () => {
    const name = saveName?.trim();
    if (!name) return;
    const { note: _note, ...request } = form; // eslint-disable-line @typescript-eslint/no-unused-vars -- drop the replay note
    keepSaved([{ name, draft: request }, ...saved.filter((s) => s.name !== name)]); // same name overwrites
    setSaveName(undefined);
  };
  const load = (s: Saved) => {
    setForm(s.draft);
    setOutcome(undefined);
    setError(undefined);
    setArmed(false);
  };

  const set = (patch: Partial<Draft>) => {
    setForm((f) => ({ ...f, ...patch }));
    setArmed(false);
  };
  const hasBody = !["GET", "HEAD"].includes(form.method) && form.body.trim() !== "";

  async function send() {
    if (busy) return;
    setError(undefined);

    // {{name}} placeholders come from Variables.
    const vars = parseVars(varsText);
    const missing = new Set<string>();
    const fill = (text: string) => {
      const r = fillVars(text, vars);
      r.missing.forEach((m) => missing.add(m));
      return r.text;
    };
    const f = { ...form, url: fill(form.url), headers: fill(form.headers), body: fill(form.body), origin: fill(form.origin) };
    if (missing.size) {
      return setError(`Unknown variable ${[...missing].map((m) => `{{${m}}}`).join(", ")}. Define it under Saved & variables.`);
    }

    let url: URL;
    try {
      url = new URL(f.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      return setError("Enter a full http:// or https:// URL.");
    }

    let origin = "";
    if (f.origin.trim()) {
      try {
        origin = new URL(f.origin.trim()).origin;
        if (!/^https?:/.test(origin)) throw new Error();
      } catch {
        return setError("Origin must look like http://localhost:3000, or be empty.");
      }
    }

    const headers = parseHeaderLines(f.headers);
    if (hasBody) {
      const ct = headers["content-type"];
      try {
        JSON.parse(f.body);
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
      await requestHosts([url.toString()]);
      try {
        await setOriginRule(origin);
      } catch (e) {
        return setError(`Could not set the Origin header (${(e as Error).message}). Reload the extension and try again.`);
      }
      if (ctrl.signal.aborted) return;
      const result = await sendRequest(form.method, r.url, headers, hasBody ? f.body : undefined, ctrl.signal);
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
        {saveName === undefined ? (
          <button onClick={() => setSaveName(form.url ? `${form.method} ${pathOf(fillVars(form.url, parseVars(varsText)).text)}` : "")}>
            Save
          </button>
        ) : (
          <>
            <input aria-label="Name for this request" className="grow" value={saveName} autoFocus
              onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
            <button onClick={save}>Save</button>
            <button className="link" onClick={() => setSaveName(undefined)}>Cancel</button>
          </>
        )}
      </div>
      <p className="muted small">Ctrl+Enter to send · uses your browser session</p>

      <details className="field saved">
        <summary>
          Saved ({saved.length}) &amp; variables ({Object.keys(parseVars(varsText)).length})
        </summary>
        {saved.length ? (
          <ul className="chips">
            {saved.map((s) => (
              <li key={s.name}>
                <button className="link" onClick={() => load(s)}>{s.name}</button>
                <button aria-label={`Delete ${s.name}`} onClick={() => keepSaved(saved.filter((x) => x !== s))}>×</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No saved requests yet.</p>
        )}
        <label className="field">
          Variables <span className="muted">(name=value per line; use as {"{{name}}"} in the URL, headers, body or Origin)</span>
          <textarea rows={3} value={varsText} spellCheck={false} placeholder={"baseUrl=http://localhost:3000\ntoken=…"}
            onChange={(e) => {
              setVarsText(e.target.value);
              void chrome.storage.local.set({ vars: e.target.value });
            }} />
        </label>
        <p className="muted small">Saved requests and variables are kept on this computer, unmasked.</p>
      </details>
      {armed && <p className="warn-text">DELETE can remove data. Click again to confirm.</p>}
      {error && <p className="warn-text">{error}</p>}

      {outcome && (
        <div className="result">
          <h2>
            <StatusPill r={outcome.r} /> {outcome.r.statusText || outcome.r.error}
            <span className="muted"> · {ms(outcome.r.durationMs)}{outcome.result ? ` · ${outcome.result.size.toLocaleString()} bytes` : ""}</span>
          </h2>
          <Diagnostics items={diagnose(outcome.r, { responseBody: outcome.result?.body })} />
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
