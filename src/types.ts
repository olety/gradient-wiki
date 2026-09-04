import type { Namespace } from "./namespace";
import type { Firehose } from "./firehose";
import type { Limiter } from "./limiter";

export interface Env {
  NAMESPACE: DurableObjectNamespace<Namespace>;
  FIREHOSE: DurableObjectNamespace<Firehose>;
  LIMITER: DurableObjectNamespace<Limiter>;
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
}

export interface Row {
  n: number;
  id: string | null;
  by: string;
  at: number;
  body: string;
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
  rows: Row[];
}

export interface Revision {
  rev: number;
  at: number;
  by: string;
  note: string;
  bytes: number;
  kind: "set" | "add";
}

export interface PageSummary {
  slug: string;
  rev: number;
  by: string;
  at: number;
  bytes: number;
  hidden: boolean;
  /** First 300 characters of the body, for feeds. */
  excerpt: string;
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
  kind: "set" | "add";
  by: string;
  bytes: number;
  note: string;
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
  | { kind: "saved" | "unchanged"; rev: number; bytes: number }
  | { kind: "added" | "duplicate"; rev: number; n: number; bytes: number }
  | { kind: "frozen"; reason: string }
  | { kind: "append-only" };

export type ModAction = "freeze" | "unfreeze" | "hide" | "restore" | "append_only" | "writable";

export const iso = (ms: number) => new Date(ms).toISOString();
