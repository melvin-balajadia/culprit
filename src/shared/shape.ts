// The shape of a JSON body: field path -> type, with array items folded together ("items[].id").
// Used to compare a failing response with the last success, and (later) to spot contract drift.
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

export interface ShapeChange {
  path: string;
  now: string; // type in this response, or "—" when the field is missing
  before: string; // type in the reference response
}

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
