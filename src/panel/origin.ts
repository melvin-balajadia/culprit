// fetch() can't set Origin, and by default ours is chrome-extension://…, which server CORS allowlists reject.
// A session rule rewrites it on the extension's own requests (tester and chain re-runs) so a replay looks like
// the app's call. An empty origin removes the header, like cURL.
export function setOriginRule(origin: string) {
  const { HeaderOperation, ResourceType, RuleActionType } = chrome.declarativeNetRequest;
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        action: {
          type: RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            origin
              ? { header: "origin", operation: HeaderOperation.SET, value: origin }
              : { header: "origin", operation: HeaderOperation.REMOVE }
          ]
        },
        condition: {
          initiatorDomains: [chrome.runtime.id], // only this extension's own requests, never the page's
          resourceTypes: [ResourceType.XMLHTTPREQUEST]
        }
      }
    ]
  });
}

// Host permission for every host in the list, asked once. Must be the first await in a click handler.
// URLs that don't parse (an edited chain step) are skipped; sending them reports the error per step.
export const requestHosts = (urls: string[]) =>
  chrome.permissions
    .request({ origins: [...new Set(urls.flatMap((u) => (URL.canParse(u) ? [`${new URL(u).protocol}//${new URL(u).hostname}/*`] : [])))] })
    .catch(() => false);
