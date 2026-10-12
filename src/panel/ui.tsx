import { useState } from "react";
import type { ApiRequest, Diagnostic, Headers } from "../shared/types";
import { formatJson, isCancelled } from "../shared/http";

const MAX_RENDER = 200_000;

export const ms = (n?: number) => (n === undefined ? "—" : `${n} ms`);

export function StatusPill({ r }: { r: ApiRequest }) {
  const s = r.status ?? 0;
  const kind = r.error ? (isCancelled(r) ? "muted" : "fail") : s >= 500 ? "fail" : s >= 400 ? "warn" : "ok";
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

// Always rendered as text inside <pre>; React escapes it, so HTML responses can't execute.
export function Body({ text, contentType, hint }: { text?: string; contentType?: string; hint?: string }) {
  if (text === undefined) return <p className="muted">{hint ?? "Not captured."}</p>;
  if (text === "") return <p className="muted">Empty body.</p>;
  const { pretty, error } = formatJson(text, contentType);
  const shown = pretty ?? text;
  return (
    <>
      {error && <p className="warn-text">Invalid JSON: {error}. Showing raw text.</p>}
      <pre className="body">{shown.slice(0, MAX_RENDER)}</pre>
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
