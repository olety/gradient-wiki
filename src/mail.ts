import type { Row, CaseEntry } from "./types";
import { iso, signed } from "./types";

// Inbox mail: new rows on lobby/inbox are batched (at most one message per 10 minutes) and
// forwarded through the Email Workers binding. The message is assembled by hand as RFC 5322
// text so the project needs no mail dependency.

export interface InboxMail {
  from: string;
  to: string;
  raw: string;
}

export function buildInboxMail(rows: Row[], opts: { to: string; publicUrl: string; now: number }): InboxMail {
  const host = new URL(opts.publicUrl).host;
  const from = `inbox@${host}`;
  const subject = rows.length === 1 ? `[${host}] 1 new inbox note` : `[${host}] ${rows.length} new inbox notes`;
  const body = rows
    .map((r) => `${iso(r.at)}  by ${signed(r.by, r.sealed)}\n${r.body}\n${opts.publicUrl}/p/lobby/inbox#row-${r.n}\n`)
    .join("\n");
  const raw = [
    `From: ${host} inbox <${from}>`,
    `To: <${opts.to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date(opts.now).toUTCString()}`,
    `Message-ID: <inbox-${opts.now}-${rows[rows.length - 1]?.n ?? 0}@${host}>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    body,
  ].join("\r\n");
  return { from, to: opts.to, raw };
}

// RFC 2047 encoded-word for the subject, so non-ASCII notes survive strict relays.
function encodeHeader(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?utf-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;
}

export async function sendInboxMail(binding: SendEmail, mail: InboxMail): Promise<void> {
  const { EmailMessage } = await import("cloudflare:email");
  await binding.send(new EmailMessage(mail.from, mail.to, mail.raw));
}

export function caseLine(c: CaseEntry): string {
  const quote = (c.quote ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 80);
  const note = c.note.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return `case ${c.seq} ${iso(c.at)} ${c.ns}/${c.slug} rev ${c.rev}${c.row !== null ? ` row ${c.row}` : ""} ${c.source}:${c.reason} ${c.status} ${c.action}${quote ? ` ${quote}` : ""}${note ? ` note: ${note}` : ""}`;
}

export function buildCaseMail(cases: CaseEntry[], opts: { to: string; publicUrl: string; now: number }): InboxMail {
  const host = new URL(opts.publicUrl).hostname;
  const from = `inbox@${host}`;
  const raw = [
    `From: ${host} inbox <${from}>`, `To: <${opts.to}>`,
    `Subject: gradient.wiki: ${cases.length} open cases`,
    `Date: ${new Date(opts.now).toUTCString()}`,
    `Message-ID: <cases-${opts.now}-${cases[cases.length - 1]?.seq ?? 0}@${host}>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "",
    cases.map(caseLine).join("\n") + `\n\n${opts.publicUrl.replace(/\/$/, "")}/mod/queue\n`,
  ].join("\r\n");
  return { from, to: opts.to, raw };
}
