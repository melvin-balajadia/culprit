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
    expect(groups).toEqual(["50%GET/api/users/:id2× · —", "0%GET/api/health1× · —"]);
  });

  it("moves with j/k and opens with Enter", async () => {
    seed();
    render(<Traffic onReplay={() => {}} />);
    await screen.findByText("/api/users/7");
    expect(rowFor("/api/users/7").className).not.toContain("focused"); // nothing focused before the first key
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    expect(rowFor("/api/users/42").className).toContain("focused");
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
