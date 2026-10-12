import { describe, expect, it } from "vitest";
import type { ApiRequest } from "./types";
import { ShapeBook, parseShape, shapeDiff, shapeOf } from "./shape";
import { diagnose } from "./diagnostics";
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

describe("contract drift", () => {
  const ok = { total: 42, user: { id: 1, name: "Ada" }, items: [{ sku: "A1" }], coupon: "X1" };
  const learn = (book: ShapeBook, ...bodies: unknown[]) => bodies.map((b) => book.check("GET a.test/cart", shapeOf(b)));

  it("says nothing until it has seen a couple of successes", () => {
    const book = new ShapeBook();
    expect(learn(book, ok, { user: null })).toEqual([[], []]);
  });

  it("flags a field that was always there and is now missing or null", () => {
    const book = new ShapeBook();
    learn(book, ok, ok);
    expect(book.check("GET a.test/cart", shapeOf({ ...ok, total: undefined, user: { id: null, name: "Ada" } }))).toEqual([
      { path: "total", now: "—", before: "number" },
      { path: "user.id", now: "null", before: "number" }
    ]);
  });

  it("stays quiet about optional fields, empty arrays and new fields", () => {
    const book = new ShapeBook();
    const { coupon: _coupon, ...withoutCoupon } = ok; // eslint-disable-line @typescript-eslint/no-unused-vars
    learn(book, ok, withoutCoupon, ok); // coupon is optional: absent once
    expect(book.check("GET a.test/cart", shapeOf({ ...withoutCoupon, items: [], extra: true }))).toEqual([]);
  });

  it("explains drift in the diagnosis", () => {
    const r = { id: "c", tabId: 1, method: "GET", url: "http://a.test/cart", startedAt: 0, status: 200, drift: [{ path: "total", now: "—", before: "number" }] };
    const d = diagnose(r).find((x) => x.title === "Response shape changed");
    expect(d?.explanation).toContain("total is missing");
  });
});
