import type { ApiRequest } from "../shared/types";
import { traceBack } from "../shared/lineage";
import { StatusPill, pathOf } from "./ui";

const field = (path: string) => path.replace(/^response\./, "");

// The "Why?" chain: earlier calls that supplied values this one used, oldest first, with the culprit marked.
export default function Trace({ r, history, onSelect }: { r: ApiRequest; history: ApiRequest[]; onSelect: (r: ApiRequest) => void }) {
  // The culprit's explanation is already the first diagnosis; here the badge marks it in the chain.
  const { chain, culprit } = traceBack(r, history);

  if (chain.length === 1) {
    return (
      <p className="muted">
        {r.deep
          ? "No earlier captured call supplied a value this call used."
          : "Turn on Deep capture for this tab to see which earlier calls fed this one (tokens, ids, links)."}
      </p>
    );
  }

  return (
    <>
      <ol className="trace">
        {chain.map((node, i) => {
          const self = node.id === r.id;
          // Values this call supplied to later calls in the chain.
          const fed = chain.slice(i + 1).flatMap((target) =>
            (target.links ?? []).filter((l) => l.from === node.id).map((l) => ({ ...l, target }))
          );
          return (
            <li key={node.id} className={node.id === culprit?.id ? "culprit" : self ? "self" : ""}>
              <button className="node" disabled={self} onClick={() => onSelect(node)} title={node.url}>
                <StatusPill r={node} />
                <b>{node.method}</b>
                <span className="path">{pathOf(node.url)}</span>
                {node.id === culprit?.id && <span className="badge">Culprit</span>}
                {self && <span className="badge self">This call</span>}
              </button>
              {node.callSite && <div className="muted small">from {node.callSite}</div>}
              {fed.map((l) => (
                <div className="edge small" key={`${l.target.id} ${l.to}`}>
                  ↓ {field(l.fromPath)}
                  {l.missing ? " was null" : ""} → {l.target.method} {pathOf(l.target.url)} ({l.to})
                  {l.confidence === "likely" ? " · likely" : ""}
                </div>
              ))}
            </li>
          );
        })}
      </ol>
    </>
  );
}
