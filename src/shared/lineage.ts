// Data lineage between API calls: which earlier response supplied a value (token, id, link) that a later
// request used. Pure and Chrome-free; background.ts feeds it captures, the panel reads the resulting links.
// Privacy: the index keeps fingerprints and field paths only, never the values themselves.
import type { ApiRequest, Headers, Link, RawData } from "./types";
import { isFailure, isSensitive } from "./http";

const MAX_LEAVES = 2000;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 5000;
const COMMON_AFTER = 3; // a value seen in more responses than this is too common to link on alone
const MISSING = new Set(["undefined", "null", "NaN", "[object Object]"]);

export interface Leaf {
  path: string;
  key: string;
  value: string | number | boolean | null;
}

// Leaves of a JSON value with their paths ("user.id", "items[0].sku"), bounded in size and depth.
export function extractValues(json: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, path: string, key: string, depth: number) => {
    if (out.length >= MAX_LEAVES || depth > MAX_DEPTH) return;
    if (v === null || typeof v !== "object") {
      if (["string", "number", "boolean"].includes(typeof v) || v === null) out.push({ path, key, value: v as Leaf["value"] });
      return;
    }
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${path}[${i}]`, key, depth + 1));
    else for (const [k, item] of Object.entries(v)) walk(item, path ? `${path}.${k}` : k, k, depth + 1);
  };
  walk(json, "", "", 0);
  return out;
}

// Worth tracking: values unlikely to appear by coincidence.
export function isDistinctive(key: string, value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && (Math.abs(value) >= 100 || /id$/i.test(key));
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return false; // dates repeat across unrelated responses
  if (/^\d+$/.test(v)) return v.length >= 3 || /id$/i.test(key);
  return (v.length >= 6 && /\d/.test(v)) || v.length >= 16;
}

// FNV-1a plus length: a cheap, collision-resistant-enough key that doesn't keep the value.
export function fingerprint(value: unknown): string {
  const s = String(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}:${s.length}`;
}

// Only custom and credential headers carry values worth linking; Accept, Content-Type and friends would
// produce coincidental matches.
const trackHeader = (name: string) => name !== "cookie" && name !== "set-cookie" && (name.startsWith("x-") || isSensitive(name));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const singular = (s: string) => s.replace(/(ies)$/, "y").replace(/s$/, "");

interface Producer {
  reqId: string;
  path: string;
  name: string; // normalized naming hint, e.g. "userid" for user.id
  tabId: number;
  at: number; // when the producing response finished (epoch ms)
  seen: Set<string>;
}

interface Consumed {
  to: string; // where the request used it: path[2], query.userId, header.authorization, body.cart.id
  name: string; // naming hint
  value: string;
}

// Values a request used, with where it used them.
export function consumerValues(url: string, headers: Headers = {}, body?: string): Consumed[] {
  const out: Consumed[] = [];
  const add = (to: string, name: string, value: unknown) => {
    if (isDistinctive(name, value)) out.push({ to, name: norm(name), value: String(value) });
  };
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    segments.forEach((s, i) => add(`path[${i}]`, i ? `${singular(segments[i - 1])}id` : s, s));
    for (const [k, v] of u.searchParams) add(`query.${k}`, k, v);
  } catch {
    // not a URL we can read
  }
  for (const [k, v] of Object.entries(headers)) {
    if (trackHeader(k)) add(`header.${k}`, k, v.replace(/^(Bearer|Token|Basic)\s+/i, ""));
  }
  if (body) {
    try {
      for (const leaf of extractValues(JSON.parse(body))) add(`body.${leaf.path}`, leaf.path.replace(/\[\d+\]/g, ""), leaf.value);
    } catch {
      for (const [k, v] of new URLSearchParams(body)) add(`body.${k}`, k, v);
    }
  }
  return out;
}

// Path segments that are a missing value ("/users/undefined") and the field name they stand for.
function missingSlots(url: string): { to: string; names: string[] }[] {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const slots = segments.flatMap((s, i) => {
      if (!MISSING.has(s) || !i) return [];
      const base = singular(segments[i - 1]);
      return [{ to: `path[${i}]`, names: [norm(base), `${norm(base)}id`] }];
    });
    for (const [k, v] of u.searchParams) if (MISSING.has(v)) slots.push({ to: `query.${k}`, names: [norm(k)] });
    return slots;
  } catch {
    return [];
  }
}

// "user.id" -> "userid", "access_token" -> "accesstoken", "items[0].sku" -> "itemssku"
const nameOf = (path: string) => {
  const parts = path.replace(/\[\d+\]/g, "").split(".");
  const last = parts.at(-1)!;
  return norm(/^id$/i.test(last) && parts.length > 1 ? `${singular(parts.at(-2)!)}id` : last);
};

export class LineageIndex {
  private producers = new Map<string, Producer>();
  // Fields that came back null, by name, so "/users/undefined" can point at the response that lacked the id.
  private nulls = new Map<string, Omit<Producer, "seen">>();

  // Record what a finished response made available.
  add(r: ApiRequest, raw?: RawData, responseHeaders: Headers = {}) {
    const at = r.startedAt + (r.durationMs ?? 0);
    const offer = (path: string, value: unknown) => {
      const fp = fingerprint(value);
      const prev = this.producers.get(fp);
      const seen = prev?.seen ?? new Set<string>();
      seen.add(r.id);
      this.producers.delete(fp); // re-insert: Map order doubles as least-recently-used order
      this.producers.set(fp, { reqId: r.id, path, name: nameOf(path), tabId: r.tabId, at, seen });
      if (this.producers.size > MAX_ENTRIES) this.producers.delete(this.producers.keys().next().value!);
    };
    if (raw?.responseBody) {
      try {
        for (const leaf of extractValues(JSON.parse(raw.responseBody))) {
          if (leaf.value === null) {
            this.nulls.set(nameOf(leaf.path), { reqId: r.id, path: leaf.path, name: nameOf(leaf.path), tabId: r.tabId, at });
            this.nulls.set(norm(leaf.key), { reqId: r.id, path: leaf.path, name: norm(leaf.key), tabId: r.tabId, at });
          } else if (isDistinctive(leaf.key, leaf.value)) offer(`response.${leaf.path}`, leaf.value);
        }
      } catch {
        // not JSON
      }
    }
    for (const [k, v] of Object.entries(responseHeaders)) if (trackHeader(k) && isDistinctive(k, v)) offer(`header.${k}`, v);
  }

  // Which earlier responses supplied the values this request used.
  link(r: ApiRequest, raw?: RawData): Link[] {
    const best = new Map<string, Link>();
    const keep = (l: Link) => {
      const k = `${l.from} ${l.to}`;
      if (!best.has(k) || (best.get(k)!.confidence === "likely" && l.confidence === "certain")) best.set(k, l);
    };
    const url = raw?.url ?? r.url;

    for (const c of consumerValues(url, raw?.requestHeaders ?? r.requestHeaders, raw?.requestBody)) {
      const p = this.producers.get(fingerprint(c.value));
      if (!p || p.reqId === r.id || p.at > r.startedAt + 50) continue;
      const named = p.name === c.name || p.name.endsWith(c.name) || c.name.endsWith(p.name);
      if (p.seen.size > COMMON_AFTER && !named) continue;
      keep({ from: p.reqId, fromPath: p.path, to: c.to, confidence: named || c.value.length >= 20 ? "certain" : "likely" });
    }
    for (const slot of missingSlots(url)) {
      const n = slot.names.map((name) => this.nulls.get(name)).find((x) => x && x.at <= r.startedAt + 50);
      if (n) keep({ from: n.reqId, fromPath: `response.${n.path}`, to: slot.to, confidence: "likely", missing: true });
    }
    return [...best.values()];
  }

  clear() {
    this.producers.clear();
    this.nulls.clear();
  }
}

export interface Trace {
  chain: ApiRequest[]; // ancestors oldest first, then the request itself
  culprit?: ApiRequest;
  reason?: string;
}

// Walk links upstream and pick the most likely root cause.
export function traceBack(r: ApiRequest, history: ApiRequest[]): Trace {
  const byId = new Map(history.map((h) => [h.id, h]));
  const ancestors = new Map<string, ApiRequest>();
  let frontier = [r];
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const next: ApiRequest[] = [];
    for (const node of frontier) {
      for (const l of node.links ?? []) {
        const from = byId.get(l.from);
        if (from && !ancestors.has(from.id) && from.id !== r.id) {
          ancestors.set(from.id, from);
          next.push(from);
        }
      }
    }
    frontier = next;
  }
  const chain = [...[...ancestors.values()].sort((a, b) => a.startedAt - b.startedAt), r];
  const describe = (x: ApiRequest) => `${x.method} ${pathOf(x.url)}`;

  // 1. An ancestor failed: everything after it inherited a bad value.
  const failed = chain.slice(0, -1).find(isFailure);
  if (failed) return { chain, culprit: failed, reason: `${describe(failed)} failed earlier in this chain.` };

  // 2. A value was missing because an earlier response returned null.
  const missing = (r.links ?? []).find((l) => l.missing && byId.has(l.from));
  if (missing) {
    const src = byId.get(missing.from)!;
    return { chain, culprit: src, reason: `${describe(src)} returned null for ${missing.fromPath.replace(/^response\./, "")}, so this URL was built without it.` };
  }

  // 3. A sibling that used the same earlier response failed first (e.g. the token refresh).
  const sources = new Set(chain.slice(0, -1).map((a) => a.id));
  const sibling = history
    .filter((h) => h.id !== r.id && h.startedAt < r.startedAt && isFailure(h) && (h.links ?? []).some((l) => sources.has(l.from)))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (sibling && isFailure(r)) {
    return {
      chain: [...chain.slice(0, -1), sibling, r].sort((a, b) => a.startedAt - b.startedAt),
      culprit: sibling,
      reason: `${describe(sibling)} used the same earlier response and failed just before this call.`
    };
  }
  return { chain };
}

// Every call connected to this one by links, upstream (what fed it) and downstream (what it fed).
export function relatedIds(r: ApiRequest, history: ApiRequest[]): Set<string> {
  const ids = new Set(traceBack(r, history).chain.map((x) => x.id));
  let frontier = new Set([r.id]);
  for (let depth = 0; depth < 5 && frontier.size; depth++) {
    const next = new Set<string>();
    for (const h of history) {
      if (!ids.has(h.id) && (h.links ?? []).some((l) => frontier.has(l.from))) {
        ids.add(h.id);
        next.add(h.id);
      }
    }
    frontier = next;
  }
  return ids;
}

function pathOf(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
