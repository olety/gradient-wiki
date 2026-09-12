import { SELF, env, createExecutionContext, waitOnExecutionContext, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { renderMarkdown } from "../src/markdown";
import type { Env } from "../src/types";

const B = "https://gradient.wiki";
const MOD = "mod=test-mod-key";
const REASONS = ["fraud", "crime", "threat", "csam", "doxx", "defamation", "copyright", "secret", "other"];
type Reply = { verdict: "OK" | "VIOLATION"; category: number | null; quote: string | null };
type Case = { seq: number; ns: string; slug: string; rev: number; row: number | null; source: string; reason: string; note: string; quote: string | null; status: string; action: string; resolved_by: string | null };
const replies = new Map<string, Reply>();
const calls: Array<{ model: string; temperature: number; max_tokens: number; messages: Array<{ role: string; content: string }>; response_format: Record<string, unknown> }> = [];
const dnsCalls: string[] = [];
const blocked = new Set<string>();
const dnsErrors = new Set<string>();
const outages = new Map<string, number>();
const OK: Reply = { verdict: "OK", category: null, quote: null };
let counter = 0;

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://policy.test" && url.pathname === "/v1") {
      const request = JSON.parse(String(init?.body)) as typeof calls[number];
      calls.push(request);
      const target = request.messages[1]!.content.split(" ")[0]!;
      if (outages.has(target)) {
        const attempt = outages.get(target)!;
        outages.set(target, attempt + 1);
        if (attempt === 0) return new Response("unavailable", { status: 500 });
        throw new DOMException("timed out", "TimeoutError");
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies.get(target) ?? OK) } }] }));
    }
    if (url.origin === "https://security.cloudflare-dns.com") {
      const host = url.searchParams.get("name")!;
      dnsCalls.push(host);
      expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
      expect(url.searchParams.get("type")).toBe("A");
      return new Response(JSON.stringify({ Answer: [{ data: blocked.has(host) ? "0.0.0.0" : "1.1.1.1" }] }), { status: dnsErrors.has(host) ? 500 : 200 });
    }
    throw new Error("unmocked outbound fetch");
  });
});
afterAll(() => vi.restoreAllMocks());

function client() {
  const n = ++counter * 7919 + Math.floor(Math.random() * 1000);
  const ip = `172.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  const tag = `m${n}`;
  const path = `/p/lobby/${tag}`;
  const get = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    SELF.fetch(`${B}${path}`, { ...init, headers: { "cf-connecting-ip": ip, ...(init.headers ?? {}) } });
  const text = async (path: string, init?: RequestInit & { headers?: Record<string, string> }) => (await get(path, init)).text();
  const json = async <T>(path: string, init?: RequestInit & { headers?: Record<string, string> }) => (await get(path, init)).json<T>();
  const queue = async (all = false) => (await json<{ cases: Case[] }>(`/mod/queue.json?${MOD}&n=200${all ? "&all=1" : ""}`)).cases;
  const ownCases = async (all = false) => (await queue(all)).filter((c) => c.slug === tag);
  const direct = async (path: string, vars: Partial<Env>, init: RequestInit = {}) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${B}${path}`, { ...init, headers: { "cf-connecting-ip": ip } }) as Request<unknown, IncomingRequestCfProperties>, { ...env, ...vars }, ctx);
    return { res, done: () => waitOnExecutionContext(ctx) };
  };
  return { ip, tag, path, get, text, json, queue, ownCases, direct };
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 100 && !ready(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  expect(ready(value), "background policy work did not finish").toBe(true);
  return value;
}

async function flags(ns: string, slug: string, row = false) {
  const stub = env.NAMESPACE.get(env.NAMESPACE.idFromName(ns));
  return runInDurableObject(stub, async (_instance, state) => state.storage.sql.exec<{ flag_cat: number | null; flag_quote: string | null; flag_model: string | null; flag_at: number | null; kept_body: string | null }>(
    `SELECT flag_cat, flag_quote, flag_model, flag_at, kept_body FROM ${row ? "rows" : "revisions"} WHERE slug = ? ORDER BY ${row ? "n" : "rev"} DESC LIMIT 1`, slug).one());
}
const classified = (ns: string, slug: string, row = false) => until(() => flags(ns, slug, row), (f) => f.flag_at !== null);
const violation = (slug: string, category: number, quote = "short evidence") => replies.set(`lobby/${slug}`, { verdict: "VIOLATION", category, quote });

// Each write uses its own target so delayed policy work cannot consume another test's verdict.
describe("notice and the report door", () => {
  it("serves the exact bilingual notice in markdown, HTML and JSON", async () => {
    const { get, text, json } = client();
    const notice = await get("/notice");
    expect(notice.headers.get("content-type")).toContain("text/markdown");
    const body = await notice.text();
    expect(body.startsWith("# Notice\n")).toBe(true);
    expect(body).toContain("# お知らせ（法的表示）");
    expect(body).toContain("hello@gradient.wiki");
    expect(body).toContain("@therotobo");
    expect(body).toContain(`${B}/p/<ns>/<slug>?report=<reason>`);
    expect(await text("/notice.md")).toBe(body);
    for (const path of ["/notice.html", "/notice"]) {
      const res = await get(path, { headers: { accept: "text/html" } });
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("x-robots-tag")).toBeNull();
      const html = await res.text();
      expect(html).toContain("お知らせ（法的表示）");
      expect(html).toContain("Governing law");
      expect(html).toContain(`href="${B}/notice"`);
    }
    expect(await json("/notice.json")).toEqual({ url: `${B}/notice`, updated: "2026-09-13", categories: REASONS });
    const manual = await text("/");
    expect(manual.split("\n").length).toBeLessThanOrEqual(60);
    expect(manual).toContain("NOTICE   GET");
    expect(manual).toContain("REPORT   GET");
    expect(manual).toContain("Illegal under Japanese law is removed:");
    const robots = await text("/robots.txt");
    for (const line of ["Disallow: /*?report=", "Disallow: /*&report=", "Disallow: /*/report"]) expect(robots).toContain(`${line}\n`);
    expect(robots).not.toContain("Disallow: /notice");
    expect(await json("/.well-known/gradient-wiki")).toMatchObject({ notice: `${B}/notice`, report: `${B}/p/<ns>/<slug>?report=<reason>` });
    expect(await text("/log.html")).toContain(`href="${B}/notice"`);
    for (const name of ["notice", "mod"]) expect((await get(`/ns/new?name=${name}`)).status).toBe(409);
  });

  it("takes GET, form and JSON reports with exact receipts and private notes", async () => {
    const c = client();
    await c.get(`${c.path}?set=ordinary+text`);
    await classified("lobby", c.tag);
    const response = await c.get(`${c.path}?report=copyright&note=PRIVATE-NOTE&by=reporter`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.text()).toMatch(new RegExp(`^reported rev 1 ${B}${c.path} case \\d+\nnotice: ${B}/notice\n$`));
    const reported = await c.json<{ case: number }>(`${c.path}.json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ report: "other", rev: 1, note: "JSON-NOTE" }) });
    expect(reported).toMatchObject({ ok: true, action: "reported", rev: 1, row: null, url: `${B}${c.path}` });
    expect(typeof reported.case).toBe("number");
    await c.get(`${c.path}?add=one+row`);
    await classified("lobby", c.tag, true);
    const form = await c.get(c.path, { method: "POST", body: new URLSearchParams({ report: "other", row: "1", rev: "", note: "FORM-NOTE" }) });
    expect(await form.text()).toMatch(new RegExp(`^reported row 1 rev 2 ${B}${c.path} case \\d+\nnotice: ${B}/notice\n$`));
    const queue = await c.ownCases();
    expect(queue).toHaveLength(3);
    expect(queue.map((x) => x.note)).toEqual(expect.arrayContaining(["PRIVATE-NOTE", "JSON-NOTE", "FORM-NOTE"]));
    const log = await c.text("/log?n=100");
    expect(log).toContain(`lobby/${c.tag} report rev 1: copyright`);
    for (const note of ["PRIVATE-NOTE", "JSON-NOTE", "FORM-NOTE"]) expect(log).not.toContain(note);
    for (const suffix of [".json", "/history.json"]) expect(await c.text(c.path + suffix)).not.toContain("PRIVATE-NOTE");
  });

  it("rejects bad reasons and bad targets without creating cases", async () => {
    const c = client();
    await c.get(`${c.path}?set=ordinary`);
    for (const reason of ["", "spam", "insult"]) {
      const res = await c.get(`${c.path}?report=${reason}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe(`report needs ?report=<reason>: ${REASONS.join(" ")}\n`);
    }
    for (const target of ["rev=0", "rev=1.5", "row=-1", "row=word", "rev=1&row=1"]) expect((await c.get(`${c.path}?report=other&${target}`)).status).toBe(400);
    expect((await c.get(`${c.path}?report=other&rev=99`)).status).toBe(404);
    expect(await c.ownCases()).toHaveLength(0);
  });

  it("limits reports to ten per hour on top of write limits", async () => {
    const c = client();
    await c.get(`${c.path}?set=ordinary`);
    for (let i = 0; i < 10; i++) expect((await c.get(`${c.path}?report=other`)).status).toBe(200);
    const limited = await c.get(`${c.path}?report=other`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.text()).toContain("slow down: 10 reports per hour");
    expect(await c.ownCases()).toHaveLength(10);
    expect((await c.get(`${c.path}?set=still+can+write`)).status).toBe(200);
  });

  it("renders report forms and links without adding executable JavaScript", async () => {
    const c = client();
    await c.get(`${c.path}?set=ordinary`);
    const form = await c.get(`${c.path}/report`);
    expect(form.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await form.text();
    expect(html).toContain(`<form method="post" action="${B}${c.path}">`);
    for (const reason of REASONS) expect(html).toContain(`value="${reason}"`);
    for (const name of ["report", "rev", "row", "note", "by"]) expect(html).toContain(`name="${name}"`);
    expect(html).not.toMatch(/<script(?:\s[^>]*type="(?!application\/ld\+json)[^"]*")?>/);
    expect(await c.text(`${c.path}.html`)).toContain(`href="${B}${c.path}/report"`);
    expect(await c.text(`${c.path}/history.html`)).toContain(`?report=other&amp;rev=1`);
    const receipt = await c.text(`${c.path}?report=other`, { headers: { accept: "text/html" } });
    expect(receipt).toContain(`reported rev 1 ${B}${c.path} case `);
    expect(receipt).toContain(`notice: ${B}/notice`);
    expect(receipt).toContain(`<a href="${B}${c.path}">open the page</a>`);
  });

  it("keys the queue, paginates and resolves only a case on the named page", async () => {
    const c = client();
    expect((await c.get("/mod/queue")).status).toBe(401);
    expect((await c.get("/mod/queue.json?mod=wrong")).status).toBe(401);
    await c.get(`${c.path}?set=ordinary`);
    const first = await c.json<{ case: number }>(`${c.path}.json?report=other&note=first`);
    const second = await c.json<{ case: number }>(`${c.path}.json?report=copyright&note=second`);
    const text = await c.text(`/mod/queue?${MOD}&n=1`);
    expect(text).toContain(`case ${second.case} `);
    expect(text).toContain("more: ");
    const page = await c.json<{ cases: Case[]; before: number }>(`/mod/queue.json?${MOD}&n=1`);
    expect(page.cases[0]!.seq).toBe(second.case);
    const older = await c.json<{ cases: Case[] }>(`/mod/queue.json?${MOD}&before=${page.before}&n=1`);
    expect(older.cases[0]!.seq).toBe(first.case);
    expect((await c.get(`${c.path}-wrong?${MOD}&resolve=${first.case}`)).status).toBe(404);
    expect((await c.get(`${c.path}?${MOD}&resolve=${first.case}`)).status).toBe(200);
    expect((await c.ownCases()).map((x) => x.seq)).not.toContain(first.case);
    expect((await c.ownCases(true)).find((x) => x.seq === first.case)).toMatchObject({ status: "resolved", resolved_by: "moderator" });
    expect(await c.text("/log")).toContain(`lobby/${c.tag} resolve`);
  });
});

describe("post-receipt policy", () => {
  it("redacts category one, stores private evidence and restores the exact body", async () => {
    const c = client();
    const body = "first line\nsecond line\n";
    violation(c.tag, 1, "PRIVATE-QUOTE");
    const saved = await c.text(`${c.path}?set=${encodeURIComponent(body)}&by=writer&note=summary`);
    expect(saved).toMatch(new RegExp(`^saved rev 1 ${B}${c.path}\nundo: `));
    await until(() => c.text(c.path), (body) => body.startsWith("[redacted by policy fraud "));
    const f = await classified("lobby", c.tag);
    expect(f).toMatchObject({ flag_cat: 1, flag_quote: "PRIVATE-QUOTE", kept_body: body });
    expect(f.flag_model).toBe("openai/gpt-oss-safeguard-20b");
    expect(typeof f.flag_at).toBe("number");
    const cases = await until(() => c.ownCases(true), (cases) => cases.some((x) => x.status === "resolved"));
    expect(cases[0]).toMatchObject({ source: "auto", status: "resolved", resolved_by: "policy" });
    expect(await c.text("/log")).toContain(`lobby/${c.tag} policy-redact rev 1: fraud`);
    for (const suffix of [".json", "/history.json"]) {
      const served = await c.text(c.path + suffix);
      for (const secret of ["PRIVATE-QUOTE", "kept_body", "flag_quote", "first line"]) expect(served).not.toContain(secret);
    }
    const dump = new TextDecoder().decode(await (await c.get("/p/lobby.jsonl")).arrayBuffer());
    expect(dump).not.toContain("PRIVATE-QUOTE");
    expect(dump).not.toContain('"kept_body"');
    expect(await c.text("/log")).not.toContain("PRIVATE-QUOTE");
    expect((await c.get(`${c.path}?${MOD}&unredact=1`)).status).toBe(200);
    expect(await c.text(c.path)).toBe(body);
    expect(await c.text(`${c.path}?rev=1`)).toBe(body);
    expect(await c.text("/log")).toContain(`lobby/${c.tag} unredact`);
    expect((await c.json<Array<{ redacted: boolean }>>(`${c.path}/history.json`))[0]!.redacted).toBe(false);
    const request = calls.find((x) => x.messages[1]!.content.startsWith(`lobby/${c.tag} rev 1\n`))!;
    expect(request).toMatchObject({ temperature: 0, max_tokens: 400, model: "openai/gpt-oss-safeguard-20b", response_format: { type: "json_schema", json_schema: { name: "verdict", strict: true } } });
    expect(request.messages[0]!.role).toBe("system");
    expect(request.messages[0]!.content.startsWith("Reasoning: low\n")).toBe(true);
    expect(request.messages[1]!.content).toBe(`lobby/${c.tag} rev 1\nby: writer\nnote: summary\nreport: none\n---\n${body}`);
  });

  it("leaves category six alone on write, then redacts on a defamation report", async () => {
    const c = client();
    violation(c.tag, 6);
    await c.get(`${c.path}?set=named+person+claim`);
    await until(() => c.ownCases(), (cases) => cases.length === 1);
    expect(await c.text(c.path)).toBe("named person claim");
    expect((await c.ownCases())[0]).toMatchObject({ source: "auto", status: "open" });
    const reported = await c.json<{ case: number }>(`${c.path}.json?report=defamation`);
    await until(() => c.text(c.path), (body) => body.startsWith("[redacted by policy defamation "));
    await until(() => c.ownCases(true), (cases) => cases.some((x) => x.seq === reported.case && x.status === "resolved"));
  });

  it.each(["copyright", "other"])("keeps %s reports open even when the model emits a violation", async (reason) => {
    const c = client();
    await c.get(`${c.path}?set=claim+for+human`);
    await classified("lobby", c.tag);
    violation(c.tag, 1);
    await c.get(`${c.path}?report=${reason}`);
    await until(() => flags("lobby", c.tag), (f) => f.flag_cat === 1);
    expect(await c.text(c.path)).toBe("claim for human");
    expect((await c.ownCases())[0]).toMatchObject({ status: "open", reason });
  });

  it("checks secret reports locally and preserves author and moderator originals", async () => {
    const c = client();
    const secret = "key AKIAIOSFODNN7EXAMPLE";
    const saved = await c.json<{ undo: string }>(`${c.path}.json?set=${encodeURIComponent(secret)}`);
    await classified("lobby", c.tag);
    const before = calls.filter((x) => x.messages[1]!.content.startsWith(`lobby/${c.tag} `)).length;
    await c.get(`${c.path}?report=secret`);
    await until(() => c.text(c.path), (body) => body.startsWith("[redacted by policy secret "));
    expect(calls.filter((x) => x.messages[1]!.content.startsWith(`lobby/${c.tag} `))).toHaveLength(before);
    await c.get(`${c.path}?${MOD}&unredact=1`);
    expect(await c.text(c.path)).toBe(secret);
    await c.get(saved.undo.slice(B.length));
    expect((await flags("lobby", c.tag)).kept_body).toBe(secret);
    await c.get(`${c.path}?${MOD}&unredact=1`);
    await c.get(`${c.path}?${MOD}&redact=1`);
    expect((await flags("lobby", c.tag)).kept_body).toBe(secret);
    await c.get(`${c.path}?${MOD}&unredact=1`);
    expect(await c.text(c.path)).toBe(secret);
  });

  it("keeps a secret report open when the target is not a credential", async () => {
    const c = client();
    await c.get(`${c.path}?set=ordinary`);
    await classified("lobby", c.tag);
    await c.get(`${c.path}?report=secret`);
    expect((await c.ownCases())[0]).toMatchObject({ reason: "secret", status: "open" });
    expect(await c.text(c.path)).toBe("ordinary");
  });

  it("classifies rows, targets add revisions and restores row ids and history", async () => {
    const c = client();
    violation(c.tag, 2);
    await c.get(`${c.path}?add=row+evidence&id=stable`);
    await until(() => c.text(c.path), (body) => body.includes("[redacted by policy crime "));
    expect((await classified("lobby", c.tag, true)).kept_body).toBe("row evidence");
    await c.get(`${c.path}?${MOD}&unredactrow=1`);
    expect(await c.json(`${c.path}.json`)).toMatchObject({ rows: [{ n: 1, id: "stable", body: "row evidence", redacted: false }] });
    await c.get(`${c.path}?report=crime&rev=1`);
    await until(() => c.text(c.path), (body) => body.includes("[redacted by policy crime "));
    await c.get(`${c.path}?${MOD}&unredact=1`);
    expect(await c.json(`${c.path}.json`)).toMatchObject({ rows: [{ n: 1, id: "stable", body: "row evidence", redacted: false }] });
  });

  it("does nothing on OK and skips unchanged writes and duplicate rows", async () => {
    const c = client();
    await c.get(`${c.path}?set=ordinary`);
    expect((await classified("lobby", c.tag)).flag_cat).toBe(0);
    await c.get(`${c.path}?add=row&id=stable`);
    await classified("lobby", c.tag, true);
    await c.get(`${c.path}?set=ordinary`);
    await c.get(`${c.path}?add=row&id=stable`);
    expect(calls.filter((x) => x.messages[1]!.content.startsWith(`lobby/${c.tag} `))).toHaveLength(2);
    expect(await c.ownCases(true)).toHaveLength(0);
    expect(await c.text(c.path)).toBe("ordinary\n\n## rows\n- row\n");
  });

  it("does not classify private writes but accepts keyed reports without public logs", async () => {
    const c = client();
    const ns = `private-${c.tag}`;
    const created = await c.json<{ key: string }>(`/ns/new.json?name=${ns}&private=1`);
    const path = `/p/${ns}/${c.tag}`;
    replies.set(`${ns}/${c.tag}`, { verdict: "VIOLATION", category: 5, quote: "PRIVATE-QUOTE" });
    await c.get(`${path}?key=${created.key}&set=private+body`);
    expect((await flags(ns, c.tag)).flag_at).toBeNull();
    expect((await c.get(`${path}?report=doxx`)).status).toBe(401);
    expect((await c.get(`${path}/report`)).status).toBe(401);
    await c.get(`${path}?key=${created.key}&report=doxx&note=PRIVATE-REPORT`);
    await until(() => c.text(`${path}?key=${created.key}`), (body) => body.startsWith("[redacted by policy doxx "));
    expect((await c.ownCases(true))[0]).toMatchObject({ ns, source: "report", note: "PRIVATE-REPORT" });
    await c.get(`${path}?key=${created.key}&${MOD}&unredact=1`);
    expect(await c.text(`${path}?key=${created.key}`)).toBe("private body");
    for (const feed of ["/log", "/changes", "/sitemap.xml"]) expect(await c.text(feed)).not.toContain(ns);
  });

  it("accepts reports in public keyed namespaces without the write key", async () => {
    const c = client();
    const ns = `public-${c.tag}`;
    const { key } = await c.json<{ key: string }>(`/ns/new.json?name=${ns}`);
    await c.get(`/p/${ns}/${c.tag}?key=${key}&set=ordinary`);
    expect((await c.get(`/p/${ns}/${c.tag}?report=other`)).status).toBe(200);
  });

  it("keeps reports when the classifier is disabled and honors the pause gate", async () => {
    const c = client();
    const saved = await c.direct(`${c.path}?set=ordinary`, { OPENROUTER_KEY: "" });
    expect(saved.res.status).toBe(200);
    await saved.done();
    expect((await flags("lobby", c.tag)).flag_at).toBeNull();
    const reported = await c.direct(`${c.path}?report=fraud`, { OPENROUTER_KEY: "" });
    expect(reported.res.status).toBe(200);
    await reported.done();
    expect((await c.ownCases())[0]).toMatchObject({ reason: "fraud", status: "open" });
    const paused = await c.direct(`${c.path}?report=other`, { PAUSE_WRITES: "1" });
    expect(paused.res.status).toBe(503);
    await paused.done();
    expect(await c.ownCases()).toHaveLength(1);
  });
  it("returns the saved receipt unchanged through a classifier outage", async () => {
    const c = client();
    outages.set(`lobby/${c.tag}`, 0);
    const result = await c.direct(`${c.path}?set=outage+body`, {});
    expect(result.res.status).toBe(200);
    const receipt = await result.res.text();
    expect(receipt).toMatch(new RegExp(`^saved rev 1 ${B}${c.path}\nundo: `));
    expect(await c.text(c.path)).toBe("outage body");
    await result.done();
    expect(outages.get(`lobby/${c.tag}`)).toBe(2);
    expect(await c.text(c.path)).toBe("outage body");
    expect((await flags("lobby", c.tag)).flag_at).toBeNull();
    expect(await c.ownCases(true)).toHaveLength(0);
    const report = await c.direct(`${c.path}?report=fraud`, {});
    await report.done();
    expect((await c.ownCases())[0]).toMatchObject({ reason: "fraud", status: "open" });
  });

  it("keeps the latest body when an older revision is redacted and restored", async () => {
    const c = client();
    await c.get(`${c.path}?set=older`);
    await classified("lobby", c.tag);
    await c.get(`${c.path}?set=newer`);
    await classified("lobby", c.tag);
    violation(c.tag, 3);
    await c.get(`${c.path}?report=threat&rev=1`);
    await until(() => c.text(`${c.path}?rev=1`), (body) => body.startsWith("[redacted by policy threat "));
    expect(await c.text(c.path)).toBe("newer");
    await c.get(`${c.path}?${MOD}&unredact=1`);
    expect(await c.text(`${c.path}?rev=1`)).toBe("older");
    expect(await c.text(c.path)).toBe("newer");
  });

});

describe("the link screen", () => {
  it("refuses listed links on every write dialect and records only the host", async () => {
    const c = client();
    const host = `${c.tag}.blocked.test`;
    blocked.add(host);
    const body = `[link](https://${host}/PRIVATE-PATH)`;
    const writes: Array<[string, RequestInit & { headers?: Record<string, string> }]> = [
      [`${c.path}?set=${encodeURIComponent(body)}`, {}],
      [`${c.path}?add=${encodeURIComponent(body)}`, {}],
      [c.path, { method: "PUT", body }],
      [c.path, { method: "POST", body: new URLSearchParams({ add: body }) }],
      [c.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: body }) }],
      [`/wiki.pl?title=${c.tag}&oldtime=1&text=${encodeURIComponent(body)}`, {}],
      ["/wiki.cgi", { method: "POST", body: new URLSearchParams({ title: c.tag, oldtime: "1", text: body }) }],
    ];
    for (const [path, init] of writes) {
      const res = await c.get(path, init);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe(`refused: link to ${host} is on a malware or phishing blocklist. see ${B}/notice\n`);
    }
    expect((await c.get(c.path)).status).toBe(404);
    const log = await c.text("/log?n=100");
    expect(log).toContain(`refuse lobby/${c.tag}: ${host}`);
    expect(log).not.toContain("PRIVATE-PATH");
    expect(dnsCalls.filter((x) => x === host)).toHaveLength(1);
  });

  it("saves clean links, exempts the site and checks at most twenty distinct hosts", async () => {
    const c = client();
    const hosts = Array.from({ length: 22 }, (_, n) => `${c.tag}-${n}.clean.test`);
    const body = [B, `https://${hosts[0]}/one`, `http://${hosts[0]}/two`, ...hosts.map((h) => `https://${h}/`)].join(" ");
    expect((await c.get(`${c.path}?set=${encodeURIComponent(body)}`)).status).toBe(200);
    expect(await c.text(c.path)).toBe(body);
    expect(dnsCalls.filter((x) => hosts.includes(x))).toHaveLength(20);
    expect(dnsCalls).not.toContain("gradient.wiki");
  });

  it("fails open on DNS errors and honors LINK_SCREEN=0", async () => {
    const c = client();
    const host = `${c.tag}.error.test`;
    dnsErrors.add(host);
    expect((await c.get(`${c.path}?set=${encodeURIComponent(`https://${host}/`)}`)).status).toBe(200);
    const disabled = `${c.tag}.disabled.test`;
    blocked.add(disabled);
    const result = await c.direct(`${c.path}?set=${encodeURIComponent(`https://${disabled}/`)}`, { LINK_SCREEN: "0" });
    expect(result.res.status).toBe(200);
    await result.done();
    expect(dnsCalls).not.toContain(disabled);
    expect(await c.text(c.path)).toBe(`https://${disabled}/`);
  });
});


describe("case mail", () => {
  it("batches new open cases with an alarm, skips resolved cases and retries a failed send", async () => {
    const c = client();
    const fh = env.FIREHOSE.get(env.FIREHOSE.idFromName("firehose"));
    await fh.flushCaseMail();
    await c.get(`${c.path}?set=ordinary`);
    const first = await c.json<{ case: number }>(`${c.path}.json?report=copyright&note=mail-note`);
    const second = await c.json<{ case: number }>(`${c.path}.json?report=other`);
    await c.get(`${c.path}?${MOD}&resolve=${second.case}`);
    const due = await runInDurableObject(fh, async (_instance, state) => state.storage.getAlarm());
    expect(due).not.toBeNull();
    expect(due! - Date.now()).toBeLessThanOrEqual(600_000);
    const cursor = await runInDurableObject(fh, async (_instance, state) => state.storage.get<number>("caseMailedSeq"));
    await runInDurableObject(fh, async (instance, state) => {
      const send = vi.spyOn(instance, "flushCaseMail").mockRejectedValueOnce(new Error("temporary"));
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(await state.storage.get<number>("caseMailedSeq")).toBe(cursor);
      expect(await state.storage.getAlarm()).not.toBeNull();
      send.mockRestore();
    });
    expect(await fh.flushCaseMail()).toBe(1);
    expect(await fh.flushCaseMail()).toBe(0);
    expect(await runDurableObjectAlarm(fh)).toBe(true);
    expect(await runInDurableObject(fh, async (_instance, state) => state.storage.getAlarm())).toBeNull();
    expect((await c.ownCases())[0]!.seq).toBe(first.case);
  });

  it("does not turn a report URL from a stranger into a clickable action", () => {
    const html = renderMarkdown(`[report](https://gradient.wiki/p/lobby/x?report=other) https://gradient.wiki/p/lobby/x?report=fraud`);
    expect(html).not.toContain("href=");
  });
});
