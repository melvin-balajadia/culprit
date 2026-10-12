# Culprit

**Find the API call that really broke it.** A Chrome side-panel extension that shows *why* your app's API calls fail, not just that they did.

- **Traffic**: every fetch/XHR from the current tab, with failures highlighted and a red error count on the toolbar icon.
- **Diagnosis**: status rules plus context: 401 with no credentials sent, `ERR_CONNECTION_REFUSED` ("is the backend running?"), HTML returned instead of JSON, Retry-After, Allow, slow calls.
- **vs. last success**: a failed call is matched to the last successful call to the same endpoint (`/users/42` ≈ `/users/7`). You see what changed (status, query params, request headers), and headers that went missing are called out.
- **Deep capture** (opt-in, per tab): records request/response bodies and the exact CORS error through Chrome's debugger.
- **Replay in tester**: opens a captured call in the tester with its real headers and body. The tester uses your browser session and isn't blocked by CORS on sites you allow.
- **Copy report / cURL**: Markdown or cURL for tickets and chat, with tokens, cookies, passwords, and API keys masked.

## Run it

```sh
npm install
npm run build      # or: npm run dev (rebuilds on change)
npm run check      # lint + tests + build; CI runs the same on every push
npm run demo       # playground API with one button per failure case (PORT=4010 to change the port)
```

Where things live: `src/background.ts` wires Chrome events to the pure modules in `src/shared/` (`capture.ts` for deep capture, `diagnostics.ts`, `http.ts` for masking, cURL and the tester), which hold the logic and the unit tests. `src/panel/` is the React side panel.

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
- Deep capture records bodies for calls made by the page itself. Calls from cross-origin iframes and workers are still listed, but without bodies.

- Without Deep capture there are no bodies: `webRequest` can't read them.
- Only `fetch`/XHR are recorded. Page loads, images, and WebSockets are not.
- After a service-worker restart, calls that were in flight may lose their duration.
