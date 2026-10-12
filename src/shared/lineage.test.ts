import { describe, expect, it } from "vitest";
import type { ApiRequest, RawData } from "./types";
import { LineageIndex, extractValues, fingerprint, isDistinctive, traceBack } from "./lineage";
import { diagnose } from "./diagnostics";
import { callSiteOf } from "./capture";

const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (exp: number) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "4821", exp })}.sig`;

// Replays captures through the index in order, the way background.ts does, and returns the records.
function session(steps: { id: string; method?: string; url: string; status: number; at: number; headers?: Record<string, string>; body?: string; response?: unknown }[]) {
  const idx = new LineageIndex();
  const records: ApiRequest[] = [];
  const raws: Record<string, RawData> = {};
  for (const s of steps) {
    const r: ApiRequest = { id: s.id, tabId: 1, method: s.method ?? "GET", url: s.url, startedAt: s.at, durationMs: 20, status: s.status };
    const raw: RawData = { url: s.url, requestHeaders: s.headers, requestBody: s.body, responseBody: s.response === undefined ? undefined : JSON.stringify(s.response) };
    r.links = idx.link(r, raw);
    idx.add(r, raw);
    records.push(r);
    raws[r.id] = raw;
  }
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  return { records, byId, raws, history: [...records].reverse() };
}

const T0 = 1_760_000_000_000;
const loginResponse = (token: string) => ({ access_token: token, refresh_token: "rt_9f8e7d6c5b4a", user: { id: 4821 } });

describe("linking values between calls", () => {
  const token = jwt(T0 / 1000 + 3600);
  const s = session([
    { id: "login", method: "POST", url: "http://app.test/api/session/login", status: 200, at: T0, body: '{"username":"ada"}', response: loginResponse(token) },
    { id: "me", url: "http://app.test/api/session/me", status: 200, at: T0 + 100, headers: { authorization: `Bearer ${token}` }, response: { user: { id: 4821, name: "Ada" } } },
    { id: "orders", url: "http://app.test/api/session/users/4821/orders", status: 200, at: T0 + 200, headers: { authorization: `Bearer ${token}`, accept: "application/json" }, response: { orders: [] } }
  ]);

  it("links a token to the response that issued it", () => {
    expect(s.byId.me.links).toEqual([{ from: "login", fromPath: "response.access_token", to: "header.authorization", confidence: "certain" }]);
  });

  it("links an id in the URL path to the response field it came from", () => {
    expect(s.byId.orders.links).toContainEqual({ from: "me", fromPath: "response.user.id", to: "path[3]", confidence: "certain" });
    expect(s.byId.orders.links!.some((l) => l.to === "header.accept")).toBe(false);
  });

  it("traces the healthy chain without blaming anyone", () => {
    const t = traceBack(s.byId.orders, s.history);
    expect(t.chain.map((r) => r.id)).toEqual(["login", "me", "orders"]);
    expect(t.culprit).toBeUndefined();
  });

  it("stores only field paths in links, never values", () => {
    expect(JSON.stringify(s.records.map((r) => r.links))).not.toContain(token);
    expect(JSON.stringify(s.records.map((r) => r.links))).not.toContain("4821");
  });
});

describe("finding the culprit", () => {
  it("blames the failed token refresh for a later 401, and spots the expired token", () => {
    const expired = jwt(T0 / 1000 + 1);
    const s = session([
      { id: "login", method: "POST", url: "http://app.test/api/session/login", status: 200, at: T0, response: loginResponse(expired) },
      { id: "refresh", method: "POST", url: "http://app.test/api/session/refresh", status: 500, at: T0 + 1500, body: '{"refresh_token":"rt_9f8e7d6c5b4a"}', response: { error: "refresh store unavailable" } },
      { id: "orders", url: "http://app.test/api/session/users/4821/orders", status: 401, at: T0 + 1600, headers: { authorization: `Bearer ${expired}` } }
    ]);
    expect(s.byId.refresh.links).toEqual([{ from: "login", fromPath: "response.refresh_token", to: "body.refresh_token", confidence: "certain" }]);

    const t = traceBack(s.byId.orders, s.history);
    expect(t.culprit?.id).toBe("refresh");
    expect(t.chain.map((r) => r.id)).toEqual(["login", "refresh", "orders"]);

    const titles = diagnose(s.byId.orders, { raw: s.raws.orders, history: s.history }).map((d) => d.title);
    expect(titles[0]).toBe("Likely culprit: POST /api/session/refresh");
    expect(titles).toContain("Token expired");
  });

  it("blames the response that returned null for a URL built with 'undefined'", () => {
    const s = session([
      { id: "profile", url: "http://app.test/api/profile", status: 200, at: T0, response: { user: null } },
      { id: "user", url: "http://app.test/api/users/undefined", status: 404, at: T0 + 100 }
    ]);
    expect(s.byId.user.links).toEqual([{ from: "profile", fromPath: "response.user", to: "path[2]", confidence: "likely", missing: true }]);
    expect(traceBack(s.byId.user, s.history).culprit?.id).toBe("profile");
    const titles = diagnose(s.byId.user, { history: s.history }).map((d) => d.title);
    expect(titles).toEqual(expect.arrayContaining(["Likely culprit: GET /api/profile", "URL built from a missing value", "Resource not found"]));
  });

  it("blames an earlier call in the chain that failed", () => {
    const s = session([
      { id: "cart", method: "POST", url: "http://app.test/api/cart", status: 503, at: T0, response: { cartId: "cart_7f3a91" } },
      { id: "checkout", method: "POST", url: "http://app.test/api/checkout", status: 400, at: T0 + 100, body: '{"cartId":"cart_7f3a91"}' }
    ]);
    expect(traceBack(s.byId.checkout, s.history).culprit?.id).toBe("cart");
  });
});

describe("avoiding false links", () => {
  it("ignores small numbers, dates and booleans", () => {
    const s = session([
      { id: "a", url: "http://app.test/api/list", status: 200, at: T0, response: { page: 1, total: 42, created: "2026-10-12T08:00:00Z", ok: true } },
      { id: "b", url: "http://app.test/api/list?page=1&since=2026-10-12T08:00:00Z", status: 200, at: T0 + 100 }
    ]);
    expect(s.byId.b.links).toEqual([]);
  });

  it("does not link on a value that appears in many unrelated responses", () => {
    const steps = [1, 2, 3, 4, 5].map((i) => ({ id: `r${i}`, url: `http://app.test/api/thing${i}`, status: 200, at: T0 + i, response: { version: "v2-2024" } }));
    const s = session([...steps, { id: "use", url: "http://app.test/api/build?build=v2-2024", status: 200, at: T0 + 100 }]);
    expect(s.byId.use.links).toEqual([]);
  });

  it("only links to responses that finished before the request started", () => {
    const s = session([
      { id: "late", url: "http://app.test/api/a", status: 200, at: T0 + 1000, response: { orderId: "ord_5512aa" } },
      { id: "early", url: "http://app.test/api/orders/ord_5512aa", status: 200, at: T0 }
    ]);
    expect(s.byId.early.links).toEqual([]);
  });
});

describe("helpers", () => {
  it("bounds extraction and fingerprints without keeping the value", () => {
    const big = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i]));
    expect(extractValues(big)).toHaveLength(2000);
    expect(extractValues({ a: { b: [{ c: 1 }] } })).toEqual([{ path: "a.b[0].c", key: "c", value: 1 }]);
    expect(fingerprint("secret-token-123")).not.toContain("secret");
    expect(fingerprint(4821)).toBe(fingerprint("4821"));
  });

  it("decides what is distinctive", () => {
    expect(isDistinctive("id", 7)).toBe(true);
    expect(isDistinctive("count", 7)).toBe(false);
    expect(isDistinctive("name", "Ada")).toBe(false);
    expect(isDistinctive("sku", "AB-1234")).toBe(true);
  });

  it("finds the app's own call site behind library frames", () => {
    const stack = {
      callFrames: [{ functionName: "dispatchXhrRequest", url: "http://localhost:5173/node_modules/.vite/deps/axios.js?v=1", lineNumber: 10 }],
      parent: { callFrames: [{ functionName: "loadOrders", url: "http://localhost:5173/src/api/orders.ts?t=123", lineNumber: 41 }] }
    };
    expect(callSiteOf(stack)).toBe("src/api/orders.ts:42 loadOrders");
    expect(callSiteOf(undefined)).toBeUndefined();
  });
});
