import { describe, expect, it } from "vitest";
import type { ApiRequest } from "./types";
import { diagnose } from "./diagnostics";
import {
  REDACTED,
  compare,
  exportCurl,
  buildReport,
  endpointKey,
  findBaseline,
  formatJson,
  isFailure,
  parseHeaderLines,
  redactBody,
  redactHeaders,
  redactUrl,
  scrub,
  toCurl
} from "./http";

let n = 0;
const req = (p: Partial<ApiRequest>): ApiRequest => ({
  id: String(n++),
  tabId: 1,
  url: "https://api.test/users/42",
  method: "GET",
  startedAt: 0,
  ...p
});
const titles = (r: ApiRequest, base?: ApiRequest) => diagnose(r, { baseline: base }).map((d) => d.title);

describe("diagnose", () => {
  it.each([
    [400, "Bad request"],
    [401, "Authentication required"],
    [403, "Access forbidden"],
    [404, "Resource not found"],
    [429, "Rate limit reached"],
    [500, "Server error"],
    [599, "Server-side failure"]
  ])("status %i", (status, title) => {
    expect(titles(req({ status }))).toContain(title);
  });

  it("is quiet for a normal JSON success", () => {
    expect(diagnose(req({ status: 200, responseHeaders: { "content-type": "application/json" } }))).toEqual([]);
  });

  it("flags HTML returned from an API call", () => {
    expect(titles(req({ status: 200, responseHeaders: { "content-type": "text/html" } }))).toContain("HTML returned instead of data");
  });

  it("spots a 401 with no credentials sent", () => {
    expect(titles(req({ status: 401, requestHeaders: { accept: "*/*" } }))).toContain("No credentials were sent");
    expect(titles(req({ status: 401, requestHeaders: { authorization: REDACTED } }))).not.toContain("No credentials were sent");
  });

  it("reads Retry-After and Allow", () => {
    expect(titles(req({ status: 429, responseHeaders: { "retry-after": "30" } }))).toContain("Retry-After");
    expect(redactHeaders({ "www-authenticate": "Bearer" })).toEqual({ "www-authenticate": "Bearer" });
    expect(titles(req({ status: 405, responseHeaders: { allow: "GET" } }))).toContain("Allowed methods");
  });

  it("names network failures without inventing a status", () => {
    const r = req({ error: "net::ERR_CONNECTION_REFUSED" });
    expect(titles(r)).toEqual(["Server not reachable"]);
    expect(r.status).toBeUndefined();
    expect(titles(req({ error: "net::ERR_FAILED", corsError: "MissingAllowOriginHeader" }))).toEqual(["Blocked by CORS"]);
    expect(titles(req({ error: "Failed to fetch" }))).toEqual(["Request failed before a response"]);
    expect(titles(req({ error: "Timed out after 30 s" }))).toEqual(["Timed out"]);
  });

  it("flags slow calls", () => {
    expect(titles(req({ status: 200, durationMs: 2500 }))).toContain("Slow response");
  });

  it("names headers the last success sent but this failure did not", () => {
    const ok = req({ status: 200, requestHeaders: { authorization: REDACTED, "x-request-id": "a" } });
    const bad = req({ status: 401, requestHeaders: { "x-request-id": "b" } });
    const missing = diagnose(bad, { baseline: ok }).find((d) => d.title === "Headers missing vs. last success");
    expect(missing?.explanation).toContain("authorization");
    expect(missing?.explanation).not.toContain("x-request-id"); // volatile, ignored
  });
});

describe("comparison", () => {
  it("treats numeric and uuid path segments as the same endpoint", () => {
    expect(endpointKey("get", "https://a.io/users/42/posts")).toBe(endpointKey("GET", "https://a.io/users/7/posts"));
    expect(endpointKey("GET", "https://a.io/o/3f2b8c1e-1111-4a2b-9c3d-0123456789ab")).toBe("GET a.io/o/:id");
    expect(endpointKey("GET", "https://a.io/users")).not.toBe(endpointKey("POST", "https://a.io/users"));
  });

  it("picks the most recent success for the same endpoint", () => {
    const failed = req({ status: 500, url: "https://api.test/users/1" });
    const recent = req({ status: 200, url: "https://api.test/users/2" });
    const older = req({ status: 200, url: "https://api.test/users/3" });
    const other = req({ status: 200, url: "https://api.test/orders/1" });
    expect(findBaseline(failed, [failed, other, recent, older])).toBe(recent);
    expect(findBaseline(failed, [failed, other])).toBeUndefined();
  });

  it("does not count cancellations as failures", () => {
    expect(isFailure(req({ error: "net::ERR_ABORTED" }))).toBe(false);
    expect(isFailure(req({ status: 404 }))).toBe(true);
  });
});

describe("redaction", () => {
  it("masks sensitive headers, query params, and body fields", () => {
    expect(redactHeaders({ authorization: "Bearer x", cookie: "s=1", "x-api-key": "k", accept: "*/*" })).toEqual({
      authorization: REDACTED, cookie: REDACTED, "x-api-key": REDACTED, accept: "*/*"
    });
    expect(redactUrl("https://a.io/x?api_key=secret&page=2")).toBe(`https://a.io/x?api_key=${REDACTED}&page=2`);
    const body = JSON.parse(redactBody('{"user":{"email":"a@b.c","password":"hunter2"},"refreshToken":"t"}'));
    expect(body).toEqual({ user: { email: "a@b.c", password: REDACTED }, refreshToken: REDACTED });
    expect(redactBody("username=ada&password=hunter2")).toBe(`username=ada&password=${REDACTED}`);
    expect(redactBody("<xml>secret</xml>")).not.toContain("secret");
  });

  it("keeps secrets out of the shareable report", () => {
    const failed = req({ status: 401, url: "https://api.test/me?token=abc123", requestHeaders: redactHeaders({ authorization: "Bearer abc123" }) });
    const ok = req({ status: 200, url: "https://api.test/me?token=zzz999", requestHeaders: redactHeaders({ authorization: "Bearer zzz999" }) });
    const report = buildReport(failed, diagnose(failed, { baseline: ok }), ok, {
      requestHeaders: { authorization: "Bearer abc123" },
      requestBody: '{"password":"hunter2"}',
      responseBody: '{"error":"bad token","token":"abc123"}'
    });
    for (const secret of ["abc123", "zzz999", "hunter2"]) expect(report).not.toContain(secret);
    expect(report).toContain("bad token");
  });
});

describe("helpers", () => {
  it("formats JSON and reports parse errors", () => {
    expect(formatJson('{"a":1}').pretty).toBe('{\n  "a": 1\n}');
    expect(formatJson("{oops", "application/json").error).toBeTruthy();
    expect(formatJson("plain text", "text/plain")).toEqual({});
  });

  it("parses header lines and builds a shell-safe cURL", () => {
    expect(parseHeaderLines("Accept: a\n\nX-Time: 10:30\nbad line")).toEqual({ accept: "a", "x-time": "10:30" });
    expect(toCurl("POST", "https://a.io/x", { "content-type": "application/json" }, `{"n":"O'Brien"}`)).toBe(
      `curl -X 'POST' 'https://a.io/x' \\\n  -H 'content-type: application/json' \\\n  --data-raw '{"n":"O'\\''Brien"}'`
    );
  });
});

describe("server-side CORS rejection", () => {
  it("names a CORS rejection hidden behind a 500", () => {
    const r = req({ status: 500, requestHeaders: { origin: "chrome-extension://abc" } });
    const diag = diagnose(r, { responseBody: '{"message":"Internal Server Error","error":"Error: Not allowed by CORS"}' })[0];
    expect(diag.title).toBe("Rejected by the server's CORS check");
    expect(diag.explanation).toContain("chrome-extension://abc");
    expect(titles(req({ status: 500 }))).not.toContain("Rejected by the server's CORS check");
  });
});

describe("review fixes", () => {
  it("masks credentials in the URL and secrets recognised by value", () => {
    expect(redactUrl("https://ada:hunter2@a.io/x")).not.toContain("hunter2");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    expect(scrub(`{"user":{"jwtish":"${jwt}"}} Authorization: Bearer abcdef123456`)).toBe(
      `{"user":{"jwtish":"${REDACTED}"}} Authorization: Bearer ${REDACTED}`
    );
    expect(redactHeaders({ "x-access-key": "k", "x-cache": "HIT" })).toEqual({ "x-access-key": REDACTED, "x-cache": "HIT" });
  });

  it("only flags real server CORS rejections", () => {
    const cors = "Rejected by the server's CORS check";
    expect(titles(req({ status: 404 }))).not.toContain(cors);
    expect(diagnose(req({ status: 404 }), { responseBody: '{"error":"Cannot GET /cors-test"}' }).map((d) => d.title)).not.toContain(cors);
    expect(diagnose(req({ status: 403 }), { responseBody: "Invalid CORS request" }).map((d) => d.title)).toContain(cors);
  });

  it("does not claim missing credentials for tester calls, which send cookies implicitly", () => {
    expect(titles(req({ tabId: -1, status: 401, requestHeaders: {} }))).not.toContain("No credentials were sent");
  });

  it("does not call a cancelled or timed-out request slow", () => {
    expect(titles(req({ error: "net::ERR_ABORTED", durationMs: 30_000 }))).not.toContain("Slow response");
  });
});

describe("second review fixes", () => {
  it("quotes the method so a hostile page can't inject shell commands into Copy cURL", () => {
    const curl = toCurl("GET&rm$IFS-rf$IFS$HOME&", "https://a.io/", {});
    expect(curl.startsWith("curl -X 'GET&rm$IFS-rf$IFS$HOME&' ")).toBe(true);
    expect(toCurl("HEAD", "https://a.io/", {})).toBe("curl -I 'https://a.io/'");
  });

  it("leaves an unmaskable body out of the shareable cURL instead of posting a placeholder", () => {
    const curl = exportCurl("POST", "https://a.io/x?token=t1", { authorization: "Bearer abcdefghij" }, "<xml>secret</xml>");
    expect(curl.split("\n")[0]).toMatch(/^# request body left out/);
    expect(curl).not.toContain("--data-raw");
    for (const secret of ["t1", "abcdefghij", "secret"]) expect(curl).not.toContain(secret);
  });

  it("covers more secret names without hiding harmless ones", () => {
    const h = redactHeaders({ "ocp-apim-subscription-key": "k", "x-functions-key": "k", author: "ada", authors: "x", "author_id": "1", accept: "x" });
    expect(h).toEqual({ "ocp-apim-subscription-key": REDACTED, "x-functions-key": REDACTED, author: "ada", authors: "x", "author_id": "1", accept: "x" });
    expect(JSON.parse(redactBody('{"pwd":"p","access":"a","refresh":"r","sig":"s","private_key":"k","name":"n"}'))).toEqual({
      pwd: REDACTED, access: REDACTED, refresh: REDACTED, sig: REDACTED, private_key: REDACTED, name: "n"
    });
  });

  it("does not treat binary notes or bracketed logs as broken JSON", () => {
    expect(formatJson("[binary response, ~120 bytes]", "image/png")).toEqual({});
    expect(formatJson("[INFO] started", "text/plain")).toEqual({});
    expect(formatJson('[{"a":1}]').pretty).toBeDefined(); // no content-type: still sniffed
  });

  it("ignores browser-added headers when comparing captures from different modes", () => {
    const a = req({ status: 500, requestHeaders: { accept: "*/*" } });
    const b = req({ status: 200, requestHeaders: { accept: "*/*", "sec-fetch-mode": "cors", "accept-encoding": "gzip", cookie: REDACTED } });
    expect(compare(a, b).map((row) => row.field)).toEqual(["status", "request header cookie"]);
  });
});
