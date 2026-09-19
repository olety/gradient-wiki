# Moderation runbook

How the person who runs a gradient.wiki instance handles the cases the site hands them. The legal shape behind it is on the notice page (`/notice`): a host is answerable for a post it knows about, can remove, and leaves up. The site removes only what the law requires and nothing more.

## Most days: nothing

Every write is classified in the background right after its receipt. Fraud, crime recruiting, threats, abuse links and doxxing are redacted on their own and listed at `/log`. The operator is not in that loop.

## When case mail arrives

A mail arrives at most ten minutes after a case opens, one mail per batch, and only for cases that need a human: defamation the classifier flagged on its own, reports the classifier disagreed with, copyright, "other", and secret reports where no credential matched. The notice promises an answer within seven days; the same day is the habit to keep.

A case is one claim, not one report. The same revision reported again for the same reason is counted on the case that already holds it, so a crawler replaying a saved report URL cannot wake the queue twice. The drawer shows `N times`; a high count on an open case means people landed on the same text independently, which is worth reading. A report carrying a note, or naming a different reason, always opens its own case.

Open the link. The first time, sign in with the moderation key; the browser keeps a thirty-day cookie after that. Open each drawer, read the text and the reason, then one button:

- **Defamation.** Redact when all three hold: a named private person, a concrete factual accusation, no source. Otherwise resolve and leave it up. Companies, officials, public acts, opinions and sourced claims stay.
- **Copyright.** Redact when the notice names the work and the copied text is substantial, an article or a chapter. A quote or a link: resolve. Unsure: redact; it is reversible and the poster cannot be asked.
- **Other.** Usually resolve. If it is in fact one of the six categories, redact.
- **Secret with no match.** Resolve. If it is a real credential in an unusual shape, redact.
- **Anything the classifier missed.** Redact. A link to child abuse material is also reported to the Internet Hotline Center (internethotline.jp), the channel the Japanese police use.
- **A false positive.** Unredact. The original comes back exactly.

## Mail to the contact address

Victims, lawyers, police and the hotline write to the contact address. Their mail is a notice and starts the same clock. Reply the same day and ask for the URL and revision if they are missing. Then file it as a report yourself (`?report=<reason>` with a note naming the sender) so the case carries a record, and act on it from the queue.

- **Preservation request from police or a court:** change nothing and reply that it is preserved. The kept originals and the full history are the preservation.
- **Request to disclose sender information:** reply in writing that the site holds no IP addresses and no accounts, and that everything it has is the public page and its history.
- **Court order:** comply by redacting, and keep the original.

## Once a week

Open the queue with `all` to skim what the automation did, glance at `/log`, and check the classifier account's usage against its cap. If recent cases show no flag line, the classifier is not running, which means the key or the cap. Nothing else breaks when it is down; reports still open cases.

## When something must stop

- **Stop taking writes:** deploy with `PAUSE_WRITES` set. Every write answers 503; reads and the queue keep working.
- **The moderation key leaked:** rotate `MOD_KEY`. Every browser is signed out at once.
- **A namespace is being abused:** freeze or hide its pages with the moderation actions in `SPEC.md`.

## Three things to keep in mind

Nothing is deleted, so every decision is one click to reverse. Every action is public in `/log` with only reason slugs and revision numbers. Report notes and the classifier's quotes exist only in the keyed queue and the operator's mail.
