// The shape of a JSON body: field path -> type, with array items folded together ("items[].id").
// Used to compare a failing response with the last success, and to spot contract drift.
import type { ShapeChange } from "./types";
import { extractValues } from "./lineage";

export type Shape = Map<string, string>;

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function shapeOf(json: unknown): Shape {
  const shape: Shape = new Map();
  for (const leaf of extractValues(json)) {
    const path = leaf.path.replace(/\[\d+\]/g, "[]");
    const prev = shape.get(path);
    const t = typeOf(leaf.value);
    // Items in an array may differ (e.g. some null); keep every type seen.
    shape.set(path, prev && prev !== t && !prev.split("|").includes(t) ? `${prev}|${t}` : (prev ?? t));
  }
  return shape;
}

export function parseShape(text?: string): Shape | undefined {
  if (!text) return;
  try {
    return shapeOf(JSON.parse(text));
  } catch {
    return;
  }
}

export type { ShapeChange };

// Structural differences only: fields missing, added, or of another type (including value -> null).
// Different values of the same type (ids, timestamps) are expected and left out.
export function shapeDiff(now: Shape, before: Shape, limit = 20): ShapeChange[] {
  const out: ShapeChange[] = [];
  for (const path of new Set([...before.keys(), ...now.keys()])) {
    const a = now.get(path) ?? "—";
    const b = before.get(path) ?? "—";
    if (a !== b) out.push({ path, now: a, before: b });
  }
  // Missing fields first: they are what usually breaks the UI.
  return out.sort((x, y) => Number(y.now === "—") - Number(x.now === "—")).slice(0, limit);
}

const MIN_SAMPLES = 2; // successes to learn from before judging a response
const MAX_ENDPOINTS = 300;

// Learns each endpoint's usual response shape from its successes, and flags a success that drifts from it:
// a field present in every earlier success is now missing, or a field has a type never seen before (e.g.
// null). Optional fields and array items that come and go are left alone, so the alerts stay quiet.
export class ShapeBook {
  private book = new Map<string, { n: number; fields: Map<string, { seen: number; types: Set<string> }> }>();

  check(endpoint: string, shape: Shape): ShapeChange[] {
    const learned = this.book.get(endpoint);
    const changes: ShapeChange[] = [];
    if (learned && learned.n >= MIN_SAMPLES) {
      for (const [path, f] of learned.fields) {
        // Fields of array items vanish whenever the array is empty, which is normal.
        if (f.seen === learned.n && !shape.has(path) && !path.includes("[]")) {
          changes.push({ path, now: "—", before: [...f.types].join("|") });
        }
      }
      for (const [path, types] of shape) {
        const f = learned.fields.get(path);
        const fresh = types.split("|").filter((t) => f && !f.types.has(t));
        if (f && f.seen === learned.n && fresh.length) changes.push({ path, now: types, before: [...f.types].join("|") });
      }
    }
    this.learn(endpoint, shape);
    // Missing first, and keep the list short: the first few fields tell the story.
    return changes.sort((a, b) => Number(b.now === "—") - Number(a.now === "—")).slice(0, 10);
  }

  private learn(endpoint: string, shape: Shape) {
    const entry = this.book.get(endpoint) ?? { n: 0, fields: new Map() };
    entry.n++;
    for (const [path, types] of shape) {
      const f = entry.fields.get(path) ?? { seen: 0, types: new Set<string>() };
      f.seen++;
      types.split("|").forEach((t) => f.types.add(t));
      entry.fields.set(path, f);
    }
    this.book.delete(endpoint); // re-insert: Map order doubles as least-recently-used order
    this.book.set(endpoint, entry);
    if (this.book.size > MAX_ENDPOINTS) this.book.delete(this.book.keys().next().value!);
  }

  clear() {
    this.book.clear();
  }
}
