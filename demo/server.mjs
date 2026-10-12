// Local playground for Culprit: `npm run demo`, then open http://localhost:4000 (PORT=4010 npm run demo to change)
import http from "node:http";

const PORT = Number(process.env.PORT) || 4000;

const page = `<!doctype html>
<meta charset="utf-8"><title>Culprit demo</title>
<style>body{font:14px system-ui;max-width:640px;margin:40px auto;padding:0 16px}button{margin:4px;padding:6px 10px}</style>
<h1>Culprit demo</h1>
<p>Open the Culprit side panel (Alt+Shift+N), then click buttons. Each one makes a fetch() call.</p>
<div id="b"></div>
<script>
const token = "Bearer demo-secret-123";
const cases = {
  "200 JSON":            () => fetch("/api/users/1"),
  "200 with token":      () => fetch("/api/me", { headers: { Authorization: token } }),
  "401 no token":        () => fetch("/api/me"),
  "400 bad request":     () => fetch("/api/users", { method: "POST", headers: { "content-type": "application/json" }, body: '{"email":"","password":"hunter2"}' }),
  "403 forbidden":       () => fetch("/api/admin"),
  "404 not found":       () => fetch("/api/users/999/posts"),
  "405 wrong method":    () => fetch("/api/users/1", { method: "PATCH" }),
  "422 validation":      () => fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: '{"qty":-1}' }),
  "429 rate limited":    () => fetch("/api/search?q=x&api_key=demo-key"),
  "500 server error":    () => fetch("/api/report"),
  "503 unavailable":     () => fetch("/api/health"),
  "Slow (2.5 s)":        () => fetch("/api/slow"),
  "Invalid JSON":        () => fetch("/api/broken"),
  "HTML instead of JSON":() => fetch("/api/spa-fallback"),
  "Image (binary)":      () => fetch("/api/avatar"),
  "CORS blocked":        () => fetch("http://127.0.0.1:${PORT}/api/users/1"),
  "Login (CORS allowlist)": () => fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_username: "ada", user_password: "hunter2" }) }),
  "Server not running":  () => fetch("http://localhost:4999/api/users"),
  "Cancelled":           () => { const c = new AbortController(); const p = fetch("/api/slow", { signal: c.signal }); setTimeout(() => c.abort(), 100); return p; },
};
for (const [name, run] of Object.entries(cases)) {
  const btn = document.createElement("button");
  btn.textContent = name;
  btn.onclick = () => run().catch(() => {});
  b.append(btn);
}
</script>`;

const routes = {
  "GET /api/users/1": [200, { id: 1, name: "Ada" }],
  "GET /api/me": (req) => (req.headers.authorization ? [200, { id: 1, role: "user" }] : [401, { error: "missing token" }, { "www-authenticate": 'Bearer realm="api"' }]),
  "POST /api/users": [400, { error: "email is required" }],
  "GET /api/admin": [403, { error: "admin role required" }],
  "POST /api/orders": [422, { errors: { qty: "must be positive" } }],
  "GET /api/search": [429, { error: "slow down" }, { "retry-after": "30" }],
  "GET /api/report": [500, { error: "TypeError: cannot read properties of undefined (reading 'total')" }],
  "GET /api/health": [503, { status: "starting" }],
};

http
  .createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    const send = (status, body, headers = {}) => {
      const text = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(text);
    };

    if (path === "/") return send(200, page, { "content-type": "text/html" });
    if (path === "/api/slow") return setTimeout(() => send(200, { done: true }), 2500);
    if (path === "/api/broken") return send(200, '{"items": [1, 2,');
    if (path === "/api/spa-fallback") return send(200, "<!doctype html><div id=root></div>", { "content-type": "text/html" });
    if (path === "/api/avatar") return send(200, Buffer.from("89504e470d0a1a0a", "hex"), { "content-type": "image/png" });
    if (path === "/api/users/1" && req.method === "PATCH") return send(405, { error: "method not allowed" }, { allow: "GET, PUT" });

    // Like Express `cors` with an allowlist: a rejected Origin is thrown and becomes a 500.
    if (path === "/api/login") {
      const origin = req.headers.origin;
      if (origin && origin !== `http://localhost:${PORT}`) return send(500, { message: "Internal Server Error", error: "Error: Not allowed by CORS" });
      return send(200, { token: "demo-token" }, origin ? { "access-control-allow-origin": origin } : {});
    }

    const route = routes[`${req.method} ${path}`];
    if (!route) return send(404, { error: `no route ${req.method} ${path}` });
    send(...(typeof route === "function" ? route(req) : route));
  })
  .listen(PORT, () => console.log(`Culprit demo: http://localhost:${PORT}`));
