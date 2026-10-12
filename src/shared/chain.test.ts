import { describe, expect, it } from "vitest";
import type { Link } from "./types";
import { applyLinks, changesData, placeValue, valueAt, type Output, type Step } from "./chain";

const link = (from: string, fromPath: string, to: string, extra: Partial<Link> = {}): Link => ({ from, fromPath, to, confidence: "certain", ...extra });
const step = (p: Partial<Step>): Step => ({ id: "s", label: "", method: "GET", url: "http://a.test/", headers: {}, links: [], ...p });

describe("reading values from a fresh response", () => {
  const out: Output = { body: '{"access_token":"new-tok","user":{"id":77,"tags":["a"]},"items":[{"sku":"X9"}],"none":null}', headers: { "x-csrf-token": "csrf-2" } };
  it.each([
    ["response.access_token", "new-tok"],
    ["response.user.id", "77"],
    ["response.items[0].sku", "X9"],
    ["header.x-csrf-token", "csrf-2"],
    ["response.none", undefined],
    ["response.user", undefined], // an object isn't a value we can place
    ["response.missing.deep", undefined]
  ])("%s", (path, expected) => expect(valueAt(out, path)).toBe(expected));
});

describe("placing a value in a request", () => {
  it("replaces a path segment, a query value, a header (keeping Bearer) and a JSON field (keeping its type)", () => {
    const s = step({
      url: "http://a.test/users/undefined/orders?cart=c1",
      headers: { authorization: "Bearer old" },
      body: '{"cart":{"id":5},"note":"x"}'
    });
    expect(placeValue(s, "path[1]", "77")!.url).toBe("http://a.test/users/77/orders?cart=c1");
    expect(placeValue(s, "query.cart", "c2")!.url).toBe("http://a.test/users/undefined/orders?cart=c2");
    expect(placeValue(s, "header.authorization", "new-tok")!.headers.authorization).toBe("Bearer new-tok");
    expect(JSON.parse(placeValue(s, "body.cart.id", "9")!.body!)).toEqual({ cart: { id: 9 }, note: "x" });
    expect(placeValue(step({ body: "a=1&b=2" }), "body.b", "3")!.body).toBe("a=1&b=3");
    expect(placeValue(s, "path[9]", "x")).toBeUndefined();
  });
});

describe("applying a chain's links", () => {
  it("carries fresh values forward and reports what it couldn't fill", () => {
    const orders = step({
      url: "http://a.test/users/4821/orders",
      headers: { authorization: "Bearer expired" },
      links: [
        link("login", "response.access_token", "header.authorization"),
        link("me", "response.user.id", "path[1]"),
        link("cart", "response.cartId", "query.cart"),
        link("not-replayed", "response.x", "query.y")
      ]
    });
    const outputs = new Map<string, Output>([
      ["login", { body: '{"access_token":"fresh"}', headers: {} }],
      ["me", { body: '{"user":{"id":99}}', headers: {} }],
      ["cart", { body: '{"error":"down"}', headers: {} }]
    ]);
    const { step: next, applied } = applyLinks(orders, outputs);
    expect(next.headers.authorization).toBe("Bearer fresh");
    expect(next.url).toBe("http://a.test/users/99/orders");
    expect(applied.map((a) => [a.link.from, a.ok])).toEqual([["login", true], ["me", true], ["cart", false]]);
  });

  it("fills a value that was missing the first time", () => {
    const s = step({ url: "http://a.test/api/users/undefined", links: [link("profile", "response.user", "path[2]", { missing: true })] });
    const { step: next } = applyLinks(s, new Map([["profile", { body: '{"user":{"id":5}}', headers: {} }]]));
    expect(next.url).toBe("http://a.test/api/users/5");
  });

  it("knows which steps change data", () => {
    expect(changesData(step({ method: "POST" }))).toBe(true);
    expect(changesData(step({ method: "get" }))).toBe(false);
  });
});
