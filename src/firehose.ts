import { DurableObject } from "cloudflare:workers";
import type { Change, Env, LogEntry, CaseEntry, CaseInput } from "./types";

import { buildCaseMail, sendInboxMail } from "./mail";

// A single Durable Object that orders every public save across all namespaces. Its sequence
// number is the /changes cursor. Private namespaces only reach the keyed cases queue.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, ns TEXT NOT NULL, slug TEXT NOT NULL,
  rev INTEGER NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, bytes INTEGER NOT NULL, note TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS changes_ns ON changes(ns, seq);
CREATE INDEX IF NOT EXISTS changes_author ON changes(author, seq);
CREATE TABLE IF NOT EXISTS log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, ns TEXT NOT NULL, slug TEXT NOT NULL,
  action TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, ns TEXT NOT NULL, slug TEXT NOT NULL,
  rev INTEGER NOT NULL, row INTEGER, source TEXT NOT NULL, reason TEXT NOT NULL, note TEXT NOT NULL,
  "by" TEXT NOT NULL, cat INTEGER, quote TEXT, action TEXT NOT NULL, status TEXT NOT NULL,
  resolved_at INTEGER, resolved_by TEXT);
CREATE INDEX IF NOT EXISTS cases_status ON cases(status, seq);
`;

// Columns added after the first schema; brings a pre-existing database up to date.
const LATER_COLUMNS: Record<string, string> = { sealed: "INTEGER NOT NULL DEFAULT 0" };

const MAX_WAITERS = 500;
const MAIL_BATCH = 10 * 60_000;

type ChangeRec = {
  seq: number;
  at: number;
  ns: string;
  slug: string;
  rev: number;
  kind: "set" | "add";
  author: string;
  bytes: number;
  note: string;
  sealed: number;
};

export class Firehose extends DurableObject<Env> {
  private warnedNoMail = false;
  private waiters = new Set<() => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      const have = new Set(this.sql.exec<{ name: string }>("PRAGMA table_info(changes)").toArray().map((r) => r.name));
      for (const [col, decl] of Object.entries(LATER_COLUMNS)) if (!have.has(col)) this.sql.exec(`ALTER TABLE changes ADD COLUMN ${col} ${decl}`);
      await this.queueCaseMail();
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  record(c: Omit<Change, "seq">): number {
    this.sql.exec(
      "INSERT INTO changes (at, ns, slug, rev, kind, author, bytes, note, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      c.at, c.ns, c.slug, c.rev, c.kind, c.by, c.bytes, c.note, c.sealed ? 1 : 0);
    const seq = this.sql.exec<{ seq: number }>("SELECT last_insert_rowid() AS seq").one().seq;
    for (const done of [...this.waiters]) done();
    return seq;
  }

  list(q: { ns?: string; by?: string; before?: number; n: number }): { changes: Change[]; before: number | null } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.ns) where.push("ns = ?"), args.push(q.ns);
    if (q.by) where.push("author = ?"), args.push(q.by);
    if (q.before) where.push("seq < ?"), args.push(q.before);
    const rows = this.sql
      .exec<ChangeRec>(
        `SELECT * FROM changes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`,
        ...args, q.n + 1)
      .toArray();
    const page = rows.slice(0, q.n);
    return {
      changes: page.map((r) => ({ seq: r.seq, at: r.at, ns: r.ns, slug: r.slug, rev: r.rev, kind: r.kind, by: r.author, bytes: r.bytes, note: r.note, sealed: r.sealed === 1 })),
      before: rows.length > q.n ? page[page.length - 1]!.seq : null,
    };
  }

  latest(): number {
    return this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").one().seq;
  }

  /** Every namespace that has had a public save. Private namespaces never reach this object, so this is the sitemap's roster. */
  namespaces(): string[] {
    return this.sql.exec<{ ns: string }>("SELECT DISTINCT ns FROM changes ORDER BY ns").toArray().map((r) => r.ns);
  }

  /** Resolves true when a change lands with seq > since, false after `seconds`. */
  async wait(since: number, seconds: number): Promise<boolean> {
    if (this.latest() > since) return true;
    if (this.waiters.size >= MAX_WAITERS) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => (this.waiters.delete(done), resolve(false)), seconds * 1000);
      const done = () => (clearTimeout(timer), this.waiters.delete(done), resolve(true));
      this.waiters.add(done);
    });
  }

  logAction(e: Omit<LogEntry, "seq">): void {
    this.sql.exec("INSERT INTO log (at, ns, slug, action, reason) VALUES (?, ?, ?, ?, ?)", e.at, e.ns, e.slug, e.action, e.reason);
  }

  logList(q: { before?: number; n: number }): { entries: LogEntry[]; before: number | null } {
    const rows = this.sql
      .exec<LogEntry>(`SELECT * FROM log ${q.before ? "WHERE seq < ?" : ""} ORDER BY seq DESC LIMIT ?`, ...(q.before ? [q.before] : []), q.n + 1)
      .toArray();
    const page = rows.slice(0, q.n);
    return { entries: page, before: rows.length > q.n ? page[page.length - 1]!.seq : null };
  }

  async openCase(c: CaseInput): Promise<number> {
    const status = c.status ?? "open";
    this.sql.exec(`INSERT INTO cases (at, ns, slug, rev, row, source, reason, note, "by", cat, quote, action, status, resolved_at, resolved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.at, c.ns, c.slug, c.rev, c.row, c.source, c.reason, c.note, c.by, c.cat, c.quote?.slice(0, 300) ?? null,
      c.action ?? "none", status, status === "resolved" ? Date.now() : null, status === "resolved" ? "policy" : null);
    const seq = this.sql.exec<{ seq: number }>("SELECT last_insert_rowid() AS seq").one().seq;
    if (status === "open") await this.queueCaseMail();
    return seq;
  }

  flagCase(seq: number, cat: number | null, quote: string | null): void {
    this.sql.exec("UPDATE cases SET cat = ?, quote = ? WHERE seq = ?", cat, quote?.slice(0, 300) ?? null, seq);
  }

  resolveCase(seq: number, ns: string, slug: string, who = "moderator", action = "resolve"): boolean {
    const found = this.sql.exec<{ seq: number }>("SELECT seq FROM cases WHERE seq = ? AND ns = ? AND slug = ?", seq, ns, slug).toArray()[0];
    if (!found) return false;
    this.sql.exec("UPDATE cases SET status = 'resolved', resolved_at = ?, resolved_by = ?, action = ? WHERE seq = ? AND status = 'open'", Date.now(), who, action, seq);
    return true;
  }

  listCases(q: { all?: boolean; before?: number; n: number }): { cases: CaseEntry[]; before: number | null } {
    const rows = this.sql.exec<CaseEntry>(
      "SELECT * FROM cases WHERE (? = 1 OR status = 'open') AND seq < ? ORDER BY seq DESC LIMIT ?",
      q.all ? 1 : 0, q.before ?? Number.MAX_SAFE_INTEGER, Math.min(200, Math.max(1, q.n)) + 1).toArray();
    const cases = rows.slice(0, q.n);
    return { cases, before: rows.length > q.n ? cases[cases.length - 1]!.seq : null };
  }

  private async queueCaseMail(): Promise<void> {
    const mailed = (await this.ctx.storage.get<number>("caseMailedSeq")) ?? 0;
    const pending = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM cases WHERE seq > ? AND status = 'open'", mailed).one().n;
    if (!pending) return;
    if (!this.env.INBOX_TO || !this.env.INBOX_MAIL) {
      if (!this.warnedNoMail) console.log("case mail off: INBOX_MAIL binding or INBOX_TO secret missing");
      this.warnedNoMail = true;
      return;
    }
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + MAIL_BATCH);
  }

  async flushCaseMail(): Promise<number> {
    if (!this.env.INBOX_TO || !this.env.INBOX_MAIL) return 0;
    const mailed = (await this.ctx.storage.get<number>("caseMailedSeq")) ?? 0;
    const newest = this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM cases").one().seq;
    const cases = this.sql.exec<CaseEntry>("SELECT * FROM cases WHERE seq > ? AND seq <= ? AND status = 'open' ORDER BY seq DESC", mailed, newest).toArray();
    if (cases.length) await sendInboxMail(this.env.INBOX_MAIL, buildCaseMail(cases, { to: this.env.INBOX_TO, publicUrl: this.env.PUBLIC_URL, now: Date.now() }));
    await this.ctx.storage.put("caseMailedSeq", newest);
    return cases.length;
  }

  async alarm(): Promise<void> {
    try { await this.flushCaseMail(); }
    catch {
      // Keep the cursor unchanged so a failed send cannot lose a batch.
      console.error("case mail failed, retrying in 10 min");
      await this.ctx.storage.setAlarm(Date.now() + MAIL_BATCH);
      return;
    }
    await this.queueCaseMail();
  }
}
