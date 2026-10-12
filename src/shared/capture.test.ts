import { describe, expect, it } from "vitest";
import { BODY_LIMIT, DeepCapture, bodyText, toCapture, type CdpParams } from "./capture";
import { REDACTED } from "./http";

const TAB = 7;
const sent = (requestId: string, url: string, extra: Partial<CdpParams> = {}): CdpParams => ({
  requestId,
  type: "Fetch",
  timestamp: 100,
  wallTime: 1_700_000_000,
  request: { url, method: "GET", headers: { Accept: "application/json" } },
  ...extra
});
const response = (requestId: string, status: number, headers: Record<string, string> = {}): CdpParams => ({
  requestId,
  timestamp: 100.2,
  response: { status, statusText: status === 200 ? "OK" : "Unauthorized", headers }
});

describe("DeepCapture", () => {
  it("turns a fetch's events into a masked record plus raw data", () => {
    const cap = new DeepCapture();
    cap.event(TAB, "Network.requestWillBeSent", sent("1", "https://api.test/me?token=abc", {
      request: { url: "https://api.test/me?token=abc", method: "POST", headers: { Authorization: "Bearer xyz" }, postData: '{"a":1}' }
    }));
    cap.event(TAB, "Network.responseReceived", response("1", 200, { "Content-Type": "application/json" }));
    const done = cap.event(TAB, "Network.loadingFinished", { requestId: "1", timestamp: 100.25 })!;
    expect(done.wantsBody).toBe(true);

    const { record, raw } = toCapture(done, '{"ok":true}');
    expect(record).toMatchObject({
      tabId: TAB, method: "POST", status: 200, durationMs: 250, deep: true,
      url: `https://api.test/me?token=${REDACTED}`,
      requestHeaders: { authorization: REDACTED },
      responseHeaders: { "content-type": "application/json" }
    });
    expect(raw).toEqual({
      url: "https://api.test/me?token=abc",
      requestHeaders: { authorization: "Bearer xyz" },
      requestBody: '{"a":1}',
      responseBody: '{"ok":true}'
    });
  });

  it("ignores page loads, images and other non-API requests", () => {
    const cap = new DeepCapture();
    cap.event(TAB, "Network.requestWillBeSent", sent("2", "https://a.test/logo.png", { type: "Image" }));
    expect(cap.event(TAB, "Network.loadingFinished", { requestId: "2", timestamp: 101 })).toBeUndefined();
  });

  it("keeps wire headers (cookies) that arrive before the request event", () => {
    const cap = new DeepCapture();
    cap.event(TAB, "Network.requestWillBeSentExtraInfo", { requestId: "3", timestamp: 0, headers: { Cookie: "sid=1" } });
    cap.event(TAB, "Network.requestWillBeSent", sent("3", "https://api.test/x"));
    const done = cap.event(TAB, "Network.loadingFinished", { requestId: "3", timestamp: 101 })!;
    expect(toCapture(done).raw.requestHeaders).toMatchObject({ cookie: "sid=1", accept: "application/json" });
  });

  it("measures a redirected request from its first hop", () => {
    const cap = new DeepCapture();
    cap.event(TAB, "Network.requestWillBeSent", sent("4", "https://api.test/old"));
    cap.event(TAB, "Network.requestWillBeSent", sent("4", "https://api.test/new", { timestamp: 100.5 }));
    const done = cap.event(TAB, "Network.loadingFinished", { requestId: "4", timestamp: 101 })!;
    const { record } = toCapture(done);
    expect(record.url).toBe("https://api.test/new");
    expect(record.durationMs).toBe(1000);
  });

  it("records failures with the CORS reason and never invents a status", () => {
    const cap = new DeepCapture();
    cap.event(TAB, "Network.requestWillBeSent", sent("5", "https://other.test/x"));
    const done = cap.event(TAB, "Network.loadingFailed", {
      requestId: "5", timestamp: 100.1, errorText: "net::ERR_FAILED", corsErrorStatus: { corsError: "MissingAllowOriginHeader" }
    })!;
    expect(done.wantsBody).toBe(false);
    const { record } = toCapture(done);
    expect(record).toMatchObject({ error: "net::ERR_FAILED", corsError: "MissingAllowOriginHeader" });
    expect(record.status).toBeUndefined();
  });

  it("lets webRequest skip each debugger-recorded request exactly once, and forgets a detached tab", () => {
    const cap = new DeepCapture();
    cap.event(TAB, "Network.requestWillBeSent", sent("6", "https://api.test/a"));
    expect(cap.consumeClaim(TAB, "GET", "https://api.test/a")).toBe(true);
    expect(cap.consumeClaim(TAB, "GET", "https://api.test/a")).toBe(false); // a second identical call is webRequest's
    expect(cap.consumeClaim(TAB, "GET", "https://api.test/iframe-call")).toBe(false);

    cap.event(TAB, "Network.requestWillBeSent", sent("7", "https://api.test/b"));
    cap.forgetTab(TAB);
    expect(cap.consumeClaim(TAB, "GET", "https://api.test/b")).toBe(false);
    expect(cap.event(TAB, "Network.loadingFinished", { requestId: "7", timestamp: 101 })).toBeUndefined();
  });

  it("expires claims webRequest never reports", () => {
    const cap = new DeepCapture();
    cap.event(TAB, "Network.requestWillBeSent", sent("8", "https://untracked.test/a"), 0);
    cap.event(TAB, "Network.requestWillBeSent", sent("9", "https://api.test/b"), 10 * 60_000); // prunes old claims
    expect(cap.consumeClaim(TAB, "GET", "https://untracked.test/a")).toBe(false);
  });

  it("clips large bodies and summarises binary ones", () => {
    const cap = new DeepCapture();
    cap.event(TAB, "Network.requestWillBeSent", sent("10", "https://api.test/big"));
    const done = cap.event(TAB, "Network.loadingFinished", { requestId: "10", timestamp: 101 })!;
    const body = toCapture(done, "x".repeat(BODY_LIMIT + 10)).raw.responseBody!;
    expect(body.endsWith("…[truncated]")).toBe(true);
    expect(bodyText({ body: "AAAA", base64Encoded: true })).toBe("[binary response, ~3 bytes]");
  });
});
