// Re-run a call together with the calls that fed it, carrying fresh values (tokens, ids) forward.
import { useEffect, useState } from "react";
import type { ApiRequest, RawData } from "../shared/types";
import { ancestorsOf } from "../shared/lineage";
import { applyLinks, changesData, type Applied, type Output, type Step } from "../shared/chain";
import { REDACTED, fetchErrorMessage, headerLines, isFailure, parseHeaderLines, replayable, sendRequest } from "../shared/http";
import { diagnose } from "../shared/diagnostics";
import { requestHosts, setOriginRule } from "./origin";
import { Diagnostics, StatusPill, ms, pathOf } from "./ui";

interface Result {
  r: ApiRequest;
  applied: Applied[];
  body?: string;
}

const field = (path: string) => path.replace(/^response\./, "");

// A captured call as a runnable step. Masked header values are dropped: fresh ones come from earlier steps.
function toStep(c: ApiRequest, raw?: RawData): Step & { note?: string } {
  const sent = raw?.requestHeaders ?? c.requestHeaders ?? {};
  const headers = Object.fromEntries(Object.entries(replayable(sent)).filter(([, v]) => v !== REDACTED));
  const note = !raw
    ? "Its recorded data is no longer in memory: masked headers are left out and the body is missing."
    : !raw.requestBody && changesData({ method: c.method } as Step)
      ? "Its request body wasn't recorded."
      : undefined;
  return { id: c.id, label: `${c.method} ${pathOf(c.url)}`, method: c.method, url: raw?.url ?? c.url, headers, body: raw?.requestBody, origin: sent.origin, links: c.links ?? [], note };
}

export default function ChainRunner({ r, history }: { r: ApiRequest; history: ApiRequest[] }) {
  // The chain as it was when opened; new captures don't reshuffle steps mid-edit.
  const [calls] = useState(() => [...ancestorsOf(r, history), r]);
  const [steps, setSteps] = useState<(Step & { note?: string })[]>();
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState<AbortController>();
  const [armed, setArmed] = useState(false);
  const [editing, setEditing] = useState<string>();

  useEffect(() => {
    let live = true;
    Promise.all(calls.map((c) => chrome.storage.session.get(`raw:${c.id}`).then((d) => d[`raw:${c.id}`] as RawData | undefined))).then(
      (raws) => live && setSteps(calls.map((c, i) => toStep(c, raws[i])))
    );
    return () => {
      live = false;
    };
  }, [calls]);

  if (!steps) return <p className="muted">Loading the chain…</p>;
  const risky = steps.filter(changesData);
  const stepOf = (id: string) => calls.findIndex((c) => c.id === id) + 1;

  const edit = (id: string, patch: Partial<Step>) => {
    setSteps((all) => all!.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    setArmed(false);
  };

  async function run() {
    if (busy || !steps) return;
    if (risky.length && !armed) return setArmed(true);
    setArmed(false);
    const ctrl = new AbortController();
    setBusy(ctrl);
    setResults({});
    try {
      await requestHosts(steps.map((s) => s.url)); // first await, so it still counts as part of the click
      const outputs = new Map<string, Output>();
      for (const original of steps) {
        if (ctrl.signal.aborted) break;
        const { step, applied } = applyLinks(original, outputs);
        await setOriginRule(step.origin ?? "");
        const base: ApiRequest = { id: `rerun-${step.id}`, tabId: -1, url: step.url, method: step.method, startedAt: Date.now(), requestHeaders: step.headers };
        let result: Result;
        try {
          const body = changesData(step) ? step.body : undefined;
          const res = await sendRequest(step.method, step.url, step.headers, body, ctrl.signal);
          outputs.set(step.id, { body: res.body, headers: res.headers });
          result = { r: { ...base, status: res.status, statusText: res.statusText, durationMs: res.durationMs, responseHeaders: res.headers }, applied, body: res.body };
        } catch (e) {
          result = { r: { ...base, durationMs: Date.now() - base.startedAt, error: fetchErrorMessage(e) }, applied };
        }
        setResults((prev) => ({ ...prev, [step.id]: result }));
      }
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="chain">
      <p className="muted small">
        Runs these calls in order. Values a call used from an earlier one (tokens, ids) are taken from the fresh responses, so
        editing a step changes what flows to the steps after it.
      </p>
      <ol className="steps">
        {steps.map((s, i) => {
          const res = results[s.id];
          const fed = s.links.filter((l) => stepOf(l.from) > 0);
          return (
            <li key={s.id}>
              <div className="step-head">
                <span className="num">{i + 1}</span>
                <b>{s.method}</b>
                <span className="path" title={s.url}>{pathOf(s.url)}</span>
                {changesData(s) && <span className="badge warn">changes data</span>}
                <button className="link small" onClick={() => setEditing(editing === s.id ? undefined : s.id)}>
                  {editing === s.id ? "Done" : "Edit"}
                </button>
              </div>
              {fed.map((l) => (
                <div className="edge small" key={l.to}>
                  ← {l.to} from step {stepOf(l.from)}&apos;s {field(l.fromPath)}
                </div>
              ))}
              {s.note && <p className="warn-text small">{s.note}</p>}
              {editing === s.id && (
                <div className="step-edit">
                  <input aria-label={`Step ${i + 1} URL`} value={s.url} onChange={(e) => edit(s.id, { url: e.target.value })} />
                  <textarea rows={3} aria-label={`Step ${i + 1} headers`} value={headerLines(s.headers)} spellCheck={false}
                    onChange={(e) => edit(s.id, { headers: parseHeaderLines(e.target.value) })} />
                  {changesData(s) && (
                    <textarea rows={4} aria-label={`Step ${i + 1} body`} value={s.body ?? ""} spellCheck={false}
                      onChange={(e) => edit(s.id, { body: e.target.value })} />
                  )}
                </div>
              )}
              {res && (
                <div className="step-result">
                  <StatusPill r={res.r} /> {res.r.statusText || res.r.error} · {ms(res.r.durationMs)}
                  <span className="muted small"> (was <StatusPill r={calls[i]} />)</span>
                  {res.applied.filter((a) => !a.ok).map((a) => (
                    <p className="warn-text small" key={a.link.to}>
                      Couldn&apos;t fill {a.link.to}: step {stepOf(a.link.from)}&apos;s response had no {field(a.link.fromPath)}, so the original value was kept.
                    </p>
                  ))}
                  {isFailure(res.r) && <Diagnostics items={diagnose(res.r, { responseBody: res.body })} />}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="toolbar">
        {busy ? (
          <button onClick={() => busy.abort()}>Cancel</button>
        ) : (
          <button className={armed ? "danger" : "primary"} onClick={run}>
            {armed ? `Confirm: run ${risky.length} call${risky.length > 1 ? "s that change" : " that changes"} data` : `Run ${steps.length} calls`}
          </button>
        )}
      </div>
      {armed && <p className="warn-text">{risky.map((s) => s.label).join(", ")} will run again on the server.</p>}
    </div>
  );
}
