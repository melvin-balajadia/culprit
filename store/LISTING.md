# Chrome Web Store submission: Culprit

Copy these into the developer dashboard. Upload-ready images (PNG, the formats the store accepts) are in `store/screenshots/store-upload/`.

## Package

1. `npm run check` (lint, tests, build).
2. Bump `version` in `public/manifest.json` (and `package.json`) for each upload.
3. Zip the **contents** of `dist/` (manifest.json at the zip root) and upload it.

## Store listing

**Name:** Culprit

**Summary** (132 characters max):
> Find the API call that really broke it: live API monitor, root-cause diagnostics, compare with last success, and a built-in tester.

**Category:** Developer Tools

**Description:**

> Culprit is a side panel for developers that shows **why** your app's API calls fail, not just that they did.
>
> **Find the real culprit.** Turn on Deep capture and Culprit links values between calls: the token your login returned, the id your profile call returned. Open a failed call and see the chain that led to it, with the culprit marked: the token refresh that failed before your 401, or the response that returned null before your request to /users/undefined.
>
> **Re-run the chain with fresh data.** Replay a failed call together with the calls that fed it. A new login's token and ids flow into the next steps automatically, so an expired session replays as a working one. No scripts.
>
> **Take it with you.** Copy the chain as a Postman collection with the variables and scripts already written, or as a Vitest regression test that expects the failing call to pass.
>
> **Catch the 200s that break your UI.** Culprit learns each endpoint's usual response and flags a success that lost a field or turned a value into null.
>
> Also: diagnoses for common HTTP and network errors (CORS, expired tokens, server down, HTML instead of JSON…), comparison with the last success, timeline and per-endpoint views, a request tester with saved requests and variables, HAR export, and masked reports for tickets. Keyboard friendly.
>
> **Private by design:** everything stays in your browser. No server, no account, no analytics. Tokens, cookies and passwords are masked before anything is saved or copied.

## Privacy practices tab

**Single purpose:**
> Help developers find and fix failing API calls in the web apps they are building, by showing those calls, explaining failures, and replaying them.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `webRequest` | Reads the method, URL, status, timing and headers of fetch/XHR calls on sites the user allows, to list them and diagnose failures. Read-only; requests are never blocked or modified. |
| `debugger` | Opt-in "Deep capture", switched on per tab by the user, reads request and response bodies and exact CORS errors through the Chrome DevTools Protocol Network domain. These are needed to trace which call supplied a value to which, and to detect changed response shapes. Chrome shows its debugging banner while it is on; nothing attaches until the user clicks Deep capture. Chrome doesn't allow this permission to be optional. |
| `declarativeNetRequestWithHostAccess` | One session rule sets the Origin header on requests the extension itself sends from its tester, so a replayed call matches the app's (servers often reject the extension's own origin). The rule only matches the extension's own requests (`initiatorDomains` = the extension id), never page traffic. |
| `storage` | Keeps the last 100 calls (with secrets masked), saved tester requests, variables and watched endpoints on the user's computer; bodies only in session memory. |
| `sidePanel` | The user interface is a side panel, so it stays open while the user works in their app. |
| `activeTab` | Lets the panel read the current tab's address to suggest it under Site access. |
| Host permissions (`localhost`, `127.0.0.1`; other sites optional) | Local development servers work out of the box. Any other site is only visible after the user allows it in the panel, or when the user sends a tester request to it. |

**Remote code:** No. All code is packaged with the extension.

**Data usage:** Culprit doesn't collect or transmit user data: everything is processed and stored locally (see `PRIVACY.md`). Review the dashboard's data categories against that policy before ticking the boxes.

**Privacy policy URL:** publish `PRIVACY.md` (for example the GitHub file URL) and paste its link.

## Screenshots

Upload these from `store/screenshots/store-upload/` (1280×800 PNG, no transparency; the store allows 5):

1. `01-why.png`: a 401 traced back to the failed token refresh
2. `02-rerun.png`: the chain re-run with fresh data, 401 → 200
3. `03-export.png`: the chain turned into a Vitest test
4. `04-shape-changed.png`: a 200 whose response shape changed, on a watched endpoint
5. `05-compare.png`: diagnosis compared with the last success

**Small promo tile** (440×280): `promo-small.png`.

The WebP files in `store/screenshots/` (2560×1600, plus `featured.webp` at 1920×1080 and a sixth timeline shot) are high-resolution versions for the portfolio, case study and GitHub. The store doesn't accept WebP.
