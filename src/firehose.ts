import { DurableObject } from "cloudflare:workers";
import type { Change, Env, LogEntry } from "./types";

// A single Durable Object that orders every public save across all namespaces. Its sequence
// number is the /changes cursor. Private namespaces never reach it. It also keeps the public
// moderation log.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, ns TEXT NOT NULL, slug TEXT NOT NULL,
  rev INTEGER NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, bytes INTEGER NOT NULL, note TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS changes_ns ON changes(ns, seq);
CREATE INDEX IF NOT EXISTS changes_author ON changes(author, seq);
CREATE TABLE IF NOT EXISTS log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, ns TEXT NOT NULL, slug TEXT NOT NULL,
  action TEXT NOT NULL, reason TEXT NOT NULL);
`;

const MAX_WAITERS = 500;

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
};

export class Firehose extends DurableObject<Env> {
  private waiters = new Set<() => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => void this.sql.exec(SCHEMA));
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  record(c: Omit<Change, "seq">): number {
    this.sql.exec(
      "INSERT INTO changes (at, ns, slug, rev, kind, author, bytes, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      c.at, c.ns, c.slug, c.rev, c.kind, c.by, c.bytes, c.note);
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
      changes: page.map((r) => ({ seq: r.seq, at: r.at, ns: r.ns, slug: r.slug, rev: r.rev, kind: r.kind, by: r.author, bytes: r.bytes, note: r.note })),
      before: rows.length > q.n ? page[page.length - 1]!.seq : null,
    };
  }

  latest(): number {
    return this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").one().seq;
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
}
