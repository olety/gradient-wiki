import type { Namespace } from "./namespace";
import type { Firehose } from "./firehose";
import type { Limiter } from "./limiter";

export interface Env {
  NAMESPACE: DurableObjectNamespace<Namespace>;
  FIREHOSE: DurableObjectNamespace<Firehose>;
  LIMITER: DurableObjectNamespace<Limiter>;
  OPENROUTER_KEY?: string;
  POLICY_MODEL?: string;
  POLICY_URL?: string;
  LINK_SCREEN?: string;
  PUBLIC_URL: string;
  SOURCE_URL: string;
  CONTACT_EMAIL: string;
  CONTACT_X: string;
  /** Secret. Enables ?mod= actions. Unset = moderation disabled. */
  MOD_KEY?: string;
  /** Secret. Salts the per-IP rate-limit bucket hash. */
  IP_SALT?: string;
  /** Email Workers binding used to forward lobby/inbox rows to the owner. Optional. */
  INBOX_MAIL?: SendEmail;
  /** Secret. Where inbox mail goes. Unset = mail forwarding off. */
  INBOX_TO?: string;
  /** "1" = every write answers 503 with Retry-After: 300. Reads and feeds keep working. */
  PAUSE_WRITES?: string;
  /** The text after "writes paused: " while paused. Default "back soon". */
  PAUSE_MESSAGE?: string;
}

export interface Row {
  n: number;
  id: string | null;
  by: string;
  at: number;
  body: string;
  redacted: boolean;
  /** Written with the moderator key: from the person who runs the site. Every other name is a guest. */
  sealed: boolean;
}

export interface Page {
  slug: string;
  rev: number;
  body: string;
  by: string;
  note: string;
  at: number;
  created: number;
  frozen: boolean;
  frozenReason: string;
  hidden: boolean;
  appendOnly: boolean;
  /** The latest revision was sealed. */
  sealed: boolean;
  rows: Row[];
}

export interface Revision {
  rev: number;
  at: number;
  by: string;
  note: string;
  bytes: number;
  kind: "set" | "add";
  redacted: boolean;
  sealed: boolean;
}

export interface PageSummary {
  slug: string;
  rev: number;
  by: string;
  at: number;
  bytes: number;
  hidden: boolean;
  sealed: boolean;
  /** First 300 characters of the body, for feeds. */
  excerpt: string;
  /** Nothing but redaction markers is left: the body is empty or a marker and no row is unredacted. Feeds and lists keep such pages; the sitemap leaves them out. */
  tombstone: boolean;
}

export type Beat = {
  slug: string;
  runid: string;
  at: number;
};

export interface Change {
  seq: number;
  at: number;
  ns: string;
  slug: string;
  rev: number;
  kind: "set" | "add" | "redact";
  by: string;
  bytes: number;
  note: string;
  sealed: boolean;
}

export type LogEntry = {
  seq: number;
  at: number;
  ns: string;
  slug: string;
  action: string;
  reason: string;
};

export type WriteResult =
  | { kind: "saved"; rev: number; bytes: number; undo: string }
  | { kind: "unchanged"; rev: number; bytes: number }
  | { kind: "added"; rev: number; n: number; bytes: number; undo: string }
  | { kind: "duplicate"; rev: number; n: number; bytes: number }
  | { kind: "frozen"; reason: string }
  | { kind: "append-only" };

export type RedactResult =
  | { kind: "redacted" | "already"; rev: number; row: number | null; by: string }
  | { kind: "invalid" | "missing" };

export type ModAction = "freeze" | "unfreeze" | "hide" | "restore" | "append_only" | "writable";

/** One line of a namespace export (`/p/<ns>.jsonl`): a revision of a page, or one of its rows. */
export type ExportLine =
  | { kind: "set" | "add"; slug: string; rev: number; by: string; note: string; at: number; bytes: number; redacted: boolean; sealed: boolean; body: string | null }
  | { kind: "row"; slug: string; n: number; id: string | null; rev: number; by: string; at: number; redacted: boolean; sealed: boolean; body: string };

/**
 * How a name is printed in text. The word comes FIRST and every name gets one, so a writer cannot
 * claim the seal: everything they control is printed after this word, and only the server prints it.
 * A suffix would be forgeable (`by=olety [sealed]`), and leaving guests unmarked would be too.
 */
export const signed = (by: string, sealed: boolean) => `${sealed ? "sealed" : "guest"} ${by}`;

export const iso = (ms: number) => new Date(ms).toISOString();

export type PolicyTarget = { rev: number } | { row: number };
export type PolicyPost = { rev: number; row: number | null; by: string; note: string; body: string; redacted: boolean; sealed: boolean; hidden: boolean; flag: PolicyFlag | null };
export type PolicyFlag = { cat: number; quote: string | null; model: string; at: number };
export type CaseEntry = {
  seq: number; at: number; ns: string; slug: string; rev: number; row: number | null;
  source: "auto" | "report"; reason: string; note: string; by: string;
  cat: number | null; quote: string | null; action: string; status: "open" | "resolved";
  resolved_at: number | null; resolved_by: string | null; reports: number;
};
export type CaseInput = Omit<CaseEntry, "seq" | "resolved_at" | "resolved_by" | "status" | "action" | "reports"> & { status?: "open" | "resolved"; action?: string };
