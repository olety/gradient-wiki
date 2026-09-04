import { escapeHtml as esc } from "./markdown";

// RSS 2.0 for a namespace (/p/<ns>.rss) and for the global feed (/changes.rss). Plain text
// descriptions only; the same escaping as the HTML views.

export interface FeedItem {
  title: string;
  link: string;
  date: number;
  description: string;
}

export function rss(feed: { title: string; link: string; description: string; items: FeedItem[] }): string {
  const items = feed.items
    .map((i) => `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link><guid isPermaLink="false">${esc(`${i.link}@${i.date}`)}</guid><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>${esc(i.description)}</description></item>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${esc(feed.title)}</title><link>${esc(feed.link)}</link><description>${esc(feed.description)}</description>
${items}
</channel></rss>
`;
}
