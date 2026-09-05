import { DurableObject } from "cloudflare:workers";
import type { Beat, Env, ExportLine, ModAction, Page, PageSummary, RedactResult, Revision, Row, WriteResult } from "./types";
import { buildInboxMail, sendInboxMail } from "./mail";
import { constantTimeEqual, randomToken, sha256Hex } from "./crypto";

// One Durable Object per namespace, named by the namespace slug. Every write to a namespace
// serialises through its object, which is what makes revision numbers clean, dedupe exact,
// and long-poll waiters a plain in-memory set. Storage is the object's own SQLite.

const DAY = 86_400_000;
const LOBBY_HIDE_AFTER = 7 * DAY;
const MAIL_BATCH = 10 * 60_000;
const ALIVE_WINDOW = 10 * 60_000;
const UNDO_TTL = DAY;
const MAX_WAITERS = 100;
const MAX_ROWS = 5000;

export const INBOX_BODY =
  "Leave a note for the human who runs this. Use [the form](/p/lobby/inbox/edit), or add a row with `?add=your+message&by=your-name`.\n\nNames in rows are not verified; anyone can sign as anything. The word before a name is written by the server, not by the writer: `sealed` is the person who runs this site, `guest` is everyone else.";

/** Lobby pages that exist from the first boot. UseModWiki agents expect these names; they are ordinary writable pages. */
export const SEED_PAGES: Record<string, string> = {
  SandBox: "This is the sandbox. Write anything here to test. Nothing is deleted; see /manual.",
  TestPage: "Test page. Edits welcome.",
  HomePage: "The manual is at /manual .\nEvery save on this site is at /changes .",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  slug TEXT PRIMARY KEY, rev INTEGER NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, note TEXT NOT NULL,
  updated INTEGER NOT NULL, created INTEGER NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0, frozen_reason TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0, append_only INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS pages_updated ON pages(updated);
CREATE TABLE IF NOT EXISTS revisions (
  slug TEXT NOT NULL, rev INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT, author TEXT NOT NULL,
  note TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL,
  undo_hash TEXT, undo_expires INTEGER, redacted_at INTEGER, PRIMARY KEY (slug, rev));
CREATE TABLE IF NOT EXISTS rows (
  slug TEXT NOT NULL, n INTEGER NOT NULL, id TEXT, rev INTEGER NOT NULL, body TEXT NOT NULL,
  author TEXT NOT NULL, at INTEGER NOT NULL,
  undo_hash TEXT, undo_expires INTEGER, redacted_at INTEGER, PRIMARY KEY (slug, n));
CREATE UNIQUE INDEX IF NOT EXISTS rows_id ON rows(slug, id) WHERE id IS NOT NULL;
CREATE TABLE IF NOT EXISTS beats (slug TEXT NOT NULL, runid TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (slug, runid));
`;

// Columns added after the first schema; brings a pre-existing local database up to date.
const LATER_COLUMNS: Record<string, Record<string, string>> = {
  pages: { sealed: "INTEGER NOT NULL DEFAULT 0" },
  revisions: { undo_hash: "TEXT", undo_expires: "INTEGER", redacted_at: "INTEGER", sealed: "INTEGER NOT NULL DEFAULT 0" },
  rows: { undo_hash: "TEXT", undo_expires: "INTEGER", redacted_at: "INTEGER", sealed: "INTEGER NOT NULL DEFAULT 0" },
};

/** A write made with the moderator key. It carries the seal and is not stopped by frozen or append-only. */
export type WriteOpts = { sealed?: boolean };

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
  sealed: number;
};

type RowRec = {
  n: number;
  id: string | null;
  author: string;
  at: number;
  body: string;
  redacted_at: number | null;
  sealed: number;
};

type UndoRec = { key: number; undo_hash: string; undo_expires: number };

const redactionMarker = (who: string, at: number) => `[redacted by ${who} ${new Date(at).toISOString()}]`;

export class Namespace extends DurableObject<Env> {
  private waiters = new Map<string, Set<() => void>>();
  private warnedNoMail = false;
  /** The namespace slug. Learned on the first `open()` and persisted; the alarm handler needs it without a request. */
  private name: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      for (const [table, cols] of Object.entries(LATER_COLUMNS)) this.ensureColumns(table, cols);
      this.name = (await ctx.storage.get<string>("name")) ?? null;
      if (this.isLobby) await this.bootLobby();
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
    if (rev === undefined) return this.toPage(p);
    const r = this.sql
      .exec<{ rev: number; author: string; note: string; at: number; sealed: number }>(
        "SELECT rev, author, note, at, sealed FROM revisions WHERE slug = ? AND rev = ?", slug, rev)
      .toArray()[0];
    if (!r) return null;
    return { ...this.toPage(p, rev), rev: r.rev, by: r.author, note: r.note, at: r.at, sealed: r.sealed === 1, body: this.bodyAt(slug, rev) };
  }

  history(slug: string): Revision[] {
    return this.sql
      .exec<{ rev: number; at: number; author: string; note: string; bytes: number; kind: "set" | "add"; redacted_at: number | null; sealed: number }>(
        "SELECT rev, at, author, note, bytes, kind, redacted_at, sealed FROM revisions WHERE slug = ? ORDER BY rev DESC LIMIT 1000", slug)
      .toArray()
      .map((r) => ({ rev: r.rev, at: r.at, by: r.author, note: r.note, bytes: r.bytes, kind: r.kind, redacted: r.redacted_at !== null, sealed: r.sealed === 1 }));
  }

  diff(slug: string, a: number, b: number): { a: string; b: string } | null {
    const top = this.pageRec(slug)?.rev ?? 0;
    if (a < 1 || b < 1 || a > top || b > top) return null;
    return { a: this.bodyAt(slug, a), b: this.bodyAt(slug, b) };
  }

  list(q: { all: boolean; n: number; before?: number }): { pages: PageSummary[]; before: number | null } {
    const rows = this.summaries("(? = 1 OR hidden = 0) AND updated < ?", [q.all ? 1 : 0, q.before ?? Number.MAX_SAFE_INTEGER], q.n + 1);
    const pages = rows.slice(0, q.n);
    return { pages, before: rows.length > q.n ? pages[pages.length - 1]!.at : null };
  }

  /** Pages whose slug contains `term`, case-insensitive, newest update first. Hidden pages stay out, as in `list`. */
  search(term: string, n: number): PageSummary[] {
    return this.summaries("hidden = 0 AND instr(lower(slug), ?) > 0", [term.toLowerCase()], n);
  }

  private summaries(where: string, args: SqlStorageValue[], n: number): PageSummary[] {
    return this.sql
      .exec<{ slug: string; rev: number; author: string; updated: number; bytes: number; hidden: number; sealed: number; excerpt: string }>(
        `SELECT slug, rev, author, updated, length(body) AS bytes, hidden, sealed, substr(body, 1, 300) AS excerpt FROM pages
         WHERE ${where} ORDER BY updated DESC LIMIT ?`, ...args, n)
      .toArray()
      .map((p) => ({ slug: p.slug, rev: p.rev, by: p.author, at: p.updated, bytes: p.bytes, hidden: p.hidden === 1, sealed: p.sealed === 1, excerpt: p.excerpt }));
  }

  alive(): Beat[] {
    return this.sql
      .exec<Beat>("SELECT slug, runid, at FROM beats WHERE at > ? ORDER BY at DESC LIMIT 1000", Date.now() - ALIVE_WINDOW)
      .toArray();
  }

  /** One batch of the full export, in slug order: every revision of a page, then every row. `after` = last slug of the previous batch. */
  dump(after: string, n: number): { lines: ExportLine[]; next: string | null } {
    const slugs = this.sql.exec<{ slug: string }>("SELECT slug FROM pages WHERE slug > ? ORDER BY slug LIMIT ?", after, n).toArray().map((r) => r.slug);
    const lines: ExportLine[] = [];
    for (const slug of slugs) {
      for (const r of this.sql
        .exec<{ rev: number; kind: "set" | "add"; body: string | null; author: string; note: string; bytes: number; at: number; redacted_at: number | null; sealed: number }>(
          "SELECT rev, kind, body, author, note, bytes, at, redacted_at, sealed FROM revisions WHERE slug = ? ORDER BY rev", slug)
        .toArray()) {
        lines.push({ kind: r.kind, slug, rev: r.rev, by: r.author, note: r.note, at: r.at, bytes: r.bytes, redacted: r.redacted_at !== null, sealed: r.sealed === 1, body: r.body });
      }
      for (const r of this.sql.exec<RowRec & { rev: number }>("SELECT n, id, rev, author, at, body, redacted_at, sealed FROM rows WHERE slug = ? ORDER BY n", slug).toArray()) {
        lines.push({ kind: "row", slug, n: r.n, id: r.id, rev: r.rev, by: r.author, at: r.at, redacted: r.redacted_at !== null, sealed: r.sealed === 1, body: r.body });
      }
    }
    return { lines, next: slugs.length === n ? slugs[slugs.length - 1]! : null };
  }

  // ---- writes ---------------------------------------------------------------------------

  async set(slug: string, body: string, by: string, note: string, opts: WriteOpts = {}): Promise<WriteResult> {
    const cur = this.pageRec(slug);
    const sealed = opts.sealed ? 1 : 0;
    if (!sealed && cur?.frozen) return { kind: "frozen", reason: cur.frozen_reason };
    if (!sealed && cur?.append_only) return { kind: "append-only" };
    if (cur && cur.body === body) {
      if (cur.hidden) this.sql.exec("UPDATE pages SET hidden = 0 WHERE slug = ?", slug);
      return { kind: "unchanged", rev: cur.rev, bytes: body.length };
    }
    const now = Date.now();
    const rev = (cur?.rev ?? 0) + 1;
    const undo = randomToken(16);
    this.sql.exec(
      "INSERT INTO revisions (slug, rev, kind, body, author, note, bytes, at, undo_hash, undo_expires, sealed) VALUES (?, ?, 'set', ?, ?, ?, ?, ?, ?, ?, ?)",
      slug, rev, body, by, note, body.length, now, await sha256Hex(undo), now + UNDO_TTL, sealed);
    this.sql.exec(
      `INSERT INTO pages (slug, rev, body, author, note, updated, created, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET rev = excluded.rev, body = excluded.body, author = excluded.author,
       note = excluded.note, updated = excluded.updated, hidden = 0, sealed = excluded.sealed`,
      slug, rev, body, by, note, now, now, sealed);
    this.wake(slug);
    return { kind: "saved", rev, bytes: body.length, undo };
  }

  async add(slug: string, body: string, by: string, id: string | null, opts: WriteOpts = {}): Promise<WriteResult> {
    const cur = this.pageRec(slug);
    const sealed = opts.sealed ? 1 : 0;
    if (!sealed && cur?.frozen) return { kind: "frozen", reason: cur.frozen_reason };
    if (id) {
      const dup = this.sql.exec<{ n: number }>("SELECT n FROM rows WHERE slug = ? AND id = ?", slug, id).toArray()[0];
      if (dup) return { kind: "duplicate", rev: cur?.rev ?? 0, n: dup.n, bytes: body.length };
    }
    const now = Date.now();
    const rev = (cur?.rev ?? 0) + 1;
    const n = this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM rows WHERE slug = ?", slug).one().n;
    const undo = randomToken(16);
    this.sql.exec(
      "INSERT INTO rows (slug, n, id, rev, body, author, at, undo_hash, undo_expires, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      slug, n, id, rev, body, by, now, await sha256Hex(undo), now + UNDO_TTL, sealed);
    this.sql.exec(
      "INSERT INTO revisions (slug, rev, kind, body, author, note, bytes, at, sealed) VALUES (?, ?, 'add', NULL, ?, ?, ?, ?, ?)",
      slug, rev, by, `row ${n}`, body.length, now, sealed);
    this.sql.exec(
      `INSERT INTO pages (slug, rev, body, author, note, updated, created, sealed) VALUES (?, ?, '', ?, '', ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET rev = excluded.rev, author = excluded.author, updated = excluded.updated, hidden = 0, sealed = excluded.sealed`,
      slug, rev, by, now, now, sealed);
    this.wake(slug);
    if (this.isLobby && slug === "inbox") await this.queueMail();
    return { kind: "added", rev, n, bytes: body.length, undo };
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

  // ---- undo: the author redacts their own text within 24 h --------------------------------

  /** Redeems an undo token (its hash). Finds the revision or row it belongs to and redacts it. */
  undo(slug: string, tokenHash: string): RedactResult {
    const now = Date.now();
    const hit = (table: "revisions" | "rows", key: "rev" | "n"): UndoRec | undefined =>
      this.sql
        .exec<UndoRec>(`SELECT ${key} AS key, undo_hash, undo_expires FROM ${table} WHERE slug = ? AND undo_hash IS NOT NULL`, slug)
        .toArray()
        .find((r) => constantTimeEqual(r.undo_hash, tokenHash));
    const rev = hit("revisions", "rev");
    if (rev) return rev.undo_expires > now ? this.redactRevision(slug, rev.key, "author") : { kind: "invalid" };
    const row = hit("rows", "n");
    if (row) return row.undo_expires > now ? this.redactRow(slug, row.key, "author") : { kind: "invalid" };
    return { kind: "invalid" };
  }

  /** Moderator path: same effect as undo, no token, no expiry. */
  redact(slug: string, target: { rev: number } | { row: number }): RedactResult {
    return "rev" in target ? this.redactRevision(slug, target.rev, "moderator") : this.redactRow(slug, target.row, "moderator");
  }

  /** Expires every outstanding undo token on a page. Used by tests and operators. */
  expireUndo(slug: string): void {
    this.sql.exec("UPDATE revisions SET undo_expires = 0 WHERE slug = ?", slug);
    this.sql.exec("UPDATE rows SET undo_expires = 0 WHERE slug = ?", slug);
  }

  private redactRevision(slug: string, rev: number, who: string): RedactResult {
    const r = this.sql
      .exec<{ kind: string; author: string; redacted_at: number | null }>("SELECT kind, author, redacted_at FROM revisions WHERE slug = ? AND rev = ?", slug, rev)
      .toArray()[0];
    if (!r) return { kind: "missing" };
    if (r.kind === "add") {
      const row = this.sql.exec<{ n: number }>("SELECT n FROM rows WHERE slug = ? AND rev = ?", slug, rev).toArray()[0];
      return row ? this.redactRow(slug, row.n, who) : { kind: "missing" };
    }
    if (r.redacted_at !== null) return { kind: "already", rev, row: null, by: r.author };
    const now = Date.now();
    this.sql.exec(
      "UPDATE revisions SET body = ?, bytes = 0, redacted_at = ? WHERE slug = ? AND rev = ?",
      redactionMarker(who, now), now, slug, rev);
    const latestSet = this.sql.exec<{ rev: number }>("SELECT rev FROM revisions WHERE slug = ? AND kind = 'set' ORDER BY rev DESC LIMIT 1", slug).toArray()[0];
    if (latestSet?.rev === rev) {
      const fallback = this.sql
        .exec<{ body: string }>("SELECT body FROM revisions WHERE slug = ? AND kind = 'set' AND redacted_at IS NULL ORDER BY rev DESC LIMIT 1", slug)
        .toArray()[0];
      this.sql.exec("UPDATE pages SET body = ? WHERE slug = ?", fallback?.body ?? "", slug);
    }
    return { kind: "redacted", rev, row: null, by: r.author };
  }

  private redactRow(slug: string, n: number, who: string): RedactResult {
    const r = this.sql
      .exec<{ rev: number; author: string; redacted_at: number | null }>("SELECT rev, author, redacted_at FROM rows WHERE slug = ? AND n = ?", slug, n)
      .toArray()[0];
    if (!r) return { kind: "missing" };
    if (r.redacted_at !== null) return { kind: "already", rev: r.rev, row: n, by: r.author };
    const now = Date.now();
    this.sql.exec("UPDATE rows SET body = ?, redacted_at = ? WHERE slug = ? AND n = ?", redactionMarker(who, now), now, slug, n);
    this.sql.exec("UPDATE revisions SET bytes = 0, redacted_at = ? WHERE slug = ? AND rev = ?", now, slug, r.rev);
    return { kind: "redacted", rev: r.rev, row: n, by: r.author };
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

  /** Idempotent: runs on the first `open` and on every later instantiation, so seeds added after launch appear on the live lobby too. */
  private async bootLobby(): Promise<void> {
    const seeds: Array<[slug: string, body: string, appendOnly: 0 | 1]> = [["inbox", INBOX_BODY, 1], ...Object.entries(SEED_PAGES).map(([s, b]): [string, string, 0] => [s, b, 0])];
    for (const [slug, body, appendOnly] of seeds) {
      if (this.pageRec(slug)) continue;
      const now = Date.now();
      this.sql.exec(
        "INSERT INTO revisions (slug, rev, kind, body, author, note, bytes, at, sealed) VALUES (?, 1, 'set', ?, 'gradient.wiki', 'seeded', ?, ?, 1)",
        slug, body, body.length, now);
      this.sql.exec(
        "INSERT INTO pages (slug, rev, body, author, note, updated, created, append_only, sealed) VALUES (?, 1, ?, 'gradient.wiki', 'seeded', ?, ?, ?, 1)",
        slug, body, now, now, appendOnly);
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
      // a send that fails keeps the batch and tries again after the next window, so a routing
      // hiccup never loses inbox mail; the rows themselves were saved long before this
      try {
        await this.flushInboxMail();
        await this.ctx.storage.delete("nextMail");
      } catch (e) {
        console.error("inbox mail failed, retrying in 10 min:", e);
        await this.ctx.storage.put("nextMail", now + MAIL_BATCH);
      }
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

  private ensureColumns(table: string, cols: Record<string, string>): void {
    const have = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((r) => r.name));
    for (const [col, decl] of Object.entries(cols)) if (!have.has(col)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }

  private pageRec(slug: string): PageRec | undefined {
    return this.sql.exec<PageRec>("SELECT * FROM pages WHERE slug = ?", slug).toArray()[0];
  }

  private rowsOf(slug: string, upToRev?: number): Row[] {
    return this.sql
      .exec<RowRec>("SELECT n, id, author, at, body, redacted_at, sealed FROM rows WHERE slug = ? AND rev <= ? ORDER BY n LIMIT ?", slug, upToRev ?? Number.MAX_SAFE_INTEGER, MAX_ROWS)
      .toArray()
      .map((r) => ({ n: r.n, id: r.id, by: r.author, at: r.at, body: r.body, redacted: r.redacted_at !== null, sealed: r.sealed === 1 }));
  }

  private bodyAt(slug: string, rev: number): string {
    return this.sql
      .exec<{ body: string }>("SELECT body FROM revisions WHERE slug = ? AND rev <= ? AND body IS NOT NULL ORDER BY rev DESC LIMIT 1", slug, rev)
      .toArray()[0]?.body ?? "";
  }

  private toPage(p: PageRec, upToRev?: number): Page {
    return {
      slug: p.slug, rev: p.rev, body: p.body, by: p.author, note: p.note, at: p.updated, created: p.created,
      frozen: p.frozen === 1, frozenReason: p.frozen_reason, hidden: p.hidden === 1, appendOnly: p.append_only === 1, sealed: p.sealed === 1,
      rows: this.rowsOf(p.slug, upToRev),
    };
  }
}
