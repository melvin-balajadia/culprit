// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ApiRequest } from "../shared/types";

// A minimal in-memory chrome.* for the panel. Hoisted: Tester reads chrome.declarativeNetRequest at import time.
const fake = vi.hoisted(() => {
  const data: Record<"local" | "session", Record<string, unknown>> = { local: {}, session: {} };
  const area = (name: "local" | "session") => ({
    get: async (key: string) => ({ [key]: data[name][key] }),
    set: async (items: Record<string, unknown>) => void Object.assign(data[name], items),
    remove: async () => {}
  });
  const noopEvent = { addListener() {}, removeListener() {} };
  const chrome = {
    storage: { local: area("local"), session: area("session"), onChanged: noopEvent },
    tabs: { query: async () => [{ id: 1, url: "http://localhost:3000/" }], onActivated: noopEvent },
    runtime: { id: "ext", getManifest: () => ({ host_permissions: ["http://localhost/*"] }), sendMessage: vi.fn(async () => ({})) },
    permissions: { getAll: async () => ({ origins: ["http://localhost/*"] }), request: vi.fn(async () => true), remove: async () => true },
    declarativeNetRequest: {
      HeaderOperation: { SET: "set", REMOVE: "remove" },
      ResourceType: { XMLHTTPREQUEST: "xmlhttprequest" },
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      updateSessionRules: vi.fn(async () => {})
    }
  };
  Object.assign(globalThis, { chrome });
  return { data, chrome };
});

import App from "./App";
import Traffic from "./Traffic";
import Tester from "./Tester";

const req = (p: Partial<ApiRequest>): ApiRequest => ({ id: p.url!, tabId: 1, method: "GET", startedAt: 0, url: "", ...p });
fake.data.local.requests = [
  req({ url: "http://localhost:3000/api/orders", status: 401, requestHeaders: { authorization: "REDACTED", accept: "application/json" } }),
  req({ url: "http://localhost:3000/api/users", status: 200 }),
  req({ url: "http://localhost:3000/api/other-tab", status: 500, tabId: 2 })
];

afterEach(cleanup);

const rowFor = (path: string) => screen.getByText(path).closest("button")!;
const paths = () => screen.queryAllByRole("button").map((b) => b.querySelector(".path")?.textContent).filter(Boolean);

describe("Traffic filters", () => {
  it("shows this tab by default, then narrows by errors and search", async () => {
    render(<Traffic onReplay={() => {}} />);
    await screen.findByText("/api/orders");
    expect(paths()).toEqual(["/api/orders", "/api/users"]); // tab 2's call is hidden

    fireEvent.click(screen.getByLabelText(/Errors/));
    expect(paths()).toEqual(["/api/orders"]);

    fireEvent.click(screen.getByLabelText(/This tab/));
    expect(paths()).toEqual(["/api/orders", "/api/other-tab"]);

    fireEvent.change(screen.getByPlaceholderText(/Filter by URL/), { target: { value: "other" } });
    expect(paths()).toEqual(["/api/other-tab"]);
  });
});

describe("Replay", () => {
  it("opens the call in the tester without masked headers, and says which to re-enter", async () => {
    render(<App />);
    await screen.findByText("/api/orders");
    fireEvent.click(rowFor("/api/orders"));
    fireEvent.click(await screen.findByText("Replay in tester"));

    expect(await screen.findByText(/Re-enter authorization/)).toBeTruthy();
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("http://localhost:3000/api/orders");
    const headers = screen.getByPlaceholderText(/Authorization: Bearer/) as HTMLTextAreaElement;
    expect(headers.value).toBe("accept: application/json");
  });
});

describe("Tester", () => {
  it("needs a second click before sending a DELETE", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Tester />);

    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "DELETE" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "http://localhost:3000/api/orders/9" } });
    fireEvent.click(screen.getByText("Send"));

    expect(screen.getByText("Confirm DELETE")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Confirm DELETE"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]).toMatchObject(["http://localhost:3000/api/orders/9", { method: "DELETE" }]);
    expect(within(await screen.findByRole("heading", { level: 2 })).getByText("200")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("disarms the DELETE confirmation when the request is edited", () => {
    render(<Tester />);
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "DELETE" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "http://localhost:3000/a" } });
    fireEvent.click(screen.getByText("Send"));
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "http://localhost:3000/b" } });
    expect(screen.queryByText("Confirm DELETE")).toBeNull();
  });
});

describe("Why? trace", () => {
  it("marks the culprit in the chain and leads the diagnosis with it", async () => {
    fake.data.local.requests = [
      req({ url: "http://localhost:3000/api/users/undefined", status: 404, startedAt: 2, links: [{ from: "p", fromPath: "response.user", to: "path[2]", confidence: "likely", missing: true }] }),
      { ...req({ url: "http://localhost:3000/api/profile", status: 200, startedAt: 1 }), id: "p" }
    ];
    render(<Traffic onReplay={() => {}} />);
    await screen.findByText("/api/users/undefined");
    fireEvent.click(rowFor("/api/users/undefined"));

    expect(await screen.findByText("Likely culprit: GET /api/profile")).toBeTruthy();
    const culpritNode = screen.getByText("Culprit").closest("li")!;
    expect(within(culpritNode).getByText("/api/profile")).toBeTruthy();
    expect(within(culpritNode).getByText(/user was null → GET \/api\/users\/undefined/)).toBeTruthy();
  });
});

describe("views and keys", () => {
  const seed = () => {
    fake.data.local.requests = [
      req({ url: "http://localhost:3000/api/users/7", status: 500, startedAt: 3 }),
      req({ url: "http://localhost:3000/api/users/42", status: 200, startedAt: 2 }),
      req({ url: "http://localhost:3000/api/health", status: 200, startedAt: 1 })
    ];
  };

  it("groups calls by endpoint with a failure rate, worst first", async () => {
    seed();
    render(<Traffic onReplay={() => {}} />);
    await screen.findByText("/api/users/7");
    fireEvent.click(screen.getByText("By endpoint"));
    const groups = [...document.querySelectorAll(".group-row")].map((g) => g.textContent);
    expect(groups).toEqual(["50%GET/api/users/:id2× · —☆", "0%GET/api/health1× · —☆"]);
  });

  it("moves with j/k and opens with Enter", async () => {
    seed();
    render(<Traffic onReplay={() => {}} />);
    await screen.findByText("/api/users/7");
    expect(rowFor("/api/users/7").className).not.toContain("focused"); // nothing focused before the first key
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(rowFor("/api/users/7").className).toContain("focused"));
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(rowFor("/api/users/42").className).toContain("focused"));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(await screen.findByText("← All requests")).toBeTruthy();
    expect(screen.getByText("http://localhost:3000/api/users/42")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("List")).toBeTruthy();
  });

  it("ignores shortcuts while typing in the filter", async () => {
    seed();
    render(<Traffic onReplay={() => {}} />);
    const filter = await screen.findByPlaceholderText(/Filter by URL/);
    fireEvent.keyDown(filter, { key: "e" });
    expect((screen.getByLabelText(/Errors/) as HTMLInputElement).checked).toBe(false);
  });
});

describe("Re-run chain", () => {
  it("asks before re-sending a POST, then carries the fresh token into the next call", async () => {
    fake.data.local.requests = [
      req({ url: "http://localhost:3000/api/orders", status: 401, startedAt: 2, links: [{ from: "login", fromPath: "response.access_token", to: "header.authorization", confidence: "certain" }] }),
      { ...req({ url: "http://localhost:3000/api/login", method: "POST", status: 200, startedAt: 1 }), id: "login" }
    ];
    fake.data.session["raw:login"] = { url: "http://localhost:3000/api/login", requestHeaders: { "content-type": "application/json" }, requestBody: '{"username":"ada"}' };
    fake.data.session["raw:http://localhost:3000/api/orders"] = { url: "http://localhost:3000/api/orders", requestHeaders: { authorization: "Bearer stale-token-123" } };
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/login")
        ? new Response('{"access_token":"fresh-token-456"}', { status: 200, headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Traffic onReplay={() => {}} />);
    await screen.findByText("/api/orders");
    fireEvent.click(rowFor("/api/orders"));
    fireEvent.click(await screen.findByText("Run 2 calls"));
    expect(fetchMock).not.toHaveBeenCalled(); // the POST needs confirming first

    fireEvent.click(screen.getByText(/Confirm: run 1 call that changes data/));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, ordersInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((ordersInit.headers as Record<string, string>).authorization).toBe("Bearer fresh-token-456");
    await waitFor(() => expect(document.querySelectorAll(".step-result")).toHaveLength(2)); // each step shows its new result
    vi.unstubAllGlobals();
  });
});

describe("Tester variables and saved requests", () => {
  it("fills {{variables}}, refuses unknown ones, and saves the request", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    fake.data.local.vars = "base=http://localhost:3000";
    fake.data.local.saved = [];
    render(<Tester />);
    await waitFor(() => expect(screen.getByText(/variables \(1\)/)).toBeTruthy()); // stored variables loaded

    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "{{base}}/api/{{missing}}" } });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText(/Unknown variable \{\{missing\}\}/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "{{base}}/api/me" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("http://localhost:3000/api/me");

    fireEvent.click(screen.getByText("Save"));
    expect((screen.getByLabelText("Name for this request") as HTMLInputElement).value).toBe("GET /api/me");
    fireEvent.click(screen.getAllByText("Save").at(-1)!);
    expect(fake.data.local.saved).toEqual([{ name: "GET /api/me", draft: { method: "GET", url: "{{base}}/api/me", headers: "", body: "", origin: "" } }]);
    vi.unstubAllGlobals();
  });
});

describe("watching endpoints", () => {
  it("watches an endpoint from the grouped view and shows its latest status across tabs", async () => {
    fake.data.local.pins = [];
    fake.data.local.requests = [
      req({ url: "http://localhost:3000/api/cart", status: 200, startedAt: 3, tabId: 9, drift: [{ path: "total", now: "—", before: "number" }] }),
      req({ url: "http://localhost:3000/api/cart", status: 500, startedAt: 2 })
    ];
    render(<Traffic onReplay={() => {}} />);
    await screen.findByText("/api/cart");
    fireEvent.click(screen.getByText("By endpoint"));
    fireEvent.click(screen.getByLabelText("Watch GET /api/cart"));

    const strip = await waitFor(() => document.querySelector(".watching") as HTMLElement);
    expect(within(strip).getByText("1/2 failed")).toBeTruthy(); // counts the other tab's call too
    expect(within(strip).getByText("shape changed")).toBeTruthy();
    expect(fake.data.local.pins).toEqual(["GET localhost:3000/api/cart"]);

    fireEvent.click(within(strip).getByLabelText("Stop watching GET /api/cart"));
    await waitFor(() => expect(document.querySelector(".watching")).toBeNull());
  });
});

describe("flow view", () => {
  it("draws an arc from the endpoint that supplied a value and opens an endpoint's latest call", async () => {
    const link = { from: "http://localhost:3000/api/login", fromPath: "response.token", to: "header.authorization", confidence: "certain" as const };
    fake.data.local.requests = [
      req({ url: "http://localhost:3000/api/orders/9", status: 401, startedAt: 3, links: [link] }),
      req({ url: "http://localhost:3000/api/health", status: 200, startedAt: 2 }),
      req({ url: "http://localhost:3000/api/login", method: "POST", status: 200, startedAt: 1 })
    ];
    render(<Traffic onReplay={() => {}} />);
    await screen.findByText("/api/orders/9");
    fireEvent.click(screen.getByText("Flow"));
    const rows = [...document.querySelectorAll(".flow-row .path")].map((p) => p.textContent);
    expect(rows).toEqual(["/api/login", "/api/orders/:id"]); // health is linked to nothing
    expect(document.querySelectorAll(".arc")).toHaveLength(1);
    fireEvent.click(rowFor("/api/orders/:id"));
    expect(await screen.findByText("http://localhost:3000/api/orders/9")).toBeTruthy();
  });
});

describe("audit regressions", () => {
  it("keeps j/k on a visible row when a view shows fewer rows than the list", async () => {
    const link = { from: "http://localhost:3000/api/login", fromPath: "response.token", to: "header.authorization", confidence: "certain" as const };
    fake.data.local.requests = [
      req({ url: "http://localhost:3000/api/a", status: 200, startedAt: 5 }),
      req({ url: "http://localhost:3000/api/b", status: 200, startedAt: 4 }),
      req({ url: "http://localhost:3000/api/orders/9", status: 401, startedAt: 3, links: [link] }),
      req({ url: "http://localhost:3000/api/login", method: "POST", status: 200, startedAt: 1 })
    ];
    render(<Traffic onReplay={() => {}} />);
    await screen.findByText("/api/a");
    for (let i = 0; i < 4; i++) fireEvent.keyDown(window, { key: "j" }); // last of 4 list rows
    fireEvent.click(screen.getByText("Flow")); // 2 endpoint rows
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(document.querySelector(".flow-row.focused .path")?.textContent).toBe("/api/login"));
  });

  it("still runs a chain when a step's URL was edited into something invalid", async () => {
    fake.data.local.requests = [
      req({ url: "http://localhost:3000/api/orders", status: 401, startedAt: 2, links: [{ from: "token", fromPath: "response.token", to: "header.authorization", confidence: "certain" }] }),
      { ...req({ url: "http://localhost:3000/api/token", status: 200, startedAt: 1 }), id: "token" }
    ];
    fake.data.session["raw:token"] = { url: "http://localhost:3000/api/token", requestHeaders: {} };
    fake.data.session["raw:http://localhost:3000/api/orders"] = { url: "http://localhost:3000/api/orders", requestHeaders: {} };
    const fetchMock = vi.fn(async (url: string) => {
      new URL(url); // like real fetch: an invalid URL rejects
      return new Response('{"token":"t-123456"}', { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Traffic onReplay={() => {}} />);
    fireEvent.click(await screen.findByText("/api/orders"));
    fireEvent.click((await screen.findAllByText("Edit"))[0]);
    fireEvent.change(screen.getByLabelText("Step 1 URL"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByText("Run 2 calls"));
    await waitFor(() => expect(document.querySelectorAll(".step-result")).toHaveLength(2)); // step 1 fails, step 2 still runs
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
