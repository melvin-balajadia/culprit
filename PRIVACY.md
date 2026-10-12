# Culprit privacy policy

_Last updated: 2026-10-12_

Culprit is a developer tool that runs entirely in your browser. It has no server, no account, no analytics and no remote code. Nothing it records is sent anywhere by Culprit.

## What Culprit reads

- **API calls (fetch/XHR) made by the sites you allow.** URL, method, status, timing and headers, through Chrome's `webRequest` API. Only sites you allow under *Site access* (plus `localhost` and `127.0.0.1`) are visible to it.
- **Request and response bodies, only with Deep capture on.** Deep capture is off by default, is switched on per tab by you, and Chrome shows a "debugging this browser" banner while it is on.

## What Culprit stores, and where

| Data | Where | How long |
|---|---|---|
| The last 100 API calls: URL, method, status, timing, headers | `chrome.storage.local` on your computer | Until you click **Clear** or remove the extension |
| Secrets in that history (Authorization, cookies, tokens, API keys, passwords, credentials in URLs) | Not stored: masked before saving | — |
| Raw headers and bodies (for replay and the trace) | `chrome.storage.session`, in memory | Until you click **Clear** or close the browser |
| Trace links (which call supplied a value to which) | With the history | Field paths only, never the values |
| Saved tester requests and variables | `chrome.storage.local` on your computer | Until you delete them |
| Watched endpoints | `chrome.storage.local` on your computer | Until you unwatch them |

## What leaves your browser

Only what you send yourself:

- requests you send from the **Tester** or by **re-running a chain** go to the server you address them to, as they would from your app;
- text you **copy** (report, cURL, Postman collection, Vitest test) or a **HAR** file you export. These are masked: tokens, cookies, passwords and API keys are replaced with placeholders.

Culprit does not sell, share or transfer any data, and does not use it for anything except showing it back to you.

## Contact

Questions about this policy: _[add your contact email]_
