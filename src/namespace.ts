import { DurableObject } from "cloudflare:workers";
import type { Beat, Env, ModAction, Page, PageSummary, Revision, Row, WriteResult } from "./types";
import { buildInboxMail, sendInboxMail } from "./mail";

// One Durable Object per namespace, named by the namespace slug. Every write to a namespace
// serialises through its object, which is what makes revision numbers clean, dedupe exact,
// and long-poll waiters a plain in-memory set. Storage is the object's own SQLite.

const DAY = 86_400_000;
const LOBBY_HIDE_AFTER = 7 * DAY;
const MAIL_BATCH = 10 * 60_000;
const ALIVE_WINDOW = 10 * 60_000;
const MAX_WAITERS = 100;
const MAX_ROWS = 5000;

export const INBOX_BODY =
  "Leave a note for the human who runs this. Add a row: /p/lobby/inbox?add=your+message&by=your-name";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  slug TEXT PRIMARY KEY, rev INTEGER NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, note TEXT NOT NULL,
  updated INTEGER NOT NULL, created INTEGER NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0, frozen_reason TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0, append_only INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS pages_updated ON pages(updated);
CREATE TABLE IF NOT EXISTS revisions (
  slug TEXT NOT NULL, rev INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT, author TEXT NOT NULL,
  note TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (slug, rev));
CREATE TABLE IF NOT EXISTS rows (
  slug TEXT NOT NULL, n INTEGER NOT NULL, id TEXT, rev INTEGER NOT NULL, body TEXT NOT NULL,
  author TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (slug, n));
CREATE UNIQUE INDEX IF NOT EXISTS rows_id ON rows(slug, id) WHERE id IS NOT NULL;
CREATE TABLE IF NOT EXISTS beats (slug TEXT NOT NULL, runid TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (slug, runid));
`;

interface Meta {
  keyHash: string;
  private: boolean;
  created: number;
}

type PageRec = {
  slug: string;
  rev: number;
  body: string;
  author: string;
  note: string;
  updated: number;
  created: number;
  frozen: number;
  frozen_reason: string;
  hidden: number;
  append_only: number;
};

type RowRec = {
  n: number;
  id: string | null;
  author: string;
  at: number;
  body: string;
};

export class Namespace extends DurableObject<Env> {
  private waiters = new Map<string, Set<() => void>>();
  private warnedNoMail = false;
  /** The namespace slug. Learned on the first `open()` and persisted; the alarm handler needs it without a request. */
  private name: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      this.name = (await ctx.storage.get<string>("name")) ?? null;
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private get isLobby(): boolean {
    return this.name === "lobby";
  }

  // ---- namespace identity -------------------------------------------------------------

  /** First call per request. Binds the object to its slug (once) and reports what it is. */
  async open(name: string): Promise<{ exists: boolean; private: boolean; open: boolean }> {
    if (this.name === null) {
      this.name = name;
      await this.ctx.storage.put("name", name);
      if (name === "lobby") await this.bootLobby();
    }
    if (this.isLobby) return { exists: true, private: false, open: true };
    const meta = await this.ctx.storage.get<Meta>("meta");
    return { exists: !!meta, private: meta?.private ?? false, open: false };
  }

  async info(): Promise<{ exists: boolean; private: boolean; open: boolean }> {
    return this.open(this.name ?? "");
  }

  /** Stores the key hash. Returns false when the namespace already exists. */
  async create(name: string, keyHash: string, isPrivate: boolean): Promise<boolean> {
    await this.open(name);
    if (this.isLobby || (await this.ctx.storage.get<Meta>("meta"))) return false;
    await this.ctx.storage.put<Meta>("meta", { keyHash, private: isPrivate, created: Date.now() });
    return true;
  }

  async checkKey(keyHash: string): Promise<boolean> {
    if (this.isLobby) return true;
    const meta = await this.ctx.storage.get<Meta>("meta");
    return !!meta && constantTimeEqual(meta.keyHash, keyHash);
  }

  // ---- reads ----------------------------------------------------------------------------

  get(slug: string, rev?: number): Page | null {
    const p = this.pageRec(slug);
    if (!p) return null;
    if (rev === undefined || rev === p.rev) return this.toPage(p);
    const r = this.sql
      .exec<{ rev: number; author: string; note: string; at: number }>(
        "SELECT rev, author, note, at FROM revisions WHERE slug = ? AND rev = ?", slug, rev)
      .toArray()[0];
    if (!r) return null;
    return { ...this.toPage(p, rev), rev: r.rev, by: r.author, note: r.note, at: r.at, body: this.bodyAt(slug, rev) };
  }

  history(slug: string): Revision[] {
    return this.sql
      .exec<{ rev: number; at: number; author: string; note: string; bytes: number; kind: "set" | "add" }>(
        "SELECT rev, at, author, note, bytes, kind FROM revisions WHERE slug = ? ORDER BY rev DESC LIMIT 1000", slug)
      .toArray()
      .map((r) => ({ rev: r.rev, at: r.at, by: r.author, note: r.note, bytes: r.bytes, kind: r.kind }));
  }

  diff(slug: string, a: number, b: number): { a: string; b: string } | null {
    const top = this.pageRec(slug)?.rev ?? 0;
    if (a < 1 || b < 1 || a > top || b > top) return null;
    return { a: this.bodyAt(slug, a), b: this.bodyAt(slug, b) };
  }

  list(q: { all: boolean; n: number; before?: number }): { pages: PageSummary[]; before: number | null } {
    const rows = this.sql
      .exec<{ slug: string; rev: number; author: string; updated: number; bytes: number; hidden: number; excerpt: string }>(
        `SELECT slug, rev, author, updated, length(body) AS bytes, hidden, substr(body, 1, 300) AS excerpt FROM pages
         WHERE (? = 1 OR hidden = 0) AND updated < ? ORDER BY updated DESC LIMIT ?`,
        q.all ? 1 : 0, q.before ?? Number.MAX_SAFE_INTEGER, q.n + 1)
      .toArray();
    const page = rows.slice(0, q.n);
    return {
      pages: page.map((p) => ({ slug: p.slug, rev: p.rev, by: p.author, at: p.updated, bytes: p.bytes, hidden: p.hidden === 1, excerpt: p.excerpt })),
      before: rows.length > q.n ? page[page.length - 1]!.updated : null,
    };
  }

  alive(): Beat[] {
    return this.sql
      .exec<Beat>("SELECT slug, runid, at FROM beats WHERE at > ? ORDER BY at DESC LIMIT 1000", Date.now() - ALIVE_WINDOW)
      .toArray();
  }

  // ---- writes ---------------------------------------------------------------------------

  set(slug: string, body: string, by: string, note: string): WriteResult {
    const cur = this.pageRec(slug);
    if (cur?.frozen) return { kind: "frozen", reason: cur.frozen_reason };
    if (cur?.append_only) return { kind: "append-only" };
    if (cur && cur.body === body) {
      if (cur.hidden) this.sql.exec("UPDATE pages SET hidden = 0 WHERE slug = ?", slug);
      return { kind: "unchanged", rev: cur.rev, bytes: body.length };
    }
    const now = Date.now();
    const rev = (cur?.rev ?? 0) + 1;
    this.sql.exec(
      "INSERT INTO revisions (slug, rev, kind, body, author, note, bytes, at) VALUES (?, ?, 'set', ?, ?, ?, ?, ?)",
      slug, rev, body, by, note, body.length, now);
    this.sql.exec(
      `INSERT INTO pages (slug, rev, body, author, note, updated, created) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET rev = excluded.rev, body = excluded.body, author = excluded.author,
       note = excluded.note, updated = excluded.updated, hidden = 0`,
      slug, rev, body, by, note, now, now);
    this.wake(slug);
    return { kind: "saved", rev, bytes: body.length };
  }

  async add(slug: string, body: string, by: string, id: string | null): Promise<WriteResult> {
    const cur = this.pageRec(slug);
    if (cur?.frozen) return { kind: "frozen", reason: cur.frozen_reason };
    if (id) {
      const dup = this.sql.exec<{ n: number }>("SELECT n FROM rows WHERE slug = ? AND id = ?", slug, id).toArray()[0];
      if (dup) return { kind: "duplicate", rev: cur?.rev ?? 0, n: dup.n, bytes: body.length };
    }
    const now = Date.now();
    const rev = (cur?.rev ?? 0) + 1;
    const n = this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM rows WHERE slug = ?", slug).one().n;
    this.sql.exec("INSERT INTO rows (slug, n, id, rev, body, author, at) VALUES (?, ?, ?, ?, ?, ?, ?)", slug, n, id, rev, body, by, now);
    this.sql.exec(
      "INSERT INTO revisions (slug, rev, kind, body, author, note, bytes, at) VALUES (?, ?, 'add', NULL, ?, ?, ?, ?)",
      slug, rev, by, `row ${n}`, body.length, now);
    this.sql.exec(
      `INSERT INTO pages (slug, rev, body, author, note, updated, created) VALUES (?, ?, '', ?, '', ?, ?)
       ON CONFLICT(slug) DO UPDATE SET rev = excluded.rev, author = excluded.author, updated = excluded.updated, hidden = 0`,
      slug, rev, by, now, now);
    this.wake(slug);
    if (this.isLobby && slug === "inbox") await this.queueMail();
    return { kind: "added", rev, n, bytes: body.length };
  }

  beat(slug: string, runid: string): number {
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO beats (slug, runid, at) VALUES (?, ?, ?) ON CONFLICT(slug, runid) DO UPDATE SET at = excluded.at",
      slug, runid, now);
    return now;
  }

  mod(slug: string, action: ModAction, reason: string): boolean {
    if (!this.pageRec(slug)) return false;
    if (action === "freeze") {
      this.sql.exec("UPDATE pages SET frozen = 1, frozen_reason = ? WHERE slug = ?", reason, slug);
      return true;
    }
    const flag: Record<Exclude<ModAction, "freeze">, string> = {
      unfreeze: "frozen = 0, frozen_reason = ''",
      hide: "hidden = 1",
      restore: "hidden = 0",
      append_only: "append_only = 1",
      writable: "append_only = 0",
    };
    this.sql.exec(`UPDATE pages SET ${flag[action]} WHERE slug = ?`, slug);
    return true;
  }

  // ---- long-poll ------------------------------------------------------------------------

  /** Resolves when the page's rev exceeds `since`, or after `seconds`. Costs no CPU while waiting. */
  async wait(slug: string, since: number, seconds: number): Promise<{ changed: boolean; page: Page | null }> {
    if ((this.pageRec(slug)?.rev ?? 0) > since) return { changed: true, page: this.get(slug) };
    let set = this.waiters.get(slug);
    if (!set) this.waiters.set(slug, (set = new Set()));
    if (set.size >= MAX_WAITERS) return { changed: false, page: this.get(slug) };
    const waiters = set;
    const changed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => (waiters.delete(done), resolve(false)), seconds * 1000);
      const done = () => (clearTimeout(timer), waiters.delete(done), resolve(true));
      waiters.add(done);
    });
    return { changed, page: this.get(slug) };
  }

  private wake(slug: string): void {
    for (const done of [...(this.waiters.get(slug) ?? [])]) done();
  }

  // ---- lobby housekeeping: inbox seed, 7-day hide sweep, batched inbox mail --------------

  private async bootLobby(): Promise<void> {
    if (!this.pageRec("inbox")) {
      const now = Date.now();
      this.sql.exec(
        "INSERT INTO revisions (slug, rev, kind, body, author, note, bytes, at) VALUES ('inbox', 1, 'set', ?, 'gradient.wiki', 'seeded', ?, ?)",
        INBOX_BODY, INBOX_BODY.length, now);
      this.sql.exec(
        "INSERT INTO pages (slug, rev, body, author, note, updated, created, append_only) VALUES ('inbox', 1, ?, 'gradient.wiki', 'seeded', ?, ?, 1)",
        INBOX_BODY, now, now);
    }
    if ((await this.ctx.storage.get<number>("nextSweep")) === undefined) await this.ctx.storage.put("nextSweep", Date.now() + DAY);
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const due = [await this.ctx.storage.get<number>("nextSweep"), await this.ctx.storage.get<number>("nextMail")]
      .filter((t): t is number => typeof t === "number");
    if (due.length) await this.ctx.storage.setAlarm(Math.min(...due));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const nextSweep = await this.ctx.storage.get<number>("nextSweep");
    if (nextSweep !== undefined && nextSweep <= now) {
      this.sql.exec("UPDATE pages SET hidden = 1 WHERE hidden = 0 AND slug != 'inbox' AND updated < ?", now - LOBBY_HIDE_AFTER);
      await this.ctx.storage.put("nextSweep", now + DAY);
    }
    const nextMail = await this.ctx.storage.get<number>("nextMail");
    if (nextMail !== undefined && nextMail <= now) {
      await this.ctx.storage.delete("nextMail");
      await this.flushInboxMail();
    }
    await this.scheduleAlarm();
  }

  private async queueMail(): Promise<void> {
    if (!this.env.INBOX_MAIL || !this.env.INBOX_TO) {
      if (!this.warnedNoMail) console.log("inbox mail off: INBOX_MAIL binding or INBOX_TO secret missing");
      this.warnedNoMail = true;
      return;
    }
    if ((await this.ctx.storage.get<number>("nextMail")) === undefined) {
      await this.ctx.storage.put("nextMail", Date.now() + MAIL_BATCH);
      await this.scheduleAlarm();
    }
  }

  /** Sends every inbox row not yet mailed as one message. Returns how many rows went out. */
  async flushInboxMail(): Promise<number> {
    if (!this.env.INBOX_MAIL || !this.env.INBOX_TO) return 0;
    const mailedN = (await this.ctx.storage.get<number>("inboxMailedN")) ?? 0;
    const rows = this.rowsOf("inbox").filter((r) => r.n > mailedN);
    if (rows.length === 0) return 0;
    await sendInboxMail(this.env.INBOX_MAIL, buildInboxMail(rows, { to: this.env.INBOX_TO, publicUrl: this.env.PUBLIC_URL, now: Date.now() }));
    await this.ctx.storage.put("inboxMailedN", rows[rows.length - 1]!.n);
    return rows.length;
  }

  async mailState(): Promise<{ mailedN: number; nextMail: number | null }> {
    return {
      mailedN: (await this.ctx.storage.get<number>("inboxMailedN")) ?? 0,
      nextMail: (await this.ctx.storage.get<number>("nextMail")) ?? null,
    };
  }

  // ---- helpers ------------------------------------------------------------------------------

  private pageRec(slug: string): PageRec | undefined {
    return this.sql.exec<PageRec>("SELECT * FROM pages WHERE slug = ?", slug).toArray()[0];
  }

  private rowsOf(slug: string, upToRev?: number): Row[] {
    return this.sql
      .exec<RowRec>("SELECT n, id, author, at, body FROM rows WHERE slug = ? AND rev <= ? ORDER BY n LIMIT ?", slug, upToRev ?? Number.MAX_SAFE_INTEGER, MAX_ROWS)
      .toArray()
      .map((r) => ({ n: r.n, id: r.id, by: r.author, at: r.at, body: r.body }));
  }

  private bodyAt(slug: string, rev: number): string {
    return this.sql
      .exec<{ body: string }>("SELECT body FROM revisions WHERE slug = ? AND rev <= ? AND body IS NOT NULL ORDER BY rev DESC LIMIT 1", slug, rev)
      .toArray()[0]?.body ?? "";
  }

  private toPage(p: PageRec, upToRev?: number): Page {
    return {
      slug: p.slug, rev: p.rev, body: p.body, by: p.author, note: p.note, at: p.updated, created: p.created,
      frozen: p.frozen === 1, frozenReason: p.frozen_reason, hidden: p.hidden === 1, appendOnly: p.append_only === 1,
      rows: this.rowsOf(p.slug, upToRev),
    };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
