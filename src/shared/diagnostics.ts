import type { ApiRequest, Diagnostic } from "./types";
import { compare, isFailure } from "./http";

type Rule = [Diagnostic["severity"], string, string, string];
const d = ([severity, title, explanation, nextStep]: Rule): Diagnostic => ({ severity, title, explanation, nextStep });

export const SLOW_MS = 1000;
// Wording of common server-side CORS rejections (Express `cors`, Spring, ASP.NET), not just any mention of "cors".
const CORS_REJECTION = /not allowed by cors|invalid cors request|cors (policy|error|origin)|origin .{0,80}not allowed/i;

const STATUS: Record<number, Rule> = {
  400: ["warning", "Bad request", "The server rejected the request as invalid.", "Check required fields, query parameters, and payload format against the API contract."],
  401: ["warning", "Authentication required", "The server did not accept the request's credentials.", "Check the auth scheme, that the token is attached, and that it has not expired."],
  403: ["warning", "Access forbidden", "The server knows who you are but refused this operation.", "Check user roles, resource ownership, and server access policies."],
  404: ["warning", "Resource not found", "The route or resource does not exist on this server.", "Verify the base URL, route, API version, and resource ID."],
  405: ["warning", "Method not allowed", "The route exists but does not accept this HTTP method.", "Check the method, or whether the route is registered for it on the server."],
  408: ["warning", "Request timeout", "The server gave up waiting for the request.", "Check payload size and client network speed."],
  409: ["warning", "Conflict", "The request conflicts with the current state of the resource.", "Check for duplicates, stale versions, or unique constraints."],
  413: ["warning", "Payload too large", "The request body exceeds the server's limit.", "Reduce the payload or raise the body-size limit on the server/proxy."],
  415: ["warning", "Unsupported media type", "The server does not accept the body's Content-Type.", "Send the Content-Type the endpoint expects (often application/json)."],
  422: ["warning", "Validation failed", "The payload was well-formed but failed validation.", "Read the response body for the failing fields."],
  429: ["warning", "Rate limit reached", "The server is limiting the request rate.", "Back off; check rate-limit headers and Retry-After before retrying."],
  500: ["error", "Server error", "The server crashed or threw while handling the request.", "Check server logs for the stack trace at this timestamp."],
  502: ["error", "Bad gateway", "A proxy or gateway got an invalid response from the backend.", "Check that the upstream service is running and healthy."],
  503: ["error", "Service unavailable", "The server is overloaded, starting up, or in maintenance.", "Check service health and deploy status; retry later."],
  504: ["error", "Gateway timeout", "A proxy gave up waiting for the backend.", "Find the slow query or dependency; check proxy timeouts."]
};
const OTHER_5XX: Rule = ["error", "Server-side failure", "The server reported an unsuccessful response.", "Check server logs, dependencies, and the response body."];

// No HTTP response at all. Matched against Chrome's net::ERR_* codes and fetch() errors.
const NETWORK: [RegExp, Rule][] = [
  [/CONNECTION_REFUSED/, ["error", "Server not reachable", "Nothing accepted the connection at this host and port.", "Make sure the backend is running and the port in the URL is right."]],
  [/NAME_NOT_RESOLVED/, ["error", "Unknown host", "The hostname could not be resolved (DNS).", "Check the base URL / environment variable for typos."]],
  [/BLOCKED_BY_CLIENT/, ["warning", "Blocked by an extension", "An ad blocker or privacy extension cancelled the request.", "Allow this site in the blocker, or avoid trigger words like 'ads' or 'track' in the route."]],
  [/ERR_ABORTED|Cancelled/, ["info", "Request cancelled", "The page aborted it (navigation, AbortController, or a newer request replaced it).", "Usually harmless; check the cancellation is intended."]],
  [/TIMED_OUT|Timed out/, ["error", "Timed out", "The server did not respond in time.", "Check whether the server is hung or the endpoint is very slow."]],
  [/ERR_CERT|SSL/, ["error", "TLS certificate problem", "The HTTPS certificate was rejected.", "Check the certificate, its hostname, and expiry (self-signed in dev?)."]],
  [/INTERNET_DISCONNECTED|NETWORK_CHANGED/, ["error", "Offline", "The browser lost its network connection.", "Reconnect and retry."]],
  [/CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE/, ["error", "Connection dropped", "The server closed the connection without a valid response, often a crash.", "Check server logs and any proxy in between."]],
  [/ERR_FAILED|Failed to fetch/, ["error", "Request failed before a response", "Most often CORS, a server that is down, or a wrong URL.", "Check the console for a CORS message, or turn on Deep capture to see the exact reason."]]
];
const NETWORK_OTHER: Rule = ["error", "Network failure", "No HTTP response was received.", "Check connectivity, the URL, and the browser console."];

export function diagnose(r: ApiRequest, baseline?: ApiRequest, responseBody?: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const res = r.responseHeaders ?? {};
  const sent = r.requestHeaders;

  if (r.corsError) {
    out.push(d(["error", "Blocked by CORS", `The browser blocked the response (${r.corsError}).`, "Allow this origin on the server: Access-Control-Allow-Origin, plus the OPTIONS preflight for non-simple requests."]));
  } else if (r.error) {
    out.push(d(NETWORK.find(([re]) => re.test(r.error!))?.[1] ?? NETWORK_OTHER));
  }

  const status = r.status;
  if (status !== undefined) {
    // e.g. Express `cors` with an origin allowlist: the rejection is thrown, so it surfaces as a 500.
    if (status >= 400 && CORS_REJECTION.test(responseBody ?? "")) {
      out.push(d(["error", "Rejected by the server's CORS check", `The server refused this request's Origin (${sent?.origin ?? "none sent"}), so this is not a real ${status}.`, "Add that origin to the server's CORS allowlist. Tip: answer disallowed origins with 403 instead of throwing, so they don't look like a crash."]));
    }
    const rule = STATUS[status] ?? (status >= 500 ? OTHER_5XX : undefined);
    if (rule) out.push(d(rule));
    // Only for captured calls: the tester sends browser cookies implicitly, so its headers don't show them.
    if (status === 401 && r.tabId >= 0 && sent && !sent.authorization && !sent.cookie) {
      out.push(d(["warning", "No credentials were sent", "The request had neither an Authorization nor a Cookie header.", "Check the client attaches the token (interceptor, credentials: 'include', withCredentials)."]));
    }
    if (status === 401 && res["www-authenticate"]) {
      out.push(d(["info", "Server's expected auth", `WWW-Authenticate: ${res["www-authenticate"]}`, "Match this scheme in the Authorization header."]));
    }
    if (status === 405 && res.allow) {
      out.push(d(["info", "Allowed methods", `This route accepts: ${res.allow}`, "Use one of these methods."]));
    }
    if (status === 429 && res["retry-after"]) {
      out.push(d(["info", "Retry-After", `The server asks to wait: ${res["retry-after"]} (seconds or date).`, "Wait at least that long before retrying."]));
    }
    if (status >= 200 && status < 300 && /text\/html/i.test(res["content-type"] ?? "")) {
      out.push(d(["warning", "HTML returned instead of data", "The endpoint answered with an HTML page: often a SPA fallback, a login redirect, or a wrong base URL.", "Check the base URL / dev-server proxy and that the route exists on the API."]));
    }
  }

  // A response that took long; a cancelled long-poll or a timeout is already explained above.
  if (status !== undefined && (r.durationMs ?? 0) > SLOW_MS) {
    out.push(d(["info", "Slow response", `Took ${r.durationMs} ms.`, "Look for slow queries, N+1 calls, or missing caching on the server."]));
  }

  if (baseline && isFailure(r)) {
    const missing = compare(r, baseline)
      .filter((row) => row.field.startsWith("request header ") && row.failed === "—")
      .map((row) => row.field.slice("request header ".length));
    if (missing.length) {
      out.push(d(["warning", "Headers missing vs. last success", `The last successful call sent ${missing.join(", ")}; this one did not.`, "Check whatever attaches these headers (auth interceptor, proxy, env config)."]));
    }
  }
  return out;
}
