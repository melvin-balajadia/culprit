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
}

export function Row({ r, focused, onOpen }: { r: ApiRequest; focused?: boolean; onOpen: (r: ApiRequest) => void }) {
  return (
    <li>
      <button className={`row ${isFailure(r) ? "failed" : ""} ${focused ? "focused" : ""}`} onClick={() => onOpen(r)} title={r.url}>
        <StatusPill r={r} />
        <b>{r.method}</b>
        <span className="path">{pathOf(r.url)}</span>
        <span className="muted">{ms(r.durationMs)}</span>
      </button>
    </li>
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
export function GroupView({ shown, focusedId, onOpen }: ViewProps) {
  const groups = new Map<string, ApiRequest[]>();
  for (const r of shown) {
    const key = endpointKey(r.method, r.url);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const rows = [...groups].map(([key, calls]) => {
    const failed = calls.filter(isFailure).length;
    const timed = calls.filter((c) => c.durationMs !== undefined);
    const avg = timed.length ? Math.round(timed.reduce((sum, c) => sum + c.durationMs!, 0) / timed.length) : undefined;
    const [method, rest] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
    return { key, method, path: rest.slice(rest.indexOf("/")), host: rest.slice(0, rest.indexOf("/")), calls, failed, avg };
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
