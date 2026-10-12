// The three ways to look at captured calls: a list, grouped by endpoint, and a timeline.
import { useState } from "react";
import type { ApiRequest } from "../shared/types";
import { endpointKey, isFailure } from "../shared/http";
import { relatedIds } from "../shared/lineage";
import { StatusPill, kindOf, ms, pathOf } from "./ui";

interface ViewProps {
  shown: ApiRequest[]; // newest first, already filtered
  history: ApiRequest[]; // everything, for links
  focusedId?: string; // keyboard focus (j/k)
  onOpen: (r: ApiRequest) => void;
  pins?: string[]; // watched endpoint keys
  onTogglePin?: (key: string) => void;
}

// "GET api.test/users/:id" -> { method: "GET", host: "api.test", path: "/users/:id" }
export function splitKey(key: string) {
  const space = key.indexOf(" ");
  const rest = key.slice(space + 1);
  const slash = rest.indexOf("/");
  return { method: key.slice(0, space), host: slash < 0 ? rest : rest.slice(0, slash), path: slash < 0 ? "/" : rest.slice(slash) };
}

export function Row({ r, focused, onOpen }: { r: ApiRequest; focused?: boolean; onOpen: (r: ApiRequest) => void }) {
  return (
    <li>
      <button className={`row ${isFailure(r) ? "failed" : ""} ${focused ? "focused" : ""}`} onClick={() => onOpen(r)} title={r.url}>
        <StatusPill r={r} />
        <b>{r.method}</b>
        <span className="path">{pathOf(r.url)}</span>
        {r.drift?.length ? <span className="drift-mark" title="Response shape changed from this endpoint's usual one">shape changed</span> : null}
        <span className="muted">{ms(r.durationMs)}</span>
      </button>
    </li>
  );
}

// Watched endpoints, across tabs and filters: latest status, failures, and drift.
export function Watching({ pins, history, onOpen, onTogglePin }: { pins: string[]; history: ApiRequest[]; onOpen: (r: ApiRequest) => void; onTogglePin: (key: string) => void }) {
  if (!pins.length) return null;
  return (
    <div className="watching">
      <b className="small">Watching</b>
      <ul className="list">
        {pins.map((key) => {
          const calls = history.filter((r) => endpointKey(r.method, r.url) === key);
          const last = calls[0];
          const failed = calls.filter(isFailure).length;
          const drift = calls.some((c) => c.drift?.length);
          const { method, host, path } = splitKey(key);
          return (
            <li key={key} className="watch-row">
              <button className={`row ${last && isFailure(last) ? "failed" : ""}`} disabled={!last} onClick={() => last && onOpen(last)} title={host}>
                {last ? <StatusPill r={last} /> : <span className="pill muted">—</span>}
                <b>{method}</b>
                <span className="path">{path}</span>
                {drift && <span className="drift-mark">shape changed</span>}
                <span className="muted small">{calls.length ? `${failed}/${calls.length} failed` : "no calls yet"}</span>
              </button>
              <button className="unpin" aria-label={`Stop watching ${method} ${path}`} onClick={() => onTogglePin(key)}>×</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ListView({ shown, focusedId, onOpen }: ViewProps) {
  return (
    <ul className="list">
      {shown.map((r) => (
        <Row key={r.id} r={r} focused={r.id === focusedId} onOpen={onOpen} />
      ))}
    </ul>
  );
}

// One row per endpoint (/users/42 and /users/7 together), worst failure rate first.
export function GroupView({ shown, focusedId, onOpen, pins = [], onTogglePin }: ViewProps) {
  const groups = new Map<string, ApiRequest[]>();
  for (const r of shown) {
    const key = endpointKey(r.method, r.url);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const rows = [...groups].map(([key, calls]) => {
    const failed = calls.filter(isFailure).length;
    const timed = calls.filter((c) => c.durationMs !== undefined);
    const avg = timed.length ? Math.round(timed.reduce((sum, c) => sum + c.durationMs!, 0) / timed.length) : undefined;
    return { key, ...splitKey(key), calls, failed, avg };
  });
  rows.sort((a, b) => b.failed / b.calls.length - a.failed / a.calls.length || b.calls.length - a.calls.length);

  return (
    <ul className="groups">
      {rows.map((g) => {
        const rate = Math.round((g.failed / g.calls.length) * 100);
        return (
          <li key={g.key}>
            <details>
              <summary className="group-row" title={g.host}>
                <span className={`rate ${rate === 0 ? "ok" : rate === 100 ? "fail" : "warn"}`}>{rate}%</span>
                <b>{g.method}</b>
                <span className="path">{g.path}</span>
                <span className="muted">
                  {g.calls.length}× · {ms(g.avg)}
                </span>
                {onTogglePin && (
                  <button
                    className="pin"
                    aria-pressed={pins.includes(g.key)}
                    aria-label={`${pins.includes(g.key) ? "Stop watching" : "Watch"} ${g.method} ${g.path}`}
                    title="Watch this endpoint"
                    onClick={(e) => {
                      e.preventDefault(); // don't toggle the group open/closed
                      onTogglePin(g.key);
                    }}
                  >
                    {pins.includes(g.key) ? "★" : "☆"}
                  </button>
                )}
              </summary>
              <ul className="list">
                {g.calls.map((r) => (
                  <Row key={r.id} r={r} focused={r.id === focusedId} onOpen={onOpen} />
                ))}
              </ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

const MAX_TIMELINE = 60;
const span = (msTotal: number) => (msTotal < 2000 ? `${Math.round(msTotal)} ms` : `${(msTotal / 1000).toFixed(1)} s`);

// Calls as bars over time, oldest at the top. Hovering one highlights the calls linked to it.
export function TimelineView({ shown, history, focusedId, onOpen }: ViewProps) {
  const [hovered, setHovered] = useState<ApiRequest>();
  const items = shown.slice(0, MAX_TIMELINE).reverse();
  if (!items.length) return null;
  const t0 = Math.min(...items.map((r) => r.startedAt));
  const t1 = Math.max(...items.map((r) => r.startedAt + (r.durationMs ?? 0)));
  const total = Math.max(t1 - t0, 1);
  const related = hovered ? relatedIds(hovered, history) : undefined;

  return (
    <div className="timeline">
      <div className="axis muted small">
        <span>0</span>
        <span>
          {span(total)}
          {shown.length > MAX_TIMELINE ? ` · latest ${MAX_TIMELINE} calls` : ""}
        </span>
      </div>
      {items.map((r) => (
        <button
          key={r.id}
          className={`tl-row ${related && !related.has(r.id) ? "dim" : ""} ${r.id === focusedId ? "focused" : ""}`}
          onMouseEnter={() => setHovered(r)}
          onMouseLeave={() => setHovered(undefined)}
          onFocus={() => setHovered(r)}
          onBlur={() => setHovered(undefined)}
          onClick={() => onOpen(r)}
          title={`${r.method} ${r.url} · ${ms(r.durationMs)}`}
        >
          <span className="tl-label">
            <StatusPill r={r} />
            <span className="path">{pathOf(r.url)}</span>
          </span>
          <span className="tl-track">
            <span
              className={`tl-bar ${kindOf(r)}`}
              style={{ left: `${((r.startedAt - t0) / total) * 100}%`, width: `${Math.max(((r.durationMs ?? 0) / total) * 100, 1)}%` }}
            />
          </span>
        </button>
      ))}
    </div>
  );
}
