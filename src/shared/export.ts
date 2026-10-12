// Exports for taking a captured chain elsewhere: a Postman collection (variables and scripts written for
// you), a Vitest regression test, and HAR. Secrets become {{variables}} or process.env.* placeholders and
// everything passes through scrub(), so no captured token or password leaves in the output.
import type { ApiRequest, Headers, Link, RawData } from "./types";
import { isSensitive, redactBody, redactHeaders, redactUrl, scrub } from "./http";
import { placeValue, segments, type Step } from "./chain";

// "response.user.id" -> "userId", "response.access_token" -> "accessToken", "header.x-csrf-token" -> "xCsrfToken"
export function varName(path: string): string {
  const parts = path.replace(/^(response|header)\./, "").replace(/\[\d+\]/g, "").split(".");
  const last = parts.at(-1)!;
  const base = /^id$/i.test(last) && parts.length > 1 ? `${parts.at(-2)}_id` : last;
  return base.replace(/[-_\s]+(\w)/g, (_, c: string) => c.toUpperCase()).replace(/[^\w]/g, "") || "value";
}

const commonOrigin = (steps: Step[]) => {
  const origins = new Set(steps.map((s) => new URL(s.url).origin));
  return origins.size === 1 ? [...origins][0] : undefined;
};

// Links into step i from steps that come before it in this export.
const incoming = (steps: Step[], i: number) => {
  const index = new Map(steps.map((s, j) => [s.id, j]));
  return steps[i].links.filter((l) => (index.get(l.from) ?? i) < i).map((l) => ({ link: l, from: index.get(l.from)! }));
};

function jsonAt(body: string | undefined, path: string): unknown {
  try {
    let v: unknown = JSON.parse(body ?? "");
    for (const key of segments(path)) v = (v as Record<string | number, unknown>)?.[key];
    return v;
  } catch {
    return undefined;
  }
}

// Placeholders in a URL survive encoding by URL/URLSearchParams.
const unbrace = (s: string) => s.replace(/%7B%7B/gi, "{{").replace(/%7D%7D/gi, "}}");

// ---- Postman ----

export function toPostman(steps: Step[], name: string): string {
  const vars = new Map<string, string>();
  const varOf = new Map<string, string>(); // "stepId fromPath" -> variable
  const ensure = (l: Link) => {
    const key = `${l.from} ${l.fromPath}`;
    if (!varOf.has(key)) {
      let v = varName(l.fromPath);
      for (let n = 2; vars.has(v); n++) v = `${varName(l.fromPath)}${n}`;
      vars.set(v, "");
      varOf.set(key, v);
    }
    return varOf.get(key)!;
  };
  const secret = (name: string) => {
    const v = varName(name);
    if (!vars.has(v)) vars.set(v, "");
    return `{{${v}}}`;
  };
  const base = commonOrigin(steps);
  if (base) vars.set("baseUrl", base);

  const item = steps.map((s, i) => {
    let step = s;
    const numeric: string[] = []; // body placeholders that replace a number, so they go in unquoted
    for (const { link } of incoming(steps, i)) {
      const placeholder = `{{${ensure(link)}}}`;
      if (link.to.startsWith("body.") && typeof jsonAt(step.body, link.to.slice(5)) === "number") numeric.push(placeholder);
      step = placeValue(step, link.to, placeholder) ?? step;
    }

    // Values this step hands to later steps, captured by a test script.
    const exec = [
      ...new Set(
        steps.slice(i + 1).flatMap((later) =>
          later.links
            .filter((l) => l.from === s.id)
            .map((l) => {
              const get = l.fromPath.startsWith("header.")
                ? `pm.response.headers.get(${JSON.stringify(l.fromPath.slice(7))})`
                : `pm.response.json()${segments(l.fromPath.slice(9)).map((k) => `[${JSON.stringify(k)}]`).join("")}`;
              return `pm.collectionVariables.set(${JSON.stringify(ensure(l))}, ${get});`;
            })
        )
      )
    ];

    const u = new URL(step.url);
    for (const [k, v] of u.searchParams) if (isSensitive(k) && !v.startsWith("{{")) u.searchParams.set(k, secret(k));
    let url = unbrace(u.toString());
    if (base && url.startsWith(base)) url = `{{baseUrl}}${url.slice(base.length)}`;

    const header = Object.entries({ ...step.headers, ...(step.origin ? { origin: step.origin } : {}) }).map(([key, value]) => ({
      key,
      value: isSensitive(key) && !value.includes("{{") ? secret(key) : value
    }));

    let raw = step.body;
    if (raw) {
      try {
        raw = JSON.stringify(JSON.parse(raw, (k, v) => (k && isSensitive(k) && !String(v).includes("{{") ? secret(k) : v)), null, 2);
        for (const p of numeric) raw = raw.replaceAll(`"${p}"`, p);
      } catch {
        raw = redactBody(raw);
      }
    }

    return {
      name: s.label,
      request: {
        method: step.method,
        header,
        url,
        ...(raw ? { body: { mode: "raw", raw, options: { raw: { language: "json" } } } } : {})
      },
      ...(exec.length ? { event: [{ listen: "test", script: { type: "text/javascript", exec } }] } : {})
    };
  });

  const collection = {
    info: { name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    variable: [...vars].map(([key, value]) => ({ key, value })),
    item
  };
  return scrub(JSON.stringify(collection, null, 2));
}

// ---- Vitest ----

const accessor = (path: string) =>
  segments(path)
    .map((k) => (typeof k === "number" ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `?.${k}` : `?.[${JSON.stringify(k)}]`))
    .join("");
const envName = (name: string) => name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
const tpl = (s: string) => s.replace(/[`\\]/g, "\\$&").replace(/\$\{/g, "\\${");

// A regression test that replays the chain and expects the last call to succeed. The server comes from
// API_BASE_URL, not BASE_URL: Vite and Vitest set BASE_URL to "/" themselves.
export function toVitest(steps: Step[], title: string, statuses: (number | undefined)[]): string {
  const base = commonOrigin(steps);
  const env = new Set<string>();
  const needsJson = new Set<number>();
  const lines: string[] = [];

  steps.forEach((s, i) => {
    const n = i + 1;
    const exprs = new Map<string, string>(); // marker -> JS expression
    const mark = (expr: string) => {
      const m = `__CULPRIT_${exprs.size}__`;
      exprs.set(m, expr);
      return m;
    };
    let step = s;
    for (const { link, from } of incoming(steps, i)) {
      const expr = link.fromPath.startsWith("header.")
        ? `r${from + 1}.headers.get(${JSON.stringify(link.fromPath.slice(7))})`
        : `s${from + 1}${accessor(link.fromPath.slice(9))}`;
      if (!link.fromPath.startsWith("header.")) needsJson.add(from + 1);
      step = placeValue(step, link.to, mark(expr)) ?? step;
    }
    const secretExpr = (name: string) => {
      env.add(envName(name));
      return mark(`process.env.${envName(name)} ?? ""`);
    };

    // Inline markers become ${expr} in template literals; a value that is only a marker becomes the expression.
    const inline = (text: string) => {
      let out = tpl(text);
      for (const [m, expr] of exprs) out = out.replaceAll(m, `\${${expr}}`);
      return `\`${out}\``;
    };
    const value = (text: string) => (exprs.has(text) ? exprs.get(text)! : [...exprs.keys()].some((m) => text.includes(m)) ? inline(text) : JSON.stringify(text));

    const u = new URL(step.url);
    for (const [k, v] of u.searchParams) if (isSensitive(k) && !v.startsWith("__CULPRIT_")) u.searchParams.set(k, secretExpr(k));
    let url = u.toString();
    url = base && url.startsWith(base) ? inline(url.slice(base.length)).replace(/^`/, "`${API_BASE_URL}") : inline(url);

    const headers = Object.entries({ ...step.headers, ...(step.origin ? { origin: step.origin } : {}) }).map(([k, v]) => {
      const val = isSensitive(k) && !v.includes("__CULPRIT_") ? secretExpr(k) : v;
      return `${JSON.stringify(k)}: ${value(val)}`;
    });

    let body: string | undefined;
    if (step.body && !["GET", "HEAD"].includes(step.method.toUpperCase())) {
      try {
        const json = JSON.parse(step.body, (k, v) => (k && isSensitive(k) && !String(v).includes("__CULPRIT_") ? secretExpr(k) : v));
        body = JSON.stringify(json, null, 2);
        for (const [m] of exprs) body = body.replaceAll(`"${m}"`, m);
        for (const [m, expr] of exprs) body = body.replaceAll(m, expr);
        body = `JSON.stringify(${body.replace(/\n/g, "\n    ")})`;
      } catch {
        body = inline(redactBody(step.body));
      }
    }

    const options = [`method: ${JSON.stringify(step.method)}`, `headers: { ${headers.join(", ")} }`, ...(body ? [`body: ${body}`] : [])];
    lines.push(`  // ${n}. ${s.label}`, `  const r${n} = await fetch(${url}, { ${options.join(", ")} });`);
    const last = i === steps.length - 1;
    if (last) {
      lines.push(`  expect(r${n}.ok, "this call returned ${statuses[i] ?? "an error"} when it was captured").toBe(true);`);
    } else if (statuses[i] !== undefined) {
      lines.push(`  expect(r${n}.status).toBe(${statuses[i]});`);
    }
    lines.push("");
  });

  // Parse the responses later steps read from.
  const out = lines.map((line) => {
    const m = line.match(/^ {2}const r(\d+) = /);
    return m && needsJson.has(Number(m[1])) ? `${line}\n  const s${m[1]} = await r${m[1]}.clone().json();` : line;
  });

  const header = [
    "// Generated by Culprit from a captured chain of API calls.",
    `// Run: ${base ? `API_BASE_URL=${base} ` : ""}npx vitest run <this file>`,
    ...(env.size ? [`// Secrets are read from the environment: ${[...env].join(", ")}`] : []),
    'import { expect, test } from "vitest";',
    "",
    ...(base ? [`const API_BASE_URL = process.env.API_BASE_URL ?? ${JSON.stringify(base)};`, ""] : []),
    `test(${JSON.stringify(title)}, async () => {`
  ];
  return scrub([...header, ...out.slice(0, -1), "});", ""].join("\n"));
}

// ---- HAR ----

const pairs = (h: Headers = {}) => Object.entries(redactHeaders(h)).map(([name, value]) => ({ name, value }));

// HAR 1.2 for any HAR viewer (DevTools, Charles…). Same masking as Copy report.
export function toHar(records: ApiRequest[], raws: Record<string, RawData | undefined>, version: string): string {
  const entries = records.map((r) => {
    const raw = raws[r.id];
    const url = redactUrl(raw?.url ?? r.url);
    const reqType = r.requestHeaders?.["content-type"] ?? "";
    const resType = r.responseHeaders?.["content-type"] ?? "";
    return {
      startedDateTime: new Date(r.startedAt).toISOString(),
      time: r.durationMs ?? 0,
      request: {
        method: r.method,
        url,
        httpVersion: "HTTP/1.1",
        headers: pairs(r.requestHeaders),
        queryString: [...new URL(url).searchParams].map(([name, value]) => ({ name, value })),
        cookies: [],
        headersSize: -1,
        bodySize: -1,
        ...(raw?.requestBody ? { postData: { mimeType: reqType, text: redactBody(raw.requestBody) } } : {})
      },
      response: {
        status: r.status ?? 0,
        statusText: r.statusText ?? r.error ?? "",
        httpVersion: "HTTP/1.1",
        headers: pairs(r.responseHeaders),
        cookies: [],
        content: { size: -1, mimeType: resType, ...(raw?.responseBody ? { text: redactBody(raw.responseBody) } : {}) },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
        ...(r.error ? { _error: r.error } : {})
      },
      cache: {},
      timings: { send: 0, wait: r.durationMs ?? 0, receive: 0 }
    };
  });
  return scrub(JSON.stringify({ log: { version: "1.2", creator: { name: "Culprit", version }, entries } }, null, 2));
}
