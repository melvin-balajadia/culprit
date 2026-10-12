// Re-running a chain of calls with fresh data: each step's response supplies the values (tokens, ids)
// that later steps used, at exactly the locations the lineage links recorded. Pure, no Chrome APIs.
import type { Headers, Link } from "./types";

export interface Step {
  id: string; // id of the original captured call
  label: string; // "POST /api/login"
  method: string;
  url: string;
  headers: Headers;
  body?: string;
  origin?: string; // the Origin the app sent; replayed through the tester's Origin rule
  links: Link[]; // where this step's values came from
}

export interface Output {
  body?: string;
  headers: Headers;
}

export interface Applied {
  link: Link;
  ok: boolean; // false: the new response had no value at that path, so the original was kept
}

// Split "user.items[0].id" into ["user", "items", 0, "id"].
export const segments = (path: string) =>
  path.split(".").flatMap((part) => part.split(/\[(\d+)\]/).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s)));

// Value at a link's fromPath in a step's output: "response.user.id" or "header.x-csrf-token".
export function valueAt(out: Output, fromPath: string): string | undefined {
  if (fromPath.startsWith("header.")) return out.headers[fromPath.slice("header.".length)];
  if (!fromPath.startsWith("response.") || !out.body) return;
  try {
    let v: unknown = JSON.parse(out.body);
    for (const key of segments(fromPath.slice("response.".length))) {
      if (v === null || typeof v !== "object") return;
      v = (v as Record<string | number, unknown>)[key];
    }
    return v === null || v === undefined || typeof v === "object" ? undefined : String(v);
  } catch {
    return;
  }
}

function setInJson(body: string, path: string, value: string): string | undefined {
  try {
    const root = JSON.parse(body);
    const keys = segments(path);
    let node = root;
    for (const key of keys.slice(0, -1)) node = node?.[key];
    if (node === null || typeof node !== "object") return;
    const last = keys.at(-1)!;
    // Keep the original type: an id that was a number stays a number.
    node[last] = typeof node[last] === "number" && !Number.isNaN(Number(value)) ? Number(value) : value;
    return JSON.stringify(root);
  } catch {
    return;
  }
}

// Put one value into a step's request at a link's "to" location. Returns undefined if the location is gone.
export function placeValue(step: Step, to: string, value: string): Step | undefined {
  if (to.startsWith("path[")) {
    const index = Number(to.slice(5, -1));
    const u = new URL(step.url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (index >= parts.length) return;
    parts[index] = encodeURIComponent(value);
    u.pathname = `/${parts.join("/")}`;
    return { ...step, url: u.toString() };
  }
  if (to.startsWith("query.")) {
    const u = new URL(step.url);
    u.searchParams.set(to.slice("query.".length), value);
    return { ...step, url: u.toString() };
  }
  if (to.startsWith("header.")) {
    const name = to.slice("header.".length);
    const prefix = step.headers[name]?.match(/^(Bearer|Token|Basic)\s+/i)?.[0] ?? (name === "authorization" ? "Bearer " : "");
    return { ...step, headers: { ...step.headers, [name]: `${prefix}${value}` } };
  }
  if (to.startsWith("body.") && step.body !== undefined) {
    const path = to.slice("body.".length);
    const json = setInJson(step.body, path, value);
    if (json !== undefined) return { ...step, body: json };
    const form = new URLSearchParams(step.body);
    if (!form.has(path)) return;
    form.set(path, value);
    return { ...step, body: form.toString() };
  }
}

// Apply every link whose source step has already run in this replay.
export function applyLinks(step: Step, outputs: Map<string, Output>): { step: Step; applied: Applied[] } {
  const applied: Applied[] = [];
  let next = step;
  for (const link of step.links) {
    const out = outputs.get(link.from);
    if (!out) continue; // the source isn't part of this replay; keep the original value
    // A missing-value link points at the field that was null (e.g. "user"); once fixed it is usually an
    // object, and the URL wants its id.
    const value = valueAt(out, link.fromPath) ?? (link.missing ? valueAt(out, `${link.fromPath}.id`) : undefined);
    const placed = value === undefined ? undefined : placeValue(next, link.to, value);
    if (placed) next = placed;
    applied.push({ link, ok: !!placed });
  }
  return { step: next, applied };
}

// Steps that change data on the server, so the runner asks before sending them.
export const changesData = (s: Step) => !["GET", "HEAD", "OPTIONS"].includes(s.method.toUpperCase());
