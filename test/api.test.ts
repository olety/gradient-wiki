import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { INBOX_BODY, SEED_PAGES } from "../src/namespace";
import { renderMarkdown } from "../src/markdown";

// Every test gets its own client IP (own rate-limit buckets) and its own slug prefix, so the
// suite does not depend on per-test storage isolation and reads like real traffic.

const B = "https://gradient.wiki";
const UNDO = /^undo: (\S+\?undo=[A-Za-z0-9_-]{22})$/;
let counter = 0;

function client() {
  const n = ++counter * 7919 + Math.floor(Math.random() * 1000);
  const ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  const tag = `t${n}`;
  const get = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    SELF.fetch(`${B}${path}`, { ...init, headers: { "cf-connecting-ip": ip, ...(init.headers ?? {}) } });
  const text = async (path: string, init?: RequestInit & { headers?: Record<string, string> }) => (await get(path, init)).text();
  const json = async <T>(path: string, init?: RequestInit & { headers?: Record<string, string> }) => (await get(path, init)).json<T>();
  const ns = async (name: string, isPrivate = false) => (await json<{ key: string }>(`/ns/new.json?name=${name}${isPrivate ? "&private=1" : ""}`)).key;
  /** Asserts a write receipt: first line exact, last line an undo link. Returns the undo URL path. */
  const receipt = async (path: string, first: string, init?: RequestInit & { headers?: Record<string, string> }) => {
    const lines = (await text(path, init)).trimEnd().split("\n");
    expect(lines[0]).toBe(first);
    const m = UNDO.exec(lines[lines.length - 1]!);
    expect(m, `undo line missing in: ${lines.join(" | ")}`).not.toBeNull();
    return { lines, undoPath: m![1]!.slice(B.length) };
  };
  return { ip, tag, get, text, json, ns, receipt };
}

describe("front door", () => {
  it("serves the manual as text to non-browsers and HTML to browsers", async () => {
    const { get, text } = client();
    const res = await get("/");
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body.split("\n").length).toBeLessThanOrEqual(60);
    expect(body).toContain("accepts writes over GET on purpose");
    expect(body).toContain("/p/lobby/inbox?add=");
    expect(body).toContain("@therotobo");
    expect(body).toContain("UNDO     GET");
    expect(body).toContain("saved with a warning; every write receipt ends with an undo link");
    expect(body).not.toContain("refused");
    const html = await get("/", { headers: { accept: "text/html" } });
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("<title>gradient.wiki</title>");
    expect(await text("/llms.txt")).toContain("READ ");
  });

  it("publishes robots.txt, the declaration and a clock", async () => {
    const { get, text, json } = client();
    const robots = await text("/robots.txt");
    expect(robots).toContain("Disallow: /*?set=");
    expect(robots).toContain("Disallow: /*?undo=");
    const decl = await json<{ accepts_writes_via: string[]; note: string }>("/.well-known/gradient-wiki");
    expect(decl.accepts_writes_via).toContain("GET query string");
    expect(decl.note).toContain("block this domain");
    expect(await text("/time")).toMatch(/^\d{4}-\d\d-\d\dT\S+ \d+\n$/);
    expect((await get("/nope")).status).toBe(404);
    expect((await get("/p/lobby/x", { method: "DELETE" })).status).toBe(405);
  });

  it("sets the shared headers on every response", async () => {
    const { get, tag } = client();
    const res = await get(`/p/lobby/${tag}/hello?set=hi`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-accepts-writes")).toBe("GET,POST,PUT");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const read = await get(`/p/lobby/${tag}/hello`);
    expect(read.headers.get("x-rev")).toBe("1");
    expect(read.headers.get("x-robots-tag")).toBeNull();
    expect(read.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("pages", () => {
  it("writes with a bare GET, reads back, and dedupes identical bodies", async () => {
    const { get, text, receipt, tag } = client();
    const u = `${B}/p/lobby/${tag}/hello`;
    await receipt(`/p/lobby/${tag}/hello?set=hello+world&by=tester`, `saved rev 1 ${u}`);
    expect(await text(`/p/lobby/${tag}/hello?set=hello+world`)).toBe(`unchanged rev 1 ${u}\n`);
    await receipt(`/p/lobby/${tag}/hello?set=hello+again`, `saved rev 2 ${u}`);
    const res = await get(`/p/lobby/${tag}/hello`);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("hello again");
    expect(await text(`/p/lobby/${tag}/hello?rev=1`)).toBe("hello world");
    expect((await get(`/p/lobby/${tag}/hello?rev=9`)).status).toBe(404);
    expect((await get(`/p/lobby/${tag}/missing`)).status).toBe(404);
  });

  it("negotiates the format by suffix and Accept", async () => {
    const { get, json, tag } = client();
    const slug = `${tag}/fmt`;
    await get(`/p/lobby/${slug}?set=**bold**+and+%3Cb%3Eraw%3C%2Fb%3E&by=a&note=first`);
    const j = await json<Record<string, unknown>>(`/p/lobby/${slug}.json`);
    expect(j).toMatchObject({ ns: "lobby", slug, rev: 1, by: "a", note: "first", body: "**bold** and <b>raw</b>", url: `${B}/p/lobby/${slug}` });
    const h = await (await get(`/p/lobby/${slug}.html`)).text();
    expect(h).toContain("<strong>bold</strong>");
    expect(h).toContain("&lt;b&gt;raw&lt;/b&gt;");
    expect(h).not.toContain("<b>raw</b>");
    const negotiated = await get(`/p/lobby/${slug}`, { headers: { accept: "text/html,*/*" } });
    expect(negotiated.headers.get("content-type")).toContain("text/html");
    const receipt = await json<Record<string, unknown>>(`/p/lobby/${slug}.json?set=changed`);
    expect(receipt).toMatchObject({ ok: true, action: "saved", rev: 2, url: `${B}/p/lobby/${slug}` });
    expect(receipt.undo).toMatch(new RegExp(`^${B}/p/lobby/${slug}\\?undo=[A-Za-z0-9_-]{22}$`));
    expect(receipt).not.toHaveProperty("warning");
  });

  it("appends rows without overwriting and dedupes on id", async () => {
    const { get, text, json, receipt, tag } = client();
    const slug = `${tag}/table`;
    const u = `${B}/p/lobby/${slug}`;
    await receipt(`/p/lobby/${slug}?add=row+one&by=w1`, `added row 1 rev 1 ${u}`);
    await receipt(`/p/lobby/${slug}?add=row+two&id=r2`, `added row 2 rev 2 ${u}`);
    expect(await text(`/p/lobby/${slug}?add=row+two+again&id=r2`)).toBe(`duplicate row 2 rev 2 ${u}\n`);
    expect(await text(`/p/lobby/${slug}`)).toBe("\n\n## rows\n- row one\n- row two\n");
    const j = await json<{ rows: Array<{ n: number; id: string | null; body: string; redacted: boolean }> }>(`/p/lobby/${slug}.json`);
    expect(j.rows.map((r) => [r.n, r.id, r.body, r.redacted])).toEqual([[1, null, "row one", false], [2, "r2", "row two", false]]);
    await get(`/p/lobby/${slug}?set=a+heading`);
    expect(await text(`/p/lobby/${slug}`)).toBe("a heading\n\n## rows\n- row one\n- row two\n");
  });

  it("accepts PUT and POST for shell agents", async () => {
    const { get, text, receipt, tag } = client();
    const slug = `${tag}/shell`;
    const u = `${B}/p/lobby/${slug}`;
    await receipt(`/p/lobby/${slug}`, `saved rev 1 ${u}`, { method: "PUT", body: "put body", headers: { "x-by": "putter" } });
    await receipt(`/p/lobby/${slug}`, `saved rev 2 ${u}`, { method: "POST", body: new URLSearchParams({ set: "form body", by: "former" }) });
    await receipt(`/p/lobby/${slug}`, `added row 1 rev 3 ${u}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ add: "json row", id: "j1" }) });
    await receipt(`/p/lobby/${slug}`, `saved rev 4 ${u}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "raw text becomes set" });
    expect((await get(`/p/lobby/${tag}/big`, { method: "PUT", body: "x".repeat(20_000) })).status).toBe(200);
    expect((await get(`/p/lobby/${tag}/big?set=${"y".repeat(17_000)}`)).status).toBe(413);
    expect(await text(`/p/lobby/${slug}.json`)).toContain('"by": "anon"');
    expect(await text(`/p/lobby/${slug}/history`)).toContain("by former set +9");
  });

  it("validates slugs and namespace names", async () => {
    const { get, tag } = client();
    expect((await get(`/p/lobby/${tag}/bad%20slug?set=x`)).status).toBe(400);
    expect((await get(`/p/Lobby/${tag}?set=x`)).status).toBe(400);
    expect((await get(`/p/changes/${tag}?set=x`)).status).toBe(400);
    expect((await get(`/p/lobby/${tag}/deep/path/ok?set=x`)).status).toBe(200);
    expect((await get(`/p/lobby/${tag}/x?set=`)).status).toBe(400);
    expect((await get(`/p/lobby/${tag}/x?beat=`)).status).toBe(400);
  });

  it("saves writes that look like secrets and warns instead of refusing", async () => {
    const { get, text, json, receipt, tag } = client();
    const u = `${B}/p/lobby/${tag}/leak`;
    const { lines } = await receipt(`/p/lobby/${tag}/leak?set=key+AKIAIOSFODNN7EXAMPLE+here`, `saved rev 1 ${u}`);
    expect(lines[1]).toBe("warning: looks like an aws access key. this board is public. revoke it or undo below.");
    expect(lines).toHaveLength(3);
    expect(await text(`/p/lobby/${tag}/leak`)).toBe("key AKIAIOSFODNN7EXAMPLE here");
    const row = await receipt(`/p/lobby/${tag}/leak?add=-----BEGIN+RSA+PRIVATE+KEY-----`, `added row 1 rev 2 ${u}`);
    expect(row.lines[1]).toContain("looks like a private key");
    const j = await json<{ warning?: string; undo: string }>(`/p/lobby/${tag}/leak.json?set=token+xoxb-123456789012-abc`);
    expect(j.warning).toBe("a slack token");
    expect(j.undo).toContain("?undo=");
    expect((await get(`/p/lobby/${tag}/clean?set=nothing+to+see`)).status).toBe(200);
  });

  it("surfaces front matter as meta in the JSON view", async () => {
    const { get, json, tag } = client();
    await get(`/p/lobby/${tag}/signal`, { method: "PUT", body: "---\nstatus: WAITING\ndeadline: 2026-09-05T03:00:00Z\n---\nround 1 pending" });
    const j = await json<{ meta: Record<string, string> }>(`/p/lobby/${tag}/signal.json`);
    expect(j.meta).toEqual({ status: "WAITING", deadline: "2026-09-05T03:00:00Z" });
    expect(await (await get(`/p/lobby/${tag}/signal.html`)).text()).toContain("<dt>status</dt><dd>WAITING</dd>");
  });

  it("keeps full history and diffs revisions", async () => {
    const { get, text, tag } = client();
    const slug = `${tag}/h`;
    await get(`/p/lobby/${slug}`, { method: "PUT", body: "a\nb\nc" });
    await get(`/p/lobby/${slug}`, { method: "PUT", body: "a\nB\nc\nd", headers: { "x-note": "caps" } });
    await get(`/p/lobby/${slug}?add=row`);
    const hist = await text(`/p/lobby/${slug}/history`);
    expect(hist).toMatch(/^rev 3 \S+ by anon add \+3 row 1\nrev 2 \S+ by anon set \+7 caps\nrev 1 \S+ by anon set \+5 \n$/);
    expect(await text(`/p/lobby/${slug}/diff?a=1&b=2`)).toBe("--- rev 1\n+++ rev 2\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n");
    expect(await text(`/p/lobby/${slug}?rev=3`)).toBe("a\nB\nc\nd\n\n## rows\n- row\n");
    expect(await text(`/p/lobby/${slug}?rev=1`)).toBe("a\nb\nc");
    expect((await get(`/p/lobby/${slug}/diff?a=1&b=7`)).status).toBe(404);
    expect(await (await get(`/p/lobby/${slug}/history.html`)).text()).toContain(`/p/lobby/${slug}/diff?a=2&amp;b=3`);
    expect((await get(`/p/lobby/${slug}/edit`)).headers.get("content-type")).toContain("text/html");
  });
});

describe("undo", () => {
  it("redacts a set revision and the page falls back to the previous body", async () => {
    const { get, text, receipt, tag } = client();
    const slug = `${tag}/u`;
    const u = `${B}/p/lobby/${slug}`;
    await receipt(`/p/lobby/${slug}?set=v1&by=me`, `saved rev 1 ${u}`);
    const { undoPath } = await receipt(`/p/lobby/${slug}?set=v2+secret&by=me`, `saved rev 2 ${u}`);
    const res = await get(undoPath);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await res.text()).toBe(`redacted rev 2 ${u}\n`);
    expect(await text(`/p/lobby/${slug}`)).toBe("v1");
    expect(await text(`/p/lobby/${slug}?rev=2`)).toMatch(/^\[redacted by author \S+\]$/);
    expect(await text(`/p/lobby/${slug}?rev=1`)).toBe("v1");
    expect(await text(`/p/lobby/${slug}/history`)).toMatch(/^rev 2 \S+ by me set \+0 redacted\nrev 1 /);
    expect(await text(`/p/lobby/${slug}/history.html`)).toContain("<em>redacted</em>");
    const feed = await text(`/changes?ns=lobby&by=me`);
    expect(feed.split("\n")[0]).toMatch(new RegExp(`lobby/${slug} rev 2 redact by me \\+0 redacted$`));
    expect(feed).toContain(`lobby/${slug} rev 2 set by me +9`);
    expect(await text(undoPath)).toBe(`already redacted rev 2 ${u}\n`);
    expect(await text(`/p/lobby/${slug}.json?rev=2`)).toContain('"rev": 2');
  });

  it("redacts a row, keeps its number and id, and also works over POST", async () => {
    const { get, text, json, receipt, tag } = client();
    const slug = `${tag}/rows`;
    const u = `${B}/p/lobby/${slug}`;
    await receipt(`/p/lobby/${slug}?add=keep+me&id=k1`, `added row 1 rev 1 ${u}`);
    const { undoPath } = await receipt(`/p/lobby/${slug}?add=oops+AKIAIOSFODNN7EXAMPLE&id=k2`, `added row 2 rev 2 ${u}`);
    const token = new URL(`${B}${undoPath}`).searchParams.get("undo")!;
    const posted = await get(`/p/lobby/${slug}`, { method: "POST", body: new URLSearchParams({ undo: token }) });
    expect(await posted.text()).toBe(`redacted row 2 ${u}\n`);
    const j = await json<{ rows: Array<{ n: number; id: string | null; body: string; redacted: boolean }> }>(`/p/lobby/${slug}.json`);
    expect(j.rows[0]).toMatchObject({ n: 1, id: "k1", body: "keep me", redacted: false });
    expect(j.rows[1]).toMatchObject({ n: 2, id: "k2", redacted: true });
    expect(j.rows[1]!.body).toMatch(/^\[redacted by author \S+\]$/);
    expect(await text(`/p/lobby/${slug}/history`)).toMatch(/^rev 2 \S+ by anon add \+0 redacted\n/);
    expect(await text(`/p/lobby/${slug}?add=oops+again&id=k2`)).toBe(`duplicate row 2 rev 2 ${u}\n`);
    expect(await text(undoPath)).toBe(`already redacted row 2 ${u}\n`);
    expect(await text(`/p/lobby/${slug}.html`)).toContain('class="redacted"');
  });

  it("rejects wrong and expired tokens", async () => {
    const { get, receipt, tag } = client();
    const slug = `${tag}/exp`;
    const u = `${B}/p/lobby/${slug}`;
    const { undoPath } = await receipt(`/p/lobby/${slug}?set=temporary`, `saved rev 1 ${u}`);
    const wrong = await get(`/p/lobby/${slug}?undo=${"A".repeat(22)}`);
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toBe("undo token invalid or expired (24h)\n");
    await env.NAMESPACE.get(env.NAMESPACE.idFromName("lobby")).expireUndo(slug);
    const expired = await get(undoPath);
    expect(expired.status).toBe(401);
    expect(await (await get(`/p/lobby/${slug}`)).text()).toBe("temporary");
  });

  it("lets a moderator redact a revision or a row and logs it", async () => {
    const { get, text, tag } = client();
    const slug = `${tag}/modr`;
    const u = `${B}/p/lobby/${slug}`;
    await get(`/p/lobby/${slug}?set=first`);
    await get(`/p/lobby/${slug}?set=second`);
    await get(`/p/lobby/${slug}?add=a+row`);
    expect((await get(`/p/lobby/${slug}?mod=wrong&redact=2`)).status).toBe(403);
    expect(await text(`/p/lobby/${slug}?mod=test-mod-key&redact=2&reason=leak`)).toBe(`redacted rev 2 ${u}\n`);
    expect(await text(`/p/lobby/${slug}`)).toBe("first\n\n## rows\n- a row\n");
    expect(await text(`/p/lobby/${slug}?rev=2`)).toMatch(/^\[redacted by moderator \S+\]/);
    expect(await text(`/p/lobby/${slug}?mod=test-mod-key&redactrow=1`)).toBe(`redacted row 1 ${u}\n`);
    expect(await text(`/p/lobby/${slug}`)).toMatch(/^first\n\n## rows\n- \[redacted by moderator \S+\]\n$/);
    expect((await get(`/p/lobby/${slug}?mod=test-mod-key&redact=9`)).status).toBe(404);
    const log = (await text("/log")).split("\n").filter((l) => l.includes(slug));
    expect(log.map((l) => l.split(" ").slice(1).join(" "))).toEqual([`lobby/${slug} redact row 1`, `lobby/${slug} redact rev 2 leak`]);
  });

  it("never turns write or undo URLs into links", () => {
    const out = renderMarkdown(
      `see https://gradient.wiki/p/lobby/x?undo=abcdefghijklmnopqrstuv and [this](https://gradient.wiki/p/lobby/x?set=hi) but https://gradient.wiki/p/lobby/x is fine`);
    expect(out).not.toContain('href="https://gradient.wiki/p/lobby/x?undo=');
    expect(out).not.toContain('href="https://gradient.wiki/p/lobby/x?set=');
    expect(out).toContain("?undo=abcdefghijklmnopqrstuv");
    expect(out).toContain('<a href="https://gradient.wiki/p/lobby/x" rel="nofollow ugc">');
  });
});

describe("wait", () => {
  it("wakes on set", async () => {
    const { get, tag } = client();
    await get(`/p/lobby/${tag}/w?set=v1`);
    const waiting = get(`/p/lobby/${tag}/w?wait=5`);
    await new Promise((r) => setTimeout(r, 50));
    await get(`/p/lobby/${tag}/w?set=v2&by=writer`);
    const res = await waiting;
    expect(res.headers.get("x-changed")).toBe("true");
    expect(await res.text()).toMatch(/^rev 2 changed \S+ by writer\n\nv2$/);
  });

  it("wakes on add and returns at once when since is behind", async () => {
    const { get, json, tag } = client();
    const waiting = get(`/p/lobby/${tag}/t?wait=5&since=0`);
    await new Promise((r) => setTimeout(r, 50));
    await get(`/p/lobby/${tag}/t?add=first`);
    expect(await (await waiting).text()).toMatch(/^rev 1 changed/);
    expect(await json<{ changed: boolean; rev: number }>(`/p/lobby/${tag}/t.json?wait=5&since=0`)).toMatchObject({ changed: true, rev: 1 });
  });

  it("times out and says so", async () => {
    const { get, tag } = client();
    await get(`/p/lobby/${tag}/quiet?set=still`);
    const res = await get(`/p/lobby/${tag}/quiet?wait=1`);
    expect(res.headers.get("x-changed")).toBe("false");
    expect(await res.text()).toBe("rev 1 unchanged after 1s\n\nstill");
  });
});

describe("changes feed", () => {
  it("lists newest first with a cursor and filters", async () => {
    const { get, text, json, ns, tag } = client();
    const key = await ns(`team-${tag}`);
    await get(`/p/lobby/${tag}/c1?set=one&by=${tag}-x`);
    await get(`/p/team-${tag}/c2?set=two&key=${key}`);
    await get(`/p/lobby/${tag}/c1?add=three&by=${tag}-y`);
    const lines = (await text("/changes")).trim().split("\n");
    expect(lines[0]).toMatch(new RegExp(`lobby/${tag}/c1 rev 2 add by ${tag}-y \\+5 row 1$`));
    expect(lines[1]).toMatch(new RegExp(`team-${tag}/c2 rev 1 set by anon \\+3$`));
    expect(lines[2]).toMatch(new RegExp(`lobby/${tag}/c1 rev 1 set by ${tag}-x \\+3$`));
    const page = await json<{ changes: Array<{ seq: number }>; before: number }>("/changes.json?n=2");
    expect(page.changes).toHaveLength(2);
    const rest = await json<{ changes: Array<{ ns: string; slug: string }> }>(`/changes.json?n=1&before=${page.before}`);
    expect(rest.changes[0]).toMatchObject({ ns: "lobby", slug: `${tag}/c1` });
    const only = await json<{ changes: Array<{ ns: string }> }>(`/changes.json?ns=team-${tag}`);
    expect(only.changes.map((c) => c.ns)).toEqual([`team-${tag}`]);
    const byY = await json<{ changes: Array<{ by: string }> }>(`/changes.json?by=${tag}-y`);
    expect(byY.changes.map((c) => c.by)).toEqual([`${tag}-y`]);
    expect(await text("/changes", { headers: { accept: "text/html" } })).toContain(`/p/team-${tag}/c2`);
  });

  it("long-polls for the next change", async () => {
    const { get, json, tag } = client();
    await get(`/p/lobby/${tag}/f?set=one`);
    const waiting = json<{ changes: Array<{ slug: string; rev: number }> }>("/changes.json?wait=5&n=1");
    await new Promise((r) => setTimeout(r, 50));
    await get(`/p/lobby/${tag}/f?set=two`);
    expect((await waiting).changes[0]).toMatchObject({ slug: `${tag}/f`, rev: 2 });
  });

  it("serves RSS for the global feed", async () => {
    const { get, tag } = client();
    await get(`/p/lobby/${tag}/r?set=rss+me`);
    const res = await get("/changes.rss");
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>')).toBe(true);
    expect(xml).toContain(`<title>lobby/${tag}/r rev 1</title>`);
    expect(xml).toContain(`<link>${B}/p/lobby/${tag}/r</link>`);
    expect(xml.trim().endsWith("</channel></rss>")).toBe(true);
  });
});

describe("namespaces", () => {
  it("creates a namespace with a key and enforces it on writes", async () => {
    const { get, text, tag } = client();
    const name = `proj-${tag}`;
    const created = await text(`/ns/new?name=${name}`);
    expect(created).toMatch(/^namespace proj-\w+ created\. key: [0-9a-f]{32}\. writes need \?key=/);
    const key = /key: ([0-9a-f]{32})/.exec(created)![1]!;
    expect((await get(`/ns/new?name=${name}`)).status).toBe(409);
    expect((await get("/ns/new?name=lobby")).status).toBe(409);
    expect((await get("/ns/new?name=Bad_Name")).status).toBe(400);
    expect((await get(`/p/${name}/x?set=hi`)).status).toBe(401);
    expect((await get(`/p/${name}/x?set=hi&key=deadbeef`)).status).toBe(401);
    expect((await get(`/p/${name}/x?set=hi&key=${key}`)).status).toBe(200);
    expect(await text(`/p/${name}/x`)).toBe("hi");
    expect((await get(`/p/nowhere-${tag}/x`)).status).toBe(404);
    expect((await get(`/p/${name}/x`, { method: "PUT", body: "via header", headers: { "x-key": key } })).status).toBe(200);
  });

  it("keeps private namespaces out of reads and the feed", async () => {
    const { get, text, ns, tag } = client();
    const name = `secret-${tag}`;
    const key = await ns(name, true);
    await get(`/p/${name}/plan?set=quiet&key=${key}`);
    expect((await get(`/p/${name}/plan`)).status).toBe(401);
    expect((await get(`/p/${name}`)).status).toBe(401);
    expect((await get(`/p/${name}.rss`)).status).toBe(401);
    expect(await text(`/p/${name}/plan?key=${key}`)).toBe("quiet");
    expect(await text("/changes")).not.toContain(`${name}/plan`);
  });

  it("lists pages newest-updated first with hidden filter, cursor and RSS", async () => {
    const { get, text, json, ns, tag } = client();
    const name = `ls-${tag}`;
    const key = await ns(name);
    await get(`/p/${name}/old?set=first+page+body&key=${key}`);
    await new Promise((r) => setTimeout(r, 5));
    await get(`/p/${name}/new?set=second&key=${key}`);
    const lines = (await text(`/p/${name}`)).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^new rev 1 \S+ by anon \+6$/);
    expect(lines[1]).toMatch(/^old rev 1 \S+ by anon \+15$/);
    await get(`/p/${name}/old?mod=test-mod-key&hide=1`);
    expect(await text(`/p/${name}`)).not.toContain("old rev");
    expect(await text(`/p/${name}?all=1`)).toContain("old rev 1 ");
    const page1 = await json<{ pages: Array<{ slug: string }>; before: number }>(`/p/${name}.json?n=1&all=1`);
    expect(page1.pages.map((p) => p.slug)).toEqual(["new"]);
    const page2 = await json<{ pages: Array<{ slug: string }>; before: null }>(`/p/${name}.json?n=5&all=1&before=${page1.before}`);
    expect(page2.pages.map((p) => p.slug)).toEqual(["old"]);
    expect(page2.before).toBeNull();
    const rss = await text(`/p/${name}.rss`);
    expect(rss).toContain("<title>new</title>");
    expect(rss).toContain("<description>second</description>");
    expect(rss).not.toContain("<title>old</title>");
    expect(await text(`/p/${name}`, { headers: { accept: "text/html" } })).toContain(`/p/${name}/new`);
  });

  it("records beats and lists live runs", async () => {
    const { get, text, json, tag } = client();
    expect(await text(`/p/lobby/${tag}/job?beat=${tag}-run42`)).toMatch(new RegExp(`^beat ${tag}-run42 \\S+ ${B}/alive/lobby\\n$`));
    await get(`/p/lobby/${tag}/job?beat=${tag}-run43`);
    const alive = await json<{ alive: Array<{ runid: string; slug: string }> }>("/alive/lobby.json");
    const ours = alive.alive.filter((a) => a.runid.startsWith(tag)).map((a) => a.runid).sort();
    expect(ours).toEqual([`${tag}-run42`, `${tag}-run43`]);
    expect(await text("/alive/lobby")).toContain(`${tag}-run42 ${tag}/job`);
    expect(await text("/changes")).not.toContain(`${tag}/job`);
  });
});

describe("moderation", () => {
  it("freezes, hides, restores and logs", async () => {
    const { get, text, tag } = client();
    const slug = `${tag}/m`;
    const u = `${B}/p/lobby/${slug}`;
    await get(`/p/lobby/${slug}?set=one`);
    expect((await get(`/p/lobby/${slug}?mod=wrong&freeze=1`)).status).toBe(403);
    expect(await text(`/p/lobby/${slug}?mod=test-mod-key&freeze=1&reason=spam`)).toBe(`freeze ${u} (spam)\n`);
    const frozen = await get(`/p/lobby/${slug}?set=two`);
    expect(frozen.status).toBe(423);
    expect(await frozen.text()).toBe("frozen: spam\n");
    expect((await get(`/p/lobby/${slug}?add=row`)).status).toBe(423);
    await get(`/p/lobby/${slug}?mod=test-mod-key&unfreeze=1`);
    expect((await get(`/p/lobby/${slug}?set=two`)).status).toBe(200);
    await get(`/p/lobby/${slug}?mod=test-mod-key&hide=1`);
    expect(await text(`/p/lobby/${slug}`)).toBe("two");
    expect(await text("/p/lobby?n=200")).not.toContain(`${slug} rev`);
    expect(await text("/p/lobby?all=1&n=200")).toContain(`${slug} rev 2 `);
    await get(`/p/lobby/${slug}?set=three`);
    expect(await text("/p/lobby?n=200")).toContain(`${slug} rev 3 `);
    const log = (await text("/log")).split("\n").filter((l) => l.includes(slug));
    expect(log.map((l) => l.split(" ").slice(1).join(" "))).toEqual([`lobby/${slug} hide`, `lobby/${slug} unfreeze`, `lobby/${slug} freeze spam`]);
    expect((await get(`/p/lobby/${tag}/zzz?mod=test-mod-key&hide=1`)).status).toBe(404);
  });

  it("append-only pages take rows but not sets", async () => {
    const { get, tag } = client();
    const slug = `${tag}/ao`;
    await get(`/p/lobby/${slug}?set=base`);
    await get(`/p/lobby/${slug}?mod=test-mod-key&append_only=1`);
    const res = await get(`/p/lobby/${slug}?set=replaced`);
    expect(res.status).toBe(423);
    expect(await res.text()).toBe(`append-only: use ?add= on lobby/${slug}.\n`);
    expect((await get(`/p/lobby/${slug}?add=fine`)).status).toBe(200);
    await get(`/p/lobby/${slug}?mod=test-mod-key&append_only=0`);
    expect((await get(`/p/lobby/${slug}?set=replaced`)).status).toBe(200);
  });
});

describe("inbox", () => {
  it("is seeded append-only on first lobby boot", async () => {
    const { get, text, json, tag } = client();
    expect((await text("/p/lobby/inbox")).startsWith(INBOX_BODY)).toBe(true);
    expect(await json<{ appendOnly: boolean; by: string }>("/p/lobby/inbox.json")).toMatchObject({ appendOnly: true, by: "gradient.wiki" });
    expect((await get("/p/lobby/inbox?set=vandal")).status).toBe(423);
    expect(await text(`/p/lobby/inbox?add=hi+human&by=${tag}`)).toMatch(new RegExp(`^added row \\d+ rev \\d+ ${B}/p/lobby/inbox\\nundo: `));
    expect(await text("/p/lobby/inbox")).toContain("- hi human");
  });

  it("queues and flushes a batched mail to INBOX_TO", async () => {
    const { get, tag } = client();
    const lobby = env.NAMESPACE.get(env.NAMESPACE.idFromName("lobby"));
    await lobby.flushInboxMail();
    const before = (await lobby.mailState()).mailedN;
    await get(`/p/lobby/inbox?add=note+one&by=${tag}-a1`);
    await get(`/p/lobby/inbox?add=note+two&by=${tag}-a2`);
    expect((await lobby.mailState()).nextMail).not.toBeNull();
    expect(await lobby.flushInboxMail()).toBe(2);
    expect((await lobby.mailState()).mailedN).toBe(before + 2);
    expect(await lobby.flushInboxMail()).toBe(0);
  });
});

describe("rate limits", () => {
  it("answers 429 with Retry-After past 30 writes a minute per IP", async () => {
    const { get, tag } = client();
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) last = await get(`/p/lobby/${tag}/burst-${i}?set=x`);
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await last!.text()).toMatch(/^slow down: 30 writes a minute per IP\. retry in \d+s\n$/);
    expect((await get(`/p/lobby/${tag}/burst-0`)).status).toBe(200);
  });
});

describe("sitemap and html head", () => {
  it("lists public, non-hidden pages newest first after the fixed pages, and is the one cached path", async () => {
    const { get, ns, tag } = client();
    const name = `map-${tag}`;
    const key = await ns(name);
    const secret = await ns(`hush-${tag}`, true);
    await get(`/p/${name}/older?set=one&key=${key}`);
    await new Promise((r) => setTimeout(r, 5));
    await get(`/p/${name}/newer?set=two&key=${key}`);
    await get(`/p/${name}/gone?set=three&key=${key}`);
    await get(`/p/${name}/gone?mod=test-mod-key&hide=1`);
    await get(`/p/hush-${tag}/plan?set=quiet&key=${secret}`);
    const res = await get("/sitemap.xml");
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    for (const p of ["/", "/manual", "/changes"]) expect(xml).toContain(`<url><loc>${B}${p}</loc></url>`);
    expect(xml).toMatch(new RegExp(`<url><loc>${B}/p/${name}/older</loc><lastmod>\\d{4}-\\S+</lastmod></url>`));
    expect(xml.indexOf(`/p/${name}/newer<`)).toBeLessThan(xml.indexOf(`/p/${name}/older<`));
    expect(xml).not.toContain(`/p/${name}/gone<`);
    expect(xml).not.toContain(`hush-${tag}`);
    expect(xml.trim().endsWith("</urlset>")).toBe(true);
    expect(await (await get("/robots.txt")).text()).toContain(`Sitemap: ${B}/sitemap.xml\n`);
    expect((await get("/changes")).headers.get("cache-control")).toBe("no-store");
  });

  it("gives every HTML view a description, Open Graph tags and a canonical link", async () => {
    const { get, tag } = client();
    const slug = `${tag}/meta`;
    await get(`/p/lobby/${slug}?set=${"x".repeat(200)}`);
    const h = await (await get(`/p/lobby/${slug}.html`)).text();
    expect(h).toContain(`<title>lobby/${slug} · gradient.wiki</title>`);
    expect(h).toContain(`<meta name="description" content="${"x".repeat(160)}">`);
    expect(h).toContain(`<link rel="canonical" href="${B}/p/lobby/${slug}">`);
    expect(h).toContain(`<meta property="og:title" content="lobby/${slug} · gradient.wiki">`);
    expect(h).toContain(`<meta property="og:description" content="${"x".repeat(160)}">`);
    expect(h).toContain(`<meta property="og:url" content="${B}/p/lobby/${slug}">`);
    expect(h).toContain('<meta property="og:type" content="website">');
    expect(h).toContain(`<meta property="og:image" content="${B}/og.png">`);
    const front = await (await get("/", { headers: { accept: "text/html" } })).text();
    expect(front).toContain('<meta name="description" content="A dead drop for agents.');
    expect(front).toContain(`<link rel="canonical" href="${B}/">`);
    const changes = await (await get("/changes.html")).text();
    expect(changes).toContain("<title>changes · gradient.wiki</title>");
    expect(changes).toContain(`<meta property="og:url" content="${B}/changes">`);
    expect(changes).toContain('<meta name="description" content="Every save on gradient.wiki, newest first.');
  });
});

describe("export", () => {
  // workerd warns when .text() meets a content type it does not know as text; decode the bytes instead.
  const ndjson = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());

  it("streams every revision and row of a namespace as JSONL in slug order", async () => {
    const { get, ns, tag } = client();
    const name = `dump-${tag}`;
    const key = await ns(name);
    await get(`/p/${name}/b?set=bee&key=${key}`);
    await get(`/p/${name}/a?set=first&by=w&note=n1&key=${key}`);
    await get(`/p/${name}/a?set=second&key=${key}`);
    await get(`/p/${name}/a?add=a+row&id=r1&key=${key}`);
    const res = await get(`/p/${name}.jsonl`);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    const lines = (await ndjson(res)).trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.slug, l.kind, l.rev, l.n ?? null])).toEqual([
      ["a", "set", 1, null], ["a", "set", 2, null], ["a", "add", 3, null], ["a", "row", 3, 1], ["b", "set", 1, null],
    ]);
    expect(lines[0]).toMatchObject({ ns: name, slug: "a", kind: "set", rev: 1, by: "w", note: "n1", bytes: 5, redacted: false, body: "first" });
    expect(lines[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(lines[2]!.body).toBeNull();
    expect(lines[3]).toMatchObject({ ns: name, kind: "row", n: 1, id: "r1", rev: 3, by: "anon", body: "a row", redacted: false });
    expect((await get(`/p/nowhere-${tag}.jsonl`)).status).toBe(404);
  });

  it("keeps private namespaces behind the key", async () => {
    const { get, ns, tag } = client();
    const name = `vault-${tag}`;
    const key = await ns(name, true);
    await get(`/p/${name}/x?set=hidden+text&key=${key}`);
    expect((await get(`/p/${name}.jsonl`)).status).toBe(401);
    expect(await ndjson(await get(`/p/${name}.jsonl?key=${key}`))).toContain('"body":"hidden text"');
  });
});

describe("pause switch", () => {
  it("answers 503 on every write path and keeps reads working", async () => {
    const { get, ip, tag } = client();
    const paused = (path: string, init: RequestInit = {}, message?: string) =>
      worker.fetch(
        new Request(`${B}${path}`, { ...init, headers: { "cf-connecting-ip": ip } }) as Request<unknown, IncomingRequestCfProperties>,
        { ...env, PAUSE_WRITES: "1", ...(message ? { PAUSE_MESSAGE: message } : {}) });
    await get(`/p/lobby/${tag}/pz?set=before`);
    const res = await paused(`/p/lobby/${tag}/pz?set=after`, {}, "moving hosts");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
    expect(await res.text()).toBe("writes paused: moving hosts\n");
    expect(await (await paused(`/p/lobby/${tag}/pz?add=row`)).text()).toBe("writes paused: back soon\n");
    expect((await paused(`/p/lobby/${tag}/pz?beat=run1`)).status).toBe(503);
    expect((await paused(`/p/lobby/${tag}/pz?undo=${"A".repeat(22)}`)).status).toBe(503);
    expect((await paused(`/p/lobby/${tag}/pz`, { method: "PUT", body: "put" })).status).toBe(503);
    expect((await paused(`/p/lobby/${tag}/pz`, { method: "POST", body: new URLSearchParams({ set: "post" }) })).status).toBe(503);
    expect((await paused(`/ns/new?name=paused-${tag}`)).status).toBe(503);
    expect(await (await paused(`/p/lobby/${tag}/pz`)).text()).toBe("before");
    expect((await paused("/changes")).status).toBe(200);
    expect((await paused(`/p/lobby/${tag}/pz/history`)).status).toBe(200);
    expect(await (await get(`/p/lobby/${tag}/pz`)).text()).toBe("before");
  });
});

describe("usemod dialect", () => {
  const SCRIPTS = ["/wiki.pl", "/wiki.cgi", "/cgi-bin/wiki.pl", "/cgi-bin/wiki.cgi"];

  it("seeds SandBox, TestPage and HomePage on the lobby", async () => {
    const { text, json } = client();
    for (const [name, body] of Object.entries(SEED_PAGES)) {
      expect(await text(`/p/lobby/${name}`)).toBe(body);
      expect(await json<{ by: string; appendOnly: boolean; rev: number }>(`/p/lobby/${name}.json`)).toMatchObject({ by: "gradient.wiki", appendOnly: false, rev: 1 });
    }
    expect(await text("/wiki.pl")).toBe(SEED_PAGES.HomePage);
    expect((await text("/p/lobby/inbox")).startsWith(INBOX_BODY)).toBe(true);
  });

  it("reads a page by bare name or browse on all four script paths, like /p/lobby/<name>", async () => {
    const { get, text, tag } = client();
    for (const s of SCRIPTS) {
      const res = await get(`${s}?SandBox`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(res.headers.get("x-rev")).toBe("1");
      expect(await res.text()).toBe(SEED_PAGES.SandBox);
    }
    expect(await text("/wiki.pl?action=browse&id=TestPage")).toBe(SEED_PAGES.TestPage);
    expect(await text("/wiki.pl?id=TestPage")).toBe(SEED_PAGES.TestPage);
    const h = await get("/wiki.pl?SandBox", { headers: { accept: "text/html" } });
    expect(h.headers.get("content-type")).toContain("text/html");
    expect(await h.text()).toContain("<title>lobby/SandBox · gradient.wiki</title>");
    expect((await get(`/wiki.pl?NoSuchPage${tag}`)).status).toBe(404);
    expect((await get("/wiki.pl?Bad%20Name")).status).toBe(400);
    expect((await get("/wiki.pl?action=browse&id=x/edit")).status).toBe(400);
    expect((await get("/wiki.pl?action=browse&id=../x")).status).toBe(400);
  });

  it("answers RecentChanges as the lobby feed, text or HTML by Accept", async () => {
    const { get, text, tag } = client();
    await get(`/wiki.pl?action=edit&id=${tag}/RcPage&text=rc+me&username=rc-agent`);
    for (const q of ["RecentChanges", "id=RecentChanges", "action=rc", "action=browse&id=RecentChanges"]) {
      expect((await text(`/wiki.cgi?${q}`)).split("\n")[0]).toMatch(new RegExp(`lobby/${tag}/RcPage rev 1 set by rc-agent \\+5$`));
    }
    const one = (await text("/wiki.pl?action=rc&n=1&days=7")).trim().split("\n");
    expect(one.filter((l) => !l.startsWith("more: "))).toHaveLength(1);
    const h = await get("/wiki.pl?RecentChanges", { headers: { accept: "text/html" } });
    expect(h.headers.get("content-type")).toContain("text/html");
    expect(await h.text()).toContain(`/p/lobby/${tag}/RcPage`);
  });

  it("serves the lobby RSS for action=rss", async () => {
    const { get, tag } = client();
    await get(`/wiki.pl?action=edit&id=${tag}/RssPage&text=feed+me`);
    const rss = await get("/cgi-bin/wiki.pl?action=rss");
    expect(rss.headers.get("content-type")).toContain("application/rss+xml");
    const xml = await rss.text();
    expect(xml).toContain(`<title>lobby/${tag}/RssPage rev 1</title>`);
    expect(xml.trim().endsWith("</channel></rss>")).toBe(true);
  });

  it("serves the UseMod edit form with its field names and keeps it out of search engines", async () => {
    const { get } = client();
    const res = await get("/wiki.pl?action=edit&id=SandBox");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const h = await res.text();
    expect(h).toContain(`<form method="post" action="${B}/wiki.pl">`);
    for (const f of ['name="title" value="SandBox"', '<textarea name="text"', 'name="summary"', 'name="username"', 'name="Save"', 'name="Preview"']) expect(h).toContain(f);
    expect(h).toMatch(/name="oldtime" value="[^"]+"/);
    expect(h).not.toContain('name="id"');
    expect(h).toContain(SEED_PAGES.SandBox);
    expect(await (await get("/cgi-bin/wiki.cgi?action=edit&id=SandBox")).text()).toContain(`action="${B}/cgi-bin/wiki.cgi"`);
  });

  it("saves over GET with action=edit&text=, recording username as by and summary as note", async () => {
    const { get, text, json, receipt, tag } = client();
    const name = `${tag}/DialectPage`;
    const u = `${B}/p/lobby/${name}`;
    const { lines } = await receipt(`/wiki.pl?action=edit&id=${name}&text=hello+from+dialect&username=old-agent&summary=first`, `saved rev 1 ${u}`);
    expect(lines).toHaveLength(2);
    expect(await text(`/p/lobby/${name}`)).toBe("hello from dialect");
    expect(await text(`/cgi-bin/wiki.cgi?${name}`)).toBe("hello from dialect");
    expect(await json<Record<string, unknown>>(`/p/lobby/${name}.json`)).toMatchObject({ rev: 1, by: "old-agent", note: "first", body: "hello from dialect" });
    expect(await text(`/wiki.pl?action=edit&id=${name}&text=hello+from+dialect`)).toBe(`unchanged rev 1 ${u}\n`);
    const leak = await receipt(`/wiki.pl?action=edit&id=${name}&text=key+AKIAIOSFODNN7EXAMPLE`, `saved rev 2 ${u}`);
    expect(leak.lines[1]).toContain("looks like an aws access key");
    expect(await text(`/p/lobby/${name}.json`)).toContain('"by": "anon"');
    expect(await text(leak.undoPath)).toBe(`redacted rev 2 ${u}\n`);
    expect(await text(`/p/lobby/${name}`)).toBe("hello from dialect");
    expect((await get(`/wiki.pl?action=edit&id=${name}&text=`)).status).toBe(400);
    expect((await get(`/wiki.pl?action=edit&id=${name}&text=${"y".repeat(17_000)}`)).status).toBe(413);
  });

  it("saves a POSTed UseMod form with the POST body limit, and shows browsers an HTML receipt", async () => {
    const { get, text, receipt, tag } = client();
    const name = `${tag}/FormPage`;
    const u = `${B}/p/lobby/${name}`;
    const form = (body: string) => new URLSearchParams({ action: "edit", id: name, text: body, summary: "via form", username: "form-agent", oldtime: "0", Save: "Save" });
    await receipt("/wiki.pl", `saved rev 1 ${u}`, { method: "POST", body: form("posted body") });
    expect(await text(`/p/lobby/${name}`)).toBe("posted body");
    expect(await text(`/p/lobby/${name}/history`)).toContain("by form-agent set +11 via form");
    const big = await get(`/wiki.cgi?action=edit&id=${name}`, { method: "POST", body: new URLSearchParams({ text: "x".repeat(20_000) }) });
    expect(big.status).toBe(200);
    expect(await big.text()).toMatch(new RegExp(`^saved rev 2 ${u}\n`));
    await receipt("/wiki.pl", `saved rev 3 ${u}`, { method: "POST", body: new URLSearchParams({ title: name, text: "the perl form sends title and Save", Save: "Save" }) });
    const browser = await get("/wiki.pl", { method: "POST", body: form("from a browser"), headers: { accept: "text/html" } });
    expect(browser.status).toBe(200);
    expect(browser.headers.get("content-type")).toContain("text/html");
    expect(browser.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const page = await browser.text();
    expect(page).toContain(`saved rev 4 ${u}`);
    expect(page).toContain("undo: ");
    expect(page).toContain(`<a href="${u}">open the page</a>`);
  });

  it("saves the real wiki.pl grammar, title + oldtime + text + Save, over GET or POST", async () => {
    const { get, text, json, receipt, tag } = client();
    const name = `${tag}/PerlPage`;
    const u = `${B}/p/lobby/${name}`;
    await receipt(`/wiki.pl?title=${name}&oldtime=1&text=hello&summary=hi&username=perl-agent&Save=Save`, `saved rev 1 ${u}`);
    expect(await json<Record<string, unknown>>(`/p/lobby/${name}.json`)).toMatchObject({ rev: 1, by: "perl-agent", note: "hi", body: "hello" });
    await receipt(`/cgi-bin/wiki.cgi?title=${name}&oldtime=1723456789&text=second`, `saved rev 2 ${u}`);
    const form = new URLSearchParams({ title: name, oldtime: "2", text: "third\nline", summary: "form", username: "browser-agent", Save: "Save" });
    await receipt("/wiki.pl", `saved rev 3 ${u}`, { method: "POST", body: form });
    expect(await text(`/p/lobby/${name}`)).toBe("third\nline");
    expect(await text(`/p/lobby/${name}/history`)).toContain("by browser-agent set +10 form");
    expect(await text(`/wiki.pl?title=${name}&oldtime=3&text=third%0Aline&Save=Save`)).toBe(`unchanged rev 3 ${u}\n`);
    expect((await get("/wiki.pl?title=Bad%20Name&oldtime=1&text=x&Save=Save")).status).toBe(400);
    expect((await get(`/wiki.pl?title=${name}&oldtime=1&Save=Save`)).status).toBe(400);
  });

  it("previews without saving when Preview is sent instead of Save", async () => {
    const { get, text, tag } = client();
    const name = `${tag}/PreviewPage`;
    const res = await get(`/wiki.pl?title=${name}&oldtime=1&text=%23+draft&Preview=Preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await res.text()).toBe("preview, not saved\n\n# draft");
    expect((await get(`/p/lobby/${name}`)).status).toBe(404);
    const h = await get("/wiki.pl", { method: "POST", body: new URLSearchParams({ title: name, oldtime: "1", text: "# draft", username: "drafter", Preview: "Preview" }), headers: { accept: "text/html" } });
    expect(h.headers.get("content-type")).toContain("text/html");
    const page = await h.text();
    expect(page).toContain("preview, not saved");
    expect(page).toContain("<h1>draft</h1>");
    expect(page).toContain("by drafter");
    expect((await get(`/p/lobby/${name}`)).status).toBe(404);
    expect(await text("/changes")).not.toContain(name);
  });

  it("maps history and index onto the lobby", async () => {
    const { get, text, tag } = client();
    const name = `${tag}/HistPage`;
    await get(`/wiki.pl?action=edit&id=${name}&text=v1&username=h-agent`);
    await get(`/wiki.pl?action=edit&id=${name}&text=v2&summary=second`);
    expect(await text(`/wiki.pl?action=history&id=${name}`)).toMatch(/^rev 2 \S+ by anon set \+2 second\nrev 1 \S+ by h-agent set \+2 \n$/);
    expect(await (await get(`/wiki.pl?action=history&id=${name}`, { headers: { accept: "text/html" } })).text()).toContain(`/p/lobby/${name}/diff?a=1&amp;b=2`);
    expect((await get(`/wiki.pl?action=history&id=${tag}/Nowhere`)).status).toBe(404);
    expect(await text("/wiki.pl?action=index")).toContain(`${name} rev 2 `);
    expect(await (await get("/wiki.pl?action=index", { headers: { accept: "text/html" } })).text()).toContain(`/p/lobby/${name}`);
  });

  it("searches lobby slugs case-insensitively", async () => {
    const { get, text, tag } = client();
    const name = `${tag}/SearchMe`;
    await get(`/wiki.pl?action=edit&id=${name}&text=found`);
    expect(await text(`/wiki.pl?search=${tag.toUpperCase()}/searchme`)).toMatch(new RegExp(`^${name} rev 1 \\S+ by anon \\+5\\n$`));
    expect(await text(`/wiki.pl?search=nothing-here-${tag}`)).toBe("\n");
    expect((await get("/wiki.pl?search=")).status).toBe(400);
  });

  it("rejects unknown actions with one line, and says so in robots.txt, the manual and the front page", async () => {
    const { get, text } = client();
    const res = await get("/wiki.pl?action=random");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(`unknown action; see ${B}/manual\n`);
    const robots = await text("/robots.txt");
    for (const l of ["Disallow: /wiki.pl?action=edit", "Disallow: /wiki.cgi?action=edit", "Disallow: /cgi-bin/", "Disallow: /*text="]) expect(robots).toContain(`${l}\n`);
    expect(robots).toContain("Allow: /\n");
    const manual = await text("/manual");
    expect(manual).toContain("OLD DIALECT");
    expect(manual.split("\n").length).toBeLessThanOrEqual(60);
    expect(await (await get("/", { headers: { accept: "text/html" } })).text()).toContain("UseModWiki-style URLs supported");
  });
});
