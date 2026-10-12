import { describe, expect, it } from "vitest";
import type { ApiRequest } from "./types";
import type { Step } from "./chain";
import { toHar, toPostman, toVitest, varName } from "./export";

const steps: Step[] = [
  {
    id: "login",
    label: "POST /api/login",
    method: "POST",
    url: "http://localhost:3000/api/login",
    headers: { "content-type": "application/json" },
    body: '{"username":"ada","password":"hunter2"}',
    origin: "http://localhost:3000",
    links: []
  },
  {
    id: "orders",
    label: "GET /api/users/4821/orders",
    method: "GET",
    url: "http://localhost:3000/api/users/4821/orders?api_key=k-secret-99",
    headers: { authorization: "Bearer stale-tok-123456" },
    links: [
      { from: "login", fromPath: "response.access_token", to: "header.authorization", confidence: "certain" },
      { from: "login", fromPath: "response.user.id", to: "path[2]", confidence: "certain" }
    ]
  }
];
const SECRETS = ["hunter2", "stale-tok-123456", "k-secret-99"];

describe("variable names", () => {
  it.each([
    ["response.access_token", "accessToken"],
    ["response.user.id", "userId"],
    ["header.x-csrf-token", "xCsrfToken"],
    ["response.items[0].sku", "sku"]
  ])("%s -> %s", (path, name) => expect(varName(path)).toBe(name));
});

describe("Postman collection", () => {
  const out = toPostman(steps, "orders chain");
  const c = JSON.parse(out);

  it("chains values through collection variables set by test scripts", () => {
    expect(c.info.schema).toContain("v2.1.0");
    expect(c.item[0].event[0].script.exec).toEqual([
      'pm.collectionVariables.set("accessToken", pm.response.json()["access_token"]);',
      'pm.collectionVariables.set("userId", pm.response.json()["user"]["id"]);'
    ]);
    expect(c.item[1].request.url).toBe("{{baseUrl}}/api/users/{{userId}}/orders?api_key={{apiKey}}");
    expect(c.item[1].request.header).toEqual([{ key: "authorization", value: "Bearer {{accessToken}}" }]);
    expect(c.variable.map((v: { key: string }) => v.key).sort()).toEqual(["accessToken", "apiKey", "baseUrl", "password", "userId"]);
  });

  it("keeps the app's Origin and turns secrets into variables", () => {
    expect(c.item[0].request.header).toContainEqual({ key: "origin", value: "http://localhost:3000" });
    expect(JSON.parse(c.item[0].request.body.raw)).toEqual({ username: "ada", password: "{{password}}" });
    for (const s of SECRETS) expect(out).not.toContain(s);
  });
});

describe("Vitest test", () => {
  const out = toVitest(steps, "orders chain", [200, 401]);

  it("reads values from earlier responses and expects the failing call to pass", () => {
    expect(out).toContain('const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";');
    expect(out).toContain("const s1 = await r1.clone().json();");
    expect(out).toContain("const r2 = await fetch(`${API_BASE_URL}/api/users/${s1?.user?.id}/orders?api_key=${process.env.API_KEY ?? \"\"}`");
    expect(out).toContain('"authorization": `Bearer ${s1?.access_token}`');
    expect(out).toContain('"password": process.env.PASSWORD ?? ""');
    expect(out).toContain('expect(r1.status).toBe(200);');
    expect(out).toContain('expect(r2.ok, "this call returned 401 when it was captured").toBe(true);');
    for (const s of SECRETS) expect(out).not.toContain(s);
  });

  it("is valid JavaScript", () => {
    // Parsing as a function body checks the syntax without running it.
    expect(() => new Function(out.replace(/^import .*$/m, ""))).not.toThrow();
  });
});

describe("HAR", () => {
  it("exports masked entries in HAR 1.2", () => {
    const r: ApiRequest = {
      id: "a", tabId: 1, method: "POST", url: "http://localhost:3000/api/login", startedAt: 0, durationMs: 12, status: 200,
      requestHeaders: { "content-type": "application/json", authorization: "REDACTED" }, responseHeaders: { "content-type": "application/json" }
    };
    const har = JSON.parse(toHar([r], { a: { requestBody: '{"password":"hunter2"}', responseBody: '{"token":"eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.x"}' } }, "0.1.0"));
    expect(har.log.version).toBe("1.2");
    expect(har.log.entries[0].request.postData.text).toContain("REDACTED");
    expect(JSON.stringify(har)).not.toContain("hunter2");
    expect(JSON.stringify(har)).not.toContain("eyJzdWIiOiIxIn0");
  });
});
