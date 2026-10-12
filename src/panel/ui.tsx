import { useState } from "react";
import type { ApiRequest, Diagnostic, Headers } from "../shared/types";
import { formatJson, isCancelled } from "../shared/http";

const MAX_RENDER = 200_000;

export const ms = (n?: number) => (n === undefined ? "—" : `${n} ms`);

export function pathOf(url: string) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

// Colour class for a call: ok / warn (4xx) / fail (5xx, network) / muted (cancelled).
export function kindOf(r: ApiRequest) {
  const s = r.status ?? 0;
  return r.error ? (isCancelled(r) ? "muted" : "fail") : s >= 500 ? "fail" : s >= 400 ? "warn" : "ok";
}

export function StatusPill({ r }: { r: ApiRequest }) {
  const kind = kindOf(r);
  const label = r.corsError ? "CORS" : r.error ? (isCancelled(r) ? "CANCEL" : "NET ERR") : r.status;
  return (
    <span className={`pill ${kind}`} title={r.error ?? r.statusText}>
      {label}
    </span>
  );
}

export function Diagnostics({ items }: { items: Diagnostic[] }) {
  if (!items.length) return <p className="muted">Nothing unusual detected.</p>;
  return (
    <ul className="diags">
      {items.map((d) => (
        <li key={d.title} className={d.severity}>
          <strong>{d.title}</strong>
          <p>{d.explanation}</p>
          <p className="next">→ {d.nextStep}</p>
        </li>
      ))}
    </ul>
  );
}

export function HeaderList({ headers }: { headers?: Headers }) {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return <p className="muted">Not captured.</p>;
  return (
    <dl className="headers">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}


const MAX_ITEMS = 100; // per object/array level in the tree

// Collapsible JSON built on native <details>: the first two levels start open.
function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const label = name !== undefined && <span className="k">{name}: </span>;
  if (value === null || typeof value !== "object") {
    const kind = value === null ? "null" : typeof value;
    return (
      <div className="leaf">
        {label}
        <span className={`v ${kind}`}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  return (
    <details open={depth < 2}>
      <summary>
        {label}
        <span className="muted">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </summary>
      <div className="children">
        {entries.slice(0, MAX_ITEMS).map(([k, v]) => (
          <JsonNode key={k} name={k} value={v} depth={depth + 1} />
        ))}
        {entries.length > MAX_ITEMS && <div className="muted">… {entries.length - MAX_ITEMS} more</div>}
      </div>
    </details>
  );
}

// Always rendered as text (React escapes it), so HTML responses can't execute.
export function Body({ text, contentType, hint }: { text?: string; contentType?: string; hint?: string }) {
  const [rawView, setRawView] = useState(false);
  if (text === undefined) return <p className="muted">{hint ?? "Not captured."}</p>;
  if (text === "") return <p className="muted">Empty body.</p>;
  const { pretty, error } = formatJson(text, contentType);
  const tree = pretty !== undefined && text.length <= MAX_RENDER;
  const shown = pretty ?? text;
  return (
    <>
      {error && <p className="warn-text">Invalid JSON: {error}. Showing raw text.</p>}
      {tree && (
        <button className="link small" onClick={() => setRawView(!rawView)}>
          {rawView ? "Tree view" : "Raw text"}
        </button>
      )}
      {tree && !rawView ? (
        <div className="body json">
          <JsonNode value={JSON.parse(text)} depth={0} />
        </div>
      ) : (
        <pre className="body">{shown.slice(0, MAX_RENDER)}</pre>
      )}
      {shown.length > MAX_RENDER && <p className="muted">Showing the first {MAX_RENDER.toLocaleString()} characters.</p>}
    </>
  );
}

export function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [state, setState] = useState<"Copied ✓" | "Copy failed">();
  const flash = (s: typeof state) => {
    setState(s);
    setTimeout(() => setState(undefined), 1500);
  };
  // writeText rejects when the panel isn't focused; say so instead of failing silently.
  const copy = () => navigator.clipboard.writeText(text()).then(() => flash("Copied ✓"), () => flash("Copy failed"));
  return <button onClick={copy}>{state ?? label}</button>;
}
