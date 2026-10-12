import { describe, expect, it } from "vitest";
import type { ApiRequest } from "./types";
import { parseShape, shapeDiff, shapeOf } from "./shape";
import { relatedIds } from "./lineage";

describe("response shape", () => {
  it("folds array items together and records each field's type", () => {
    const shape = shapeOf({ user: { id: 1, name: "Ada" }, items: [{ sku: "A1" }, { sku: null }] });
    expect(Object.fromEntries(shape)).toEqual({ "user.id": "number", "user.name": "string", "items[].sku": "string|null" });
    expect(parseShape("not json")).toBeUndefined();
  });

  it("reports structural changes only, missing fields first", () => {
    const before = shapeOf({ total: 10, user: { id: 1 }, createdAt: "2026-01-01" });
    const now = shapeOf({ user: null, createdAt: "2026-10-12", extra: true });
    expect(shapeDiff(now, before)).toEqual([
      { path: "total", now: "—", before: "number" },
      { path: "user.id", now: "—", before: "number" },
      { path: "user", now: "null", before: "—" },
      { path: "extra", now: "boolean", before: "—" }
    ]);
  });
});

describe("related calls", () => {
  it("collects what fed a call and what it fed, but not unrelated calls", () => {
    const r = (id: string, from?: string): ApiRequest => ({
      id, tabId: 1, method: "GET", url: `http://a.test/${id}`, startedAt: id.charCodeAt(0), status: 200,
      links: from ? [{ from, fromPath: "response.x", to: "path[0]", confidence: "certain" }] : []
    });
    const history = [r("a"), r("b", "a"), r("c", "b"), r("z")];
    expect([...relatedIds(history[1], history)].sort()).toEqual(["a", "b", "c"]);
  });
});
