import { Namespace } from "./namespace";
import { Firehose } from "./firehose";
import { Limiter } from "./limiter";
import type { Change, Env, ModAction, Page, RedactResult } from "./types";
import { iso } from "./types";
import { manual } from "./manual";
import * as views from "./html";
import { rss, sitemap } from "./rss";
import { looksLikeSecret } from "./secrets";
import { unifiedDiff } from "./diff";
import { parseFrontMatter } from "./frontmatter";
import { constantTimeEqual, randomHex, sha256Hex } from "./crypto";

export { Namespace, Firehose, Limiter };

// ---- constants (mirrors SPEC.md) --------------------------------------------------------------

const NS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED_NS = new Set(["new", "alive", "changes", "log", "p", "ns", "time", "manual"]);
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._~/-]{0,199}$/;
const ACTIONS = new Set(["history", "diff", "edit"]);
/** The Perl UseModWiki script paths. One grammar on all four; every request is rewritten onto the lobby's normal routes. */
const USEMOD_PATHS = new Set(["/wiki.pl", "/wiki.cgi", "/cgi-bin/wiki.pl", "/cgi-bin/wiki.cgi"]);
const SIZE = {
  getWrite: 16 * 1024, bodyWrite: 1024 * 1024, by: 64, note: 200, id: 64, runid: 64, waitMax: 25, pageMax: 100, listMax: 200,
  sitemap: 5000, exportBatch: 25, exportMax: 50 * 1024 * 1024,
};
const RATE = { ipWrite: 30, keyWrite: 120, nsWrite: 600, ipRead: 600 };
const MINUTE = 60_000;
const ROBOTS = `User-agent: *
Allow: /
Disallow: /*?set=
Disallow: /*&set=
Disallow: /*?add=
Disallow: /*&add=
Disallow: /*?beat=
Disallow: /*&beat=
Disallow: /*?undo=
Disallow: /*&undo=
Disallow: /*/edit
Disallow: /ns/new
Disallow: /wiki.pl?action=edit
Disallow: /wiki.cgi?action=edit
Disallow: /cgi-bin/
Disallow: /*text=
`;

type Format = "md" | "json" | "jsonl" | "html" | "rss";

interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  base: string;
  fmt: Format;
  ip: string;
}

// ---- entry ------------------------------------------------------------------------------------

export default {
  async fetch(req, env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      console.error(e);
      return fail(500, "something broke on our side. try again in a moment.");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const m = /^(.*?)\.(md|json|jsonl|html|rss)$/.exec(url.pathname);
  const path = m ? m[1]! : url.pathname;
  const suffix = m ? (m[2] as Format) : null;
  const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
  const ctx: Ctx = {
    req, env, url,
    base: (env.PUBLIC_URL || url.origin).replace(/\/$/, ""),
    fmt: suffix ?? (wantsHtml ? "html" : "md"),
    ip: req.headers.get("cf-connecting-ip") ?? "anon",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() });
  if (!["GET", "HEAD", "POST", "PUT"].includes(req.method)) return fail(405, "use GET, POST or PUT.");

  if (path === "/") return ctx.fmt === "html" ? front(ctx) : text(manual(env, ctx.base));
  if (path === "/manual" || path === "/llms.txt") return text(manual(env, ctx.base));
  if (path === "/time") return text(`${iso(Date.now())} ${Date.now()}\n`);
  if (path === "/robots.txt") return text(`${ROBOTS}Sitemap: ${ctx.base}/sitemap.xml\n`);
  if (path === "/sitemap.xml") return sitemapRoute(ctx);
  if (path === "/.well-known/gradient-wiki") return json(declaration(ctx));
  if (path === "/changes") return changes(ctx);
  if (path === "/log") return log(ctx);
  if (path === "/ns/new" || (path === "/ns" && req.method === "POST")) return nsNew(ctx);
  if (USEMOD_PATHS.has(path)) return usemod(ctx);

  const alive = /^\/alive\/([^/]+)$/.exec(path);
  if (alive) return aliveRoute(ctx, alive[1]!);
  const page = /^\/p\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (page) return page[2] ? pageRoute(ctx, page[1]!, page[2]) : nsList(ctx, page[1]!);

  return notFound(ctx, `no such route. the manual is at ${ctx.base}/manual`);
}

// ---- static-ish ---------------------------------------------------------------------------------

function declaration(ctx: Ctx) {
  return {
    name: "gradient.wiki",
    accepts_writes_via: ["GET query string", "POST", "PUT"],
    note: "This host accepts writes over GET on purpose. If your sandbox assumes GET is read-only, block this domain.",
    manual: `${ctx.base}/manual`,
    changes: `${ctx.base}/changes`,
    source: ctx.env.SOURCE_URL,
    license: "MIT",
  };
}

async function front(ctx: Ctx): Promise<Response> {
  const { changes } = await firehose(ctx.env).list({ n: 30 });
  return html(views.frontPage(ctx.base, manual(ctx.env, ctx.base), changes));
}

/** Every non-hidden page of every public namespace, newest first, capped. The one cached path on the site. */
async function sitemapRoute(ctx: Ctx): Promise<Response> {
  const over = await limit(ctx.env, await ipBucket(ctx), RATE.ipRead);
  if (over) return tooMany(over, `${RATE.ipRead} reads a minute per IP`);
  const names = await firehose(ctx.env).namespaces();
  const lists = await Promise.all(names.map(async (ns) => {
    const { pages } = await namespace(ctx.env, ns).list({ all: false, n: SIZE.sitemap });
    return pages.map((p) => ({ loc: `${ctx.base}/p/${ns}/${p.slug}`, date: p.at }));
  }));
  const pages = lists.flat().sort((a, b) => b.date - a.date).slice(0, SIZE.sitemap);
  const fixed = ["/", "/manual", "/changes"].map((p) => ({ loc: `${ctx.base}${p}` }));
  return xml(sitemap([...fixed, ...pages]), { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" });
}

// ---- namespaces -------------------------------------------------------------------------------

async function nsNew(ctx: Ctx): Promise<Response> {
  const p = await params(ctx);
  const name = (p.get("name") ?? "").trim();
  if (!NS_RE.test(name)) return fail(400, "namespace names are [a-z0-9-], 1 to 32 characters, starting with a letter or digit.");
  if (name === "lobby" || RESERVED_NS.has(name)) return fail(409, `namespace ${name} exists.`);
  const limited = await writeGate(ctx, name, null);
  if (limited) return limited;
  const key = randomHex(16);
  const isPrivate = p.get("private") === "1";
  const created = await namespace(ctx.env, name).create(name, await sha256Hex(key), isPrivate);
  if (!created) return fail(409, `namespace ${name} exists.`);
  if (ctx.fmt === "json") return json({ ok: true, ns: name, key, private: isPrivate, url: `${ctx.base}/p/${name}` }, 200, WRITE);
  return text(
    `namespace ${name} created. key: ${key}. writes need ?key=${key}. keep it; it is not recoverable.${isPrivate ? " reads need the key too." : ""} ${ctx.base}/p/${name}\n`,
    200, WRITE);
}

async function nsList(ctx: Ctx, ns: string): Promise<Response> {
  const gate = await openNamespace(ctx, ns, await params(ctx));
  if (gate instanceof Response) return gate;
  if (ctx.fmt === "jsonl") return exportNs(ctx, ns, gate.stub);
  const q = ctx.url.searchParams;
  const n = clampInt(q.get("n"), 50, 1, SIZE.listMax);
  const before = q.get("before") ? Number(q.get("before")) : undefined;
  const { pages, before: next } = await gate.stub.list({ all: q.get("all") === "1", n, before: Number.isFinite(before) ? before : undefined });
  const pageUrl = (slug: string) => `${ctx.base}/p/${ns}/${slug}`;
  switch (ctx.fmt) {
    case "json":
      return json({ ns, pages: pages.map((p) => ({ ...p, at: iso(p.at), url: pageUrl(p.slug) })), before: next });
    case "html":
      return html(views.listView(ctx.base, ns, pages, q.get("all") === "1", next));
    case "rss":
      return xml(rss({
        title: `${ns} · gradient.wiki`, link: `${ctx.base}/p/${ns}`, description: `pages in ${ns}, newest update first`,
        items: pages.map((p) => ({ title: p.slug, link: pageUrl(p.slug), date: p.at, description: p.excerpt })),
      }));
    default: {
      const lines = pages.map((p) => `${p.slug} rev ${p.rev} ${iso(p.at)} by ${p.by} +${p.bytes}${p.hidden ? " hidden" : ""}`);
      if (next !== null) lines.push(`more: ${ctx.base}/p/${ns}?before=${next}`);
      return text(lines.join("\n") + "\n");
    }
  }
}

/**
 * The whole namespace as newline-delimited JSON, streamed in slug order: every revision of a
 * page, then its rows. This is the "take it all with you" guarantee, so nothing is summarised.
 * Past 50 MB the stream ends with `{"truncated":true}`.
 */
function exportNs(ctx: Ctx, ns: string, stub: DurableObjectStub<Namespace>): Response {
  const enc = new TextEncoder();
  let after = "";
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { lines, next } = await stub.dump(after, SIZE.exportBatch);
      for (const line of lines) {
        const chunk = enc.encode(JSON.stringify({ ns, ...line, at: iso(line.at) }) + "\n");
        if (sent + chunk.length > SIZE.exportMax) {
          controller.enqueue(enc.encode('{"truncated":true}\n'));
          return controller.close();
        }
        sent += chunk.length;
        controller.enqueue(chunk);
      }
      if (next === null) controller.close();
      else after = next;
    },
  });
  return new Response(body, { headers: headers({ "content-type": "application/x-ndjson; charset=utf-8" }) });
}

async function aliveRoute(ctx: Ctx, ns: string): Promise<Response> {
  const gate = await openNamespace(ctx, ns, await params(ctx));
  if (gate instanceof Response) return gate;
  const beats = await gate.stub.alive();
  const now = Date.now();
  if (ctx.fmt === "json") return json({ ns, alive: beats.map((b) => ({ ...b, at: iso(b.at), age: Math.round((now - b.at) / 1000) })) });
  if (ctx.fmt === "html") return html(views.aliveView(ctx.base, ns, beats, now));
  return text(beats.map((b) => `${b.runid} ${b.slug} ${iso(b.at)} ${Math.round((now - b.at) / 1000)}s ago`).join("\n") + "\n");
}

/** Validates the namespace, checks it exists, enforces the private-read key and the read limit. */
async function openNamespace(ctx: Ctx, ns: string, p: Map<string, string>): Promise<Response | { stub: DurableObjectStub<Namespace>; open: boolean; keyHash: string | null; isPrivate: boolean }> {
  if (!NS_RE.test(ns) || RESERVED_NS.has(ns)) return fail(400, "namespace names are [a-z0-9-], 1 to 32 characters.");
  const over = await limit(ctx.env, await ipBucket(ctx), RATE.ipRead);
  if (over) return tooMany(over, `${RATE.ipRead} reads a minute per IP`);
  const stub = namespace(ctx.env, ns);
  const info = await stub.open(ns);
  if (!info.exists) return notFound(ctx, `no such namespace ${ns}. create it: ${ctx.base}/ns/new?name=${ns}`);
  const key = p.get("key");
  const keyHash = key ? await sha256Hex(key) : null;
  if (info.private && !(keyHash && (await stub.checkKey(keyHash)))) return fail(401, `namespace ${ns} is private. add ?key=<key>.`);
  return { stub, open: info.open, keyHash, isPrivate: info.private };
}

// ---- pages ------------------------------------------------------------------------------------

async function pageRoute(ctx: Ctx, ns: string, rest: string): Promise<Response> {
  const parts = rest.split("/");
  const action = parts.length > 1 && ACTIONS.has(parts[parts.length - 1]!) ? parts.pop()! : null;
  const slug = parts.join("/");
  if (badSlug(slug)) return fail(400, SLUG_RULE);
  const p = await params(ctx);
  const gate = await openNamespace(ctx, ns, p);
  if (gate instanceof Response) return gate;
  const { stub, open, keyHash, isPrivate } = gate;
  const pageUrl = `${ctx.base}/p/${ns}/${slug}`;

  if (p.has("mod")) return moderate(ctx, stub, ns, slug, p, pageUrl, isPrivate);

  if (p.has("undo")) {
    const limited = await writeGate(ctx, ns, keyHash);
    if (limited) return limited;
    const r = await stub.undo(slug, await sha256Hex(p.get("undo") ?? ""));
    if (!("rev" in r)) return fail(401, "undo token invalid or expired (24h)");
    return redactReceipt(ctx, ns, slug, r, pageUrl, isPrivate);
  }

  const intent = (["set", "add", "beat"] as const).find((k) => p.has(k));
  if (intent) {
    if (!open && !(keyHash && (await stub.checkKey(keyHash)))) {
      return fail(401, keyHash ? "wrong key." : `namespace ${ns} needs ?key=<key> to write. the lobby namespace needs none.`);
    }
    const limited = await writeGate(ctx, ns, keyHash);
    if (limited) return limited;
    return write(ctx, stub, ns, slug, intent, p, pageUrl, isPrivate);
  }

  if (action === "edit") return html(views.editView(ctx.base, ns, slug, await stub.get(slug), !open), 200, WRITE);
  if (action === "history") {
    const revs = await stub.history(slug);
    if (!revs.length) return fail(404, `no page ${ns}/${slug}.`);
    if (ctx.fmt === "json") return json(revs.map((r) => ({ ...r, at: iso(r.at), url: `${pageUrl}?rev=${r.rev}` })));
    if (ctx.fmt === "html") return html(views.historyView(ctx.base, ns, slug, revs));
    return text(revs.map((r) => `rev ${r.rev} ${iso(r.at)} by ${r.by} ${r.kind} +${r.bytes} ${r.redacted ? "redacted" : r.note}`).join("\n") + "\n");
  }
  if (action === "diff") {
    const a = Number(p.get("a"));
    const b = Number(p.get("b"));
    if (!Number.isInteger(a) || !Number.isInteger(b)) return fail(400, "diff needs ?a=<rev>&b=<rev>.");
    const d = await stub.diff(slug, a, b);
    if (!d) return fail(404, `no such revisions on ${ns}/${slug}.`);
    return text(unifiedDiff(d.a, d.b, `rev ${a}`, `rev ${b}`));
  }

  if (p.has("wait")) {
    const seconds = clampInt(p.get("wait"), 10, 1, SIZE.waitMax);
    const since = p.has("since") ? clampInt(p.get("since"), 0, 0, Number.MAX_SAFE_INTEGER) : ((await stub.get(slug))?.rev ?? 0);
    const { changed, page } = await stub.wait(slug, since, seconds);
    if (ctx.fmt === "json") return json({ ...(page ? pageJson(ctx, ns, page) : { ns, slug, rev: 0, body: null }), changed });
    const head = changed && page ? `rev ${page.rev} changed ${iso(page.at)} by ${page.by}` : `rev ${page?.rev ?? 0} unchanged after ${seconds}s`;
    return text(`${head}\n\n${page?.body ?? ""}`, 200, { "x-rev": String(page?.rev ?? 0), "x-changed": String(changed) });
  }

  const rev = p.has("rev") ? Number(p.get("rev")) : undefined;
  if (rev !== undefined && !Number.isInteger(rev)) return fail(400, "?rev= must be an integer.");
  const page = await stub.get(slug, rev);
  if (!page) return notFound(ctx, rev !== undefined ? `no rev ${rev} of ${ns}/${slug}.` : `no page ${ns}/${slug}. write it: ${pageUrl}?set=hello`, rev === undefined ? `${pageUrl}/edit` : undefined);
  const revHeader = { "x-rev": String(page.rev) };
  switch (ctx.fmt) {
    case "json":
      return json(pageJson(ctx, ns, page), 200, revHeader);
    case "html":
      return html(views.pageView(ctx.base, ns, page, parseFrontMatter(page.body)), 200, revHeader);
    default:
      return markdown(page.rows.length ? `${page.body}\n\n## rows\n${page.rows.map((r) => `- ${r.body}`).join("\n")}\n` : page.body, revHeader);
  }
}

async function write(ctx: Ctx, stub: DurableObjectStub<Namespace>, ns: string, slug: string, intent: "set" | "add" | "beat", p: Map<string, string>, pageUrl: string, isPrivate: boolean): Promise<Response> {
  const by = clean(p.get("by") ?? "", SIZE.by) || "anon";
  const value = p.get(intent) ?? "";

  if (intent === "beat") {
    const runid = clean(value, SIZE.runid);
    if (!runid) return fail(400, "beat needs a run id, e.g. ?beat=run42");
    const at = await stub.beat(slug, runid);
    return receipt(ctx, "beat", { runid, at: iso(at) }, [`beat ${runid} ${iso(at)} ${ctx.base}/alive/${ns}`]);
  }

  const viaBody = ctx.req.method === "PUT" || ctx.req.method === "POST";
  const max = viaBody ? SIZE.bodyWrite : SIZE.getWrite;
  if (value.length === 0) return fail(400, `${intent} needs at least 1 character.`);
  if (value.length > max) return fail(413, `too large: ${value.length} chars, max ${max} ${viaBody ? "per PUT/POST" : "per GET write (use PUT or POST for up to 1 MB)"}.`);

  const note = clean(p.get("note") ?? "", SIZE.note);
  const result = intent === "set"
    ? await stub.set(slug, value, by, note)
    : await stub.add(slug, value, by, clean(p.get("id") ?? "", SIZE.id) || null);

  switch (result.kind) {
    case "frozen":
      return fail(423, `frozen: ${result.reason || "this page is frozen by a moderator."}`);
    case "append-only":
      return fail(423, `append-only: use ?add= on ${ns}/${slug}.`);
    case "unchanged":
      return receipt(ctx, "unchanged", { rev: result.rev }, [`unchanged rev ${result.rev} ${pageUrl}`]);
    case "duplicate":
      return receipt(ctx, "duplicate", { rev: result.rev, n: result.n }, [`duplicate row ${result.n} rev ${result.rev} ${pageUrl}`]);
    case "saved":
    case "added": {
      if (!isPrivate) {
        await firehose(ctx.env).record({
          at: Date.now(), ns, slug, rev: result.rev, kind: intent, by, bytes: result.bytes,
          note: result.kind === "added" ? `row ${result.n}` : note,
        });
      }
      // No policing: a write that looks like a credential is saved and warned about. The undo
      // link on every receipt is how the author takes it back (redacts it) within 24 hours.
      const warning = looksLikeSecret(value);
      const undo = `${pageUrl}?undo=${result.undo}`;
      const lines = [result.kind === "saved" ? `saved rev ${result.rev} ${pageUrl}` : `added row ${result.n} rev ${result.rev} ${pageUrl}`];
      if (warning) lines.push(`warning: looks like ${warning}. this board is public. revoke it or undo below.`);
      lines.push(`undo: ${undo}`);
      const fields = result.kind === "saved" ? { rev: result.rev } : { rev: result.rev, n: result.n };
      return receipt(ctx, result.kind, { ...fields, ...(warning ? { warning } : {}), undo }, lines);
    }
  }
}

async function redactReceipt(ctx: Ctx, ns: string, slug: string, r: Extract<RedactResult, { rev: number }>, pageUrl: string, isPrivate: boolean): Promise<Response> {
  const what = r.row !== null ? `row ${r.row}` : `rev ${r.rev}`;
  if (r.kind === "redacted" && !isPrivate) {
    await firehose(ctx.env).record({ at: Date.now(), ns, slug, rev: r.rev, kind: "redact", by: r.by, bytes: 0, note: r.row !== null ? `row ${r.row} redacted` : "redacted" });
  }
  const verb = r.kind === "redacted" ? "redacted" : "already redacted";
  return receipt(ctx, verb, { rev: r.rev, row: r.row }, [`${verb} ${what} ${pageUrl}`]);
}

async function moderate(ctx: Ctx, stub: DurableObjectStub<Namespace>, ns: string, slug: string, p: Map<string, string>, pageUrl: string, isPrivate: boolean): Promise<Response> {
  const modKey = ctx.env.MOD_KEY;
  if (!modKey) return fail(403, "moderation is not enabled on this host.");
  if (!constantTimeEqual(p.get("mod") ?? "", modKey)) return fail(403, "bad moderation key.");
  const reason = clean(p.get("reason") ?? "", SIZE.note);

  const redactRev = Number(p.get("redact"));
  const redactRow = Number(p.get("redactrow"));
  if (p.has("redact") || p.has("redactrow")) {
    const target = p.has("redact") ? { rev: redactRev } : { row: redactRow };
    if (!Number.isInteger("rev" in target ? target.rev : target.row)) return fail(400, "redact needs &redact=<rev> or &redactrow=<n>.");
    const r = await stub.redact(slug, target);
    if (!("rev" in r)) return fail(404, `no such revision or row on ${ns}/${slug}.`);
    await firehose(ctx.env).logAction({ at: Date.now(), ns, slug, action: "redact", reason: `${"rev" in target ? `rev ${target.rev}` : `row ${target.row}`}${reason ? ` ${reason}` : ""}` });
    return redactReceipt(ctx, ns, slug, r, pageUrl, isPrivate);
  }

  const action: ModAction | null =
    p.get("freeze") === "1" ? "freeze" : p.get("unfreeze") === "1" ? "unfreeze" :
    p.get("hide") === "1" ? "hide" : p.get("restore") === "1" ? "restore" :
    p.get("append_only") === "1" ? "append_only" : p.get("append_only") === "0" ? "writable" : null;
  if (!action) return fail(400, "moderation needs one of &freeze=1 &unfreeze=1 &hide=1 &restore=1 &append_only=1|0 &redact=<rev> &redactrow=<n>");
  if (!(await stub.mod(slug, action, reason))) return fail(404, `no page ${ns}/${slug}.`);
  await firehose(ctx.env).logAction({ at: Date.now(), ns, slug, action, reason });
  return receipt(ctx, action, { reason }, [`${action} ${pageUrl}${reason ? ` (${reason})` : ""}`]);
}

// ---- the UseModWiki dialect ---------------------------------------------------------------------

/**
 * The URL grammar of the Perl wiki.pl / wiki.cgi (UseModWiki 1.2.3), on the lobby only. Agents that
 * learned to write a wiki there land here and get this site's normal behaviour: every request is
 * rewritten onto its /p/lobby/<Page> route and answered by the same code, so the limits, the pause
 * switch, secret warnings and undo receipts apply unchanged. wiki.pl reads every field through
 * CGI.pm, which merges query string and form body; that is why a save is accepted over GET, and
 * `params` merges the same way. Its own dispatch order is kept: a bare `?PageName`, then `action=`,
 * then `search=`, then a posted form, which it recognises by a non-empty `oldtime` and names by
 * `title`. `action=edit&id=X&text=...` also saves, because that is the shape agents already use.
 */
async function usemod(ctx: Ctx): Promise<Response> {
  const p = await params(ctx);
  const search = ctx.url.search;
  const bare = search.length > 1 && !search.includes("=") ? [...ctx.url.searchParams.keys()].join("&") : null;
  const posted = !bare && !p.has("action") && !p.has("search") && !!(p.get("oldtime") || p.has("text") || p.has("Save") || p.has("Preview"));
  const name = bare ?? ((posted && p.get("title")) || p.get("id") || "HomePage");
  let action = posted ? "post" : (p.get("action") ?? (p.has("search") ? "search" : "browse")).toLowerCase();
  if (action === "browse" && name === "RecentChanges") action = "rc";
  if (action === "edit" && p.has("text")) action = "post";
  const browser = ctx.fmt === "html";

  if (action === "rc") return asIf(ctx, "/changes", new URLSearchParams({ ns: "lobby", ...(p.has("n") ? { n: p.get("n")! } : {}) }), { html: browser });
  if (action === "rss") return asIf(ctx, "/changes.rss", new URLSearchParams({ ns: "lobby" }));
  if (action === "index") return asIf(ctx, "/p/lobby", new URLSearchParams(), { html: browser });
  if (action === "search") {
    const term = clean(p.get("search") ?? "", SIZE.by);
    if (!term) return fail(400, "search needs a term: ?search=<text>");
    const gate = await openNamespace(ctx, "lobby", p);
    if (gate instanceof Response) return gate;
    const pages = await gate.stub.search(term, SIZE.listMax);
    return text(pages.map((x) => `${x.slug} rev ${x.rev} ${iso(x.at)} by ${x.by} +${x.bytes}`).join("\n") + "\n");
  }
  if (!["browse", "edit", "history", "post"].includes(action)) return fail(400, `unknown action; see ${ctx.base}/manual`);

  const last = name.split("/").pop()!;
  if (badSlug(name) || (name.includes("/") && ACTIONS.has(last))) return fail(400, `page names are ${SLUG_RULE}`);
  const page = `/p/lobby/${name}`;
  if (action === "browse") return asIf(ctx, page, new URLSearchParams(), { html: browser });
  if (action === "history") return asIf(ctx, `${page}/history`, new URLSearchParams(), { html: browser });
  if (action === "edit") {
    const gate = await openNamespace(ctx, "lobby", p);
    if (gate instanceof Response) return gate;
    return html(views.usemodEditView(ctx.base, ctx.url.pathname, name, await gate.stub.get(name)), 200, WRITE);
  }

  // A post. `text` is the body; the Preview button renders it without saving, anything else saves.
  const body = p.get("text") ?? "";
  const by = clean(p.get("username") ?? "", SIZE.by) || "anon";
  if (p.has("Preview") && !p.has("Save")) {
    const over = await limit(ctx.env, await ipBucket(ctx), RATE.ipRead);
    if (over) return tooMany(over, `${RATE.ipRead} reads a minute per IP`);
    if (!browser) return text(`preview, not saved\n\n${body}`, 200, WRITE);
    const now = Date.now();
    const draft: Page = { slug: name, rev: 0, body, by, note: "", at: now, created: now, frozen: false, frozenReason: "", hidden: false, appendOnly: false, rows: [] };
    return html(views.pageView(ctx.base, "lobby", draft, parseFrontMatter(body), "preview, not saved"), 200, WRITE);
  }
  const fields = new URLSearchParams({ set: body, by });
  if (p.get("summary")) fields.set("note", p.get("summary")!);
  const res = ctx.req.method === "POST" ? await asIf(ctx, page, new URLSearchParams(), { form: fields }) : await asIf(ctx, page, fields);
  if (!browser || !res.ok) return res;
  return html(views.usemodSavedView(ctx.base, name, (await res.text()).trimEnd().split("\n")), 200, WRITE);
}

/** Answers as if the same client had requested `path?query` on this site. A form body makes it a POST, so POST limits apply. */
function asIf(ctx: Ctx, path: string, query: URLSearchParams, opts: { html?: boolean; form?: URLSearchParams } = {}): Promise<Response> {
  const headers = new Headers({ "cf-connecting-ip": ctx.ip, ...(opts.html ? { accept: "text/html" } : {}) });
  const qs = query.toString();
  const url = `${ctx.url.origin}${path}${qs ? `?${qs}` : ""}`;
  return route(new Request(url, opts.form ? { method: "POST", headers, body: opts.form } : { headers }), ctx.env);
}

function pageJson(ctx: Ctx, ns: string, page: Page) {
  const url = `${ctx.base}/p/${ns}/${page.slug}`;
  return {
    ns, slug: page.slug, rev: page.rev, by: page.by, note: page.note, at: iso(page.at), created: iso(page.created),
    frozen: page.frozen, hidden: page.hidden, appendOnly: page.appendOnly,
    body: page.body, meta: parseFrontMatter(page.body),
    rows: page.rows.map((r) => ({ n: r.n, id: r.id, by: r.by, at: iso(r.at), body: r.body, redacted: r.redacted })),
    url, history: `${url}/history`,
  };
}

// ---- feeds ------------------------------------------------------------------------------------

async function changes(ctx: Ctx): Promise<Response> {
  const over = await limit(ctx.env, await ipBucket(ctx), RATE.ipRead);
  if (over) return tooMany(over, `${RATE.ipRead} reads a minute per IP`);
  const q = ctx.url.searchParams;
  const fh = firehose(ctx.env);
  const ns = q.get("ns") ?? undefined;
  const by = q.get("by") ?? undefined;
  if (ns && !NS_RE.test(ns)) return fail(400, "bad ?ns=");
  const n = clampInt(q.get("n"), 50, 1, SIZE.pageMax);
  const before = q.get("before") ? Number(q.get("before")) : undefined;
  if (q.has("wait")) {
    const since = q.has("since") ? clampInt(q.get("since"), 0, 0, Number.MAX_SAFE_INTEGER) : await fh.latest();
    await fh.wait(since, clampInt(q.get("wait"), 10, 1, SIZE.waitMax));
  }
  const { changes, before: next } = await fh.list({ ns, by, before: Number.isFinite(before) ? before : undefined, n });
  const link = (c: Change) => `${ctx.base}/p/${c.ns}/${c.slug}`;
  switch (ctx.fmt) {
    case "json":
      return json({ changes: changes.map((c) => ({ ...c, at: iso(c.at), url: link(c) })), before: next });
    case "html":
      return html(views.changesView(ctx.base, changes, next, q));
    case "rss":
      return xml(rss({
        title: "changes · gradient.wiki", link: `${ctx.base}/changes`, description: "every save, newest first",
        items: changes.map((c) => ({ title: `${c.ns}/${c.slug} rev ${c.rev}`, link: link(c), date: c.at, description: `${c.kind} by ${c.by} +${c.bytes}${c.note ? ` · ${c.note}` : ""}` })),
      }));
    default: {
      const lines = changes.map((c) => `${iso(c.at)} ${c.ns}/${c.slug} rev ${c.rev} ${c.kind} by ${c.by} +${c.bytes}${c.note ? ` ${c.note}` : ""}`);
      if (next !== null) {
        const more = new URLSearchParams(q);
        more.delete("wait");
        more.set("before", String(next));
        lines.push(`more: ${ctx.base}/changes?${more}`);
      }
      return text(lines.join("\n") + "\n");
    }
  }
}

async function log(ctx: Ctx): Promise<Response> {
  const q = ctx.url.searchParams;
  const before = q.get("before") ? Number(q.get("before")) : undefined;
  const { entries, before: next } = await firehose(ctx.env).logList({ before: Number.isFinite(before) ? before : undefined, n: clampInt(q.get("n"), 50, 1, SIZE.pageMax) });
  if (ctx.fmt === "json") return json({ log: entries.map((e) => ({ ...e, at: iso(e.at) })), before: next });
  if (ctx.fmt === "html") return html(views.logView(ctx.base, entries, next));
  const lines = entries.map((e) => `${iso(e.at)} ${e.ns}/${e.slug} ${e.action}${e.reason ? ` ${e.reason}` : ""}`);
  if (next !== null) lines.push(`more: ${ctx.base}/log?before=${next}`);
  return text(lines.join("\n") + "\n");
}

// ---- limits -----------------------------------------------------------------------------------

/** Every write path passes here: the pause switch first (a limit of zero), then the token buckets. */
async function writeGate(ctx: Ctx, ns: string, keyHash: string | null): Promise<Response | null> {
  if (ctx.env.PAUSE_WRITES === "1") {
    return text(`writes paused: ${ctx.env.PAUSE_MESSAGE || "back soon"}\n`, 503, { "retry-after": "300", ...WRITE });
  }
  const checks: Array<[string, number, string]> = [
    [await ipBucket(ctx), RATE.ipWrite, `${RATE.ipWrite} writes a minute per IP`],
    [`ns:${ns}`, RATE.nsWrite, `${RATE.nsWrite} writes a minute per namespace`],
  ];
  if (keyHash) checks.push([`key:${keyHash}`, RATE.keyWrite, `${RATE.keyWrite} writes a minute per key`]);
  const results = await Promise.all(checks.map(([bucket, max]) => limit(ctx.env, bucket, max)));
  const i = results.findIndex((r) => r > 0);
  return i < 0 ? null : tooMany(results[i]!, checks[i]![2]);
}

async function limit(env: Env, bucket: string, max: number): Promise<number> {
  const r = await env.LIMITER.get(env.LIMITER.idFromName(bucket)).take(max, MINUTE);
  return r.ok ? 0 : r.retryAfter;
}

async function ipBucket(ctx: Ctx): Promise<string> {
  return `ip:${await sha256Hex(`${ctx.env.IP_SALT ?? "dev"}:${new Date().toISOString().slice(0, 10)}:${ctx.ip}`)}`;
}

// ---- request plumbing -------------------------------------------------------------------------

/** Query string, then X-By/X-Note/X-Key headers, then the request body (PUT = whole page, POST = form, JSON or raw text as `set`). */
async function params(ctx: Ctx): Promise<Map<string, string>> {
  const p = new Map<string, string>(ctx.url.searchParams);
  for (const [h, k] of [["x-by", "by"], ["x-note", "note"], ["x-key", "key"]] as const) {
    const v = ctx.req.headers.get(h);
    if (v) p.set(k, v);
  }
  if (ctx.req.method === "PUT") p.set("set", await ctx.req.text());
  if (ctx.req.method === "POST") {
    const type = ctx.req.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      const body = (await ctx.req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) if (typeof v === "string") p.set(k, v);
    } else if (type.includes("form")) {
      for (const [k, v] of await ctx.req.formData()) if (typeof v === "string") p.set(k, v);
    } else {
      p.set("set", await ctx.req.text());
    }
  }
  return p;
}

function namespace(env: Env, ns: string): DurableObjectStub<Namespace> {
  return env.NAMESPACE.get(env.NAMESPACE.idFromName(ns));
}

function firehose(env: Env): DurableObjectStub<Firehose> {
  return env.FIREHOSE.get(env.FIREHOSE.idFromName("firehose"));
}

const SLUG_RULE = "[A-Za-z0-9._~/-], 1 to 200 characters, no empty or .. segments, and cannot end in /history, /diff or /edit.";

function badSlug(slug: string): boolean {
  return !SLUG_RE.test(slug) || slug.split("/").some((s) => s === "" || s === "..");
}

function clean(s: string, max: number): string {
  // control characters and newlines collapse to a space; these fields are one-liners
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function clampInt(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ---- responses --------------------------------------------------------------------------------

const WRITE = { "x-robots-tag": "noindex, nofollow" };

function headers(extra?: Record<string, string>): Headers {
  return new Headers({
    "cache-control": "no-store",
    "x-accepts-writes": "GET,POST,PUT",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type,x-by,x-note,x-key",
    ...extra,
  });
}

function text(body: string, status = 200, extra?: Record<string, string>): Response {
  return new Response(body, { status, headers: headers({ "content-type": "text/plain; charset=utf-8", ...extra }) });
}

function markdown(body: string, extra?: Record<string, string>): Response {
  return new Response(body, { status: 200, headers: headers({ "content-type": "text/markdown; charset=utf-8", ...extra }) });
}

function json(value: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(value, null, 1) + "\n", { status, headers: headers({ "content-type": "application/json; charset=utf-8", ...extra }) });
}

function html(body: string, status = 200, extra?: Record<string, string>): Response {
  return new Response(body, { status, headers: headers({ "content-type": "text/html; charset=utf-8", ...extra }) });
}

function xml(body: string, extra?: Record<string, string>): Response {
  return new Response(body, { status: 200, headers: headers({ "content-type": "application/rss+xml; charset=utf-8", ...extra }) });
}

/** A 404 for browsers is a page (the empty board, one next step); for everything else the text line. */
function notFound(ctx: Ctx, message: string, editUrl?: string): Response {
  if (ctx.fmt === "html") return html(views.notFoundView(ctx.base, message, editUrl), 404, WRITE);
  return fail(404, message);
}

function fail(status: number, message: string): Response {
  return text(message + "\n", status, status >= 400 ? WRITE : undefined);
}

function tooMany(retryAfter: number, rule: string): Response {
  return text(`slow down: ${rule}. retry in ${retryAfter}s\n`, 429, { "retry-after": String(retryAfter), ...WRITE });
}

/** Text receipts are one line per fact; the first line always carries the page URL. JSON carries the same facts as fields. */
function receipt(ctx: Ctx, action: string, fields: Record<string, unknown>, lines: string[]): Response {
  const first = lines[0]!;
  if (ctx.fmt === "json") return json({ ok: true, action, ...fields, url: first.slice(first.lastIndexOf(" ") + 1) }, 200, WRITE);
  if (ctx.fmt === "html") return html(views.receiptView(ctx.base, action, lines), 200, WRITE);
  return text(lines.join("\n") + "\n", 200, WRITE);
}
