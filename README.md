# Culprit

**Find the API call that really broke it.** A Chrome side-panel extension that shows *why* your app's API calls fail, not just that they did.

- **Why? (root-cause trace)**: with Deep capture on, Culprit notices when a value from one response (a token, an id, a link) is used by a later request, and links the two. Open a failed call to see the chain of calls that led to it, with the **culprit** marked: the refresh that failed before your 401, or the response that returned `null` before your request to `/users/undefined`. Links store field paths only, never values.
- **Re-run chain**: from a traced call, run it again together with the calls that fed it. Each step uses fresh values from the steps before it (a new login's token, the id the new response returned), so an expired session replays as a working one. Edit any step first and the change flows to the steps after it. Calls that change data (POST, PUT, PATCH, DELETE) ask for confirmation.
- **Take the chain with you**: copy it as a **Postman collection** (linked values become `{{variables}}`, with the scripts that set them already written; import with Import → Raw text) or as a **Vitest regression test** that replays the chain and expects the failing call to pass (`API_BASE_URL=… npx vitest run file`). Secrets become variables or `process.env.*` placeholders.
- **Traffic**: every fetch/XHR from the current tab, with failures highlighted and a red error count on the toolbar icon. Each call shows where in your code it was made (with Deep capture). Three views:
  - **List**, newest first;
  - **By endpoint**: `/users/42` and `/users/7` grouped, with failure rate and average time, worst first;
  - **Timeline**: calls as bars over time; hover one to highlight the calls linked to it.
- **Keyboard**: `j`/`k` move, `Enter` open, `/` filter, `e` errors only, `v` switch view; in a call, `Esc` back, `r` replay, `c` copy report.
- **Diagnosis**: status rules plus context: likely culprit, expired token, URL built from a missing value, 401 with no credentials sent, `ERR_CONNECTION_REFUSED` ("is the backend running?"), HTML returned instead of JSON, Retry-After, Allow, slow calls.
- **vs. last success**: a failed call is matched to the last successful call to the same endpoint (`/users/42` ≈ `/users/7`). You see what changed (status, query params, request headers, and, with bodies, response fields that went missing, appeared, or changed type), and headers that went missing are called out.
- **Deep capture** (opt-in, per tab): records request/response bodies and the exact CORS error through Chrome's debugger, including calls from the page's iframes and workers. JSON bodies show as a collapsible tree.
- **Replay in tester**: opens a captured call in the tester with its real headers and body. The tester uses your browser session and isn't blocked by CORS on sites you allow.
- **Tester**: saved requests and `{{variables}}` (`name=value` per line), kept on this computer only.
- **Copy report / cURL / Export HAR**: Markdown (including the chain and the culprit), cURL, or a HAR file of what the list shows, with tokens, cookies, passwords, and API keys masked.

## Run it

```sh
npm install
npm run build      # or: npm run dev (rebuilds on change)
npm run check      # lint + tests + build; CI runs the same on every push
npm run demo       # playground API with one button per failure case (PORT=4010 to change the port)
```

The demo's **Chain:** buttons show the trace: turn on Deep capture, click one, then open its last call and read **Why?**.

Where things live: `src/background.ts` wires Chrome events to the pure modules in `src/shared/` (`capture.ts` for deep capture, `lineage.ts` for the Why? trace, `chain.ts` for re-running a chain, `export.ts` for Postman, Vitest and HAR, `diagnostics.ts`, `http.ts` for masking, cURL and the tester), which hold the logic and the unit tests. `src/panel/` is the React side panel.

In Chrome, open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and choose `dist/`.
To open the panel, click the toolbar icon or press **Alt+Shift+N**. After a rebuild, click reload on the extension card.

## Permissions

| Permission | Why |
|---|---|
| `webRequest` | Read request/response metadata (URL, method, status, headers, timing). |
| `host_permissions`: localhost, 127.0.0.1 | Monitor local dev servers out of the box. |
| `optional_host_permissions`: http/https | Other sites are recorded only after you allow them (panel → Site access, or automatically when the tester calls a host). |
| `debugger` | Deep capture only. Chrome doesn't allow `debugger` to be optional, so it shows at install, but nothing attaches until you click **Deep capture** on a tab. Chrome shows a banner while it's on. |
| `sidePanel`, `activeTab` | The panel UI; activeTab lets the panel read the current tab's site. |
| `storage` | History (`local`, metadata only, last 100 calls, header secrets masked). Raw headers and bodies go in `session` storage: memory only, wiped when the browser closes or history is cleared. |

Nothing leaves the browser. There is no backend and no remote code.

## Limits

- Chrome only reports a request when **both** the page and the API it calls are allowed. An app on localhost calling `https://api.example.com` needs that API allowed (panel → Site access).
- Deep capture needs Chrome 125 or later (for iframe and worker sessions). Service workers aren't attached; their calls are listed without bodies.
- Without Deep capture there are no bodies: `webRequest` can't read them, so the Why? trace can't see which response supplied a value.
- Trace links are inferred by matching distinctive values (tokens, ids, links), labelled *certain* or *likely*. The index is in memory, so it starts empty after the browser or extension restarts.
- Only `fetch`/XHR are recorded. Page loads, images, and WebSockets are not.
- After a service-worker restart, calls that were in flight may lose their duration.
